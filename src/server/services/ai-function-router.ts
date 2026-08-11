/**
 * AI Function Router
 * LLM이 추출한 intent+params를 기존 API 로직으로 연결
 */
import { prisma } from '../index';
import type { AiIntent } from './llm-service';
import { forecastDemand } from './demand-forecast';

export interface RouteResult {
  success: boolean;
  message: string;
  data?: any;
  confirmation_required?: boolean;
  pending_action?: PendingAction;
}

export interface PendingAction {
  id: string;
  intent: string;
  params: Record<string, any>;
  summary: string;
  created_at: number;
}

// 확인 대기 중인 액션 저장 (메모리 — 서버 재시작 시 초기화)
const pendingActions = new Map<string, PendingAction>();

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// 부서 이름으로 ID 찾기
async function findDepartment(name?: string) {
  if (!name) return null;
  // "2병동" → name LIKE '%2병동%'
  const dept = await prisma.department.findFirst({
    where: {
      name: { contains: name.replace(/\s/g, '') },
      deleted_at: null,
    },
  });
  return dept;
}

// 품목 이름으로 찾기
async function findItem(name: string) {
  const item = await prisma.item.findFirst({
    where: {
      OR: [
        { name: { contains: name } },
        { item_code: { contains: name } },
      ],
      is_active: true,
      deleted_at: null,
    },
  });
  return item;
}

// 숫자 포맷 (콤마)
function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}

// 템플릿 기반 응답 생성 (LLM 호출 제거 → 즉시 응답)
function formatQueryResult(label: string, items: Record<string, any>[]): string {
  if (!items.length) return `${label} 결과가 없습니다.`;
  const header = `📋 ${label} (${items.length}건)`;
  const rows = items.slice(0, 15).map((row, i) => {
    const parts = Object.entries(row).map(([k, v]) => {
      const val = typeof v === 'number' ? fmt(v) : v;
      return `${k}: ${val}`;
    });
    return `${i + 1}. ${parts.join(' | ')}`;
  });
  const more = items.length > 15 ? `\n... 외 ${items.length - 15}건` : '';
  return `${header}\n${rows.join('\n')}${more}`;
}

// 업체 이름으로 찾기
async function findVendor(name: string) {
  const vendor = await prisma.vendor.findFirst({
    where: {
      name: { contains: name },
      deleted_at: null,
    },
  });
  return vendor;
}

