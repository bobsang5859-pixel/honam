import { Router } from 'express';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, resolveDeptScope, AuthRequest } from '../middleware/auth';
import { ensureFifoTables } from '../utils/fifo';
import { audit } from '../utils/audit';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('cost', 'STATS_VIEW', 'PURCHASE_MANAGE', 'ACCOUNTING_CLOSE'));

const ACTIVE_STOCK_OUT_STATUSES = ['POSTED', 'RECEIPT_PENDING', 'RECEIPT_CONFIRMED', 'RECEIPT_DIFF'];

// 「분류별 매입/불출」 표 데이터 빌더 — Map<`${group}||${mid_code}`, amount> → 그룹별 중분류 리스트
function buildGroupedRows(
  groupMidAmounts: Map<string, number>,
  groupOrder: string[],
  midLabelOf: (cat: string) => string,
) {
  const grouped = new Map<string, { group: string; total: number; rows: { mid_code: string; mid_label: string; amount: number }[] }>();
  for (const [key, amt] of groupMidAmounts.entries()) {
    const [group, midCode] = key.split('||');
    if (amt <= 0) continue;
    const g = grouped.get(group) ?? { group, total: 0, rows: [] };
    g.total += amt;
    g.rows.push({ mid_code: midCode, mid_label: midLabelOf(midCode), amount: Math.round(amt) });
    grouped.set(group, g);
  }
  // 그룹 정렬 + 그룹 내 중분류 금액 내림차순
  return Array.from(grouped.values())
    .map((g) => ({ ...g, total: Math.round(g.total), rows: g.rows.sort((a, b) => b.amount - a.amount) }))
    .sort((a, b) => {
      const ia = groupOrder.indexOf(a.group); const ib = groupOrder.indexOf(b.group);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
}

function resolveRequestedDept(req: AuthRequest, rawDepartmentId: unknown): string {
  const scope = resolveDeptScope(req);
  const requested = rawDepartmentId ? String(rawDepartmentId) : '';
  if (!scope.is_all) {
    if (requested && scope.department_id && requested !== scope.department_id) {
      throw new Error('FORBIDDEN_DEPARTMENT');
    }
    return scope.department_id ?? '';
  }
  return requested;
}

// 물품통계 — 즉석 계산. 비용 기준 = 실제 불출 원가(stock_out_lot_allocations.line_amount).
// 비용분석/환자통계와 동일 기준으로 통일 (월마감/cost_statistics 적재에 의존하지 않음).
router.get('/statistics', requirePermission('STATS_VIEW'), async (req: AuthRequest, res) => {
  try {
    const { year_month, department_id } = req.query;
    // expense_scope 필터 — 환자직접비/운영간접비 통계 분리용. 빈값/'ALL' = 필터 없음.
    const rawScope = req.query.expense_scope ? String(req.query.expense_scope).toUpperCase() : '';
    const expenseScope: 'PATIENT_DIRECT' | 'OPS_INDIRECT' | '' =
      rawScope === 'PATIENT_DIRECT' || rawScope === 'OPS_INDIRECT' ? rawScope : '';
    // 통계 스코프 = STATS 권한 기준 (resolveDeptScope 는 구매/부서 기준이라
    // STATS_VIEW_ALL 을 인정 안 함 → 총무/관리 부서 사용자가 자기 부서로 강제 필터되어
    // 불출(department_id=받는 병동) 0건 → ₩0 으로 나오던 버그).
    const perms = req.user?.permissions ?? [];
    const canAllStats = perms.includes('SYSTEM_ADMIN') || perms.includes('STATS_VIEW_ALL');
    const requestedDept = department_id ? String(department_id) : '';
    let scopedDeptId = '';
    if (canAllStats) {
      // 전체 조회 권한 → 명시 부서 필터만 적용(없으면 전체)
      scopedDeptId = requestedDept;
    } else {
      // 내 부서만 → 본인 부서로 한정, 다른 부서 명시 요청은 거부
      const ownDept = req.user?.department_id ?? '';
      if (requestedDept && ownDept && requestedDept !== ownDept) {
        return res.status(403).json({ error: '해당 부서 데이터에 접근할 수 없습니다.' });
      }
      scopedDeptId = ownDept;
    }

    // 대상 월 결정: year+month → year_month('YYYY-MM') → 기본 현재월
    const now = new Date();
    let selY = now.getFullYear();
    let selM = now.getMonth() + 1;
    if (req.query.year && req.query.month) {
      selY = Number(req.query.year);
      selM = Number(req.query.month);
    } else if (year_month && /^\d{4}-\d{2}$/.test(String(year_month))) {
      const [yy, mm] = String(year_month).split('-');
      selY = Number(yy);
      selM = Number(mm);
    }
    const selKey = `${selY}-${String(selM).padStart(2, '0')}`;
    const selStart = new Date(selY, selM - 1, 1, 0, 0, 0, 0);
    const selEnd = new Date(selY, selM, 0, 23, 59, 59, 999);
    const windowStart = new Date(selY, selM - 1 - 11, 1, 0, 0, 0, 0); // 최근 12개월

    const stockOuts = await prisma.stockOut.findMany({
      where: {
        deleted_at: null,
        is_test: false,
        status: { in: ACTIVE_STOCK_OUT_STATUSES as any },
        issued_at: { gte: windowStart, lte: selEnd },
        ...(scopedDeptId && { department_id: scopedDeptId }),
      },
      include: {
        department: { select: { name: true } },
        items: { select: { id: true, item_id: true, item: { select: { item_code: true, name: true, expense_scope: true, category: true } } } },
        lot_allocations: { select: { stock_out_item_id: true, issued_qty: true, line_amount: true } },
      },
    });

    // 카테고리 prefix → 대분류 라벨
    const MAJOR_LABEL: Record<string, string> = {
      MED: '의료소모품', INFECT: '감염보호구', PAT: '위생·생활케어',
      DIAPER: '기저귀', FAC: '청소·주방', OFF: '사무용품', FOOD: '식음료',
      // EQUIP 는 소모품 통계 대상 외 (비품 통계 별도)
    };
    const majorOf = (cat?: string | null): string => {
      if (!cat) return '기타';
      const prefix = String(cat).split('_')[0];
      return MAJOR_LABEL[prefix] ? MAJOR_LABEL[prefix] : '기타';
    };
    // 「소모품 통계」 기준 — 비품(EQUIP) 카테고리는 제외 (비품 통계는 별도)
    const isConsumable = (cat?: string | null): boolean => !String(cat ?? '').startsWith('EQUIP');

    // 신청 유형 5개 그룹 — 통계 분류별 표의 상위 헤더 (사용자가 신청 화면에서 익숙한 묶음)
    //   의료소모품 (MED + INFECT) / 일반소모품 (PAT + FAC) / 사무용품 (OFF) / 기저귀 (DIAPER) / 식음료 (FOOD)
    //   EQUIP(비품) 등 그 외는 「기타」 그룹.
    const GROUP_LABEL: Record<string, string> = {
      MED: '의료소모품', INFECT: '의료소모품',
      PAT: '일반소모품', FAC: '일반소모품',
      OFF: '사무용품',
      DIAPER: '기저귀',
      FOOD: '식음료',
    };
    const GROUP_ORDER = ['의료소모품', '일반소모품', '사무용품', '기저귀', '식음료', '기타'];
    const groupOf = (cat?: string | null): string => {
      if (!cat) return '기타';
      const prefix = String(cat).split('_')[0];
      return GROUP_LABEL[prefix] ?? '기타';
    };

    // 중분류 라벨 — CONSUMABLE_CATEGORIES 와 동기화 (서버 측 매핑).
    //   key = items.category 값 (예: MED_INJECTION), label = '주사·수액'.
    //   미정의 키는 카테고리 코드 그대로 반환.
    const MID_LABEL: Record<string, string> = {
      MED_INJECTION: '주사·수액', MED_DRESSING: '드레싱·고정', MED_AIRWAY: '호흡·삽관',
      MED_CATHETER: '카테터·튜브', MED_SURGICAL: '수술·시술', MED_DISINFECT: '소독·멸균', MED_HANBANG: '한방재료',
      INFECT_GLOVE: '일회용 장갑', INFECT_GOWN: '일회용 가운·앞치마', INFECT_MASK: '마스크',
      PAT_HYGIENE: '환자위생케어', PAT_PAPER: '지류·티슈', PAT_BAG: '비닐·봉투류', PAT_HANDWASH: '핸드워시',
      DIAPER_MAIN: '기저귀',
      FAC_DETERGENT: '세제·세정제', FAC_SPONGE: '수세미', FAC_TOOL: '청소도구',
      FAC_PEST: '살충·방향', FAC_DISH: '일회용 식기', FAC_KIT_TOOL: '주방도구',
      OFF_PEN: '펜·마카', OFF_CLIP: '클립·스테이플러', OFF_CUTTING: '절단·접착', OFF_STN_OTHER: '기타 문구',
      OFF_BASIC_PAPER: '일반 용지·노트', OFF_LABEL: '라벨', OFF_FORM: '의료 양식지', OFF_PRINT: '인쇄물·포스트잇',
      OFF_CLEARFILE: '클리어화일', OFF_GOVFILE: '정부화일', OFF_FILE_OTHER: '펀치·바인더·기타',
      OFF_ENVELOPE: '봉투', OFF_BOX: '문서함·박스', OFF_BAG: '쇼핑백', OFF_GIFT: '경조사 봉투',
      OFF_BATTERY: '건전지', OFF_STORAGE: '저장매체', OFF_CAMERA: '카메라 소모품',
      FOOD_WATER: '생수', FOOD_BEVERAGE: '음료', FOOD_INSTANT: '인스턴트 식품',
    };
    const midLabelOf = (cat?: string | null): string => {
      if (!cat) return '기타';
      return MID_LABEL[cat] ?? String(cat);
    };

    const issueByMajor = new Map<string, number>(); // 선택월 분류별 불출금액
    const issueByGroupMid = new Map<string, number>(); // 키: `${group}||${mid_code}` → 금액
    // 부서×그룹×중분류 — 「부서별 불출」 아코디언용
    const issueByDeptBreakdown = new Map<string, {
      dept_id: string; dept_name: string;
      groupMid: Map<string, number>;
    }>();

    const monthly = new Map<string, number>();
    const deptAgg = new Map<string, { department_id: string; department_name: string; amount: number; qty: number }>();
    const itemAgg = new Map<string, { item_id: string; item_code: string; item_name: string; major: string; amount: number; qty: number }>();
    let totalIssued = 0;
    // 비용구분별 분해 (이번 달) — 의료/일반 1인당 사용액 계산용
    const issueByScope = { PATIENT_DIRECT: 0, OPS_INDIRECT: 0 } as Record<string, number>;

    for (const so of stockOuts as any[]) {
      const d = new Date(so.issued_at);
      const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const siMap = new Map<string, any>();
      for (const si of so.items ?? []) siMap.set(si.id, si);

      for (const a of so.lot_allocations ?? []) {
        const si = siMap.get(a.stock_out_item_id);
        // 비품(EQUIP) 카테고리는 소모품 통계에서 제외
        if (!isConsumable(si?.item?.category)) continue;
        const lineScope = si?.item?.expense_scope ?? 'PATIENT_DIRECT';
        // expense_scope 필터 — 품목의 비용구분이 요청과 다르면 그 라인은 통째로 제외
        if (expenseScope && lineScope !== expenseScope) continue;
        const amt = Number(a.line_amount ?? 0);
        const qty = Number(a.issued_qty ?? 0);
        monthly.set(mKey, (monthly.get(mKey) ?? 0) + amt);
        if (mKey !== selKey) continue;

        totalIssued += amt;
        if (lineScope === 'PATIENT_DIRECT') issueByScope.PATIENT_DIRECT += amt;
        else if (lineScope === 'OPS_INDIRECT') issueByScope.OPS_INDIRECT += amt;
        const dep = deptAgg.get(so.department_id) ?? {
          department_id: so.department_id, department_name: so.department?.name ?? '', amount: 0, qty: 0,
        };
        dep.amount += amt; dep.qty += qty;
        deptAgg.set(so.department_id, dep);

        if (si?.item_id) {
          const m = majorOf(si.item?.category);
          const it = itemAgg.get(si.item_id) ?? {
            item_id: si.item_id, item_code: si.item?.item_code ?? '', item_name: si.item?.name ?? '',
            major: m, amount: 0, qty: 0,
          };
          it.amount += amt; it.qty += qty;
          itemAgg.set(si.item_id, it);
          // 분류별 불출 (선택월만)
          issueByMajor.set(m, (issueByMajor.get(m) ?? 0) + amt);
          // 그룹×중분류별 불출 (분류별 불출 표용)
          const g = groupOf(si.item?.category);
          const midCode = si.item?.category ?? '기타';
          const midKey = `${g}||${midCode}`;
          issueByGroupMid.set(midKey, (issueByGroupMid.get(midKey) ?? 0) + amt);
          // 부서×그룹×중분류 (부서별 불출 아코디언용)
          const did = so.department_id;
          const dname = so.department?.name ?? '미정';
          const db = issueByDeptBreakdown.get(did) ?? {
            dept_id: did, dept_name: dname, groupMid: new Map<string, number>(),
          };
          db.groupMid.set(midKey, (db.groupMid.get(midKey) ?? 0) + amt);
          issueByDeptBreakdown.set(did, db);
        }
      }
    }

    // 월 구매금액 — 발주(PO) 기준. 구매는 조직 단위라 부서 필터 시에는 미산출(0).
    let totalPurchased = 0;
    const purchaseByMajor = new Map<string, number>();
    const purchaseByGroupMid = new Map<string, number>(); // 키: `${group}||${mid_code}` → 금액
    const purchaseByVendor = new Map<string, { vendor_id: string; vendor_name: string; amount: number }>();
    const purchaseByItem = new Map<string, { item_id: string; item_code: string; item_name: string; major: string; amount: number }>();
    // 거래처×그룹×중분류 — 「업체별 매입」 아코디언용 (각 거래처가 어떤 분류·중분류를 매입했나)
    const purchaseByVendorBreakdown = new Map<string, {
      vendor_id: string; vendor_name: string;
      groupMid: Map<string, number>; // 키: `${group}||${mid_code}` → 금액
    }>();
    if (!scopedDeptId) {
      const poItems = await prisma.purchaseOrderItem.findMany({
        where: {
          purchase_order: { deleted_at: null, status: { not: 'CANCELLED' }, ordered_at: { gte: selStart, lte: selEnd } },
          ...(expenseScope ? { item: { expense_scope: expenseScope } } : {}),
        },
        select: {
          item_id: true,
          line_amount: true,
          item: { select: { category: true, item_code: true, name: true } },
          purchase_order: { select: { vendor_id: true, vendor: { select: { name: true } } } },
        },
      });
      for (const it of poItems as any[]) {
        // 비품 제외
        if (!isConsumable(it.item?.category)) continue;
        const amt = Number(it.line_amount || 0);
        totalPurchased += amt;
        const m = majorOf(it.item?.category);
        purchaseByMajor.set(m, (purchaseByMajor.get(m) ?? 0) + amt);
        // 그룹×중분류 집계
        const g = groupOf(it.item?.category);
        const midCode = it.item?.category ?? '기타';
        const midKey = `${g}||${midCode}`;
        purchaseByGroupMid.set(midKey, (purchaseByGroupMid.get(midKey) ?? 0) + amt);
        const vid = it.purchase_order?.vendor_id ?? '';
        const vname = it.purchase_order?.vendor?.name ?? '미정';
        const cur = purchaseByVendor.get(vid) ?? { vendor_id: vid, vendor_name: vname, amount: 0 };
        cur.amount += amt;
        purchaseByVendor.set(vid, cur);
        // 거래처×그룹×중분류 집계 (아코디언용)
        const vb = purchaseByVendorBreakdown.get(vid) ?? {
          vendor_id: vid, vendor_name: vname, groupMid: new Map<string, number>(),
        };
        vb.groupMid.set(midKey, (vb.groupMid.get(midKey) ?? 0) + amt);
        purchaseByVendorBreakdown.set(vid, vb);
        // 품목별 매입 집계
        const iid = it.item_id;
        if (iid) {
          const cit = purchaseByItem.get(iid) ?? {
            item_id: iid, item_code: it.item?.item_code ?? '', item_name: it.item?.name ?? '',
            major: m, amount: 0,
          };
          cit.amount += amt;
          purchaseByItem.set(iid, cit);
        }
      }
    }

    const monthly_trend: { month: string; amount: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const dd = new Date(selY, selM - 1 - i, 1);
      const k = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}`;
      monthly_trend.push({ month: k, amount: Math.round(monthly.get(k) ?? 0) });
    }

    // 월별 매입 추이 (12개월, PO ordered_at 기준)
    const purchaseWindowStart = new Date(selY, selM - 1 - 11, 1, 0, 0, 0, 0);
    const monthlyPurchaseAgg = new Map<string, number>();
    if (!scopedDeptId) {
      const poRows: any[] = await prisma.purchaseOrderItem.findMany({
        where: {
          purchase_order: { deleted_at: null, status: { not: 'CANCELLED' }, ordered_at: { gte: purchaseWindowStart, lte: selEnd } },
          item: {
            // 비품 제외 (소모품 통계)
            category: { not: { startsWith: 'EQUIP' } },
            ...(expenseScope ? { expense_scope: expenseScope } : {}),
          },
        },
        select: {
          line_amount: true,
          purchase_order: { select: { ordered_at: true } },
        },
      });
      for (const r of poRows) {
        const d = new Date(r.purchase_order?.ordered_at);
        if (isNaN(d.getTime())) continue;
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        monthlyPurchaseAgg.set(k, (monthlyPurchaseAgg.get(k) ?? 0) + Number(r.line_amount || 0));
      }
    }
    const monthly_purchase: { month: string; amount: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const dd = new Date(selY, selM - 1 - i, 1);
      const k = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}`;
      monthly_purchase.push({ month: k, amount: Math.round(monthlyPurchaseAgg.get(k) ?? 0) });
    }

    // 그 달 일평균 점유 환자수 — ward_room_boards 일자별 기록 평균.
    // 「물품 통계의 환자 수는 항상 평균」 원칙 (1인당 재료비 등 계산용).
    const boards: any[] = await (prisma as any).wardRoomBoard.findMany({
      where: {
        board_date: { gte: selStart, lte: selEnd },
        deleted_at: null,
        ...(scopedDeptId && { department_id: scopedDeptId }),
      },
      select: { board_date: true, patient_id: true },
    });
    const occByDay = new Map<string, number>();
    for (const b of boards) {
      if (!b.patient_id) continue;
      const d = b.board_date.toISOString().slice(0, 10);
      occByDay.set(d, (occByDay.get(d) ?? 0) + 1);
    }
    let avgPatientCount = 0;
    let recordedDays = occByDay.size;
    if (recordedDays > 0) {
      let sum = 0;
      for (const v of occByDay.values()) sum += v;
      avgPatientCount = Number((sum / recordedDays).toFixed(1));
    }

    // 재고 금액 — FIFO 현재 보유 평가액 (운영보고서가 아닌 시점 평가)
    // 비품(EQUIP) 제외 — 소모품 통계
    const invRows: any[] = await (prisma as any).$queryRawUnsafe(`
      SELECT COALESCE(SUM(l.remaining_qty * l.unit_cost), 0) AS amt
      FROM inventory_lots l
      LEFT JOIN inventory_locations loc ON loc.id = l.location_id
      LEFT JOIN items i ON i.id = l.item_id
      WHERE l.deleted_at IS NULL AND l.remaining_qty > 0
        AND COALESCE(loc.is_asset_tracked, 1) = 1
        AND (i.category NOT LIKE 'EQUIP%' OR i.category IS NULL)
        ${expenseScope ? `AND i.expense_scope = '${expenseScope}'` : ''}
    `);
    const inventoryAmount = Math.round(Number(invRows?.[0]?.amt ?? 0));

    // 재고 회전율 (이번 달 기준) = 이번 달 사용금액 ÷ 현재 재고 금액
    //  · 정확한 회전율은 평균재고 기준이지만 시점별 재고 history 없으니 현재값 사용 (실무 표준 단순 회전율)
    const turnoverRate = inventoryAmount > 0 ? Number((totalIssued / inventoryAmount).toFixed(2)) : 0;

    res.json({
      year_month: selKey,
      total_issued: Math.round(totalIssued),
      total_purchased: Math.round(totalPurchased),
      patient_count_avg: avgPatientCount,
      patient_count_recorded_days: recordedDays,
      inventory_amount: inventoryAmount,
      turnover_rate: turnoverRate,
      // 비용구분별 분해 — 의료/일반 1인당 사용액 카드용
      expense_scope_breakdown: {
        PATIENT_DIRECT: Math.round(issueByScope.PATIENT_DIRECT),
        OPS_INDIRECT: Math.round(issueByScope.OPS_INDIRECT),
      },
      by_department: Array.from(deptAgg.values())
        .map((x) => ({ ...x, amount: Math.round(x.amount) }))
        .sort((a, b) => b.amount - a.amount),
      by_item: Array.from(itemAgg.values())
        .map((x) => ({ ...x, amount: Math.round(x.amount) }))
        .sort((a, b) => b.amount - a.amount),
      // 분류별 매입/불출 (개요 탭 도넛용)
      purchase_by_major: Array.from(purchaseByMajor.entries())
        .map(([label, amount]) => ({ label, amount: Math.round(amount) }))
        .filter((x) => x.amount > 0)
        .sort((a, b) => b.amount - a.amount),
      issue_by_major: Array.from(issueByMajor.entries())
        .map(([label, amount]) => ({ label, amount: Math.round(amount) }))
        .filter((x) => x.amount > 0)
        .sort((a, b) => b.amount - a.amount),
      // 업체별 매입 (현재월) — 도넛용. vendor-summary 와 별개로 cost/statistics 한 번 호출로 끝나게.
      purchase_by_vendor: Array.from(purchaseByVendor.values())
        .map((x) => ({ ...x, amount: Math.round(x.amount) }))
        .filter((x) => x.amount > 0)
        .sort((a, b) => b.amount - a.amount),
      // 거래처×그룹×중분류 — 「업체별 매입」 아코디언용
      // 각 거래처의 그룹별 소계 + 중분류 목록. 거래처 안 비중은 클라이언트에서 계산.
      purchase_vendor_breakdown: Array.from(purchaseByVendorBreakdown.values())
        .map((vb) => {
          const groups = buildGroupedRows(vb.groupMid, GROUP_ORDER, midLabelOf);
          const total = groups.reduce((s, g) => s + g.total, 0);
          return {
            vendor_id: vb.vendor_id,
            vendor_name: vb.vendor_name,
            total: Math.round(total),
            groups,
          };
        })
        .filter((v) => v.total > 0)
        .sort((a, b) => b.total - a.total),
      // 부서×그룹×중분류 — 「부서별 불출」 아코디언용
      issue_dept_breakdown: Array.from(issueByDeptBreakdown.values())
        .map((db) => {
          const groups = buildGroupedRows(db.groupMid, GROUP_ORDER, midLabelOf);
          const total = groups.reduce((s, g) => s + g.total, 0);
          return {
            dept_id: db.dept_id,
            dept_name: db.dept_name,
            total: Math.round(total),
            groups,
          };
        })
        .filter((d) => d.total > 0)
        .sort((a, b) => b.total - a.total),
      // 품목별 매입 (현재월) — 상세 분석 서브탭용
      purchase_by_item: Array.from(purchaseByItem.values())
        .map((x) => ({ ...x, amount: Math.round(x.amount) }))
        .filter((x) => x.amount > 0)
        .sort((a, b) => b.amount - a.amount),
      // 그룹×중분류 — 「분류별 매입/불출」 표용 (신청 유형 그룹 5개 + 그 안의 중분류)
      purchase_groups: buildGroupedRows(purchaseByGroupMid, GROUP_ORDER, midLabelOf),
      issue_groups: buildGroupedRows(issueByGroupMid, GROUP_ORDER, midLabelOf),
      monthly_trend,          // 12개월 사용 (불출원가)
      monthly_purchase,       // 12개월 매입 (PO ordered_at)
    });
  } catch (e) {
    console.error('[cost/statistics] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// POST /cost/materialize (월마감/cost_statistics 적재) 제거됨.
// 비용은 모든 화면에서 불출 실제원가(stock_out_lot_allocations.line_amount) 즉석계산으로 통일.

// GET /api/cost/price-changes
// 가격 변동 요약 — 각 (item_id, vendor_id) 페어에 대해 최근 priceHistory 2건을 비교해
// 가격이 바뀐 항목만 반환. 인상률/인하률 / 절대 변동액 같이.
//
// 쿼리 파라미터:
//   months: 분석 기간 (기본 6) — 그 안에 effective_from 이 있는 entry 중에서만 비교
//   limit: 반환 개수 (기본 30)
//
// 응답:
//   { changes: [{ item_id, item_code, name, vendor_name, prev_price, current_price, change_amount, change_pct, effective_from }] }
router.get('/price-changes', requirePermission('STATS_VIEW', 'PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const months = Math.max(1, Math.min(36, parseInt(String(req.query.months ?? '6'), 10) || 6));
    const limit = Math.max(5, Math.min(200, parseInt(String(req.query.limit ?? '30'), 10) || 30));

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);

    // 모든 priceHistory 가져오기 (최근 effective_from 으로 정렬). 쿼리량이 많을 수 있으니 cutoff 로 1차 필터.
    const rows = await prisma.priceHistory.findMany({
      where: { effective_from: { gte: cutoff } },
      orderBy: { effective_from: 'desc' },
      include: {
        item: { select: { id: true, item_code: true, name: true, deleted_at: true } },
        vendor: { select: { id: true, name: true } },
      },
    });

    // (item_id, vendor_id) 별로 그룹핑 — 최근 2건의 가격 비교
    const groups = new Map<string, any[]>();
    for (const r of rows) {
      if (!r.item || r.item.deleted_at) continue;
      const key = `${r.item_id}::${r.vendor_id}`;
      const arr = groups.get(key) ?? [];
      arr.push(r);
      groups.set(key, arr);
    }

    const changes: any[] = [];
    for (const arr of groups.values()) {
      if (arr.length < 2) continue;
      // arr 는 desc 정렬 → arr[0] = 현재, arr[1] = 직전
      const cur = arr[0];
      const prev = arr[1];
      const curPrice = Number(cur.price);
      const prevPrice = Number(prev.price);
      if (curPrice === prevPrice) continue;
      const diff = curPrice - prevPrice;
      const pct = prevPrice > 0 ? (diff / prevPrice) * 100 : 0;
      changes.push({
        item_id: cur.item_id,
        item_code: cur.item?.item_code ?? '',
        name: cur.item?.name ?? '',
        vendor_id: cur.vendor_id,
        vendor_name: cur.vendor?.name ?? '',
        prev_price: prevPrice,
        current_price: curPrice,
        change_amount: Math.round(diff),
        change_pct: Math.round(pct * 10) / 10,
        effective_from: cur.effective_from,
      });
    }

    // 절대 변동률 큰 순 — 인상/인하 모두 함께 (음수 인하 포함)
    changes.sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));

    const top = changes.slice(0, limit);
    const upCount = changes.filter(c => c.change_amount > 0).length;
    const downCount = changes.filter(c => c.change_amount < 0).length;

    res.json({
      months,
      total_changes: changes.length,
      up_count: upCount,
      down_count: downCount,
      changes: top,
    });
  } catch (e) {
    console.error('[GET /cost/price-changes] error:', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/vendor-summary', requirePermission('STATS_VIEW', 'PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    await ensureFifoTables(prisma as any);

    const dateFrom = req.query.date_from ? new Date(String(req.query.date_from)) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const dateTo = req.query.date_to ? new Date(String(req.query.date_to)) : new Date();
    if (Number.isNaN(dateFrom.getTime()) || Number.isNaN(dateTo.getTime()) || dateFrom > dateTo) {
      return res.status(400).json({ error: 'date_from/date_to 값이 올바르지 않습니다.' });
    }

    let departmentId = '';
    try {
      departmentId = resolveRequestedDept(req, req.query.department_id);
    } catch {
      return res.status(403).json({ error: '해당 부서 데이터에 접근할 수 없습니다.' });
    }

    const rawScope = req.query.expense_scope ? String(req.query.expense_scope).toUpperCase() : '';
    const expenseScope: 'PATIENT_DIRECT' | 'OPS_INDIRECT' | '' =
      rawScope === 'PATIENT_DIRECT' || rawScope === 'OPS_INDIRECT' ? rawScope : '';

    const dayMs = 24 * 60 * 60 * 1000;
    const days = Math.floor((dateTo.getTime() - dateFrom.getTime()) / dayMs) + 1;
    const prevTo = new Date(dateFrom.getTime() - dayMs);
    const prevFrom = new Date(prevTo.getTime() - (days - 1) * dayMs);
    const endOf = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T23:59:59.999Z`);
    const pct = (curr: number, prev: number) => (prev === 0 ? (curr === 0 ? 0 : 100) : Number((((curr - prev) / prev) * 100).toFixed(1)));

    const orderWhereCurrent: any = {
      deleted_at: null,
      status: { not: 'CANCELLED' },
      ordered_at: { gte: dateFrom, lte: endOf(dateTo) },
    };
    const orderWherePrev: any = {
      deleted_at: null,
      status: { not: 'CANCELLED' },
      ordered_at: { gte: prevFrom, lte: endOf(prevTo) },
    };

    if (departmentId) {
      orderWhereCurrent.receipts = { some: { stock_in_items: { some: { location: { department_id: departmentId } } } } };
      orderWherePrev.receipts = { some: { stock_in_items: { some: { location: { department_id: departmentId } } } } };
    }

    // expense_scope 필터가 있으면 PO 라인 단위로 집계 (해당 비용구분 품목만 합산).
    // 없으면 기존 방식 그대로 PO total_amount 합.
    const includePo: any = { vendor: true };
    if (expenseScope) {
      includePo.items = { where: { item: { expense_scope: expenseScope } }, select: { line_amount: true } };
    }
    const [ordersCurrent, ordersPrev] = await Promise.all([
      prisma.purchaseOrder.findMany({ where: orderWhereCurrent, include: includePo }),
      prisma.purchaseOrder.findMany({ where: orderWherePrev, include: includePo }),
    ]);
    const poAmount = (po: any): number => {
      if (expenseScope) return (po.items ?? []).reduce((s: number, it: any) => s + Number(it.line_amount || 0), 0);
      return Number(po.total_amount || 0);
    };

    const mapCurrent = new Map<string, { vendor_id: string; vendor_name: string; amount: number }>();
    for (const po of ordersCurrent as any[]) {
      const amt = poAmount(po);
      if (expenseScope && amt === 0) continue;
      const key = po.vendor_id;
      const cur = mapCurrent.get(key) ?? { vendor_id: key, vendor_name: po.vendor?.name ?? '미정', amount: 0 };
      cur.amount += amt;
      mapCurrent.set(key, cur);
    }

    const mapPrev = new Map<string, number>();
    for (const po of ordersPrev as any[]) {
      const amt = poAmount(po);
      if (expenseScope && amt === 0) continue;
      mapPrev.set(po.vendor_id, (mapPrev.get(po.vendor_id) ?? 0) + amt);
    }

    const vendorNames = new Map<string, string>();
    for (const po of [...(ordersCurrent as any[]), ...(ordersPrev as any[])]) {
      vendorNames.set(po.vendor_id, po.vendor?.name ?? '미정');
    }

    const vendorIds = new Set<string>([...Array.from(mapCurrent.keys()), ...Array.from(mapPrev.keys())]);
    const vendor_order_amounts = Array.from(vendorIds)
      .map((vendorId) => {
        const current = Number(mapCurrent.get(vendorId)?.amount ?? 0);
        const previous = Number(mapPrev.get(vendorId) ?? 0);
        return {
          vendor_id: vendorId,
          vendor_name: vendorNames.get(vendorId) ?? '미정',
          order_amount_current: Number(current.toFixed(2)),
          order_amount_previous: Number(previous.toFixed(2)),
          diff_pct: pct(current, previous),
        };
      })
      .sort((a, b) => b.order_amount_current - a.order_amount_current);

    const deptCond = departmentId ? ` AND loc.department_id = ?` : '';
    const scopeCond = expenseScope ? ` AND i.expense_scope = ?` : '';
    const lotParams: any[] = [];
    if (departmentId) lotParams.push(departmentId);
    if (expenseScope) lotParams.push(expenseScope);
    // 재고자산 정책: is_asset_tracked = 1 인 위치만 자산 합산 (총무구매 창고 외 부서 보관함은 출고 시점 비용 인식이라 자산 미포함)
    const lots = await (prisma as any).$queryRawUnsafe(`
      SELECT COALESCE(l.vendor_id, i.default_vendor_id) AS vendor_id,
             COALESCE(v.name, dv.name, '미정') AS vendor_name,
             SUM(l.remaining_qty * l.unit_cost) AS inventory_amount_fifo,
             COUNT(*) AS lot_count,
             COUNT(DISTINCT l.item_id) AS item_count
      FROM inventory_lots l
      LEFT JOIN inventory_locations loc ON loc.id = l.location_id
      LEFT JOIN items i ON i.id = l.item_id
      LEFT JOIN vendors v ON v.id = l.vendor_id
      LEFT JOIN vendors dv ON dv.id = i.default_vendor_id
      WHERE l.deleted_at IS NULL
        AND l.remaining_qty > 0
        AND COALESCE(loc.is_asset_tracked, 1) = 1
        ${deptCond}
        ${scopeCond}
      GROUP BY COALESCE(l.vendor_id, i.default_vendor_id), COALESCE(v.name, dv.name, '미정')
      ORDER BY inventory_amount_fifo DESC
    `, ...lotParams);

    const vendor_inventory_amounts = (lots || []).map((r: any) => ({
      vendor_id: r.vendor_id ?? '',
      vendor_name: r.vendor_name ?? '미정',
      inventory_amount_fifo: Number(Number(r.inventory_amount_fifo ?? 0).toFixed(2)),
      lot_count: Number(r.lot_count ?? 0),
      item_count: Number(r.item_count ?? 0),
    }));

    const order_total_current = ordersCurrent.reduce((s: number, po: any) => s + poAmount(po), 0);
    const order_total_previous = ordersPrev.reduce((s: number, po: any) => s + poAmount(po), 0);
    const inventory_total_fifo = vendor_inventory_amounts.reduce((s: number, r: any) => s + Number(r.inventory_amount_fifo || 0), 0);

    // 거래처 집중도 — 상위 N개 거래처가 전체 매입에서 차지하는 비중
    const concentration = (() => {
      if (order_total_current <= 0 || vendor_order_amounts.length === 0) return null;
      const sorted = [...vendor_order_amounts].sort((a, b) => b.order_amount_current - a.order_amount_current);
      const sumTopN = (n: number) => sorted.slice(0, n).reduce((s, v) => s + v.order_amount_current, 0);
      return {
        top1_pct: Number(((sumTopN(1) / order_total_current) * 100).toFixed(1)),
        top3_pct: Number(((sumTopN(3) / order_total_current) * 100).toFixed(1)),
        top5_pct: Number(((sumTopN(5) / order_total_current) * 100).toFixed(1)),
        total_vendors: vendor_order_amounts.filter(v => v.order_amount_current > 0).length,
      };
    })();

    res.json({
      period: {
        current: { date_from: dateFrom.toISOString().slice(0, 10), date_to: dateTo.toISOString().slice(0, 10) },
        previous: { date_from: prevFrom.toISOString().slice(0, 10), date_to: prevTo.toISOString().slice(0, 10) },
      },
      vendor_order_amounts,
      vendor_inventory_amounts,
      concentration,
      totals: {
        order_total_current: Number(order_total_current.toFixed(2)),
        order_total_previous: Number(order_total_previous.toFixed(2)),
        order_diff_pct: pct(order_total_current, order_total_previous),
        inventory_total_fifo: Number(inventory_total_fifo.toFixed(2)),
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── GET /cost/vendor-detail ─────────────────────────────────────────────
// 거래처별 분석 — 그 거래처에서 산 분류별 매입 표.
//   year_month, vendor_id 필수. expense_scope 필터 옵션.
router.get('/vendor-detail', requirePermission('STATS_VIEW', 'PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const vendorId = String(req.query.vendor_id || '');
    if (!vendorId) return res.status(400).json({ error: 'vendor_id 필수' });

    const ymRaw = String(req.query.year_month || '');
    const now = new Date();
    let selY = now.getFullYear();
    let selM = now.getMonth() + 1;
    if (/^\d{4}-\d{2}$/.test(ymRaw)) {
      const [yy, mm] = ymRaw.split('-');
      selY = Number(yy); selM = Number(mm);
    }
    const selStart = new Date(selY, selM - 1, 1, 0, 0, 0, 0);
    const selEnd = new Date(selY, selM, 0, 23, 59, 59, 999);

    const rawScope = req.query.expense_scope ? String(req.query.expense_scope).toUpperCase() : '';
    const expenseScope: 'PATIENT_DIRECT' | 'OPS_INDIRECT' | '' =
      rawScope === 'PATIENT_DIRECT' || rawScope === 'OPS_INDIRECT' ? rawScope : '';

    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true, name: true } });
    if (!vendor) return res.status(404).json({ error: '거래처를 찾을 수 없습니다.' });

    // 카테고리 → 대분류 라벨 (cost/statistics 와 동일)
    const MAJOR_LABEL: Record<string, string> = {
      MED: '의료소모품', INFECT: '감염보호구', PAT: '위생·생활케어',
      DIAPER: '기저귀', FAC: '청소·주방', OFF: '사무용품', FOOD: '식음료', EQUIP: '비품',
    };
    const majorOf = (cat?: string | null): string => {
      if (!cat) return '기타';
      const prefix = String(cat).split('_')[0];
      return MAJOR_LABEL[prefix] ?? '기타';
    };

    const poItems = await prisma.purchaseOrderItem.findMany({
      where: {
        purchase_order: {
          deleted_at: null, status: { not: 'CANCELLED' },
          ordered_at: { gte: selStart, lte: selEnd },
          vendor_id: vendorId,
        },
        item: {
          // 비품 제외 (소모품 통계)
          category: { not: { startsWith: 'EQUIP' } },
          ...(expenseScope ? { expense_scope: expenseScope } : {}),
        },
      },
      select: { line_amount: true, item: { select: { category: true } } },
    });

    let totalAmount = 0;
    const byMajor = new Map<string, number>();
    for (const it of poItems as any[]) {
      const amt = Number(it.line_amount || 0);
      totalAmount += amt;
      const m = majorOf(it.item?.category);
      byMajor.set(m, (byMajor.get(m) ?? 0) + amt);
    }

    const by_major = Array.from(byMajor.entries())
      .map(([label, amount]) => ({ label, amount: Math.round(amount) }))
      .filter((x) => x.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    res.json({
      vendor: { id: vendor.id, name: vendor.name },
      year_month: `${selY}-${String(selM).padStart(2, '0')}`,
      expense_scope: expenseScope,
      total_amount: Math.round(totalAmount),
      line_count: poItems.length,
      by_major,
    });
  } catch (e) {
    console.error('[cost/vendor-detail] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── GET /cost/operational-report ─────────────────────────────────────────
// 운영 계획용 표 형태 보고서.
//  - category_trend: 대분류 카테고리 × 최근 12개월 불출금액 매트릭스 (MoM·YoY 포함)
//  - dept_category : 부서 × 대분류 카테고리 매트릭스 (선택월 기준)
// expense_scope 필터 적용 (전체/환자직접비/운영간접비).
router.get('/operational-report', requirePermission('STATS_VIEW'), async (req: AuthRequest, res) => {
  try {
    const ymRaw = String(req.query.year_month || '');
    const now = new Date();
    let selY = now.getFullYear();
    let selM = now.getMonth() + 1;
    if (/^\d{4}-\d{2}$/.test(ymRaw)) {
      const [yy, mm] = ymRaw.split('-');
      selY = Number(yy); selM = Number(mm);
    } else if (req.query.year && req.query.month) {
      selY = Number(req.query.year); selM = Number(req.query.month);
    }
    const selKey = `${selY}-${String(selM).padStart(2, '0')}`;

    const rawScope = req.query.expense_scope ? String(req.query.expense_scope).toUpperCase() : '';
    const expenseScope: 'PATIENT_DIRECT' | 'OPS_INDIRECT' | '' =
      rawScope === 'PATIENT_DIRECT' || rawScope === 'OPS_INDIRECT' ? rawScope : '';

    // 부서 권한 — STATS_VIEW_ALL/SYSTEM_ADMIN 만 전체. 외엔 본인 부서.
    const perms = req.user?.permissions ?? [];
    const canAllStats = perms.includes('SYSTEM_ADMIN') || perms.includes('STATS_VIEW_ALL');
    const requestedDept = req.query.department_id ? String(req.query.department_id) : '';
    let scopedDeptId = '';
    if (canAllStats) {
      scopedDeptId = requestedDept;
    } else {
      const ownDept = req.user?.department_id ?? '';
      if (requestedDept && ownDept && requestedDept !== ownDept) {
        return res.status(403).json({ error: '해당 부서 데이터에 접근할 수 없습니다.' });
      }
      scopedDeptId = ownDept;
    }

    // 최근 12개월(선택월 포함) 키 목록과 그 시작·끝 시각
    const months: string[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(selY, selM - 1 - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    // 전년 동월 (YoY) 기준 키
    const yoyKey = `${selY - 1}-${String(selM).padStart(2, '0')}`;
    const windowStart = new Date(selY - 1, selM - 1, 1, 0, 0, 0, 0); // YoY 비교용으로 13개월 로드
    const selEnd = new Date(selY, selM, 0, 23, 59, 59, 999);

    const stockOuts = await prisma.stockOut.findMany({
      where: {
        deleted_at: null,
        is_test: false,
        status: { in: ACTIVE_STOCK_OUT_STATUSES as any },
        issued_at: { gte: windowStart, lte: selEnd },
        ...(scopedDeptId && { department_id: scopedDeptId }),
      },
      include: {
        department: { select: { id: true, name: true } },
        items: { select: { id: true, item_id: true, item: { select: { category: true, expense_scope: true } } } },
        lot_allocations: { select: { stock_out_item_id: true, line_amount: true } },
      },
    });

    // 카테고리 prefix → 대분류 매핑 (서버 측, shared 와 동기화)
    const MAJOR_LABEL: Record<string, string> = {
      MED: '의료소모품',
      INFECT: '감염보호구',
      PAT: '위생·생활케어',
      DIAPER: '기저귀',
      FAC: '청소·주방',
      OFF: '사무용품',
      FOOD: '식음료',
      EQUIP: '비품',
    };
    const MAJOR_ORDER = ['MED', 'INFECT', 'PAT', 'DIAPER', 'FAC', 'OFF', 'FOOD', 'EQUIP', '기타'];
    const majorOf = (cat: string | null | undefined): string => {
      if (!cat) return '기타';
      const prefix = String(cat).split('_')[0];
      return MAJOR_LABEL[prefix] ? prefix : '기타';
    };

    // 비용구분 라벨 (사용자 친화적 명칭)
    const SCOPE_LABEL: Record<string, string> = {
      PATIENT_DIRECT: '의료소모품',
      OPS_INDIRECT: '일반소모품',
    };

    // 집계: { major: { ym: amount } } + { dept_id: { major: amount, scope: amount } } (선택월만)
    const trend = new Map<string, Map<string, number>>();   // major → ym → amount
    const deptAgg = new Map<string, { dept_id: string; dept_name: string; by_major: Map<string, number>; by_scope: Map<string, number>; total: number }>();
    const majorsSeen = new Set<string>();

    for (const so of stockOuts as any[]) {
      const d = new Date(so.issued_at);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!months.includes(ym) && ym !== yoyKey) continue;

      const siMap = new Map<string, any>();
      for (const si of so.items ?? []) siMap.set(si.id, si);

      for (const a of so.lot_allocations ?? []) {
        const si = siMap.get(a.stock_out_item_id);
        // 비품(EQUIP) 제외 — 소모품 통계
        if (String(si?.item?.category ?? '').startsWith('EQUIP')) continue;
        const lineScope = si?.item?.expense_scope ?? 'PATIENT_DIRECT';
        if (expenseScope && lineScope !== expenseScope) continue;
        const amt = Number(a.line_amount ?? 0);
        if (amt <= 0) continue; // 금액 0 인 라인은 통계에 무의미
        const m = majorOf(si?.item?.category);
        majorsSeen.add(m);

        // 추이 매트릭스 (카테고리별)
        if (months.includes(ym) || ym === yoyKey) {
          const mm = trend.get(m) ?? new Map();
          mm.set(ym, (mm.get(ym) ?? 0) + amt);
          trend.set(m, mm);
        }

        // 부서별 집계 (선택월만)
        if (ym === selKey) {
          const dep = deptAgg.get(so.department_id) ?? {
            dept_id: so.department_id, dept_name: so.department?.name ?? '미상',
            by_major: new Map<string, number>(), by_scope: new Map<string, number>(), total: 0,
          };
          dep.by_major.set(m, (dep.by_major.get(m) ?? 0) + amt);
          dep.by_scope.set(lineScope, (dep.by_scope.get(lineScope) ?? 0) + amt);
          dep.total += amt;
          deptAgg.set(so.department_id, dep);
        }
      }
    }

    // 대분류 정렬: 정의된 순서 우선, 미정의 카테고리는 뒤에
    const sortedMajors = Array.from(majorsSeen).sort((a, b) => {
      const ia = MAJOR_ORDER.indexOf(a); const ib = MAJOR_ORDER.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

    // category_trend rows
    const prevYm = months[months.length - 2]; // 전월
    const category_trend_rows = sortedMajors.map((m) => {
      const mm = trend.get(m) ?? new Map<string, number>();
      const values = months.map((k) => Math.round(mm.get(k) ?? 0));
      const cur = mm.get(selKey) ?? 0;
      const prev = mm.get(prevYm) ?? 0;
      const yoy = mm.get(yoyKey) ?? 0;
      const pct = (curV: number, prevV: number) => prevV === 0 ? (curV === 0 ? 0 : null) : Number((((curV - prevV) / prevV) * 100).toFixed(1));
      return {
        major: m,
        major_label: MAJOR_LABEL[m] ?? m,
        values,                          // 12개월 금액
        current: Math.round(cur),
        mom_pct: pct(cur, prev),         // 전월비
        yoy_pct: pct(cur, yoy),          // 전년동월비
      };
    });

    // 월별 합계 (열 합계)
    const monthly_totals = months.map((k) =>
      sortedMajors.reduce((s, m) => s + (trend.get(m)?.get(k) ?? 0), 0)
    ).map((v) => Math.round(v));

    // 부서별 환자 일평균 — 선택월 ward_room_boards 부서·일자별 점유 평균
    const selStart = new Date(selY, selM - 1, 1, 0, 0, 0, 0);
    const selEndMonth = new Date(selY, selM, 0, 23, 59, 59, 999);
    const deptBoards: any[] = await (prisma as any).wardRoomBoard.findMany({
      where: { board_date: { gte: selStart, lte: selEndMonth }, deleted_at: null },
      select: { board_date: true, department_id: true, patient_id: true },
    });
    const deptDayCounts = new Map<string, Map<string, number>>(); // dept_id → date → count
    for (const b of deptBoards) {
      if (!b.patient_id) continue;
      const d = b.board_date.toISOString().slice(0, 10);
      const inner = deptDayCounts.get(b.department_id) ?? new Map<string, number>();
      inner.set(d, (inner.get(d) ?? 0) + 1);
      deptDayCounts.set(b.department_id, inner);
    }
    const deptAvgPatient = new Map<string, number>();
    for (const [deptId, dayMap] of deptDayCounts.entries()) {
      const days = dayMap.size;
      if (days === 0) continue;
      let sum = 0;
      for (const v of dayMap.values()) sum += v;
      deptAvgPatient.set(deptId, Number((sum / days).toFixed(1)));
    }

    // dept rows (선택월) — 카테고리·비용구분 + 환자 일평균 + 1인당 사용액
    const dept_rows = Array.from(deptAgg.values())
      .map((d) => {
        const avgP = deptAvgPatient.get(d.dept_id) ?? 0;
        const total = Math.round(d.total);
        return {
          dept_id: d.dept_id, dept_name: d.dept_name,
          by_major: Object.fromEntries(sortedMajors.map((m) => [m, Math.round(d.by_major.get(m) ?? 0)])),
          by_scope: {
            PATIENT_DIRECT: Math.round(d.by_scope.get('PATIENT_DIRECT') ?? 0),
            OPS_INDIRECT: Math.round(d.by_scope.get('OPS_INDIRECT') ?? 0),
          },
          total,
          avg_patient_count: avgP,
          per_patient_amount: avgP > 0 ? Math.round(total / avgP) : 0,
        };
      })
      .sort((a, b) => b.total - a.total);
    const dept_major_totals = Object.fromEntries(
      sortedMajors.map((m) => [m, Math.round(dept_rows.reduce((s, r) => s + (r.by_major[m] ?? 0), 0))])
    );
    const dept_scope_totals = {
      PATIENT_DIRECT: Math.round(dept_rows.reduce((s, r) => s + r.by_scope.PATIENT_DIRECT, 0)),
      OPS_INDIRECT: Math.round(dept_rows.reduce((s, r) => s + r.by_scope.OPS_INDIRECT, 0)),
    };
    const dept_grand_total = dept_rows.reduce((s, r) => s + r.total, 0);

    // 비용구분 컬럼 정의 — 탭에 따라 보여줄 컬럼 결정
    const scope_columns = expenseScope
      ? [{ key: expenseScope, label: SCOPE_LABEL[expenseScope] }]
      : [
          { key: 'PATIENT_DIRECT', label: SCOPE_LABEL.PATIENT_DIRECT },
          { key: 'OPS_INDIRECT', label: SCOPE_LABEL.OPS_INDIRECT },
        ];

    res.json({
      year_month: selKey,
      expense_scope: expenseScope,
      months,
      category_trend: {
        rows: category_trend_rows,
        monthly_totals,
      },
      // 부서×비용구분 매트릭스 (사용자 친화적 큰 분류 — 의료/일반 2컬럼 + 환자 일평균 + 1인당 사용액)
      dept_scope: {
        columns: scope_columns,
        rows: dept_rows.map((r) => ({
          dept_id: r.dept_id,
          dept_name: r.dept_name,
          by_scope: r.by_scope,
          total: r.total,
          avg_patient_count: r.avg_patient_count,
          per_patient_amount: r.per_patient_amount,
        })),
        column_totals: dept_scope_totals,
        grand_total: dept_grand_total,
      },
      // 부서×카테고리 (legacy/세부 분석 필요 시) — 화면엔 기본 미노출
      dept_category: {
        majors: sortedMajors.map((m) => ({ key: m, label: MAJOR_LABEL[m] ?? m })),
        rows: dept_rows,
        major_totals: dept_major_totals,
        grand_total: dept_grand_total,
      },
    });
  } catch (e) {
    console.error('[cost/operational-report] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── GET /cost/diaper-pnl ────────────────────────────────────────────────
// 기저귀 통계 — 환자 사용 분포 + 구매비용(DIAPER 카테고리, 이지메트 포함) + 소각료.
// 회수금액(청구·수납)은 EMR 에서 별도 관리 → 본 시스템에선 산출 안 함.
// 구매비용 = 해당 월 PO ordered_at, items.category LIKE 'DIAPER%' 라인 합.
// 소각료  = incineration_monthly_overrides.final_amount_override 합. 없으면 entries × 단가.
router.get('/diaper-pnl', requirePermission('STATS_VIEW', 'PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const ymRaw = String(req.query.year_month || '');
    const now = new Date();
    let selY = now.getFullYear();
    let selM = now.getMonth() + 1;
    if (/^\d{4}-\d{2}$/.test(ymRaw)) {
      const [yy, mm] = ymRaw.split('-');
      selY = Number(yy); selM = Number(mm);
    } else if (req.query.year && req.query.month) {
      selY = Number(req.query.year); selM = Number(req.query.month);
    }
    const selKey = `${selY}-${String(selM).padStart(2, '0')}`;
    const selStart = new Date(selY, selM - 1, 1, 0, 0, 0, 0);
    const selEnd = new Date(selY, selM, 0, 23, 59, 59, 999);

    // 1) 환자 분포 — ward_room_boards 일자별 평균 (그 달 동안의 평균 재원 분포)
    //    같은 환자가 매일 한 cell 차지하므로 일별 카운트의 평균이 정확한 「평균 재원」 임.
    const boards: any[] = await (prisma as any).wardRoomBoard.findMany({
      where: { board_date: { gte: selStart, lte: selEnd }, deleted_at: null },
      select: { board_date: true, diaper_state: true, patient_id: true },
    });
    const dayMap = new Map<string, { in_house: number; personal: number; none: number }>();
    for (const b of boards) {
      const d = b.board_date.toISOString().slice(0, 10);
      const e = dayMap.get(d) ?? { in_house: 0, personal: 0, none: 0 };
      if (['IN_HOUSE', 'CIRCLE'].includes(b.diaper_state)) e.in_house++;
      else if (['PERSONAL', 'TRIANGLE'].includes(b.diaper_state)) e.personal++;
      else if (b.patient_id) e.none++; // 점유는 했으나 기저귀 미사용
      dayMap.set(d, e);
    }
    const recordedDays = dayMap.size;
    const sums = { in_house: 0, personal: 0, none: 0 };
    for (const e of dayMap.values()) {
      sums.in_house += e.in_house;
      sums.personal += e.personal;
      sums.none += e.none;
    }
    const avgRound = (n: number) => recordedDays > 0 ? Number((n / recordedDays).toFixed(1)) : 0;
    const patients = {
      in_house: avgRound(sums.in_house),  // 일평균 원내 사용 환자수
      personal: avgRound(sums.personal),  // 일평균 본인 지참
      none: avgRound(sums.none),          // 일평균 점유는 했으나 기저귀 미사용
      using: 0,
      recorded_days: recordedDays,
    };
    patients.using = Number((patients.in_house + patients.personal).toFixed(1));

    // 2) 구매비용 — 해당 월 PO ordered_at, items.category LIKE 'DIAPER%'
    const poItems = await prisma.purchaseOrderItem.findMany({
      where: {
        purchase_order: { deleted_at: null, status: { not: 'CANCELLED' }, ordered_at: { gte: selStart, lte: selEnd } },
        item: { category: { startsWith: 'DIAPER' } },
      },
      select: { line_amount: true, item: { select: { item_code: true, name: true } }, ordered_qty: true, unit_price: true },
    });
    const purchase = poItems.reduce((s, it) => s + Number(it.line_amount || 0), 0);
    const purchaseBreakdown = new Map<string, { item_code: string; name: string; qty: number; amount: number }>();
    for (const it of poItems as any[]) {
      const k = it.item?.item_code ?? '?';
      const cur = purchaseBreakdown.get(k) ?? { item_code: k, name: it.item?.name ?? '', qty: 0, amount: 0 };
      cur.qty += Number(it.ordered_qty || 0);
      cur.amount += Number(it.line_amount || 0);
      purchaseBreakdown.set(k, cur);
    }

    // 2-2) 출고 수량 — 해당 월 기저귀 카테고리 출고 (이지메트는 분류 표시만, 환자 1인당 사용량 계산에선 제외)
    const diaperOuts: any[] = await (prisma as any).stockOutLotAllocation.findMany({
      where: {
        stock_out: {
          deleted_at: null, is_test: false,
          status: { in: ACTIVE_STOCK_OUT_STATUSES as any },
          issued_at: { gte: selStart, lte: selEnd },
        },
        stock_out_item: { item: { category: { startsWith: 'DIAPER' } } },
      },
      select: {
        issued_qty: true,
        stock_out: { select: { issued_at: true } },
        stock_out_item: { select: { item_id: true, item: { select: { item_code: true, name: true, issue_uom: true } } } },
      },
    });

    // 2-3) 「팩당 장수」 시점별 이력 — 환산용
    //  - 출고 라인 시점(issued_at) 에 effective 인 units_per_pack 적용
    //  - history 없는 품목은 환산 0 (UI에서 입력 필요 표시)
    const itemIds = Array.from(new Set(diaperOuts.map((a: any) => a.stock_out_item?.item_id).filter(Boolean)));
    const histories: any[] = itemIds.length ? await (prisma as any).itemUnitsPerPack.findMany({
      where: { item_id: { in: itemIds } },
      orderBy: { effective_from: 'desc' },
    }) : [];
    const historyByItem = new Map<string, any[]>();
    for (const h of histories) {
      const arr = historyByItem.get(h.item_id) ?? [];
      arr.push(h);
      historyByItem.set(h.item_id, arr);
    }
    // 시점 t 에 effective 인 units_per_pack 찾기.
    //  - 1순위: effective_from <= t 중 가장 최근 (정상 시점별 매칭)
    //  - 2순위(fallback): t 가 모든 history 의 effective_from 보다 이전이면
    //                    가장 오래된 history 값 사용. = "첫 입력한 값은 그 이전 출고에도 적용"
    //                    사용자가 처음 팩당 장수를 등록할 때 과거 출고도 자동 환산되도록.
    //                    이후 시점에 새 값을 추가하면 그 시점 이후 출고만 새 값 적용 (정확).
    const effectiveUnits = (itemId: string, t: Date): number => {
      const arr = historyByItem.get(itemId);
      if (!arr || arr.length === 0) return 0; // 아직 입력 안 됨
      // arr 는 effective_from desc 정렬됨
      for (const h of arr) {
        if (new Date(h.effective_from).getTime() <= t.getTime()) return Number(h.units_per_pack);
      }
      // t 가 모든 history 의 effective_from 보다 이전 → 가장 오래된 값 fallback
      return Number(arr[arr.length - 1].units_per_pack);
    };
    // 「현재」 유효값 — UI 표 inline 편집 초기값
    const currentUnits = (itemId: string): number | null => {
      const arr = historyByItem.get(itemId);
      if (!arr || arr.length === 0) return null;
      return Number(arr[0].units_per_pack);
    };

    type UsageEntry = {
      item_id: string; item_code: string; name: string; uom: string;
      qty_pack: number;   // 사용 팩수 합
      qty_units: number;  // 환산 장수 합 (시점별 정확)
      current_units_per_pack: number | null;  // 현재 effective 값 (없으면 null)
      has_history: boolean;
    };
    const usageByItem = new Map<string, UsageEntry>();
    let usageTotalUnitsExclMat = 0; // 이지메트 제외 환산 장수 합 (환자 1인당 계산용)
    let allItemsHaveUnits = true;   // 한 품목이라도 history 없으면 false

    for (const a of diaperOuts) {
      const si = a.stock_out_item;
      const it = si?.item;
      const itemId = si?.item_id;
      if (!itemId) continue;
      const issuedAt = new Date(a.stock_out?.issued_at);
      const code = it?.item_code ?? '?';
      const cur = usageByItem.get(code) ?? {
        item_id: itemId, item_code: code, name: it?.name ?? '', uom: it?.issue_uom ?? '',
        qty_pack: 0, qty_units: 0,
        current_units_per_pack: currentUnits(itemId),
        has_history: historyByItem.has(itemId),
      };
      const qPack = Number(a.issued_qty || 0);
      cur.qty_pack += qPack;
      const upp = effectiveUnits(itemId, issuedAt);
      cur.qty_units += qPack * upp;
      usageByItem.set(code, cur);

      const isMat = (it?.name ?? '').includes('이지메트');
      if (!cur.has_history) allItemsHaveUnits = false;
      if (!isMat) usageTotalUnitsExclMat += qPack * upp;
    }

    const patientDays = patients.in_house * patients.recorded_days;
    // 1인당 1일 환산 장수 (이지메트 제외, 모든 품목에 팩당 장수가 입력되어 있을 때만 유효)
    const usagePerPatientDay = (patientDays > 0 && allItemsHaveUnits)
      ? Number((usageTotalUnitsExclMat / patientDays).toFixed(2))
      : 0;

    // 3) 소각료 — overrides 우선, 없으면 entries × 단가 (단가 기본 800원/kg — patients.ts INCINERATION_UNIT_PRICE 참고)
    const INCINERATION_UNIT_PRICE = 800;
    const overrideRows: any[] = await (prisma as any).$queryRawUnsafe(`
      SELECT COALESCE(SUM(final_amount_override), 0) AS amt FROM incineration_monthly_overrides WHERE year_month = ?
    `, selKey);
    const overrideSum = Number(overrideRows?.[0]?.amt ?? 0);
    let incineration = overrideSum;
    let incinerationKg = 0;
    const kgRows: any[] = await (prisma as any).$queryRawUnsafe(`
      SELECT COALESCE(SUM(weight_kg), 0) AS kg FROM incineration_entries
      WHERE strftime('%Y-%m', entry_date) = ?
    `, selKey);
    incinerationKg = Number(kgRows?.[0]?.kg ?? 0);
    if (incineration === 0 && incinerationKg > 0) {
      incineration = incinerationKg * INCINERATION_UNIT_PRICE;
    }

    // 4) 1인당 (원내 평균 기준)
    const denom = patients.in_house > 0 ? patients.in_house : 0;
    const perInHouse = {
      purchase: denom > 0 ? Math.round(purchase / denom) : 0,
    };

    res.json({
      year_month: selKey,
      patients,
      cost: {
        purchase: Math.round(purchase),
        incineration: Math.round(incineration),
        incineration_kg: Number(incinerationKg.toFixed(2)),
        total: Math.round(purchase + incineration),
        purchase_breakdown: Array.from(purchaseBreakdown.values())
          .sort((a, b) => b.amount - a.amount)
          .map((x) => ({ ...x, qty: Number(x.qty.toFixed(2)), amount: Math.round(x.amount) })),
      },
      // 사용량 — 시점별 「팩당 장수」 환산.
      // qty_pack: 사용 팩수, qty_units: 환산 장수 (history 적용), per_patient_day: 1인당 1일 환산 장수
      // current_units_per_pack 이 null = 아직 팩당 장수 입력 안 됨 → UI 에서 입력 유도
      usage: {
        total_units_excl_mat: Math.round(usageTotalUnitsExclMat),  // 이지메트 제외 환산 장수 합
        per_patient_day: usagePerPatientDay,                       // 1인당 1일 환산 장수
        patient_days: Number(patientDays.toFixed(1)),
        all_items_have_units: allItemsHaveUnits,                   // 한 품목이라도 미입력이면 false
        by_item: Array.from(usageByItem.values())
          .sort((a, b) => b.qty_pack - a.qty_pack)
          .map((x) => ({
            item_id: x.item_id,
            item_code: x.item_code,
            name: x.name,
            uom: x.uom,
            qty_pack: Number(x.qty_pack.toFixed(2)),
            qty_units: Math.round(x.qty_units),
            current_units_per_pack: x.current_units_per_pack,
            has_history: x.has_history,
            is_mat: x.name.includes('이지메트'),
          })),
      },
      per_in_house: perInHouse,
    });
  } catch (e) {
    console.error('[cost/diaper-pnl] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── PATCH /cost/item-units-per-pack ──────────────────────────────────────
// 품목 「팩당 장수」 새 이력 행 추가 (effective_from 부터 새 값 적용).
// 같은 item_id + same effective_from 이면 기존 행 갱신 (중복 방지).
// 권한: PURCHASE_MANAGE 또는 BASIC_MANAGE (마스터 관리 권한자)
router.patch('/item-units-per-pack', requirePermission('PURCHASE_MANAGE', 'BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const itemId = String(req.body?.item_id || '');
    const units = Number(req.body?.units_per_pack);
    const effFromRaw = req.body?.effective_from;
    const note = String(req.body?.note ?? '');
    if (!itemId) return res.status(400).json({ error: 'item_id 필수' });
    if (!Number.isFinite(units) || units < 1 || !Number.isInteger(units)) {
      return res.status(400).json({ error: '팩당 장수는 1 이상 정수' });
    }
    const effectiveFrom = effFromRaw ? new Date(String(effFromRaw)) : new Date();
    if (Number.isNaN(effectiveFrom.getTime())) {
      return res.status(400).json({ error: 'effective_from 형식 오류 (YYYY-MM-DD 또는 ISO)' });
    }

    // 같은 (item_id, effective_from) 행 존재 시 갱신, 없으면 신규
    const dayStart = new Date(effectiveFrom.getFullYear(), effectiveFrom.getMonth(), effectiveFrom.getDate(), 0, 0, 0, 0);
    const dayEnd = new Date(effectiveFrom.getFullYear(), effectiveFrom.getMonth(), effectiveFrom.getDate(), 23, 59, 59, 999);
    const existing: any = await (prisma as any).itemUnitsPerPack.findFirst({
      where: { item_id: itemId, effective_from: { gte: dayStart, lte: dayEnd } },
      orderBy: { effective_from: 'desc' },
    });

    let row: any;
    if (existing) {
      row = await (prisma as any).itemUnitsPerPack.update({
        where: { id: existing.id },
        data: { units_per_pack: units, note, created_by: req.user!.id },
      });
    } else {
      row = await (prisma as any).itemUnitsPerPack.create({
        data: {
          item_id: itemId,
          units_per_pack: units,
          effective_from: effectiveFrom,
          note,
          created_by: req.user!.id,
        },
      });
    }

    const item = await prisma.item.findUnique({ where: { id: itemId }, select: { item_code: true, name: true } });
    await audit({
      actor_user_id: req.user!.id,
      action: existing ? 'UPDATE' : 'CREATE',
      entity_type: 'item_units_per_pack',
      entity_id: row.id,
      reason: `${item?.item_code ?? ''} ${item?.name ?? ''} 팩당 장수 → ${units}장 (적용일 ${effectiveFrom.toISOString().slice(0, 10)})`,
    });
    res.json({ ok: true, id: row.id, item_id: itemId, units_per_pack: units, effective_from: effectiveFrom });
  } catch (e) {
    console.error('[cost/item-units-per-pack] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── GET /cost/item-units-per-pack/:itemId/history ────────────────────────
// 해당 품목의 「팩당 장수」 변경 이력 조회 (최신순)
router.get('/item-units-per-pack/:itemId/history', requirePermission('STATS_VIEW', 'PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const rows = await (prisma as any).itemUnitsPerPack.findMany({
      where: { item_id: req.params.itemId },
      orderBy: { effective_from: 'desc' },
      select: { id: true, units_per_pack: true, effective_from: true, note: true, created_at: true },
    });
    res.json({ history: rows });
  } catch (e) {
    console.error('[cost/item-units-per-pack/history] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;
