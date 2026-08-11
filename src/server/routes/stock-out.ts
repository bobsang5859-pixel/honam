import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, resolveDeptScope, AuthRequest } from '../middleware/auth';
import { expandPermissions } from '../../shared/permissions';
import { audit, generateNo, nextSeq } from '../utils/audit';
import { monthLabel } from '../utils/period-label';
import { allocateFifo, ensureFifoTables, reverseAllocationsByStockOut } from '../utils/fifo';
import { generateEquipmentSerial } from '../utils/serial';
import { pickDeptLocationId } from '../utils/inventory-helpers';
import {
  ReceiptServiceError,
  confirmReceipt,
  getReceiptDetail,
  listReceiptQueue,
  saveReceiptLine,
} from '../services/stock-out-receipt-service';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('stock-out', 'PURCHASE_MANAGE', 'REQUEST_USE', 'SYSTEM_ADMIN'));

const WORKBOARD_REQUEST_STATUSES = ['APPROVED', 'PARTIAL_APPROVED'] as const;
// 신청주기(RequestSchedule) 가 등록되는 유형 — request-schedules.ts 의 SCHEDULED_TYPES 와 동기화 필요.
// 의료소모품·사무용품도 신청주기 등록 가능하므로 포함 (이전엔 빠져서 라벨이 "2026년 5월" fallback 으로 갈라졌음)
const SCHEDULED_REQUEST_TYPES = new Set([
  'CONSUMABLE_MEDICAL',
  'CONSUMABLE_REGULAR',
  'CONSUMABLE_OFFICE',
  'DIAPER',
  'NIGHT_SNACK',
]);
const WORKBOARD_TYPE_LABEL: Record<string, string> = {
  CONSUMABLE_REGULAR: '정기소모품',
  DIAPER: '기저귀',
  NIGHT_SNACK: '야간당직간식',
  ADHOC: '비정기',
  EQUIPMENT: '비품',
};

type CreateIssueLineInput = {
  item_id: string;
  issue_qty: number;
  location_id: string;
};

type ScheduleLite = {
  request_type: string;
  open_from: Date;
  open_to: Date;
  period_label: string;
};

function isAdminLike(req: AuthRequest): boolean {
  // 총무구매(PURCHASE_MANAGE) 또는 SYSTEM_ADMIN 은 전 부서 신청을 봐야 불출 가능.
  // 권한 묶음 역추론(expandPermissions): 사용자가 5개 하위 권한
  // (APPROVAL_MANAGE / PO_MANAGE / STOCK_IN_MANAGE / STOCK_OUT_MANAGE / INVENTORY_MANAGE)
  // 모두 보유 → PURCHASE_MANAGE 자동 인정. raw .includes() 만 보면 놓침.
  const perms = req.user?.permissions ?? [];
  const expanded = expandPermissions(perms);
  if (expanded.has('SYSTEM_ADMIN') || expanded.has('PURCHASE_MANAGE')) return true;
  return resolveDeptScope(req).is_all;
}

function canAccessDepartment(req: AuthRequest, departmentId: string): boolean {
  if (isAdminLike(req)) return true;
  return req.user?.department_id === departmentId;
}