export async function routeIntent(parsed: AiIntent, userId: string): Promise<RouteResult> {
  const { intent, params } = parsed;

  try {
    switch (intent) {
      // ===== 조회 =====

      case 'inventory_query': {
        const where: any = { on_hand_qty: { gt: 0 } };
        if (params.department) {
          const dept = await findDepartment(params.department);
          if (dept) {
            const locs = await prisma.inventoryLocation.findMany({
              where: { department_id: dept.id, deleted_at: null },
            });
            if (locs.length) where.location_id = { in: locs.map(l => l.id) };
          }
        }
        const items = await prisma.inventory.findMany({
          where,
          include: {
            item: { select: { name: true, item_code: true, uom: true } },
            location: { select: { name: true } },
          },
          orderBy: { item: { name: 'asc' } },
          take: 20,
        });

        // 검색어 필터
        let filtered = items;
        if (params.search) {
          const s = params.search.toLowerCase();
          filtered = items.filter(i =>
            i.item.name.toLowerCase().includes(s) ||
            i.item.item_code.toLowerCase().includes(s)
          );
        }

        const result = filtered.map(i => ({
          품목: i.item.name,
          코드: i.item.item_code,
          재고: Number(i.on_hand_qty),
          단위: i.item.uom,
          위치: i.location.name,
        }));

        const msg = formatQueryResult('재고 조회', result);
        return { success: true, message: msg, data: result };
      }

      case 'inventory_low_stock': {
        const allInv = await prisma.inventory.findMany({
          where: { on_hand_qty: { gt: 0 } },
          include: {
            item: { select: { name: true, item_code: true, uom: true, reorder_days_threshold: true } },
            location: { select: { name: true } },
          },
        });

        const lowStock = allInv
          .filter(i => Number(i.on_hand_qty) <= i.item.reorder_days_threshold)
          .map(i => ({
            품목: i.item.name,
            재고: Number(i.on_hand_qty),
            기준: i.item.reorder_days_threshold,
            위치: i.location.name,
          }));

        const msg = formatQueryResult('부족 품목 (안전재고 이하)', lowStock);
        return { success: true, message: msg, data: lowStock };
      }

      case 'stock_out_list': {
        const where: any = { deleted_at: null };
        if (params.department) {
          const dept = await findDepartment(params.department);
          if (dept) where.department_id = dept.id;
        }

        const stockOuts = await prisma.stockOut.findMany({
          where,
          include: {
            department: { select: { name: true } },
            items: {
              include: { item: { select: { name: true, uom: true } } },
            },
          },
          orderBy: { issued_at: 'desc' },
          take: 10,
        });

        const result = stockOuts.map(so => ({
          번호: so.so_no,
          부서: so.department.name,
          일자: so.issued_at.toISOString().slice(0, 10),
          상태: so.status,
          품목수: so.items.length,
          품목: so.items.map(i => `${i.item.name} ${Number(i.issued_qty)}${i.item.uom}`).join(', '),
        }));

        const msg = formatQueryResult('불출 내역', result);
        return { success: true, message: msg, data: result };
      }

      case 'ward_request_list':
      case 'ward_request_pending': {
        const where: any = { deleted_at: null };
        if (intent === 'ward_request_pending') {
          where.status = 'SUBMITTED';
        } else if (params.status) {
          where.status = params.status;
        }
        if (params.department) {
          const dept = await findDepartment(params.department);
          if (dept) where.department_id = dept.id;
        }

        const requests = await prisma.wardRequest.findMany({
          where,
          include: {
            department: { select: { name: true } },
            items: {
              include: { item: { select: { name: true } } },
            },
          },
          orderBy: { submitted_at: 'desc' },
          take: 10,
        });

        const result = requests.map((r: any) => ({
          번호: r.request_no,
          부서: r.department.name,
          유형: r.request_type,
          상태: r.status,
          품목수: r.items.length,
          품목: r.items.slice(0, 5).map((i: any) => `${i.item.name} ${Number(i.requested_qty)}`).join(', '),
        }));

        const label = intent === 'ward_request_pending' ? '승인 대기 신청' : '신청 목록';
        const msg = formatQueryResult(label, result);
        return { success: true, message: msg, data: result };
      }

      case 'po_list': {
        const where: any = { deleted_at: null };
        if (params.status) where.status = params.status;

        const pos = await prisma.purchaseOrder.findMany({
          where,
          include: {
            vendor: { select: { name: true } },
          },
          orderBy: { ordered_at: 'desc' },
          take: 10,
        });

        const result = pos.map((p: any) => ({
          번호: p.po_no,
          업체: p.vendor.name,
          상태: p.status,
          일자: p.ordered_at.toISOString().slice(0, 10),
          금액: Number(p.total_amount),
        }));

        const msg = formatQueryResult('발주 목록', result);
        return { success: true, message: msg, data: result };
      }

      case 'cost_summary': {
        const now = new Date();
        const year = params.year || now.getFullYear();
        const month = params.month || (now.getMonth() + 1);
        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 0, 23, 59, 59);

        // 불출 기반 원가 계산
        const where: any = {
          deleted_at: null,
          issued_at: { gte: startDate, lte: endDate },
        };
        if (params.department) {
          const dept = await findDepartment(params.department);
          if (dept) where.department_id = dept.id;
        }

        const stockOuts = await prisma.stockOut.findMany({
          where,
          include: {
            department: { select: { name: true } },
            lot_allocations: { select: { line_amount: true } },
          },
        });

        // 부서별 합산
        const deptCosts: Record<string, number> = {};
        let totalCost = 0;
        for (const so of stockOuts) {
          const cost = so.lot_allocations.reduce((sum, a) => sum + Number(a.line_amount), 0);
          deptCosts[so.department.name] = (deptCosts[so.department.name] || 0) + cost;
          totalCost += cost;
        }

        const result = {
          기간: `${year}년 ${month}월`,
          총_물품비: totalCost,
          부서별: Object.entries(deptCosts).map(([name, cost]) => ({
            부서: name, 금액: cost
          })).sort((a, b) => b.금액 - a.금액),
        };

        // 물품비 템플릿 응답
        const deptLines = result.부서별.map((d: any) => `  • ${d.부서}: ${fmt(d.금액)}원`).join('\n');
        const msg = `📊 ${result.기간} 물품비 요약\n총 물품비: ${fmt(result.총_물품비)}원\n\n부서별:\n${deptLines || '  (데이터 없음)'}`;
        return { success: true, message: msg, data: result };
      }

      case 'patient_count': {
        const where: any = { status: 'ADMITTED', deleted_at: null };
        if (params.department) {
          const dept = await findDepartment(params.department);
          if (dept) where.department_id = dept.id;
        }

        const count = await prisma.patient.count({ where });

        let deptName = params.department || '전체';
        const msg = `${deptName} 현재 입원 환자: ${count}명`;
        return { success: true, message: msg, data: { department: deptName, count } };
      }

      case 'item_search': {
        if (!params.search) {
          return { success: false, message: '검색어를 입력해주세요.' };
        }

        const items = await prisma.item.findMany({
          where: {
            OR: [
              { name: { contains: params.search } },
              { item_code: { contains: params.search } },
            ],
            is_active: true,
            deleted_at: null,
          },
          take: 10,
        });

        const result = items.map(i => ({
          코드: i.item_code,
          품목명: i.name,
          분류: i.category,
          단위: i.uom,
        }));

        const msg = formatQueryResult('품목 검색', result);
        return { success: true, message: msg, data: result };
      }

      case 'demand_forecast': {
        const options: any = {};
        if (params.department) {
          const dept = await findDepartment(params.department);
          if (dept) options.deptId = dept.id;
        }

        const forecast = await forecastDemand(options);
        const critical = forecast.items.filter(i => i.risk_level === 'critical');
        const warning = forecast.items.filter(i => i.risk_level === 'warning');

        let msg = `📊 수요예측 분석 결과\n`;
        msg += `긴급 발주 필요: ${critical.length}건 | 주의: ${warning.length}건\n`;

        const top = forecast.items.filter(i => i.risk_level !== 'safe' && i.risk_level !== 'no_data').slice(0, 10);
        if (top.length) {
          msg += '\n위험 품목:\n';
          msg += top.map((it, i) => {
            const status = it.risk_level === 'critical' ? '🔴' : '🟡';
            const days = it.days_remaining !== null ? `${it.days_remaining.toFixed(0)}일` : '계산불가';
            return `${status} ${i + 1}. ${it.item_name} (${it.dept_name}) — 재고 ${fmt(it.current_stock)} / 소진 ${days}`;
          }).join('\n');
        } else {
          msg += '\n현재 위험 품목이 없습니다.';
        }

        return { success: true, message: msg, data: forecast };
      }

      // ===== 실행 (확인 필요) =====

      case 'stock_out_create':
      case 'usage_register':
      case 'usage_remaining':
      case 'po_create':
      case 'receipt_create':
      case 'approval_approve':
      case 'approval_reject': {
        // 확인 대기로 저장
        const actionId = generateId();
        const action: PendingAction = {
          id: actionId,
          intent,
          params,
          summary: parsed.summary,
          created_at: Date.now(),
        };
        pendingActions.set(actionId, action);

        // 5분 후 자동 만료
        setTimeout(() => pendingActions.delete(actionId), 5 * 60 * 1000);

        return {
          success: true,
          message: parsed.summary,
          confirmation_required: true,
          pending_action: action,
        };
      }

      // ===== 일반 =====

      case 'greeting':
        return { success: true, message: '안녕하세요! 무엇을 도와드릴까요? 재고 조회, 불출, 신청 승인 등 말씀해 주세요.' };

      case 'help':
        return {
          success: true,
          message: `사용 가능한 명령:
• "거즈 재고 얼마?" — 재고 조회
• "부족한 품목 뭐야?" — 부족 품목
• "2병동 불출 내역" — 불출 조회
• "대기 중인 신청" — 승인 대기 조회
• "이번달 물품비" — 원가 요약
• "2병동 거즈 200장 불출해줘" — 불출 생성
• "3병동 신청 승인해줘" — 승인 처리
• "거즈 10장 사용등록" — 사용 등록
• "발주 필요한 품목" — 수요예측/소진 예상`
        };

      default:
        return { success: false, message: '이해하지 못한 명령입니다. "도움말"을 입력하면 사용 가능한 명령을 볼 수 있습니다.' };
    }
  } catch (err) {
    console.error('routeIntent error:', err);
    return { success: false, message: `처리 중 오류가 발생했습니다: ${(err as Error).message}` };
  }
}