function buildReceiptViewer(req: AuthRequest) {
  return {
    user_id: String(req.user?.id ?? ''),
    department_id: req.user?.department_id ?? null,
    is_admin_like: isAdminLike(req),
  };
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 폴백 월 라벨 — 전 구매단계 공통(period-label.ts)
function formatMonthLabel(dateLike: Date | string | null | undefined): string {
  return monthLabel(dateLike);
}

function isTruthy(value: unknown): boolean {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'y' || raw === 'yes';
}

function resolvePeriodLabel(
  requestType: string,
  periodStart: Date | null,
  schedulesByType: Map<string, ScheduleLite[]>
): { period_label: string; matched: boolean } {
  if (!periodStart) return { period_label: '', matched: false };
  if (SCHEDULED_REQUEST_TYPES.has(requestType)) {
    const schedules = schedulesByType.get(requestType) ?? [];
    const matchedSchedule = schedules.find((s) => s.open_from <= periodStart && periodStart <= s.open_to);
    if (matchedSchedule) {
      return { period_label: matchedSchedule.period_label || formatMonthLabel(periodStart), matched: true };
    }
  }
  return { period_label: formatMonthLabel(periodStart), matched: false };
}

async function getLatestApprovedQtyMap(wardRequestIds: string[]): Promise<Map<string, Map<string, number>>> {
  const result = new Map<string, Map<string, number>>();
  if (wardRequestIds.length === 0) return result;

  const actions = await prisma.approvalAction.findMany({
    where: { ward_request_id: { in: wardRequestIds } },
    include: { items: true },
    orderBy: [{ ward_request_id: 'asc' }, { created_at: 'desc' }],
  });

  for (const action of actions as any[]) {
    if (!action.items || action.items.length === 0) continue;
    if (result.has(action.ward_request_id)) continue;
    const perItem = new Map<string, number>();
    for (const it of action.items) {
      // 자유입력(item_id=null)은 String(null)="null" 키 충돌이 일어나서 매핑하지 않음
      // — 직접불출 대상이 아니라 워크보드 표시에서도 제외됨
      if (!it.item_id) continue;
      perItem.set(String(it.item_id), toNumber(it.approved_qty));
    }
    result.set(String(action.ward_request_id), perItem);
  }

  return result;
}

async function getIssuedQtyMapByRequestItem(wardRequestIds: string[]): Promise<Map<string, number>> {
  const issuedMap = new Map<string, number>();
  if (wardRequestIds.length === 0) return issuedMap;

  const issuedRows = await prisma.stockOutItem.findMany({
    where: {
      stock_out: {
        ward_request_id: { in: wardRequestIds },
        deleted_at: null,
        status: { not: 'REVERSED' },
      },
    } as any,
    select: {
      item_id: true,
      issued_qty: true,
      stock_out: { select: { ward_request_id: true } },
    } as any,
  });

  for (const row of issuedRows as any[]) {
    const wardRequestId = String(row.stock_out?.ward_request_id ?? '');
    if (!wardRequestId) continue;
    const key = `${wardRequestId}::${row.item_id}`;
    issuedMap.set(key, (issuedMap.get(key) ?? 0) + toNumber(row.issued_qty));
  }

  return issuedMap;
}

// 정책: 불출은 무조건 "총무구매 창고"에서만 나가야 함 (총무구매 부서가 관리하는 중앙 창고).
// 이름 일치(=='총무구매 창고')로 식별 — seed/시스템 설정에 의존.
export const CENTRAL_STOCK_OUT_LOCATION_NAME = '총무구매 창고';
let _centralLocationCache: { id: string; name: string } | null = null;
export async function getCentralStockOutLocation(): Promise<{ id: string; name: string }> {
  if (_centralLocationCache) return _centralLocationCache;
  const loc = await prisma.inventoryLocation.findFirst({
    where: { name: CENTRAL_STOCK_OUT_LOCATION_NAME },
    select: { id: true, name: true },
  });
  if (!loc) {
    throw new Error(`출고 정책 위치 미설정: '${CENTRAL_STOCK_OUT_LOCATION_NAME}' inventory_location 레코드가 필요합니다.`);
  }
  _centralLocationCache = loc;
  return loc;
}

async function createStockOutWithLines(params: {
  department_id: string;
  ward_request_id?: string | null;
  issued_by: string;
  note?: string;
  lines: CreateIssueLineInput[];
  /** true = 수기불출 자동확정 (수령검수 단계 건너뜀; 부서 확인 없이 바로 CONFIRMED) */
  auto_confirm?: boolean;
}): Promise<{ id: string; so_no: string }> {
  const { department_id, ward_request_id, issued_by, note, lines, auto_confirm } = params;
  if (!department_id) throw new Error('department_id is required.');
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('At least one issue line is required.');

  // 기본 입력값 검증 (트랜잭션 전에 빠른 실패)
  for (const line of lines) {
    const qty = toNumber(line.issue_qty);
    if (!line.item_id || !line.location_id || qty <= 0) {
      throw new Error('Invalid issue line.');
    }
  }

  // 정책 검증: 불출 위치는 반드시 "총무구매 창고"
  const centralLoc = await getCentralStockOutLocation();
  for (const line of lines) {
    if (line.location_id !== centralLoc.id) {
      throw new Error(`불출 위치 정책 위반: 모든 불출은 '${centralLoc.name}'에서만 가능합니다.`);
    }
  }

  const seq = await nextSeq('stock_out');
  const so_no = generateNo('SO', seq);

  // is_test 자동 전파 — ward_request 또는 사용 lot의 부모 GR이 test이면 SO도 test
  let isTest = false;
  if (ward_request_id) {
    const wr = await prisma.wardRequest.findUnique({ where: { id: ward_request_id }, select: { is_test: true } });
    if (wr?.is_test) isTest = true;
  }

  // 재고 검증 + 출고 + FIFO + 장비 유닛을 하나의 트랜잭션으로 처리
  const so = await prisma.$transaction(async (tx) => {
    await ensureFifoTables(tx as any);

    // 음수 재고 허용 정책: 재고/LOT 부족해도 불출은 진행하고, 부족분은
    // inventory.on_hand_qty 가 음수로 차감되며, FIFO 미할당분은
    // stock_out_lot_allocations 에 inventory_lot_id=NULL 로 기록됩니다.
    // (현장 흐름 안 끊김 + 부족분 자동 가시화 + 입고 시 양수 회복)

    const now = new Date();
    const stockOut = await tx.stockOut.create({
      data: {
        id: uuidv4(),
        so_no,
        department_id,
        ward_request_id: ward_request_id || null,
        issued_by,
        status: auto_confirm ? 'RECEIPT_CONFIRMED' : 'RECEIPT_PENDING',
        note: note ?? '',
        is_test: isTest,
        ...(auto_confirm ? {
          receipt_confirmed_at: now,
          receipt_confirmed_by: issued_by,
          confirmed_by_purchaser: true,
        } : {}),
      } as any,
    });

    for (const line of lines) {
      const issueQty = toNumber(line.issue_qty);
      const createdLine = await tx.stockOutItem.create({
        data: {
          id: uuidv4(),
          stock_out_id: stockOut.id,
          item_id: line.item_id,
          issued_qty: issueQty,
          location_id: line.location_id,
          ...(auto_confirm ? {
            received_qty: issueQty,
            receipt_confirmed_at: now,
            receipt_confirmed_by: issued_by,
          } : {}),
        } as any,
      });
      await allocateFifo(tx as any, {
        stockOutId: stockOut.id,
        stockOutItemId: createdLine.id,
        itemId: line.item_id,
        locationId: line.location_id,
        issueQty,
      });
      // 음수 재고 허용: inventory 레코드가 없으면 음수 잔량으로 신규 생성, 있으면 그대로 차감
      await tx.inventory.upsert({
        where: { item_id_location_id: { item_id: line.item_id, location_id: line.location_id } },
        update: { on_hand_qty: { decrement: issueQty } },
        create: { item_id: line.item_id, location_id: line.location_id, on_hand_qty: -issueQty },
      });
    }

    // 비품 품목 → EquipmentUnit 자동 생성 (트랜잭션 안에서 처리)
    const itemIds = lines.map(l => l.item_id);
    const equipItems = await tx.item.findMany({
      where: { id: { in: itemIds }, category: { startsWith: 'EQUIP_' } },
      select: { id: true },
    });
    const equipItemIds = new Set(equipItems.map(i => i.id));
    if (equipItems.length > 0) {
      for (const line of lines) {
        if (!equipItemIds.has(line.item_id)) continue;
        const qty = toNumber(line.issue_qty);
        for (let i = 0; i < qty; i++) {
          const serial = await generateEquipmentSerial(tx);
          await (tx as any).equipmentUnit.create({
            data: {
              id: uuidv4(),
              serial_no: serial,
              item_id: line.item_id,
              department_id,
              stock_out_id: stockOut.id,
            },
          });
        }
      }
    }

    // 부서 보관함 자동 증가 (소모품만 — 비품은 EquipmentUnit 으로 추적)
    // 없으면 자동 생성. 부서가 받은 만큼 자기 보관함 Inventory.on_hand_qty 가 늘어남.
    const deptLocId = await pickDeptLocationId(department_id, null, tx);
    if (deptLocId) {
      for (const line of lines) {
        if (equipItemIds.has(line.item_id)) continue; // 비품은 제외
        const issueQty = toNumber(line.issue_qty);
        await tx.inventory.upsert({
          where: { item_id_location_id: { item_id: line.item_id, location_id: deptLocId } },
          update: { on_hand_qty: { increment: issueQty } },
          create: {
            id: uuidv4(),
            item_id: line.item_id,
            location_id: deptLocId,
            on_hand_qty: issueQty,
            avg_unit_cost: 0,
          } as any,
        });
      }
    }

    return stockOut;
  });

  return { id: so.id, so_no };
}

router.get('/', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    await ensureFifoTables(prisma as any);
    const { department_id, status } = req.query;
    const requestedDeptId = department_id ? String(department_id) : '';
    const scopeDeptId = String(req.user?.department_id ?? '');
    if (!isAdminLike(req)) {
      if (!scopeDeptId) {
        return res.status(403).json({ error: '소속 부서가 없습니다.' });
      }
      if (requestedDeptId && requestedDeptId !== scopeDeptId) {
        return res.status(403).json({ error: '타 부서 데이터에 접근할 수 없습니다.' });
      }
    }
    const effectiveDeptId = isAdminLike(req) ? requestedDeptId : scopeDeptId;
    const sos = await prisma.stockOut.findMany({
      where: {
        deleted_at: null,
        ...(status && { status: String(status) }),
        ...(effectiveDeptId && { department_id: effectiveDeptId }),
      },
      include: {
        department: true,
        issuer: true,
        items: { include: { item: true, location: true }, orderBy: { item: { item_code: 'asc' } } },
        ward_request: { select: { id: true, request_type: true, period_start: true } },
      } as any,
      orderBy: { issued_at: 'desc' },
    });

    // 주차 라벨 매핑 (수령검수와 동일한 로직 — RequestSchedule 기반)
    const neededTypes = Array.from(
      new Set(
        sos
          .map((so: any) => String(so.ward_request?.request_type ?? ''))
          .filter((t: string) => t && SCHEDULED_REQUEST_TYPES.has(t)),
      ),
    );
    const schedulesByType2 = new Map<string, ScheduleLite[]>();
    if (neededTypes.length > 0) {
      const schedules = await prisma.requestSchedule.findMany({
        where: { request_type: { in: neededTypes } },
        orderBy: { open_from: 'asc' },
      });
      for (const s of schedules as any[]) {
        const arr = schedulesByType2.get(String(s.request_type)) ?? [];
        arr.push({
          request_type: String(s.request_type),
          open_from: new Date(s.open_from),
          open_to: new Date(s.open_to),
          period_label: String(s.period_label ?? ''),
        });
        schedulesByType2.set(String(s.request_type), arr);
      }
    }

    res.json(
      sos.map((so: any) => {
        // 카테고리 분포
        const breakdown: Record<string, number> = {};
        for (const it of so.items) {
          const cat = String(it.item?.category ?? '');
          // shared/types getMajor 와 동일 로직
          let major = 'GENERAL';
          if (cat.startsWith('EQUIP_')) major = 'EQUIPMENT';
          else if (cat.startsWith('OFF_')) major = 'OFFICE';
          else if (cat.startsWith('MED_') || cat.startsWith('INFECT_')) major = 'MEDICAL';
          else if (cat.startsWith('DIAPER')) major = 'DIAPER';
          breakdown[major] = (breakdown[major] ?? 0) + 1;
        }
        // 주차 라벨
        const wr = so.ward_request ?? null;
        const requestType = String(wr?.request_type ?? '');
        const periodStart = wr?.period_start ? new Date(wr.period_start) : null;
        const manualLabel = String((so as any).manual_period_label ?? '').trim();
        const periodInfo = wr ? resolvePeriodLabel(requestType, periodStart, schedulesByType2) : { period_label: '', matched: false };
        const periodLabel = manualLabel || periodInfo.period_label || '';

        return {
          id: so.id,
          so_no: so.so_no,
          department_id: so.department_id,
          department_name: so.department?.name,
          ward_request_id: so.ward_request_id,
          issuer_name: so.issuer?.display_name,
          issued_at: so.issued_at,
          status: so.status,
          note: so.note,
          receipt_confirmed_at: so.receipt_confirmed_at,
          receipt_confirmed_by: so.receipt_confirmed_by,
          receipt_diff_count: Number(so.receipt_diff_count ?? 0),
          confirmed_by_purchaser: !!(so as any).confirmed_by_purchaser,
          item_count: so.items.length,
          total_qty: so.items.reduce((sum: number, it: any) => sum + Number(it.issued_qty), 0),
          period_label: periodLabel || null,
          request_type: requestType || null,
          category_breakdown: breakdown,
          items: so.items.map((it: any) => ({
            id: it.id,
            item_id: it.item_id,
            item_name: it.item?.name,
            item_code: it.item?.item_code,
            category: it.item?.category ?? '',
            uom: it.item?.uom,
            purchase_uom: it.item?.purchase_uom ?? it.item?.uom,
            issue_uom: it.item?.issue_uom ?? it.item?.uom,
            pack_size: Number(it.item?.pack_size ?? 1),
            issued_qty: Number(it.issued_qty),
            location_id: it.location_id,
            location_name: it.location?.name,
            received_qty: it.received_qty == null ? null : Number(it.received_qty),
            receipt_note: it.receipt_note ?? '',
            receipt_confirmed_at: it.receipt_confirmed_at,
            receipt_confirmed_by: it.receipt_confirmed_by,
          })),
        };
      })
    );
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/receipts', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const queue = await listReceiptQueue({
      status_query: req.query.status == null ? undefined : String(req.query.status),
      department_id_query: req.query.department_id == null ? undefined : String(req.query.department_id),
      viewer: buildReceiptViewer(req),
    });
    res.json(queue.rows);
  } catch (e: any) {
    if (e instanceof ReceiptServiceError) {
      return res.status(e.status).json({ error: e.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /stock-out/:id/period-label — 수동으로 주차 라벨 지정 (그룹화 용).
// 빈 문자열 또는 null 보내면 라벨 제거 (원래 ward_request 기준으로 복귀).
router.patch('/:id/period-label', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.id);
    const raw = req.body?.period_label;
    const label = raw == null ? null : String(raw).trim() || null;

    const so = await prisma.stockOut.findUnique({ where: { id } });
    if (!so || so.deleted_at) return res.status(404).json({ error: '불출을 찾을 수 없습니다.' });
    if (!isAdminLike(req)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });

    await (prisma as any).stockOut.update({
      where: { id },
      data: { manual_period_label: label },
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'PATCH',
      entity_type: 'stock_out',
      entity_id: id,
      before: { manual_period_label: (so as any).manual_period_label ?? null },
      after: { manual_period_label: label },
      reason: '주차 라벨 수동 지정',
    });

    res.json({ ok: true, manual_period_label: label });
  } catch (e) {
    console.error('[PATCH /stock-out/:id/period-label]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/workboard', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const requestType = String(req.query.request_type ?? '').trim();
    const periodLabelQuery = String(req.query.period_label ?? '').trim();
    const requestedDeptId = String(req.query.department_id ?? '').trim();
    const onlyEmergency = isTruthy(req.query.only_emergency);

    const scopeDeptId = String(req.user?.department_id ?? '');
    const where: any = {
      deleted_at: null,
      status: { in: [...WORKBOARD_REQUEST_STATUSES] },
      ...(requestType ? { request_type: requestType } : {}),
      ...(onlyEmergency ? { is_emergency: true } : {}),
    };

    if (!isAdminLike(req)) {
      if (!scopeDeptId) return res.json({ summary: {}, department_groups: [], item_totals: [], rows: [] });
      where.department_id = scopeDeptId;
    } else if (requestedDeptId) {
      where.department_id = requestedDeptId;
    }

    const requests = await prisma.wardRequest.findMany({
      where,
      include: {
        department: true,
        items: { include: { item: true } },
      },
      orderBy: [{ submitted_at: 'desc' }, { request_no: 'desc' }] as any,
    });

    if (requests.length === 0) {
      return res.json({
        summary: {
          department_count: 0,
          request_count: 0,
          line_count: 0,
          total_approved_qty: 0,
          total_issued_qty: 0,
          total_remaining_qty: 0,
        },
        department_groups: [],
        item_totals: [],
        rows: [],
      });
    }

    const requestIds = requests.map((wr: any) => String(wr.id));
    const neededTypes = Array.from(
      new Set(
        requests
          .map((wr: any) => String(wr.request_type ?? ''))
          .filter((t) => t && SCHEDULED_REQUEST_TYPES.has(t))
      )
    );
    const schedules =
      neededTypes.length > 0
        ? await prisma.requestSchedule.findMany({
            where: { request_type: { in: neededTypes } },
            orderBy: { open_from: 'asc' },
          })
        : [];
    const schedulesByType = new Map<string, ScheduleLite[]>();
    for (const schedule of schedules as any[]) {
      if (!schedulesByType.has(schedule.request_type)) schedulesByType.set(schedule.request_type, []);
      schedulesByType.get(schedule.request_type)!.push({
        request_type: String(schedule.request_type),
        open_from: new Date(schedule.open_from),
        open_to: new Date(schedule.open_to),
        period_label: String(schedule.period_label ?? ''),
      });
    }

    const approvedByRequest = await getLatestApprovedQtyMap(requestIds);
    const issuedByRequestItem = await getIssuedQtyMapByRequestItem(requestIds);
    const itemIds = Array.from(
      new Set(
        requests
          .flatMap((wr: any) => wr.items ?? [])
          .map((it: any) => String(it.item_id))
          .filter(Boolean)
      )
    );

    const inventoryRows = itemIds.length
      ? await prisma.inventory.findMany({
          where: { item_id: { in: itemIds } },
          include: { location: true },
          orderBy: [{ item_id: 'asc' }, { on_hand_qty: 'desc' }],
        })
      : [];
    const onHandByItem = new Map<string, number>();
    for (const inv of inventoryRows as any[]) {
      const itemId = String(inv.item_id);
      onHandByItem.set(itemId, (onHandByItem.get(itemId) ?? 0) + toNumber(inv.on_hand_qty));
    }
    // 정책: 불출은 무조건 "총무구매 창고"에서만 — 추천 위치 고정
    const centralLocation = await getCentralStockOutLocation();

    const rows: any[] = [];
    for (const wr of requests as any[]) {
      const wrId = String(wr.id);
      const periodStart = wr.period_start ? new Date(wr.period_start) : null;
      const periodInfo = resolvePeriodLabel(String(wr.request_type ?? ''), periodStart, schedulesByType);
      const periodLabel = periodInfo.period_label || formatMonthLabel(periodStart);
      if (periodLabelQuery && periodLabelQuery !== periodLabel) continue;

      const approvedMap = approvedByRequest.get(wrId) ?? new Map<string, number>();
      for (const line of wr.items ?? []) {
        // 자유입력(item_id=null) 라인은 직접불출 대상이 아니라 워크보드에서 제외
        if (!line.item_id) continue;
        const itemId = String(line.item_id);
        // 승인 데이터에 매핑이 없으면 0으로 처리 — 승인자가 삭제/0qty 처리한 라인이 표시되지 않도록
        // (예전에는 requested_qty로 fallback했으나, 승인 안 한 라인이 표시되는 원인이었음)
        const approvedQty = toNumber(approvedMap.get(itemId) ?? 0);
        const issuedQty = issuedByRequestItem.get(`${wrId}::${itemId}`) ?? 0;
        const remainingQty = Math.max(approvedQty - issuedQty, 0);
        if (remainingQty <= 0) continue;

        const packSize = Math.max(1, Number(line.item?.pack_size ?? 1));
        const onHandQty = onHandByItem.get(itemId) ?? 0;
        rows.push({
          ward_request_id: wrId,
          request_no: wr.request_no,
          request_type: String(wr.request_type ?? ''),
          request_type_label: WORKBOARD_TYPE_LABEL[String(wr.request_type ?? '')] ?? String(wr.request_type ?? ''),
          period_label: periodLabel,
          period_start: periodStart ? periodStart.toISOString() : null,
          is_emergency: !!wr.is_emergency,
          department_id: wr.department_id,
          department_name: wr.department?.name ?? '',
          item_id: itemId,
          item_name: line.item?.name ?? '',
          item_code: line.item?.item_code ?? '',
          category: line.item?.category ?? '',
          uom: line.item?.uom ?? '',
          purchase_uom: line.item?.purchase_uom ?? line.item?.uom ?? '',
          issue_uom: line.item?.issue_uom ?? line.item?.uom ?? '',
          pack_size: packSize,
          approved_qty: approvedQty,
          issued_qty_sum: issuedQty,
          remaining_qty: remainingQty,
          on_hand_qty: onHandQty,
          recommended_box_qty: Math.ceil(remainingQty / Math.max(packSize, 1)),
          recommended_location_id: centralLocation.id,
          recommended_location_name: centralLocation.name,
        });
      }
    }

    const deptMap = new Map<string, any>();
    const itemMap = new Map<string, any>();
    for (const row of rows) {
      if (!deptMap.has(row.department_id)) {
        deptMap.set(row.department_id, {
          department_id: row.department_id,
          department_name: row.department_name,
          request_ids: new Set<string>(),
          item_count: 0,
          total_remaining_qty: 0,
          lines: [] as any[],
        });
      }
      const dept = deptMap.get(row.department_id);
      dept.request_ids.add(row.ward_request_id);
      dept.item_count += 1;
      dept.total_remaining_qty += row.remaining_qty;
      dept.lines.push(row);

      if (!itemMap.has(row.item_id)) {
        itemMap.set(row.item_id, {
          item_id: row.item_id,
          item_name: row.item_name,
          item_code: row.item_code,
          uom: row.uom,
          purchase_uom: (row as any).purchase_uom,
          issue_uom: (row as any).issue_uom,
          pack_size: row.pack_size,
          total_approved_qty: 0,
          total_issued_qty: 0,
          total_remaining_qty: 0,
          on_hand_qty: row.on_hand_qty,
          recommended_location_id: row.recommended_location_id,
          recommended_location_name: row.recommended_location_name,
        });
      }
      const itemAgg = itemMap.get(row.item_id);
      itemAgg.total_approved_qty += row.approved_qty;
      itemAgg.total_issued_qty += row.issued_qty_sum;
      itemAgg.total_remaining_qty += row.remaining_qty;
      itemAgg.recommended_box_qty = Math.ceil(itemAgg.total_remaining_qty / Math.max(itemAgg.pack_size, 1));
    }

    const departmentGroups = Array.from(deptMap.values())
      .map((dept: any) => ({
        department_id: dept.department_id,
        department_name: dept.department_name,
        request_count: dept.request_ids.size,
        item_count: dept.item_count,
        total_remaining_qty: dept.total_remaining_qty,
        lines: dept.lines,
      }))
      .sort((a, b) => a.department_name.localeCompare(b.department_name, 'ko'));

    const itemTotals = Array.from(itemMap.values()).sort(
      (a, b) => Number(b.total_remaining_qty) - Number(a.total_remaining_qty)
    );

    res.json({
      summary: {
        department_count: departmentGroups.length,
        request_count: new Set(rows.map((r) => r.ward_request_id)).size,
        line_count: rows.length,
        total_approved_qty: rows.reduce((sum, r) => sum + Number(r.approved_qty), 0),
        total_issued_qty: rows.reduce((sum, r) => sum + Number(r.issued_qty_sum), 0),
        total_remaining_qty: rows.reduce((sum, r) => sum + Number(r.remaining_qty), 0),
      },
      department_groups: departmentGroups,
      item_totals: itemTotals,
      rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/workboard/:wardRequestId/issue', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    if (!isAdminLike(req)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    const wardRequestId = String(req.params.wardRequestId);
    const wardRequest = await prisma.wardRequest.findUnique({
      where: { id: wardRequestId },
      include: {
        department: true,
        items: { include: { item: true } },
      },
    });
    if (!wardRequest || wardRequest.deleted_at) return res.status(404).json({ error: '요청을 찾을 수 없습니다.' });
    if (!WORKBOARD_REQUEST_STATUSES.includes(wardRequest.status as any)) {
      return res.status(400).json({ error: '승인된 신청만 불출할 수 있습니다.' });
    }
    if (!canAccessDepartment(req, wardRequest.department_id)) {
      return res.status(403).json({ error: '타 부서 데이터에 접근할 수 없습니다.' });
    }

    const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (rawLines.length === 0) return res.status(400).json({ error: '불출 라인이 필요합니다.' });
    const lineMap = new Map<string, CreateIssueLineInput>();
    // close_remainder: 라인별로 불출 후 잔여를 0 으로 마감(승인량 = 기불출+이번불출) 할지.
    // 줄여서 불출한 뒤 다시 안 줄 경우 true. 잔여를 다음에 또 불출하려면 false(기본).
    // issue_qty=0 + close_remainder=true 케이스: 이번엔 한 개도 안 주고 그냥 잔여만 마감 (불출 row 없이 ApprovalAction 만).
    const closeRemainderSet = new Set<string>();
    for (const line of rawLines) {
      const itemId = String(line?.item_id ?? '');
      const issueQty = toNumber(line?.issue_qty);
      const locationId = String(line?.location_id ?? '');
      const wantClose = line?.close_remainder === true;
      if (!itemId) return res.status(400).json({ error: '불출 라인 형식이 올바르지 않습니다.' });
      if (issueQty < 0) return res.status(400).json({ error: '불출 라인 형식이 올바르지 않습니다.' });
      if (issueQty === 0 && !wantClose) {
        return res.status(400).json({ error: `${itemId}: 0 불출은 잔여 마감과 함께만 가능합니다.` });
      }
      if (issueQty > 0 && !locationId) return res.status(400).json({ error: '불출 라인 위치가 필요합니다.' });
      if (issueQty > 0) {
        lineMap.set(itemId, { item_id: itemId, issue_qty: issueQty, location_id: locationId });
      }
      if (wantClose) closeRemainderSet.add(itemId);
    }
    if (lineMap.size === 0 && closeRemainderSet.size === 0) {
      return res.status(400).json({ error: '불출 또는 마감 라인이 필요합니다.' });
    }

    const approvedByRequest = await getLatestApprovedQtyMap([wardRequestId]);
    const issuedByRequestItem = await getIssuedQtyMapByRequestItem([wardRequestId]);
    const approvedMap = approvedByRequest.get(wardRequestId) ?? new Map<string, number>();
    const requestItemMap = new Map<string, any>();
    for (const it of (wardRequest as any).items ?? []) {
      requestItemMap.set(String(it.item_id), it);
    }

    // 잔여 초과 라인 자동 처리 — auto_amend 옵션이 true 면 승인 수량을 늘려 ADJUST 액션 추가
    // (불출 단위와 신청·승인 단위가 다를 때 사용자가 매번 amend 페이지 가는 부담 제거)
    const autoAmend = req.body?.auto_amend !== false;  // 기본 true
    const amendUpdates: { item_id: string; old_approved: number; new_approved: number; reqItem: any }[] = [];

    for (const [itemId, line] of lineMap.entries()) {
      const reqItem = requestItemMap.get(itemId);
      if (!reqItem) return res.status(400).json({ error: '신청 품목이 아닌 항목이 포함되어 있습니다.' });
      const approvedQty = approvedMap.has(itemId) ? toNumber(approvedMap.get(itemId)) : toNumber(reqItem.requested_qty);
      const issuedQty = issuedByRequestItem.get(`${wardRequestId}::${itemId}`) ?? 0;
      const remainingQty = Math.max(approvedQty - issuedQty, 0);
      if (toNumber(line.issue_qty) > remainingQty) {
        if (!autoAmend) {
          return res.status(400).json({
            error: `${reqItem.item?.name ?? itemId} 불출수량이 잔여수량을 초과합니다. (잔여 ${remainingQty}, 입력 ${line.issue_qty})`,
          });
        }
        // 승인 수량 = 기불출 + 이번 불출 입력값으로 자동 늘림
        const newApproved = issuedQty + toNumber(line.issue_qty);
        // 임계값 — 너무 큰 차이는 거부 (사용자 실수 방지)
        // 한계: 기존 승인 × 10 + 100 (예: 승인 1 → 110 까지 OK / 승인 10 → 200 까지 OK / 승인 100 → 1100 까지 OK)
        const limit = approvedQty * 10 + 100;
        if (newApproved > limit) {
          return res.status(400).json({
            error: `${reqItem.item?.name ?? itemId}: 입력 ${line.issue_qty} 가 승인(${approvedQty}) 대비 너무 큼 (자동 조정 한도 ${limit}). 진짜 필요하면 승인 페이지에서 amend 후 다시 시도해 주세요.`,
          });
        }
        amendUpdates.push({ item_id: itemId, old_approved: approvedQty, new_approved: newApproved, reqItem });
      }
    }

    // 자동 amend 적용 — 잔여 초과한 품목들 승인량을 늘려서 새 ADJUST 액션 추가
    if (amendUpdates.length > 0) {
      // 기존 모든 라인의 승인량 + 늘릴 라인은 새 값으로 → ApprovalAction 한 건 생성
      const allApprovedItems: any[] = [];
      for (const it of (wardRequest as any).items ?? []) {
        const itemId = String(it.item_id);
        const update = amendUpdates.find(u => u.item_id === itemId);
        const newApproved = update ? update.new_approved : toNumber(approvedMap.get(itemId) ?? it.requested_qty);
        allApprovedItems.push({
          id: uuidv4(),
          item_id: it.item_id,
          custom_name: it.custom_name ?? '',
          requested_qty: Number(it.requested_qty),
          approved_qty: newApproved,
          baseline_qty: Number(it.baseline_qty),
          diff_qty: newApproved - Number(it.requested_qty),
          diff_pct: Number(it.requested_qty) > 0 ? ((newApproved - Number(it.requested_qty)) / Number(it.requested_qty)) * 100 : 0,
          policy_flags: it.policy_flags ?? '[]',
          approver_note: '',
        });
      }
      await prisma.approvalAction.create({
        data: {
          id: uuidv4(),
          ward_request_id: wardRequestId,
          approver_id: req.user!.id,
          action: 'ADJUST',
          reason: `불출 시점 자동 승인 수량 조정 (${amendUpdates.map(u => `${u.reqItem.item?.name ?? u.item_id}: ${u.old_approved}→${u.new_approved}`).join(', ')})`,
          items: { create: allApprovedItems },
        },
      });
    }

    // 실제 불출은 issue_qty>0 라인이 있을 때만 — 0 불출 + 마감만 케이스는 StockOut 안 만듦
    const created = lineMap.size > 0
      ? await createStockOutWithLines({
          department_id: wardRequest.department_id,
          ward_request_id: wardRequestId,
          issued_by: req.user!.id,
          note: String(req.body?.note ?? '').trim() || '[WORKBOARD] 신청기준 불출',
          lines: Array.from(lineMap.values()),
        })
      : null;

    // close_remainder 적용 — 마감 대상 라인의 승인량을 (기불출+이번불출) 로 줄여 잔여 0 처리.
    // 줄여서 불출했고 더 이상 안 줄 때 사용. 잔여 유지를 원하면 close_remainder=false (기본).
    if (closeRemainderSet.size > 0) {
      const closeUpdates: { item_id: string; old_approved: number; new_approved: number; reqItem: any }[] = [];
      for (const itemId of closeRemainderSet) {
        const line = lineMap.get(itemId);
        const issueQty = line ? Number(line.issue_qty) : 0;
        const beforeIssued = issuedByRequestItem.get(`${wardRequestId}::${itemId}`) ?? 0;
        const newApproved = beforeIssued + issueQty;
        // amend 가 이미 늘려둔 경우엔 그 값을 기준 — closeRemainder 는 줄이는 방향이어야 의미 있음
        const amendApplied = amendUpdates.find(u => u.item_id === itemId);
        const oldApproved = amendApplied
          ? amendApplied.new_approved
          : (approvedMap.has(itemId) ? toNumber(approvedMap.get(itemId)) : toNumber(requestItemMap.get(itemId)?.requested_qty ?? 0));
        if (newApproved >= oldApproved) continue; // 이미 잔여 0 또는 늘리는 방향 — skip
        closeUpdates.push({ item_id: itemId, old_approved: oldApproved, new_approved: newApproved, reqItem: requestItemMap.get(itemId) });
      }
      if (closeUpdates.length > 0) {
        // 최종 승인량 Map: 기존 + amend 결과 + close 결과 모두 반영
        const finalApproved = new Map<string, number>(approvedMap);
        for (const u of amendUpdates) finalApproved.set(u.item_id, u.new_approved);
        for (const u of closeUpdates) finalApproved.set(u.item_id, u.new_approved);

        const allApprovedItems: any[] = [];
        for (const it of (wardRequest as any).items ?? []) {
          const itemId = String(it.item_id);
          const newApproved = finalApproved.has(itemId) ? toNumber(finalApproved.get(itemId)) : toNumber(it.requested_qty);
          allApprovedItems.push({
            id: uuidv4(),
            item_id: it.item_id,
            custom_name: it.custom_name ?? '',
            requested_qty: Number(it.requested_qty),
            approved_qty: newApproved,
            baseline_qty: Number(it.baseline_qty),
            diff_qty: newApproved - Number(it.requested_qty),
            diff_pct: Number(it.requested_qty) > 0 ? ((newApproved - Number(it.requested_qty)) / Number(it.requested_qty)) * 100 : 0,
            policy_flags: it.policy_flags ?? '[]',
            approver_note: '',
          });
        }
        await prisma.approvalAction.create({
          data: {
            id: uuidv4(),
            ward_request_id: wardRequestId,
            approver_id: req.user!.id,
            action: 'ADJUST',
            reason: `불출 시 잔여 마감 (${closeUpdates.map(u => `${u.reqItem?.item?.name ?? u.item_id}: ${u.old_approved}→${u.new_approved}`).join(', ')})`,
            items: { create: allApprovedItems },
          },
        });
      }
    }

    await audit({
      actor_user_id: req.user!.id,
      action: 'POST',
      entity_type: 'stock_out_workboard_issue',
      entity_id: created?.id ?? wardRequestId,
      after: {
        so_no: created?.so_no ?? null,
        ward_request_id: wardRequestId,
        department_id: wardRequest.department_id,
        line_count: lineMap.size,
        closed_remainder_count: closeRemainderSet.size,
      },
    });

    res.status(201).json({
      id: created?.id ?? null,
      so_no: created?.so_no ?? null,
      ward_request_id: wardRequestId,
      department_id: wardRequest.department_id,
      closed_only: !created,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? 'Server error');
    if (msg !== 'Server error') return res.status(400).json({ error: msg });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/follow-ups', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const status = String(req.query.status ?? 'OPEN').trim().toUpperCase();
    const statuses =
      status && status !== 'ALL'
        ? status.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

    const where: any = {
      ...(statuses?.length ? { status: { in: statuses } } : {}),
    };
    if (!isAdminLike(req)) {
      const deptId = String(req.user?.department_id ?? '');
      if (!deptId) return res.json([]);
      where.department_id = deptId;
    } else if (req.query.department_id) {
      where.department_id = String(req.query.department_id);
    }

    const rows = await prisma.stockOutFollowUp.findMany({
      where,
      include: {
        stock_out: true,
        department: true,
        item: true,
        creator: true,
        resolver: true,
      },
      orderBy: { created_at: 'desc' },
    });

    res.json(
      rows.map((row: any) => ({
        id: row.id,
        stock_out_id: row.stock_out_id,
        so_no: row.stock_out?.so_no,
        ward_request_id: row.stock_out?.ward_request_id ?? null,
        department_id: row.department_id,
        department_name: row.department?.name ?? '',
        item_id: row.item_id,
        item_name: row.item?.name ?? '',
        item_code: row.item?.item_code ?? '',
        category: row.item?.category ?? '',
        uom: row.item?.uom ?? '',
        purchase_uom: row.item?.purchase_uom ?? row.item?.uom ?? '',
        issue_uom: row.item?.issue_uom ?? row.item?.uom ?? '',
        pack_size: Number(row.item?.pack_size ?? 1),
        action_type: row.action_type,
        diff_qty: toNumber(row.diff_qty),
        status: row.status,
        disposition: row.disposition ?? null,
        note: row.note ?? '',
        created_at: row.created_at,
        created_by: row.created_by,
        created_by_name: row.creator?.display_name ?? '',
        resolved_at: row.resolved_at,
        resolved_by: row.resolved_by,
        resolved_by_name: row.resolver?.display_name ?? '',
      }))
    );
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// 후속작업 대상 (stock_out + item) 의 lot 할당을 FIFO 역순(최근 할당부터)으로 qty 만큼 되돌린다.
//  - line_amount/issued_qty 를 그만큼 줄여 그 부서 불출 비용을 정정 (원 출고 lot 원가 그대로 사용)
//  - restoreWarehouse=true(회수): 실물이 창고로 돌아오므로 lot.remaining_qty 복원
//    restoreWarehouse=false(추가불출 안 함): 못 간 분이라 창고 복원 X (정책: 부서 비용에서만 제거)
async function reverseFollowUpAllocations(
  tx: any,
  params: { stockOutId: string; itemId: string; qty: number; restoreWarehouse: boolean },
): Promise<{ removedQty: number; removedAmount: number }> {
  const soi = await tx.stockOutItem.findFirst({
    where: { stock_out_id: params.stockOutId, item_id: params.itemId },
    select: { id: true },
  });
  if (!soi) return { removedQty: 0, removedAmount: 0 };
  const allocs: any[] = await tx.$queryRawUnsafe(
    `SELECT id, inventory_lot_id, issued_qty, unit_cost
     FROM stock_out_lot_allocations
     WHERE stock_out_item_id = ? AND issued_qty > 0
     ORDER BY datetime(created_at) DESC, id DESC`,
    soi.id,
  );
  let remain = Number(params.qty) || 0;
  let removedAmount = 0;
  for (const a of allocs) {
    if (remain <= 0) break;
    const aQty = Number(a.issued_qty || 0);
    if (aQty <= 0) continue;
    const take = Math.min(aQty, remain);
    const uc = Number(a.unit_cost || 0);
    const newQty = Number((aQty - take).toFixed(6));
    const newAmt = Number((newQty * uc).toFixed(2));
    removedAmount += Number((take * uc).toFixed(2));
    await tx.$executeRawUnsafe(
      `UPDATE stock_out_lot_allocations SET issued_qty = ?, line_amount = ? WHERE id = ?`,
      newQty, newAmt, a.id,
    );
    if (params.restoreWarehouse && a.inventory_lot_id) {
      await tx.$executeRawUnsafe(
        `UPDATE inventory_lots SET remaining_qty = remaining_qty + ? WHERE id = ?`,
        take, a.inventory_lot_id,
      );
    }
    remain = Number((remain - take).toFixed(6));
  }
  return { removedQty: Number(params.qty) - remain, removedAmount };
}

// 후속작업 처리(결정). disposition 으로 분기:
//   NOT_ISSUED_RETURNED (ISSUE_ADD)    추가불출 안 함 + 창고 잔류 → 창고 재고/lot 복원 + 비용 정정
//   NOT_ISSUED_LOST     (ISSUE_ADD)    추가불출 안 함 + 분실    → 비용만 정정 (창고 복원 X)
//   COLLECTED           (COLLECT_BACK) 회수 실행 → 창고 재고/lot 환입 + 비용 차감
//   NOT_COLLECTED       (COLLECT_BACK) 회수 안 함 → 변동 없음 (부서가 그대로 사용)
router.post('/follow-ups/:id/resolve', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    if (!isAdminLike(req)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    const id = String(req.params.id);
    const followUp = await prisma.stockOutFollowUp.findUnique({ where: { id }, include: { stock_out: true } });
    if (!followUp) return res.status(404).json({ error: '후속작업을 찾을 수 없습니다.' });
    if (!canAccessDepartment(req, followUp.department_id)) return res.status(403).json({ error: '권한이 없습니다.' });
    if (followUp.status !== 'OPEN') return res.status(400).json({ error: '이미 처리된 후속작업입니다.' });

    const note = String(req.body?.note ?? '').trim();
    let disposition: string = String(req.body?.disposition ?? '').trim().toUpperCase();
    // 미지정 시 안전 기본값 — 창고 복원 없는 쪽 (부작용 최소)
    if (!disposition) disposition = followUp.action_type === 'ISSUE_ADD' ? 'NOT_ISSUED_LOST' : 'NOT_COLLECTED';

    // 처리방식별 효과 정의
    //  reverse      : 부서 불출 비용(line_amount) 을 원 lot 원가로 차감 정정
    //  restoreLot   : 창고 lot.remaining_qty 복원 + 총무구매창고 재고 +복원
    //  deptMinus    : 부서 보관함 -보정
    const EFFECT: Record<string, { reverse: boolean; restoreLot: boolean; deptMinus: boolean; for: 'ISSUE_ADD' | 'COLLECT_BACK' }> = {
      // 부족(ISSUE_ADD)
      NOT_ISSUED_RETURNED: { reverse: true,  restoreLot: true,  deptMinus: true,  for: 'ISSUE_ADD'   }, // 창고에 그대로 있음(덜 보냄)
      NOT_ISSUED_LOST:     { reverse: true,  restoreLot: false, deptMinus: true,  for: 'ISSUE_ADD'   }, // 분실/파손
      // 초과(COLLECT_BACK)
      COLLECTED:           { reverse: true,  restoreLot: true,  deptMinus: true,  for: 'COLLECT_BACK' }, // 회수 실행
      NOT_COLLECTED:       { reverse: false, restoreLot: false, deptMinus: false, for: 'COLLECT_BACK' }, // 회수 안 함
    };
    const eff = EFFECT[disposition];
    if (!eff || eff.for !== followUp.action_type) {
      return res.status(400).json({ error: `이 후속작업(${followUp.action_type})에 적용할 수 없는 처리방식입니다.` });
    }

    const qty = toNumber(followUp.diff_qty);
    const stockOutId = followUp.stock_out_id;

    let removedAmount = 0;
    await prisma.$transaction(async (tx) => {
      if (eff.reverse) {
        const r = await reverseFollowUpAllocations(tx as any, {
          stockOutId, itemId: followUp.item_id, qty, restoreWarehouse: eff.restoreLot,
        });
        removedAmount = r.removedAmount;
      }
      if (eff.restoreLot) {
        // 부족분/초과분이 창고에 (그대로/되돌아) 있음 → 총무구매창고 재고 +복원
        const centralLoc = await getCentralStockOutLocation();
        await tx.inventory.upsert({
          where: { item_id_location_id: { item_id: followUp.item_id, location_id: centralLoc.id } },
          update: { on_hand_qty: { increment: qty } },
          create: { item_id: followUp.item_id, location_id: centralLoc.id, on_hand_qty: qty },
        });
      }
      if (eff.deptMinus) {
        const deptLocId = await pickDeptLocationId(followUp.department_id, null, tx);
        if (deptLocId) {
          await tx.inventory.upsert({
            where: { item_id_location_id: { item_id: followUp.item_id, location_id: deptLocId } },
            update: { on_hand_qty: { decrement: qty } },
            create: { item_id: followUp.item_id, location_id: deptLocId, on_hand_qty: -qty },
          });
        }
      }

      await tx.stockOutFollowUp.update({
        where: { id },
        data: {
          status: 'RESOLVED',
          disposition,
          note: note || followUp.note,
          resolved_at: new Date(),
          resolved_by: req.user!.id,
        } as any,
      });
    });

    const amtTxt = `${Math.round(removedAmount).toLocaleString()}원`;
    const msg =
      disposition === 'COLLECTED'           ? `회수 처리 완료 — 창고 재고 복원 + 비용 ${amtTxt} 차감`
      : disposition === 'NOT_ISSUED_RETURNED' ? `추가불출 안 함(창고 잔류) — 창고 재고 복원 + 비용 ${amtTxt} 정정`
      : disposition === 'NOT_ISSUED_LOST'   ? `추가불출 안 함(분실) — 비용 ${amtTxt} 정정 (창고 복원 없음)`
      : '회수 안 함 — 변동 없이 처리 완료';
    res.json({ message: msg, disposition, removed_amount: Math.round(removedAmount) });
  } catch (e: any) {
    console.error('[follow-ups/resolve] error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/follow-ups/:id/cancel', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    if (!isAdminLike(req)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    const id = String(req.params.id);
    const followUp = await prisma.stockOutFollowUp.findUnique({ where: { id } });
    if (!followUp) return res.status(404).json({ error: '후속작업을 찾을 수 없습니다.' });
    if (!canAccessDepartment(req, followUp.department_id)) return res.status(403).json({ error: '권한이 없습니다.' });
    if (followUp.status !== 'OPEN') return res.status(400).json({ error: '이미 처리된 후속작업입니다.' });

    const note = String(req.body?.note ?? '').trim();
    await prisma.stockOutFollowUp.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        note: note || followUp.note,
        resolved_at: new Date(),
        resolved_by: req.user!.id,
      } as any,
    });

    res.json({ message: '후속작업을 취소했습니다.' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/follow-ups/:id/create-issue', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    if (!isAdminLike(req)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    const id = String(req.params.id);
    const followUp = await prisma.stockOutFollowUp.findUnique({
      where: { id },
      include: { stock_out: true, item: true },
    });
    if (!followUp) return res.status(404).json({ error: '후속작업을 찾을 수 없습니다.' });
    if (!canAccessDepartment(req, followUp.department_id)) return res.status(403).json({ error: '권한이 없습니다.' });
    if (followUp.status !== 'OPEN') return res.status(400).json({ error: '이미 처리된 후속작업입니다.' });
    if (followUp.action_type !== 'ISSUE_ADD') {
      return res.status(400).json({ error: '추가불출 작업만 불출생성이 가능합니다.' });
    }

    // 정책: 불출은 무조건 "총무구매 창고"에서만 — body의 location_id 는 무시
    const centralLoc = await getCentralStockOutLocation();
    const selectedLocationId = centralLoc.id;

    const created = await createStockOutWithLines({
      department_id: followUp.department_id,
      ward_request_id: followUp.stock_out?.ward_request_id ?? null,
      issued_by: req.user!.id,
      note: String(req.body?.note ?? '').trim() || `[FOLLOW_UP] 추가불출 ${followUp.item?.name ?? followUp.item_id}`,
      lines: [
        {
          item_id: followUp.item_id,
          issue_qty: toNumber(followUp.diff_qty),
          location_id: selectedLocationId,
        },
      ],
    });

    await prisma.stockOutFollowUp.update({
      where: { id: followUp.id },
      data: {
        status: 'RESOLVED',
        disposition: 'ISSUED_EXTRA',
        resolved_at: new Date(),
        resolved_by: req.user!.id,
      } as any,
    });

    res.status(201).json({
      message: '추가불출을 생성했습니다.',
      follow_up_id: followUp.id,
      stock_out_id: created.id,
      so_no: created.so_no,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? 'Server error');
    if (msg !== 'Server error') return res.status(400).json({ error: msg });
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id/receipt', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const detail = await getReceiptDetail(String(req.params.id), buildReceiptViewer(req));
    res.json(detail);
  } catch (e: any) {
    if (e instanceof ReceiptServiceError) {
      return res.status(e.status).json({ error: e.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/receipt/lines/:itemId', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const updated = await saveReceiptLine({
      stock_out_id: String(req.params.id),
      item_id: String(req.params.itemId),
      received_qty: Number(req.body?.received_qty),
      receipt_note: String(req.body?.receipt_note ?? '').trim(),
      viewer: buildReceiptViewer(req),
    });
    res.json(updated);
  } catch (e: any) {
    if (e instanceof ReceiptServiceError) {
      return res.status(e.status).json({ error: e.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/receipt/confirm', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const stockOutId = String(req.params.id);
    const result = await confirmReceipt({
      stock_out_id: stockOutId,
      viewer: buildReceiptViewer(req),
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'CONFIRM_RECEIPT',
      entity_type: 'stock_out',
      entity_id: stockOutId,
      after: {
        status: result.status,
        receipt_diff_count: result.receipt_diff_count,
        follow_up_count: result.follow_up_count,
      },
    });

    res.json({
      message: 'Receipt confirmation completed.',
      status: result.status,
      receipt_diff_count: result.receipt_diff_count,
      follow_up_count: result.follow_up_count,
      follow_up_ids: result.follow_up_ids,
    });
  } catch (e: any) {
    if (e instanceof ReceiptServiceError) {
      return res.status(e.status).json({ error: e.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/stock-out/:id/force-confirm
// 「대신 확정」 — 부서가 수령검수를 안 해줄 때 총무구매가 강제로 RECEIPT_CONFIRMED 처리.
// 수령수량(received_qty)을 미입력 라인은 issued_qty 와 동일하게 채움(차이 없음 가정).
// 부서 사용자에게는 안 보이고 PURCHASE_MANAGE 만 사용 가능.
router.post('/:id/force-confirm', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const stockOutId = String(req.params.id);
    const reason = String(req.body?.reason ?? '').trim(); // 선택 입력
    const so = await prisma.stockOut.findUnique({ where: { id: stockOutId }, include: { items: true } });
    if (!so || so.deleted_at) return res.status(404).json({ error: '불출 건을 찾을 수 없습니다.' });
    if (so.status !== 'RECEIPT_PENDING' && so.status !== 'RECEIPT_DIFF') {
      return res.status(400).json({ error: `RECEIPT_PENDING 또는 RECEIPT_DIFF 상태만 대신 확정 가능합니다. (현재: ${so.status})` });
    }

    const now = new Date();
    const actorId = req.user!.id;
    const wasFromDiff = so.status === 'RECEIPT_DIFF';
    await prisma.$transaction(async (tx) => {
      // 라인별: received_qty 미입력은 issued_qty 로 자동 채움, 확정자 정보 박음.
      // DIFF 였던 건은 received_qty 가 이미 채워져 있어서 그대로 유지(차이 데이터 보존).
      let diffCountAfter = 0;
      for (const it of so.items) {
        const issued = Number((it as any).issued_qty ?? 0);
        const receivedRaw = (it as any).received_qty;
        const receivedFinal = receivedRaw == null ? issued : Number(receivedRaw);
        if (receivedFinal !== issued) diffCountAfter++;
        await tx.stockOutItem.update({
          where: { id: it.id },
          data: {
            received_qty: receivedFinal,
            receipt_confirmed_at: now,
            receipt_confirmed_by: actorId,
          } as any,
        });
      }
      await tx.stockOut.update({
        where: { id: stockOutId },
        data: {
          status: 'RECEIPT_CONFIRMED',
          receipt_confirmed_at: now,
          receipt_confirmed_by: actorId,
          // DIFF 에서 강제마감하면 기존 차이 카운트는 보존(이력 추적). PENDING 에서 오면 0.
          receipt_diff_count: wasFromDiff ? diffCountAfter : 0,
          confirmed_by_purchaser: true,
        } as any,
      });
    });

    await audit({
      actor_user_id: actorId,
      action: 'FORCE_CONFIRM',
      entity_type: 'stock_out',
      entity_id: stockOutId,
      reason,
      before: { status: so.status },
      after: { status: 'RECEIPT_CONFIRMED', confirmed_by_purchaser: true },
    });

    res.json({ message: '대신 확정 완료', status: 'RECEIPT_CONFIRMED' });
  } catch (e: any) {
    console.error('[POST /stock-out/:id/force-confirm] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

router.get('/:id', requirePermission('PURCHASE_MANAGE'), async (req, res) => {
  try {
    const so = await prisma.stockOut.findUnique({
      where: { id: String(req.params.id) },
      include: {
        department: true,
        issuer: true,
        items: { include: { item: true, location: true }, orderBy: { item: { item_code: 'asc' } } },
      },
    });
    if (!so || so.deleted_at) return res.status(404).json({ error: 'Stock-out not found.' });

    res.json({
      id: so.id,
      so_no: so.so_no,
      department_id: so.department_id,
      department_name: (so as any).department?.name,
      ward_request_id: so.ward_request_id,
      issuer_name: (so as any).issuer?.display_name,
      issued_at: so.issued_at,
      status: so.status,
      note: so.note,
      receipt_confirmed_at: so.receipt_confirmed_at,
      receipt_confirmed_by: so.receipt_confirmed_by,
      receipt_diff_count: Number(so.receipt_diff_count ?? 0),
      confirmed_by_purchaser: !!(so as any).confirmed_by_purchaser,
      items: (so.items ?? []).map((it: any) => ({
        id: it.id,
        item_id: it.item_id,
        item_name: it.item?.name,
        item_code: it.item?.item_code,
        uom: it.item?.uom,
        purchase_uom: it.item?.purchase_uom ?? it.item?.uom,
        issue_uom: it.item?.issue_uom ?? it.item?.uom,
        pack_size: Number(it.item?.pack_size ?? 1),
        issued_qty: Number(it.issued_qty),
        location_id: it.location_id,
        location_name: it.location?.name,
        received_qty: it.received_qty == null ? null : Number(it.received_qty),
        receipt_note: it.receipt_note ?? '',
        receipt_confirmed_at: it.receipt_confirmed_at,
        receipt_confirmed_by: it.receipt_confirmed_by,
      })),
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST: 불출 처리
router.post('/', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { department_id, ward_request_id, note, items } = req.body;
  if (!department_id) return res.status(400).json({ error: 'department_id is required.' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item is required.' });
  if (!isAdminLike(req) && String(req.user?.department_id ?? '') !== String(department_id)) {
    return res.status(403).json({ error: '본인 부서에 대해서만 불출할 수 있습니다.' });
  }

  try {
    const created = await createStockOutWithLines({
      department_id,
      ward_request_id: ward_request_id || null,
      issued_by: req.user!.id,
      note: note ?? '',
      lines: items.map((it: any) => ({
        item_id: String(it.item_id ?? ''),
        issue_qty: toNumber(it.issued_qty),
        location_id: String(it.location_id ?? ''),
      })),
      // 수기불출은 수령검수 단계 건너뛰고 바로 확정 (총무구매가 직접 처리)
      auto_confirm: true,
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'POST',
      entity_type: 'stock_out',
      entity_id: created.id,
      after: { so_no: created.so_no, department_id, item_count: items.length, status: 'RECEIPT_CONFIRMED', auto_confirm: true },
    });
    res.status(201).json({ id: created.id, so_no: created.so_no });
  } catch (e: any) {
    const msg = String(e?.message ?? 'Server error');
    if (msg !== 'Server error') return res.status(400).json({ error: msg });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/reverse: 불출 취소
router.post('/:id/reverse', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: '취소 사유는 필수입니다.' });

  try {
    await ensureFifoTables(prisma as any);
    const stockOutId = String(req.params.id);
    const so = await prisma.stockOut.findUnique({
      where: { id: stockOutId },
      include: { items: true },
    });
    if (!so) return res.status(404).json({ error: 'Stock-out not found.' });
    if (so.status === 'REVERSED') return res.status(400).json({ error: 'Already reversed.' });

    await prisma.$transaction(async (tx) => {
      await ensureFifoTables(tx as any);
      await tx.stockOut.update({ where: { id: stockOutId }, data: { status: 'REVERSED' } as any });
      await reverseAllocationsByStockOut(tx as any, stockOutId);
      for (const it of so.items) {
        await tx.inventory.update({
          where: { item_id_location_id: { item_id: it.item_id, location_id: it.location_id } },
          data: { on_hand_qty: { increment: Number(it.issued_qty) } },
        });
      }
    });

    await audit({ actor_user_id: req.user!.id, action: 'REVERSE', entity_type: 'stock_out', entity_id: stockOutId, reason });
    res.json({ message: 'Stock-out reversed.' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