/**
 * 확인된 액션 실행
 */
export async function executeConfirmedAction(actionId: string, userId: string): Promise<RouteResult> {
  const action = pendingActions.get(actionId);
  if (!action) {
    return { success: false, message: '확인 대기 중인 작업을 찾을 수 없습니다. 다시 명령해 주세요.' };
  }

  pendingActions.delete(actionId);
  const { intent, params } = action;

  try {
    switch (intent) {
      case 'stock_out_create': {
        const dept = await findDepartment(params.department);
        if (!dept) return { success: false, message: `"${params.department}" 부서를 찾을 수 없습니다.` };

        // 품목 찾기
        const resolvedItems: { item_id: string; qty: number; name: string }[] = [];
        for (const pi of (params.items || [])) {
          const item = await findItem(pi.name);
          if (!item) return { success: false, message: `"${pi.name}" 품목을 찾을 수 없습니다.` };
          resolvedItems.push({ item_id: item.id, qty: pi.quantity, name: item.name });
        }

        if (!resolvedItems.length) {
          return { success: false, message: '불출할 품목이 없습니다.' };
        }

        // 중앙창고 위치 찾기
        const centralLoc = await prisma.inventoryLocation.findFirst({
          where: { code: 'CENTRAL', deleted_at: null },
        });
        if (!centralLoc) return { success: false, message: '총무구매 창고를 찾을 수 없습니다.' };

        // StockOut 생성
        const lastSo = await prisma.stockOut.findFirst({ orderBy: { issued_at: 'desc' } });
        const nextNum = lastSo ? parseInt(lastSo.so_no.replace('SO-', '')) + 1 : 1;
        const soNo = `SO-${String(nextNum).padStart(4, '0')}`;

        const stockOut = await prisma.stockOut.create({
          data: {
            so_no: soNo,
            department_id: dept.id,
            issued_by: userId,
            status: 'RECEIPT_PENDING',
            items: {
              create: resolvedItems.map(ri => ({
                item_id: ri.item_id,
                issued_qty: ri.qty,
                location_id: centralLoc.id,
              })),
            },
          },
          include: {
            items: { include: { item: { select: { name: true } } } },
          },
        });

        const itemsSummary = stockOut.items.map(i => `${i.item.name} ${Number(i.issued_qty)}`).join(', ');
        return {
          success: true,
          message: `불출 완료! ${soNo}\n${dept.name}에 ${itemsSummary} 불출 처리됐습니다.`,
          data: { so_no: soNo },
        };
      }

      case 'approval_approve': {
        let request;
        if (params.request_no) {
          request = await prisma.wardRequest.findFirst({
            where: { request_no: params.request_no, deleted_at: null },
          });
        } else if (params.department) {
          const dept = await findDepartment(params.department);
          if (dept) {
            request = await prisma.wardRequest.findFirst({
              where: { department_id: dept.id, status: 'SUBMITTED', deleted_at: null },
              orderBy: { submitted_at: 'desc' },
            });
          }
        } else {
          request = await prisma.wardRequest.findFirst({
            where: { status: 'SUBMITTED', deleted_at: null },
            orderBy: { submitted_at: 'desc' },
          });
        }

        if (!request) return { success: false, message: '승인할 신청을 찾을 수 없습니다.' };

        await prisma.wardRequest.update({
          where: { id: request.id },
          data: { status: 'APPROVED' },
        });

        return { success: true, message: `${request.request_no} 신청이 승인되었습니다.\n※ 상세 승인(수량 조정 등)은 승인 페이지에서 진행해주세요.` };
      }

      case 'approval_reject': {
        let request;
        if (params.request_no) {
          request = await prisma.wardRequest.findFirst({
            where: { request_no: params.request_no, deleted_at: null },
          });
        } else if (params.department) {
          const dept = await findDepartment(params.department);
          if (dept) {
            request = await prisma.wardRequest.findFirst({
              where: { department_id: dept.id, status: 'SUBMITTED', deleted_at: null },
              orderBy: { submitted_at: 'desc' },
            });
          }
        }

        if (!request) return { success: false, message: '반려할 신청을 찾을 수 없습니다.' };

        await prisma.wardRequest.update({
          where: { id: request.id },
          data: {
            status: 'REJECTED',
            note: params.reason || 'AI 어시스턴트를 통한 반려',
          },
        });

        return { success: true, message: `${request.request_no} 신청이 반려되었습니다.` };
      }

      case 'usage_register': {
        return { success: false, message: '사용 등록 기능은 폐지되었습니다. 환자별 사용 추적은 환자관리의 처치 등록 또는 신청 화면에서 처리하세요.' };
      }

      case 'usage_remaining': {
        // 잔량 보고 — 해당 부서 인벤토리 업데이트
        const dept = await findDepartment(params.department);
        if (!dept) return { success: false, message: `부서를 찾을 수 없습니다.` };

        const loc = await prisma.inventoryLocation.findFirst({
          where: { department_id: dept.id, deleted_at: null },
        });
        if (!loc) return { success: false, message: `${dept.name} 창고를 찾을 수 없습니다.` };

        const updates: string[] = [];
        for (const pi of (params.items || [])) {
          const item = await findItem(pi.name);
          if (!item) continue;

          await prisma.inventory.upsert({
            where: {
              item_id_location_id: { item_id: item.id, location_id: loc.id },
            },
            update: { on_hand_qty: pi.quantity },
            create: {
              item_id: item.id,
              location_id: loc.id,
              on_hand_qty: pi.quantity,
              avg_unit_cost: 0,
            },
          });
          updates.push(`${item.name} → ${pi.quantity}`);
        }

        return { success: true, message: `잔량 업데이트 완료!\n${updates.join('\n')}` };
      }

      default:
        return { success: false, message: '아직 지원하지 않는 실행 명령입니다.' };
    }
  } catch (err) {
    console.error('executeConfirmedAction error:', err);
    return { success: false, message: `실행 중 오류: ${(err as Error).message}` };
  }
}

export function cancelPendingAction(actionId: string): boolean {
  return pendingActions.delete(actionId);
}
