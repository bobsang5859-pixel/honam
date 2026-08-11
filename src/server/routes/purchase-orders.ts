import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, resolveDeptScope, isCustomMenuUser, AuthRequest } from '../middleware/auth';
import { audit, generateNo, nextSeq } from '../utils/audit';
import { getFonts } from '../services/pdf';

const LOGO_PATH = path.join(__dirname, '..', '..', '..', 'assets', 'logo.png');
const HOSPITAL_PHONE = '062-717-6018 / 010-9259-5859';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('purchase-orders', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'));
const SCHEDULED_REQUEST_TYPES = new Set([
  'CONSUMABLE_MEDICAL',
  'CONSUMABLE_REGULAR',
  'CONSUMABLE_OFFICE',
  'DIAPER',
  'NIGHT_SNACK',
]);
const PO_ELIGIBLE_REQUEST_TYPES = [
  'CONSUMABLE_MEDICAL',
  'CONSUMABLE_REGULAR',
  'CONSUMABLE_OFFICE',
  'DIAPER',
  'NIGHT_SNACK',
  'ADHOC',
  'EQUIPMENT',
];
const PO_ACTIVE_STATUSES = ['SENT', 'PARTIAL_RECEIVED'] as const;
const PO_COMPLETED_STATUSES = ['CLOSED', 'CANCELLED'] as const;

function isScopedToSelfDepartment(req: AuthRequest): boolean {
  return isCustomMenuUser(req.user) && !resolveDeptScope(req).is_admin;
}

type ScheduleLite = {
  request_type: string;
  open_from: Date;
  open_to: Date;
  period_label: string;
};

// Source type detection:
// 1) Prefer explicit ward-request linkage (sources)
// 2) Fallback to note prefix for backward compatibility
function inferSourceType(note: string, sourceTypes?: string[]): string {
  if (Array.isArray(sourceTypes) && sourceTypes.length > 0) {
    const unique = Array.from(new Set(sourceTypes.filter(Boolean)));
    if (unique.length === 1) return unique[0];
  }
  if (note.includes('[AUTO]')) {
    if (note.includes('기저귀') || note.toUpperCase().includes('DIAPER')) return 'DIAPER';
    if (note.includes('야간당직') || note.toUpperCase().includes('NIGHT_SNACK')) return 'NIGHT_SNACK';
    if (note.includes('비정기') || note.toUpperCase().includes('ADHOC')) return 'ADHOC';
    return 'CONSUMABLE_REGULAR';
  }
  return 'MANUAL';
}

function formatMonthLabel(dateLike: Date | string | null | undefined): string {
  const d = dateLike ? new Date(dateLike) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function normalizeDate(value: Date | string | null | undefined): Date | null {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d;
}

function computeSchedulePeriodMeta(
  po: any,
  schedulesByType: Map<string, ScheduleLite[]>
): {
  schedule_period_label?: string;
  schedule_period_start?: string;
  schedule_period_matched: boolean;
  has_mixed_period_labels?: boolean;
} {
  const candidates: { label: string; start: Date; matched: boolean }[] = [];
  for (const src of po.sources ?? []) {
    const wrType = src?.ward_request?.request_type ? String(src.ward_request.request_type) : '';
    const periodStart = normalizeDate(src?.ward_request?.period_start);
    const orderedAt = normalizeDate(po?.ordered_at);
    if (!wrType && !periodStart) continue;

    let label = '';
    let matched = false;
    if (wrType && periodStart && SCHEDULED_REQUEST_TYPES.has(wrType)) {
      const schedules = schedulesByType.get(wrType) ?? [];
      const matchedSchedule = schedules.find((s) => s.open_from <= periodStart && periodStart <= s.open_to);
      if (matchedSchedule) {
        label = matchedSchedule.period_label || formatMonthLabel(periodStart);
        matched = true;
      }
    }
    if (!label) {
      label = periodStart ? formatMonthLabel(periodStart) : formatMonthLabel(orderedAt);
    }
    const start = periodStart ?? orderedAt;
    if (!label || !start) continue;
    candidates.push({ label, start, matched });
  }

  if (candidates.length === 0) {
    const fallbackStart = normalizeDate(po?.ordered_at);
    return {
      schedule_period_label: formatMonthLabel(fallbackStart),
      schedule_period_start: fallbackStart ? fallbackStart.toISOString() : undefined,
      schedule_period_matched: false,
      has_mixed_period_labels: false,
    };
  }

  candidates.sort((a, b) => a.start.getTime() - b.start.getTime());
  const labels = new Set(candidates.map((c) => c.label));
  const representative = candidates[0];

  return {
    schedule_period_label: representative.label,
    schedule_period_start: representative.start.toISOString(),
    schedule_period_matched: representative.matched,
    has_mixed_period_labels: labels.size > 1,
  };
}

// ─── 라인 단위 미발주 잔량 계산 ──────────────────────────────
// approved_qty (최신 ApprovalAction) - 이미 PO 발주된 수량 - 이미 STOCK_OUT 된 수량
// item_id null (자유입력 품목) 라인은 PO 대상 아니므로 제외
// 단위 정합성 — 모든 수량을 issue_uom(팩) 기준으로 환산해 비교.
//   approved_qty: 팩 (부서 신청·승인 단위)
//   ordered_qty:  박스 (PO 발주 단위) → × pack_size 로 팩 환산
//   issued_qty:   팩 (불출 단위)
async function computeUnfulfilledByItem(wrIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (wrIds.length === 0) return result;

  // 1) 승인 라인 (각 신청의 최신 ApprovalAction)
  const wrs = await prisma.wardRequest.findMany({
    where: { id: { in: wrIds }, deleted_at: null },
    include: {
      approval_actions: {
        orderBy: { created_at: 'desc' },
        take: 1,
        include: { items: true },
      },
    },
  });
  for (const wr of wrs) {
    const action = wr.approval_actions[0];
    if (!action) continue;
    for (const aai of action.items) {
      if (!aai.item_id) continue; // 자유입력 라인 제외
      const qty = Number(aai.approved_qty);
      if (qty <= 0) continue;
      result.set(aai.item_id, (result.get(aai.item_id) ?? 0) + qty);
    }
  }

  // 결과에 들어간 item 들의 pack_size 미리 조회
  const itemIds = Array.from(result.keys());
  const itemPackSize = new Map<string, number>();
  if (itemIds.length > 0) {
    const itemRows = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, pack_size: true },
    });
    for (const it of itemRows) {
      itemPackSize.set(it.id, Math.max(1, Number((it as any).pack_size ?? 1)));
    }
  }

  // 2) 이미 PO 발주된 수량 차감 (취소/삭제된 PO 제외) — 박스 → 팩 환산
  const sources = await prisma.purchaseOrderSource.findMany({
    where: { ward_request_id: { in: wrIds } },
    include: {
      po: {
        select: {
          status: true,
          deleted_at: true,
          po_items: { select: { item_id: true, ordered_qty: true } },
        },
      },
    },
  });
  // 같은 PO 가 여러 wrIds 와 연결되어 있을 수 있어 중복 차감 방지
  const countedPoIds = new Set<string>();
  for (const src of sources) {
    if (!src.po || src.po.deleted_at || src.po.status === 'CANCELLED') continue;
    if (countedPoIds.has(src.po_id)) continue;
    countedPoIds.add(src.po_id);
    for (const it of src.po.po_items) {
      if (!result.has(it.item_id)) continue;
      const ps = itemPackSize.get(it.item_id) ?? 1;
      result.set(it.item_id, (result.get(it.item_id) ?? 0) - Number(it.ordered_qty) * ps);
    }
  }

  // 3) 이미 STOCK_OUT 된 수량 차감 (REVERSED/삭제 제외) — 이미 팩 단위
  const stockOuts = await prisma.stockOut.findMany({
    where: {
      ward_request_id: { in: wrIds },
      deleted_at: null,
      status: { not: 'REVERSED' },
    },
    include: { items: { select: { item_id: true, issued_qty: true } } },
  });
  for (const so of stockOuts) {
    for (const it of so.items) {
      if (!result.has(it.item_id)) continue;
      result.set(it.item_id, (result.get(it.item_id) ?? 0) - Number(it.issued_qty));
    }
  }

  // 음수/0 정리
  for (const [k, v] of result) {
    if (v <= 0) result.delete(k);
  }
  return result;
}

router.get('/', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req, res) => {
  try {
    const { status, source_type, status_scope } = req.query;
    const statusVal = status ? String(status) : '';
    const statusScope = String(status_scope ?? 'ALL').toUpperCase();
    const statusWhere =
      statusVal && statusVal !== 'ALL'
        ? { status: statusVal }
        : statusScope === 'ACTIVE'
          ? { status: { in: [...PO_ACTIVE_STATUSES] } }
          : statusScope === 'COMPLETED'
            ? { status: { in: [...PO_COMPLETED_STATUSES] } }
            : statusScope === 'DRAFT'
              ? { status: 'DRAFT' }
              : {};
    const deptScope = resolveDeptScope(req as AuthRequest);
    const scopedDeptId = isScopedToSelfDepartment(req as AuthRequest) ? (deptScope.department_id ?? '') : '';
    const pos = await prisma.purchaseOrder.findMany({
      where: {
        deleted_at: null,
        ...statusWhere,
        ...(scopedDeptId ? { sources: { some: { ward_request: { department_id: scopedDeptId } } } } : {}),
      },
      include: {
        vendor: true,
        creator: true,
        po_items: { include: { item: { select: { category: true, item_code: true } } }, orderBy: { item: { item_code: 'asc' } } },
        sources: { include: { ward_request: { select: { request_type: true, period_start: true } } } } as any,
      },
      orderBy: { ordered_at: 'desc' },
    });
    // prisma client 가 manual_period_label 컬럼을 모를 수 있어 raw SQL 로 별도 조회
    const manualLabels = new Map<string, string | null>();
    if (pos.length > 0) {
      const ids = pos.map((p: any) => p.id);
      const placeholders = ids.map(() => '?').join(',');
      const rows: any[] = await prisma.$queryRawUnsafe(
        `SELECT id, manual_period_label FROM purchase_orders WHERE id IN (${placeholders})`,
        ...ids,
      );
      for (const r of rows) manualLabels.set(String(r.id), r.manual_period_label ?? null);
    }
    const neededTypes = Array.from(
      new Set(
        pos
          .flatMap((po: any) => (po.sources ?? []).map((s: any) => s?.ward_request?.request_type))
          .filter((t: any) => typeof t === 'string' && SCHEDULED_REQUEST_TYPES.has(t))
      )
    );
    const schedules =
      neededTypes.length > 0
        ? await prisma.requestSchedule.findMany({
            where: { request_type: { in: neededTypes as string[] } },
            orderBy: { open_from: 'asc' },
          })
        : [];
    const schedulesByType = new Map<string, ScheduleLite[]>();
    for (const s of schedules) {
      if (!schedulesByType.has(s.request_type)) schedulesByType.set(s.request_type, []);
      schedulesByType.get(s.request_type)!.push({
        request_type: s.request_type,
        open_from: s.open_from,
        open_to: s.open_to,
        period_label: s.period_label,
      });
    }

    const mapped = pos.map((po: any) => {
      // 대분류 분포
      const breakdown: Record<string, number> = {};
      for (const it of po.po_items ?? []) {
        const cat = String(it.item?.category ?? '').toUpperCase();
        let major = 'GENERAL';
        if (cat.startsWith('EQUIP_')) major = 'EQUIPMENT';
        else if (cat.startsWith('OFF_')) major = 'OFFICE';
        else if (cat.startsWith('MED_') || cat.startsWith('INFECT_')) major = 'MEDICAL';
        else if (cat.startsWith('DIAPER')) major = 'DIAPER';
        breakdown[major] = (breakdown[major] ?? 0) + 1;
      }
      const periodMeta = computeSchedulePeriodMeta(po, schedulesByType);
      const manualLabel = String(manualLabels.get(String(po.id)) ?? '').trim();
      return {
        id: po.id,
        po_no: po.po_no,
        vendor_id: po.vendor_id,
        vendor_name: po.vendor?.name,
        creator_name: po.creator?.display_name,
        status: po.status,
        ordered_at: po.ordered_at,
        expected_at: po.expected_at,
        total_amount: Number(po.total_amount),
        note: po.note,
        item_count: po.po_items.length,
        category_breakdown: breakdown,
        source_type: inferSourceType(
          po.note ?? '',
          (po.sources ?? []).map((s: any) => s.ward_request?.request_type).filter(Boolean)
        ),
        ...periodMeta,
        // 수동 라벨이 있으면 schedule_period_label 을 그것으로 덮어씀
        schedule_period_label: manualLabel || periodMeta.schedule_period_label,
        manual_period_label: manualLabel || null,
      };
    });

    const filtered = source_type
      ? mapped.filter((po: any) => po.source_type === String(source_type))
      : mapped;

    res.json(filtered);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── 발주 대기 큐 ─────────────────────────────────────────────
// 승인된 신청(WardRequest.status APPROVED|PARTIAL_APPROVED) 중 아직 발주되지 않은 라인을
// 거래처(default_vendor_id) × 회차(schedule_period_label) 로 그룹핑해 반환.
// EQUIPMENT 의 DISPOSAL/REPAIR 는 발주 대상이 아니라 제외.
// PATCH /api/purchase-orders/:id/period-label — 주차 라벨 수동 지정
router.patch('/:id/period-label', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.id);
    const raw = req.body?.period_label;
    const label = raw == null ? null : String(raw).trim() || null;

    const po = await prisma.purchaseOrder.findUnique({ where: { id } });
    if (!po || po.deleted_at) return res.status(404).json({ error: '발주를 찾을 수 없습니다.' });

    // prisma client 가 새 컬럼을 모를 수 있어 raw SQL 사용
    const beforeRow: any[] = await prisma.$queryRawUnsafe(
      `SELECT manual_period_label FROM purchase_orders WHERE id = ?`, id,
    );
    const before = beforeRow?.[0]?.manual_period_label ?? null;
    await prisma.$executeRawUnsafe(
      `UPDATE purchase_orders SET manual_period_label = ? WHERE id = ?`, label, id,
    );

    await audit({
      actor_user_id: req.user!.id,
      action: 'PATCH',
      entity_type: 'purchase_orders',
      entity_id: id,
      before: { manual_period_label: before },
      after: { manual_period_label: label },
      reason: '주차 라벨 수동 지정',
    });

    res.json({ ok: true, manual_period_label: label });
  } catch (e: any) {
    console.error('[PATCH /purchase-orders/:id/period-label]', e);
    res.status(500).json({ error: e?.message ?? '서버 오류' });
  }
});

router.get('/pending', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req, res) => {
  try {
    const sourceType = String(req.query.source_type ?? '').toUpperCase();
    const wrTypeFilter =
      sourceType && PO_ELIGIBLE_REQUEST_TYPES.includes(sourceType)
        ? { request_type: sourceType }
        : { request_type: { in: PO_ELIGIBLE_REQUEST_TYPES } };

    // 1) 승인 완료된 신청 + 최신 ApprovalAction
    const wrs = await prisma.wardRequest.findMany({
      where: {
        deleted_at: null,
        status: { in: ['APPROVED', 'PARTIAL_APPROVED'] },
        ...wrTypeFilter,
        // EQUIPMENT 중 DISPOSAL/REPAIR 는 발주 대상 아님 — 메모리 필터로 한 번 더 거름
      },
      include: {
        department: { select: { id: true, name: true } },
        approval_actions: {
          orderBy: { created_at: 'desc' },
          take: 1,
          include: { items: true },
        },
      },
      orderBy: { period_start: 'asc' },
    });
    const eligibleWrs = wrs.filter((wr: any) => {
      if (wr.request_type === 'EQUIPMENT') {
        const ert = String(wr.equipment_request_type ?? '');
        if (ert === 'DISPOSAL' || ert === 'REPAIR') return false;
      }
      return wr.approval_actions.length > 0;
    });
    if (eligibleWrs.length === 0) {
      return res.json({ buckets: [], unassigned_vendor_lines_count: 0, as_of: new Date().toISOString() });
    }

    const wrIds = eligibleWrs.map((wr: any) => wr.id);

    // 2) 이미 PO 발주된 (ward_request_id, item_id) → 합계
    const sources = await prisma.purchaseOrderSource.findMany({
      where: { ward_request_id: { in: wrIds } },
      include: {
        po: {
          select: {
            id: true,
            status: true,
            deleted_at: true,
            po_items: { select: { item_id: true, ordered_qty: true } },
          },
        },
      },
    });
    // 같은 PO 가 여러 wr 에 묶여 있을 때 한 번만 카운트하기 위해 (po_id, item_id) 풀로 차감
    const poItemPool = new Map<string, number>(); // key: item_id → totalOrderedQty (across all relevant POs)
    const countedPoIds = new Set<string>();
    for (const src of sources) {
      if (!src.po || src.po.deleted_at || src.po.status === 'CANCELLED') continue;
      if (countedPoIds.has(src.po_id)) continue;
      countedPoIds.add(src.po_id);
      for (const it of src.po.po_items) {
        poItemPool.set(it.item_id, (poItemPool.get(it.item_id) ?? 0) + Number(it.ordered_qty));
      }
    }

    // 3) 이미 STOCK_OUT 처리된 (ward_request_id, item_id) → 합계
    const stockOuts = await prisma.stockOut.findMany({
      where: {
        ward_request_id: { in: wrIds },
        deleted_at: null,
        status: { not: 'REVERSED' },
      },
      include: { items: { select: { item_id: true, issued_qty: true } } },
    });
    const stockOutPool = new Map<string, number>();
    for (const so of stockOuts) {
      for (const it of so.items) {
        stockOutPool.set(it.item_id, (stockOutPool.get(it.item_id) ?? 0) + Number(it.issued_qty));
      }
    }

    // 4) 라인 단위 미발주 잔량 계산 (item_id 풀 기준 — 묶음 PO 의 ordered_qty 가 어느 wr 몫인지 분배 정보가 없어 풀 단위 차감)
    const itemApprovedTotal = new Map<string, number>(); // item_id → Σ approved_qty (across eligibleWrs)
    type LineSeed = {
      item_id: string;
      approval_action_item_id: string;
      ward_request_id: string;
      approved_qty: number;
    };
    const lineSeeds: LineSeed[] = [];
    for (const wr of eligibleWrs as any[]) {
      const action = wr.approval_actions[0];
      for (const aai of action.items) {
        if (!aai.item_id) continue; // 자유입력 라인은 스킵
        const qty = Number(aai.approved_qty);
        if (qty <= 0) continue;
        itemApprovedTotal.set(aai.item_id, (itemApprovedTotal.get(aai.item_id) ?? 0) + qty);
        lineSeeds.push({
          item_id: aai.item_id,
          approval_action_item_id: aai.id,
          ward_request_id: wr.id,
          approved_qty: qty,
        });
      }
    }

    // 단위 환산용 pack_size 먼저 조회 — itemById 풀 조회는 5) 단계에서 별도로 함
    const approvedItemIds = Array.from(itemApprovedTotal.keys());
    const packSizeRows = approvedItemIds.length > 0
      ? await prisma.item.findMany({
          where: { id: { in: approvedItemIds } },
          select: { id: true, pack_size: true },
        })
      : [];
    const packSizeById = new Map<string, number>(
      packSizeRows.map((r: any) => [r.id, Math.max(1, Number(r.pack_size ?? 1))])
    );

    // item_id 단위 unfulfilled 잔량 (풀) — 모두 issue_uom(팩) 기준으로 환산해 비교
    //   approved_qty: 부서 신청·승인 수량 = 팩
    //   poItemPool:  PO ordered_qty = 박스 (purchase_uom). 팩으로 환산하려면 × pack_size
    //   stockOutPool: 불출 issued_qty = 팩
    // (이전엔 박스를 그대로 빼서 단위 섞임 → PO 만들어도 잔량이 안 사라지는 버그가 있었음)
    const itemUnfulfilledPool = new Map<string, number>();
    for (const [itemId, approved] of itemApprovedTotal) {
      const packSize = packSizeById.get(itemId) ?? 1;
      const poInPacks = (poItemPool.get(itemId) ?? 0) * packSize;
      const stockOutInPacks = stockOutPool.get(itemId) ?? 0;
      const remaining = approved - poInPacks - stockOutInPacks;
      if (remaining > 1e-6) itemUnfulfilledPool.set(itemId, remaining);
    }

    // 라인을 풀에서 비례 분배 (각 wr 라인의 approved_qty 비율로 unfulfilled 분배)
    const wrLineUnfulfilled = new Map<string, number>(); // key: `${wr_id}:${item_id}` → unfulfilled
    for (const seed of lineSeeds) {
      const totalApproved = itemApprovedTotal.get(seed.item_id) ?? 0;
      const pool = itemUnfulfilledPool.get(seed.item_id) ?? 0;
      if (totalApproved <= 0 || pool <= 0) continue;
      const share = pool * (seed.approved_qty / totalApproved);
      if (share > 1e-6) {
        wrLineUnfulfilled.set(`${seed.ward_request_id}:${seed.item_id}`, share);
      }
    }

    if (wrLineUnfulfilled.size === 0) {
      return res.json({ buckets: [], unassigned_vendor_lines_count: 0, as_of: new Date().toISOString() });
    }

    // 5) 품목 마스터 (default_vendor + 최근 단가)
    const itemIds = Array.from(itemUnfulfilledPool.keys());
    const itemRows = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      include: { default_vendor: { select: { id: true, name: true } } },
    });
    const itemById = new Map(itemRows.map((it: any) => [it.id, it]));

    const priceRows = await prisma.priceHistory.findMany({
      where: { item_id: { in: itemIds }, effective_to: null },
      orderBy: { effective_from: 'desc' },
    });
    const lastPriceByItem = new Map<string, number>();
    for (const p of priceRows) {
      if (!lastPriceByItem.has(p.item_id)) lastPriceByItem.set(p.item_id, Number(p.price));
    }

    // 6) 회차 라벨 매칭용 RequestSchedule 로딩
    const neededTypes = Array.from(
      new Set(eligibleWrs.map((wr: any) => wr.request_type).filter((t: string) => SCHEDULED_REQUEST_TYPES.has(t)))
    );
    const schedules =
      neededTypes.length > 0
        ? await prisma.requestSchedule.findMany({
            where: { request_type: { in: neededTypes as string[] } },
            orderBy: { open_from: 'asc' },
          })
        : [];
    const schedulesByType = new Map<string, ScheduleLite[]>();
    for (const s of schedules) {
      if (!schedulesByType.has(s.request_type)) schedulesByType.set(s.request_type, []);
      schedulesByType.get(s.request_type)!.push({
        request_type: s.request_type,
        open_from: s.open_from,
        open_to: s.open_to,
        period_label: s.period_label,
      });
    }
    const labelForWr = (wr: any): { label: string; start: Date; matched: boolean } => {
      const periodStart: Date = wr.period_start ?? wr.submitted_at ?? new Date();
      const t = wr.request_type;
      if (SCHEDULED_REQUEST_TYPES.has(t)) {
        const list = schedulesByType.get(t) ?? [];
        const matched = list.find((s) => s.open_from <= periodStart && periodStart <= s.open_to);
        if (matched) return { label: matched.period_label || formatMonthLabel(periodStart), start: periodStart, matched: true };
      }
      return { label: formatMonthLabel(periodStart) || '미분류', start: periodStart, matched: false };
    };

    // 7) bucket 구성 (vendor_id × period_label × request_type)
    type Bucket = {
      vendor_id: string | null;
      vendor_name: string;
      schedule_period_label: string;
      schedule_period_start: string;
      schedule_period_matched: boolean;
      request_type: string;
      ward_requests: any[];
      lines: any[];
      _wrSet: Set<string>;
      _lineKey: Map<string, any>;
    };
    const buckets = new Map<string, Bucket>();

    for (const seed of lineSeeds) {
      const key = `${seed.ward_request_id}:${seed.item_id}`;
      const unfulfilled = wrLineUnfulfilled.get(key);
      if (!unfulfilled || unfulfilled <= 0) continue;

      const item = itemById.get(seed.item_id);
      if (!item) continue;
      const wr = eligibleWrs.find((w: any) => w.id === seed.ward_request_id);
      if (!wr) continue;

      const periodInfo = labelForWr(wr);
      const vendorId = item.default_vendor_id ?? null;
      const vendorName = item.default_vendor?.name ?? '거래처 미지정';

      const bucketKey = `${vendorId ?? '__UNASSIGNED__'}::${periodInfo.label}::${wr.request_type}`;
      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = {
          vendor_id: vendorId,
          vendor_name: vendorName,
          schedule_period_label: periodInfo.label,
          schedule_period_start: periodInfo.start.toISOString(),
          schedule_period_matched: periodInfo.matched,
          request_type: wr.request_type,
          ward_requests: [],
          lines: [],
          _wrSet: new Set<string>(),
          _lineKey: new Map<string, any>(),
        };
        buckets.set(bucketKey, bucket);
      }

      if (!bucket._wrSet.has(wr.id)) {
        bucket._wrSet.add(wr.id);
        bucket.ward_requests.push({
          id: wr.id,
          request_no: wr.request_no,
          department_id: wr.department_id,
          department_name: wr.department?.name ?? '',
          period_start: wr.period_start,
          submitted_at: wr.submitted_at,
          is_test: Boolean(wr.is_test),
        });
      }

      // 같은 bucket 안에 같은 item_id 라인이 여러 wr에서 나올 수 있음 → 합산
      let line = bucket._lineKey.get(seed.item_id);
      const totalApproved = itemApprovedTotal.get(seed.item_id) ?? seed.approved_qty;
      const totalPo = poItemPool.get(seed.item_id) ?? 0;
      const totalStockOut = stockOutPool.get(seed.item_id) ?? 0;
      if (!line) {
        line = {
          item_id: item.id,
          item_code: item.item_code,
          item_name: item.name,
          purchase_uom: item.purchase_uom ?? item.uom,
          pack_size: Number(item.pack_size ?? 1),
          approved_qty: 0,
          po_qty: 0,
          stock_out_qty: 0,
          unfulfilled_qty: 0,
          default_vendor_id: item.default_vendor_id ?? null,
          default_vendor_name: item.default_vendor?.name ?? null,
          last_unit_price: lastPriceByItem.get(item.id) ?? 0,
          approval_action_item_ids: [] as string[],
          source_ward_request_ids: [] as string[],
          // 같은 item_id 의 풀 메타 (정보용)
          _pool_total_approved: totalApproved,
          _pool_total_po: totalPo,
          _pool_total_stockout: totalStockOut,
        };
        bucket._lineKey.set(seed.item_id, line);
        bucket.lines.push(line);
      }
      line.approved_qty += seed.approved_qty;
      line.unfulfilled_qty += unfulfilled;
      line.approval_action_item_ids.push(seed.approval_action_item_id);
      if (!line.source_ward_request_ids.includes(wr.id)) {
        line.source_ward_request_ids.push(wr.id);
      }
    }

    // 풀 합계를 라인 표시값으로 옮기고 내부 캐시 제거
    const result = Array.from(buckets.values())
      .map((b) => ({
        vendor_id: b.vendor_id,
        vendor_name: b.vendor_name,
        schedule_period_label: b.schedule_period_label,
        schedule_period_start: b.schedule_period_start,
        schedule_period_matched: b.schedule_period_matched,
        request_type: b.request_type,
        ward_requests: b.ward_requests,
        lines: b.lines.map((ln: any) => ({
          item_id: ln.item_id,
          item_code: ln.item_code,
          item_name: ln.item_name,
          purchase_uom: ln.purchase_uom,
          pack_size: ln.pack_size,
          approved_qty: Number(ln.approved_qty.toFixed(3)),
          po_qty: Number(ln._pool_total_po.toFixed(3)),
          stock_out_qty: Number(ln._pool_total_stockout.toFixed(3)),
          unfulfilled_qty: Number(ln.unfulfilled_qty.toFixed(3)),
          default_vendor_id: ln.default_vendor_id,
          default_vendor_name: ln.default_vendor_name,
          last_unit_price: ln.last_unit_price,
          approval_action_item_ids: ln.approval_action_item_ids,
          source_ward_request_ids: ln.source_ward_request_ids,
        })),
      }))
      // 거래처 미지정 → 위로, 그 다음 회차 시작일 오래된 순
      .sort((a, b) => {
        if (!a.vendor_id && b.vendor_id) return -1;
        if (a.vendor_id && !b.vendor_id) return 1;
        return new Date(a.schedule_period_start).getTime() - new Date(b.schedule_period_start).getTime();
      });

    const unassignedLinesCount = result
      .filter((b) => !b.vendor_id)
      .reduce((s, b) => s + b.lines.length, 0);

    res.json({
      buckets: result,
      unassigned_vendor_lines_count: unassignedLinesCount,
      as_of: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[GET /purchase-orders/pending] error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── 업체별 주차별 구매금액 집계 ──────────────────────────────────────────────
// GET /purchase-orders/vendor-weekly-amounts?year=XXXX&month=XX
router.get('/vendor-weekly-amounts', async (req, res) => {
  try {
    const year = parseInt(String(req.query.year ?? new Date().getFullYear()), 10);
    const month = parseInt(String(req.query.month ?? (new Date().getMonth() + 1)), 10);
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: '잘못된 연월 파라미터' });
    }

    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0, 23, 59, 59, 999);

    const pos = await prisma.purchaseOrder.findMany({
      where: {
        deleted_at: null,
        is_test: false,
        status: { in: ['SENT', 'PARTIAL_RECEIVED', 'CLOSED'] },
        ordered_at: { gte: from, lte: to },
      },
      include: { vendor: { select: { id: true, name: true } } },
      orderBy: { ordered_at: 'asc' },
    });

    const manualLabels = new Map<string, string | null>();
    if (pos.length > 0) {
      const ids = pos.map(p => p.id);
      const placeholders = ids.map(() => '?').join(',');
      const rows: any[] = await prisma.$queryRawUnsafe(
        `SELECT id, manual_period_label FROM purchase_orders WHERE id IN (${placeholders})`,
        ...ids,
      );
      for (const r of rows) manualLabels.set(String(r.id), r.manual_period_label ?? null);
    }

    function weekLabel(d: Date): string {
      const day = d.getDate();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const w = day <= 7 ? 1 : day <= 14 ? 2 : day <= 21 ? 3 : 4;
      return `${m}월 ${w}주`;
    }

    type VendorRow = { vendor_id: string; vendor_name: string; amounts: Record<string, number>; total: number };
    const vendorMap = new Map<string, VendorRow>();
    const weekSet = new Set<string>();

    for (const po of pos) {
      const label = manualLabels.get(po.id) || weekLabel(po.ordered_at);
      weekSet.add(label);
      if (!vendorMap.has(po.vendor_id)) {
        vendorMap.set(po.vendor_id, { vendor_id: po.vendor_id, vendor_name: (po.vendor as any)?.name ?? '알 수 없음', amounts: {}, total: 0 });
      }
      const row = vendorMap.get(po.vendor_id)!;
      const amt = Number(po.total_amount) || 0;
      row.amounts[label] = (row.amounts[label] || 0) + amt;
      row.total += amt;
    }

    const weeks = Array.from(weekSet).sort();
    const rows2 = Array.from(vendorMap.values()).sort((a, b) => a.vendor_name.localeCompare(b.vendor_name, 'ko'));

    const grand_total: Record<string, number> = {};
    let overall_total = 0;
    for (const w of weeks) {
      grand_total[w] = rows2.reduce((sum, r) => sum + (r.amounts[w] || 0), 0);
      overall_total += grand_total[w];
    }

    res.json({ year, month, weeks, rows: rows2, grand_total, overall_total });
  } catch (e: any) {
    console.error('[GET /purchase-orders/vendor-weekly-amounts]', e);
    res.status(500).json({ error: String(e.message) });
  }
});

router.get('/:id', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req, res) => {
  try {
    const poId = String(req.params.id);
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: {
        vendor: true,
        creator: true,
        po_items: { include: { item: { include: { default_vendor: true } } }, orderBy: { item: { item_code: 'asc' } } },
        sources: {
          include: {
            ward_request: {
              include: {
                department: true,
                items: { include: { item: true }, orderBy: { item: { item_code: 'asc' } } },
              },
            },
          },
        } as any,
      },
    });
    if (!po) return res.status(404).json({ error: 'Purchase order not found.' });
    if (isScopedToSelfDepartment(req as AuthRequest)) {
      const scopedDeptId = String((req as AuthRequest).user?.department_id ?? '');
      const canRead = ((po as any).sources ?? []).some(
        (src: any) => String(src?.ward_request?.department_id ?? '') === scopedDeptId
      );
      if (!canRead) return res.status(403).json({ error: '다른 부서의 발주서는 조회할 수 없습니다.' });
    }

    const mappedItems = (po as any).po_items.map((it: any) => ({
      id: it.id,
      item_id: it.item_id,
      item_code: it.item?.item_code,
      item_name: it.item?.name,
      uom: it.item?.uom,
      purchase_uom: it.item?.purchase_uom ?? it.item?.uom,
      issue_uom: it.item?.issue_uom ?? it.item?.uom,
      pack_size: Number(it.item?.pack_size ?? 1),
      ordered_qty: Number(it.ordered_qty),
      unit_price: Number(it.unit_price),
      line_amount: Number(it.line_amount),
    }));

    const sources = ((po as any).sources ?? []).map((src: any) => ({
      ward_request_id: src.ward_request_id,
      request_no: src.ward_request?.request_no,
      department_id: src.ward_request?.department_id,
      department_name: src.ward_request?.department?.name,
      request_type: src.ward_request?.request_type,
      items: (src.ward_request?.items ?? []).map((it: any) => ({
        item_id: it.item_id,
        item_name: it.item?.name,
        requested_qty: Number(it.requested_qty),
      })),
    }));
    const detailNeededTypes = Array.from(
      new Set(
        ((po as any).sources ?? [])
          .map((s: any) => s?.ward_request?.request_type)
          .filter((t: any) => typeof t === 'string' && SCHEDULED_REQUEST_TYPES.has(t))
      )
    );
    const detailSchedules =
      detailNeededTypes.length > 0
        ? await prisma.requestSchedule.findMany({
            where: { request_type: { in: detailNeededTypes as string[] } },
            orderBy: { open_from: 'asc' },
          })
        : [];
    const detailSchedulesByType = new Map<string, ScheduleLite[]>();
    for (const s of detailSchedules) {
      if (!detailSchedulesByType.has(s.request_type)) detailSchedulesByType.set(s.request_type, []);
      detailSchedulesByType.get(s.request_type)!.push({
        request_type: s.request_type,
        open_from: s.open_from,
        open_to: s.open_to,
        period_label: s.period_label,
      });
    }

    res.json({
      ...po,
      vendor_name: (po as any).vendor?.name,
      creator_name: (po as any).creator?.display_name,
      total_amount: Number(po.total_amount),
      source_type: inferSourceType(po.note ?? '', sources.map((s: any) => s.request_type).filter(Boolean)),
      ...computeSchedulePeriodMeta(po, detailSchedulesByType),
      po_items: mappedItems,
      items: mappedItems,
      sources,
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { vendor_id, expected_at, note, items, is_test, source_ward_request_ids, from_decision_id } = req.body;
  if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required.' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item is required.' });

  const sourceWrIds: string[] = Array.isArray(source_ward_request_ids)
    ? Array.from(new Set(source_ward_request_ids.map((x: any) => String(x)).filter(Boolean)))
    : [];

  // 결의서에서 변환된 PO 인데 클라이언트가 source_ward_request_ids 를 안 보낸 경우 → 결의서에서 끌어옴.
  // 이 sources 가 있어야 발주서 PDF 에 기저귀 병동별 분배(sub-row)가 그려진다.
  let sourcesFromDecision = false;
  if (from_decision_id && sourceWrIds.length === 0) {
    try {
      const decision: any = await (prisma as any).purchaseDecision.findUnique({
        where: { id: String(from_decision_id) },
        select: { source_ward_request_ids: true },
      });
      if (decision?.source_ward_request_ids) {
        try {
          const wrIds: string[] = JSON.parse(decision.source_ward_request_ids);
          for (const id of wrIds) {
            const s = String(id ?? '');
            if (s && !sourceWrIds.includes(s)) sourceWrIds.push(s);
          }
          if (sourceWrIds.length > 0) sourcesFromDecision = true;
        } catch { /* malformed JSON — ignore */ }
      }
    } catch (e) {
      console.error('[POST /purchase-orders] failed to load decision sources:', e);
    }
  }

  try {
    // ─── 이중 발주 방지: source_ward_request_ids 가 있으면 unfulfilled 풀과 비교
    // 단, 결의서 경유는 박스 단위 올림으로 풀을 초과하는 게 정상이므로 검사 생략(/from-decision 과 동일).
    if (sourceWrIds.length > 0 && !sourcesFromDecision) {
      const unfulfilledByItem = await computeUnfulfilledByItem(sourceWrIds);
      const requestedByItem = new Map<string, number>();
      for (const it of items as any[]) {
        const k = String(it.item_id ?? '');
        if (!k) continue;
        requestedByItem.set(k, (requestedByItem.get(k) ?? 0) + Number(it.ordered_qty ?? 0));
      }
      for (const [itemId, qty] of requestedByItem) {
        const pool = unfulfilledByItem.get(itemId) ?? 0;
        if (qty > pool + 1e-6) {
          return res.status(400).json({
            error: '미발주 잔량을 초과한 품목이 있습니다.',
            details: { item_id: itemId, ordered_qty: qty, available_unfulfilled_qty: pool },
          });
        }
      }
    }

    const seq = await nextSeq('purchase_orders');
    const po_no = generateNo('PO', seq);
    const totalAmount = items.reduce((s: number, it: any) => s + Number(it.ordered_qty) * Number(it.unit_price), 0);

    // is_test 자동 전파: 명시 우선, 없으면 source_ward_request_ids 중 하나라도 test이면 test
    let resolvedIsTest = is_test === true;
    if (!resolvedIsTest && sourceWrIds.length > 0) {
      const anyTest = await prisma.wardRequest.findFirst({
        where: { id: { in: sourceWrIds }, is_test: true },
        select: { id: true },
      });
      if (anyTest) resolvedIsTest = true;
    }

    const po = await prisma.purchaseOrder.create({
      data: {
        id: uuidv4(),
        po_no,
        vendor_id,
        created_by: req.user!.id,
        expected_at: expected_at ? new Date(expected_at) : null,
        note: note ?? '',
        total_amount: totalAmount,
        is_test: resolvedIsTest,
        po_items: {
          create: items.map((it: any) => ({
            id: uuidv4(),
            item_id: it.item_id,
            ordered_qty: it.ordered_qty,
            unit_price: it.unit_price,
            line_amount: Number(it.ordered_qty) * Number(it.unit_price),
          })),
        },
      },
    });

    if (sourceWrIds.length > 0) {
      await prisma.purchaseOrderSource.createMany({
        data: sourceWrIds.map((wrId) => ({
          id: uuidv4(),
          po_id: po.id,
          ward_request_id: wrId,
        })),
      });
    }

    // 결의서에서 로드된 PO — 결의서를 LOCKED 로 잠그고 used_in_po_id 연결
    if (from_decision_id) {
      try {
        await (prisma as any).purchaseDecision.updateMany({
          where: { id: String(from_decision_id), deleted_at: null, status: 'DRAFT' },
          data: { status: 'LOCKED', used_in_po_id: po.id },
        });
      } catch (e) {
        console.error('[POST /purchase-orders] decision lock failed:', e);
        // PO 생성 자체는 성공이므로 여기서 실패해도 흐름 유지
      }
    }

    for (const it of items) {
      try {
        await prisma.priceHistory.updateMany({
          where: { item_id: it.item_id, vendor_id, effective_to: null },
          data: { effective_to: new Date() },
        });
        await prisma.priceHistory.create({
          data: {
            id: uuidv4(),
            item_id: it.item_id,
            vendor_id,
            price: it.unit_price,
            effective_from: new Date(),
            source: 'PO',
          },
        });
      } catch {
        // keep PO flow resilient when price-history update fails
      }
    }

    await audit({
      actor_user_id: req.user!.id,
      action: 'CREATE',
      entity_type: 'purchase_orders',
      entity_id: po.id,
      after: { po_no, vendor_id, total_amount: totalAmount },
    });
    res.status(201).json(po);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/purchase-orders/from-decision
// 구매결의서를 발주서로 변환. 결의서는 LOCKED 상태로 잠김.
//
// 입력: { decision_id, expected_at?, note? }
// 출력: { po_id, po_no, total_amount, skipped_lines }
router.post('/from-decision', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { decision_id, expected_at, note } = req.body ?? {};
  if (!decision_id) return res.status(400).json({ error: 'decision_id 가 필요합니다.' });

  try {
    const decision: any = await (prisma as any).purchaseDecision.findUnique({
      where: { id: String(decision_id) },
    });
    if (!decision || decision.deleted_at) {
      return res.status(404).json({ error: '결의서를 찾을 수 없습니다.' });
    }
    if (decision.status === 'LOCKED') {
      return res.status(400).json({
        error: '이미 발주서로 사용된 결의서입니다.',
        used_in_po_id: decision.used_in_po_id,
      });
    }

    const items: any[] = (() => { try { return JSON.parse(decision.items_json ?? '[]'); } catch { return []; } })();
    if (items.length === 0) {
      return res.status(400).json({ error: '결의서에 품목이 없습니다.' });
    }

    // 자유입력 라인 (item_id 없음) 은 발주서에 못 넣으므로 분리
    const validItems = items.filter((it: any) => it.item_id);
    const skippedLines = items.filter((it: any) => !it.item_id);
    if (validItems.length === 0) {
      return res.status(400).json({ error: '품목 마스터에 등록되지 않은 자유입력 항목만 있습니다. 품목 등록 후 다시 시도하세요.' });
    }

    const sourceWrIds: string[] = (() => {
      try { return JSON.parse(decision.source_ward_request_ids ?? '[]'); } catch { return []; }
    })();

    // 결의서는 사용자가 박스 단위로 검토·편집한 결과 → unfulfilled 풀 체크는 생략.
    // (박스 올림 처리 때문에 자연스레 풀을 초과하게 되는데, 이는 의도된 동작.
    //  같은 결의서가 두 번 발주되는 건 LOCKED 로 이미 차단됨.)

    const seq = await nextSeq('purchase_orders');
    const po_no = generateNo('PO', seq);
    const totalAmount = validItems.reduce(
      (s: number, it: any) => s + Number(it.qty ?? 0) * Number(it.unit_price ?? 0),
      0,
    );

    const po = await prisma.$transaction(async (tx) => {
      const created = await tx.purchaseOrder.create({
        data: {
          id: uuidv4(),
          po_no,
          vendor_id: decision.vendor_id,
          created_by: req.user!.id,
          expected_at: expected_at ? new Date(expected_at) : null,
          note: String(note ?? decision.comment ?? ''),
          total_amount: totalAmount,
          po_items: {
            create: validItems.map((it: any) => ({
              id: uuidv4(),
              item_id: String(it.item_id),
              ordered_qty: Number(it.qty ?? 0),
              unit_price: Number(it.unit_price ?? 0),
              line_amount: Number(it.qty ?? 0) * Number(it.unit_price ?? 0),
            })),
          },
        },
      });

      // source_ward_request 연결
      if (sourceWrIds.length > 0) {
        await tx.purchaseOrderSource.createMany({
          data: sourceWrIds.map((wrId: string) => ({
            id: uuidv4(),
            po_id: created.id,
            ward_request_id: wrId,
          })),
        });
      }

      // 결의서 LOCKED + used_in_po_id 연결
      await (tx as any).purchaseDecision.update({
        where: { id: decision.id },
        data: { status: 'LOCKED', used_in_po_id: created.id },
      });

      return created;
    });

    // priceHistory 갱신 (트랜잭션 외부 — PO flow 가 그대로 살아남도록)
    for (const it of validItems) {
      try {
        await prisma.priceHistory.updateMany({
          where: { item_id: it.item_id, vendor_id: decision.vendor_id, effective_to: null },
          data: { effective_to: new Date() },
        });
        await prisma.priceHistory.create({
          data: {
            id: uuidv4(),
            item_id: it.item_id,
            vendor_id: decision.vendor_id,
            price: Number(it.unit_price ?? 0),
            effective_from: new Date(),
            source: 'PO',
          },
        });
      } catch { /* keep flow resilient */ }
    }

    await audit({
      actor_user_id: req.user!.id,
      action: 'CREATE',
      entity_type: 'purchase_orders',
      entity_id: po.id,
      after: { po_no, vendor_id: decision.vendor_id, total_amount: totalAmount, from_decision: decision.decision_no },
    });

    res.status(201).json({
      po_id: po.id,
      po_no,
      total_amount: totalAmount,
      skipped_lines: skippedLines.length,
    });
  } catch (e: any) {
    console.error('[POST /purchase-orders/from-decision] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

router.put('/:id', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const poId = String(req.params.id);
    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po) return res.status(404).json({ error: 'Purchase order not found.' });
    // DRAFT/SENT(발주완료) 까지 수정 가능. PARTIAL_RECEIVED/CLOSED/CANCELLED 는 입고가 진행됐거나 끝난 상태라 차단.
    if (!['DRAFT', 'SENT'].includes(po.status)) {
      return res.status(400).json({ error: '입고가 시작되거나 종료된 발주는 수정할 수 없습니다. (임시/발주완료 상태만 가능)' });
    }

    const { expected_at, note, items } = req.body;
    const totalAmount = Array.isArray(items)
      ? items.reduce((s: number, it: any) => s + Number(it.ordered_qty) * Number(it.unit_price), 0)
      : Number(po.total_amount);

    if (Array.isArray(items)) {
      await prisma.purchaseOrderItem.deleteMany({ where: { purchase_order_id: poId } });
      await prisma.purchaseOrderItem.createMany({
        data: items.map((it: any) => ({
          id: uuidv4(),
          purchase_order_id: poId,
          item_id: it.item_id,
          ordered_qty: it.ordered_qty,
          unit_price: it.unit_price,
          line_amount: Number(it.ordered_qty) * Number(it.unit_price),
        })),
      });

      // 단가 변경 시 PriceHistory 동기화 — latest_price/평균단가 추적이 깨지지 않도록.
      // CREATE 와 동일하게 vendor 의 동일 품목 effective_to 닫고 새 entry 생성.
      for (const it of items) {
        try {
          await prisma.priceHistory.updateMany({
            where: { item_id: it.item_id, vendor_id: po.vendor_id, effective_to: null },
            data: { effective_to: new Date() },
          });
          await prisma.priceHistory.create({
            data: {
              id: uuidv4(),
              item_id: it.item_id,
              vendor_id: po.vendor_id,
              price: it.unit_price,
              effective_from: new Date(),
              source: 'PO',
            },
          });
        } catch {
          // priceHistory 실패는 PO 수정 자체엔 영향 없도록 silent
        }
      }
    }

    const updated = await prisma.purchaseOrder.update({
      where: { id: poId },
      data: {
        ...(expected_at !== undefined && { expected_at: expected_at ? new Date(expected_at) : null }),
        ...(note !== undefined && { note }),
        total_amount: totalAmount,
      },
    });
    await audit({
      actor_user_id: req.user!.id,
      action: 'UPDATE',
      entity_type: 'purchase_orders',
      entity_id: poId,
      before: po,
      after: updated,
      reason: po.status === 'SENT' ? '발주완료 상태에서 수정' : '발주서 수정',
    });
    res.json(updated);
  } catch (e: any) {
    console.error('[PUT /purchase-orders/:id] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

router.post('/:id/send', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const poId = String(req.params.id);
    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po) return res.status(404).json({ error: 'Purchase order not found.' });
    if (po.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT can be sent.' });
    const updated = await prisma.purchaseOrder.update({ where: { id: poId }, data: { status: 'SENT' } });
    await audit({
      actor_user_id: req.user!.id,
      action: 'UPDATE',
      entity_type: 'purchase_orders',
      entity_id: poId,
      before: { status: 'DRAFT' },
      after: { status: 'SENT' },
      reason: 'PO sent',
    });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/purchase-orders/:id/revert
// "그전으로 되돌리기" — PO 를 CANCELLED 상태로 (목록에는 남음, 「취소됨」 배지) +
// 묶여 있던 구매결의서를 DRAFT 로 복원 → 결의서 자유 편집 가능.
// 상태 가드:
//   DRAFT/SENT 만 허용 (권한자 + 사유 필수)
//   PARTIAL_RECEIVED/CLOSED/CANCELLED 차단 (입고 발생/마감/이미 취소 — 별도 처리 필요)
router.post('/:id/revert', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const poId = String(req.params.id);
    const reasonText = String(req.body?.reason ?? '').trim();
    if (!reasonText) return res.status(400).json({ error: '되돌리기 사유는 필수입니다.' });
    if (reasonText.length < 5) return res.status(400).json({ error: '되돌리기 사유는 5자 이상 입력해주세요.' });

    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po || po.deleted_at) return res.status(404).json({ error: '발주서를 찾을 수 없습니다.' });
    if (po.status === 'CANCELLED') return res.status(400).json({ error: '이미 취소된 발주서입니다.' });
    if (po.status === 'PARTIAL_RECEIVED') return res.status(400).json({ error: '일부 입고된 발주서는 되돌릴 수 없습니다. 입고 역전(reversal) 먼저 진행하세요.' });
    if (po.status === 'CLOSED') return res.status(400).json({ error: '마감된 발주서는 되돌릴 수 없습니다.' });
    // DRAFT / SENT 통과

    await prisma.$transaction(async (tx) => {
      // PO 는 소프트삭제 X — 목록에 「취소됨」 배지로 남기고 추적성 유지
      const prevNote = String(po.note ?? '').trim();
      const stamp = `[되돌리기 ${new Date().toISOString().slice(0, 10)}] ${reasonText}`;
      await tx.purchaseOrder.update({
        where: { id: poId },
        data: {
          status: 'CANCELLED',
          note: prevNote ? `${prevNote}\n${stamp}` : stamp,
        },
      });
      // 연결된 LOCKED 결의서 unlock
      await (tx as any).purchaseDecision.updateMany({
        where: { used_in_po_id: poId, status: 'LOCKED' },
        data: { status: 'DRAFT', used_in_po_id: null },
      });
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'REVERT',
      entity_type: 'purchase_orders',
      entity_id: poId,
      reason: reasonText,
      before: { status: po.status },
      after: { status: 'CANCELLED' },
    });
    res.json({ message: '되돌리기 완료', po_status: 'CANCELLED' });
  } catch (e: any) {
    console.error('[POST /purchase-orders/:id/revert] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

router.delete('/:id', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const poId = String(req.params.id);
    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po) return res.status(404).json({ error: 'Purchase order not found.' });
    if (!['DRAFT'].includes(po.status)) return res.status(400).json({ error: 'Only DRAFT can be deleted.' });

    // 트랜잭션: PO 소프트 삭제 + 연결된 LOCKED 결의서를 DRAFT 로 복원 (편집 가능하게)
    await prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.update({
        where: { id: poId },
        data: { deleted_at: new Date(), status: 'CANCELLED' },
      });
      // 이 PO 가 used_in_po_id 인 결의서 찾아서 unlock
      await (tx as any).purchaseDecision.updateMany({
        where: { used_in_po_id: poId, status: 'LOCKED' },
        data: { status: 'DRAFT', used_in_po_id: null },
      });
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'SOFT_DELETE',
      entity_type: 'purchase_orders',
      entity_id: poId,
      before: po,
    });
    res.json({ message: 'Deleted.' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// 업체별 양식 설정 — 결재 직책, 분류 라벨, 마지막 컬럼, 부서명.
// 업체 등록 시 명시 설정이 없는 경우 이름 패턴으로 자동 분류 (Phase A 임시).
// Phase B 에서 Vendor.template_config 컬럼 추가하면 명시 설정 우선.
function getVendorTemplate(vendor: any): {
  approvalLabels: string[];
  categoryLabel: string;
  vendorCategory: string;  // 요약 표 업체명 옆 괄호 (예: "(의료소모품)")
  lastColLabel: string;
  deptLabel: string;
} {
  const cfg = (vendor && (vendor as any).template_config) || null;
  if (cfg && typeof cfg === 'object') {
    return {
      approvalLabels: Array.isArray(cfg.approvalLabels) && cfg.approvalLabels.length === 5
        ? cfg.approvalLabels : ['담 당', '총무부장', '행정원장', '상임이사', '이사장'],
      categoryLabel: cfg.categoryLabel || '구 매 물 품',
      vendorCategory: cfg.vendorCategory || '',
      lastColLabel: cfg.lastColLabel || '비 고',
      deptLabel: cfg.deptLabel || '총 무 부',
    };
  }
  const name = String(vendor?.name ?? '').toLowerCase();
  if (name.includes('유한메디칼') || name.includes('메디칼') || name.includes('의료')) {
    return {
      approvalLabels: ['담 당', '총무부장', '행정원장', '상임이사', '이사장'],
      categoryLabel: '의료 소모품 / 의료 기기',
      vendorCategory: '의료소모품',
      lastColLabel: '비 고',
      deptLabel: '총 무 부',
    };
  }
  if (name.includes('알파문구') || name.includes('문구') || name.includes('사무')) {
    return {
      approvalLabels: ['담 당', '부 서 장', '행정부장', '행정부원장', '이사장'],
      categoryLabel: '문 구 류',
      vendorCategory: '사무용품',
      lastColLabel: '코 드',
      deptLabel: '총 무 과',
    };
  }
  if (name.includes('예스상사') || name.includes('상사') || name.includes('생필품')) {
    return {
      approvalLabels: ['담 당', '총무부장', '행정원장', '상임이사', '이사장'],
      categoryLabel: '생 활 용 품',
      vendorCategory: '생활용품',
      lastColLabel: '비 고',
      deptLabel: '총 무 부',
    };
  }
  if (name.includes('중앙에스엔비') || name.includes('s&b') || name.includes('기저귀')) {
    return {
      approvalLabels: ['담 당', '총무부장', '행정원장', '상임이사', '이사장'],
      categoryLabel: '기 저 귀 / 화 장 지 류',
      vendorCategory: '기저귀',
      lastColLabel: '비 고',
      deptLabel: '총 무 부',
    };
  }
  if (name.includes('인터넷') || name.includes('카드') || name.includes('기타')) {
    return {
      approvalLabels: ['담 당', '행정과장', '행정원장', '상임이사', '이사장'],
      categoryLabel: '기 타 용 품',
      vendorCategory: '기타',
      lastColLabel: '비 고',
      deptLabel: '총 무 과',
    };
  }
  return {
    approvalLabels: ['담 당', '총무부장', '행정원장', '상임이사', '이사장'],
    categoryLabel: '구 매 물 품',
    vendorCategory: '',
    lastColLabel: '비 고',
    deptLabel: '총 무 부',
  };
}

// ── POST /gumae-result-pdf — 구매결의서 PDF (선택한 발주서 기반) ─────
router.post('/gumae-result-pdf', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: '발주서를 선택해주세요.' });

    const poList = await (prisma as any).purchaseOrder.findMany({
      where: { id: { in: ids }, deleted_at: null },
      include: {
        vendor: true,
        po_items: { include: { item: true }, orderBy: { item: { item_code: 'asc' } } },
        sources: { include: { ward_request: { include: { department: true, items: { include: { item: true }, orderBy: { item: { item_code: 'asc' } } } } } } },
      },
      orderBy: { ordered_at: 'asc' },
    });
    if (poList.length === 0) return res.status(400).json({ error: '조회된 발주서가 없습니다.' });

    // Build item_id → department names mapping from PO sources
    const itemDeptMap = new Map<string, Set<string>>();
    for (const po of poList) {
      for (const src of po.sources ?? []) {
        const rawName: string = src.ward_request?.department?.name ?? '';
        if (!rawName) continue;
        // 비고 정규화 — 양식 관행: 개별 하위부서 X, 상위 카테고리만.
        //   "2병동", "8병동" 등 → "병동" 으로 통일
        //   "PT실", "OT실" 같은 재활 → "재활"
        //   그 외 (신장실, 소독실, 약제실 등 단독 부서)는 그대로 유지
        let deptName = rawName;
        if (/^\d+병동$/.test(rawName)) deptName = '병동';
        else if (/^(PT실|OT실|물리치료실|재활치료실)$/.test(rawName)) deptName = '재활';
        for (const ri of src.ward_request?.items ?? []) {
          if (!itemDeptMap.has(ri.item_id)) itemDeptMap.set(ri.item_id, new Set());
          itemDeptMap.get(ri.item_id)!.add(deptName);
        }
      }
    }

    const setting = await (prisma as any).appSetting.findUnique({ where: { key: 'HOSPITAL_NAME' } });
    const hospitalName = (setting?.value as string) ?? '병원';
    const fonts = getFonts();
    const userName: string = (req.user as any)?.display_name ?? '';

    // Group by vendor
    const vendorMap = new Map<string, { vendor: any; pos: any[] }>();
    for (const po of poList) {
      const vid = po.vendor_id;
      if (!vendorMap.has(vid)) vendorMap.set(vid, { vendor: po.vendor, pos: [] });
      vendorMap.get(vid)!.pos.push(po);
    }
    const vendors = Array.from(vendorMap.values());

    // Label / 물품사용기간 — 사용자 입력 우선, 없으면 ordered_at 범위로 fallback
    const labelInput: string = String(req.body?.label || '').trim();
    const fromInput: string = String(req.body?.from || '').trim();
    const toInput: string = String(req.body?.to || '').trim();

    const dates = poList.map((p: any) => new Date(p.ordered_at).getTime());
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    const m = minDate.getMonth() + 1;
    const w = Math.ceil(minDate.getDate() / 7);
    const docLabel = labelInput || `${String(m).padStart(2, '0')}월${w}주`;
    const displayFrom = fromInput ? new Date(fromInput) : minDate;
    const displayTo = toInput ? new Date(toInput) : maxDate;

    // Comparison periods
    const comparePeriods: { label: string; from: string; to: string }[] =
      Array.isArray(req.body?.comparePeriods) ? req.body.comparePeriods.slice(0, 2) : [];

    function periodLabel(d: Date) {
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const ww = Math.ceil(d.getDate() / 7);
      return `${mm}월${ww}주`;
    }

    const compareData: { label: string; totals: Map<string, number> }[] = [];
    for (const cp of comparePeriods) {
      if (!cp.from || !cp.to) continue;
      const cpFrom = new Date(cp.from);
      const cpTo = new Date(cp.to); cpTo.setHours(23, 59, 59, 999);
      const cpPos = await (prisma as any).purchaseOrder.findMany({
        where: { ordered_at: { gte: cpFrom, lte: cpTo }, status: { notIn: ['DRAFT', 'CANCELLED'] }, deleted_at: null },
        select: { vendor_id: true, total_amount: true },
      });
      const totals = new Map<string, number>();
      for (const p of cpPos) totals.set(p.vendor_id, (totals.get(p.vendor_id) ?? 0) + Number(p.total_amount));
      compareData.push({ label: cp.label || periodLabel(cpFrom), totals });
    }

    // PDF setup
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="gumae-result.pdf"`);
    doc.pipe(res);
    doc.registerFont('K', fonts.regular).registerFont('KB', fonts.bold);

    const pageH = 841.89;
    // ── PAGE 1: 표지 ─────────────────────────────────────────────────
    // 양식 (.xlsx) 위치 기준:
    //   Row 7-8  (제목 2줄, 36pt bold)         → y ≈ 150~210
    //   Row 10   (사용기간 16pt bold)          → y ≈ 270
    //   Row 28   (담당, 가운데)                  → y ≈ 540
    {
      const yearStr = `${displayFrom.getFullYear()}년  ${docLabel}`;
      // Row 7 시작 ≈ 50(margin) + 6 * 15(default rowH) + 8(여유) = 148
      const titleY = 148;
      doc.font('KB').fontSize(36).fillColor('#000')
        .text(yearStr, 50, titleY, { width: 495, align: 'center', lineBreak: false });
      doc.font('KB').fontSize(36).fillColor('#000')
        .text('업체별 물품 구매 결의서', 50, titleY + 52, { width: 495, align: 'center', lineBreak: false });

      // 사용기간 (괄호 형식) — Row 10 ≈ titleY + 2 rows(title) + 1 empty row (Row 9)
      const fromMd = `${String(displayFrom.getMonth() + 1).padStart(2, '0')}월 ${String(displayFrom.getDate()).padStart(2, '0')}일`;
      const toMd = `${String(displayTo.getMonth() + 1).padStart(2, '0')}월 ${String(displayTo.getDate()).padStart(2, '0')}일`;
      doc.font('KB').fontSize(16).fillColor('#000')
        .text(`(물품사용기간:  ${fromMd} ~ ${toMd})`, 50, titleY + 52 + 70, { width: 495, align: 'center', lineBreak: false });

      // 담당 — Row 28 ≈ y = 50 + 27 * 15 + 여유 = 약 470. 양식에서는 페이지 하단부 가운데.
      doc.font('KB').fontSize(18).fillColor('#000')
        .text(`담  당:  ${userName}`, 50, 470, { width: 495, align: 'center', lineBreak: false });
    }

    // ── PAGE 2: 업체별 구매 금액 요약 ────────────────────────────────
    doc.addPage();
    let y = 50;
    doc.font('KB').fontSize(14).fillColor('#000').text(`${docLabel} 업체별 구매 금액`, 50, y);
    y += 26;

    const sX = 50;
    const numExtra = compareData.length;
    const vendorColW = numExtra === 0 ? 350 : numExtra === 1 ? 230 : 175;
    const amtColW = numExtra > 0 ? 105 : 120;
    const sCols = [vendorColW, ...compareData.map(() => amtColW), amtColW];
    // 헤더 — 2줄 형식 ("04월 3주\n물품금액")
    const sHeaders = ['업  체  명', ...compareData.map(cd => `${cd.label}\n물품금액`), `${docLabel}\n물품금액`];

    function drawSummaryRow(cells: string[], rowY: number, isHeader: boolean, isTotals: boolean): number {
      // 헤더는 2줄 텍스트라 높이 더 크게
      const rowH = isHeader ? 36 : 22;
      const totalW = sCols.reduce((a, b) => a + b, 0);
      // 배경
      if (isHeader) doc.rect(sX, rowY, totalW, rowH).fill('#e8edf5');
      else if (isTotals) doc.rect(sX, rowY, totalW, rowH).fill('#e8e8e8');
      // 셀 내부 가는 선 (각 셀 우측·하단)
      doc.lineWidth(0.5);
      let x = sX;
      for (let i = 0; i < sCols.length - 1; i++) {
        x += sCols[i];
        doc.moveTo(x, rowY).lineTo(x, rowY + rowH).stroke('#000');
      }
      doc.moveTo(sX, rowY + rowH).lineTo(sX + totalW, rowY + rowH).stroke('#000');
      // 외곽 굵은 선
      doc.lineWidth(1.5);
      doc.moveTo(sX, rowY).lineTo(sX + totalW, rowY).stroke('#000');
      doc.moveTo(sX, rowY).lineTo(sX, rowY + rowH).stroke('#000');
      doc.moveTo(sX + totalW, rowY).lineTo(sX + totalW, rowY + rowH).stroke('#000');
      // 텍스트
      x = sX;
      for (let i = 0; i < sCols.length; i++) {
        const align: 'left' | 'center' | 'right' = i === 0 ? (isHeader ? 'center' : 'left') : 'right';
        const fontSize = 10;
        const pad = i === 0 ? 6 : 4;
        if (isHeader && cells[i]?.includes('\n')) {
          doc.font('KB').fontSize(fontSize).fillColor('#000')
            .text(cells[i] ?? '', x + pad, rowY + 4, {
              width: sCols[i] - pad - pad, align: 'center',
            });
        } else {
          doc.font(isHeader || isTotals ? 'KB' : 'K').fontSize(fontSize).fillColor('#000')
            .text(cells[i] ?? '', x + pad, rowY + (rowH - fontSize) / 2 - 1, {
              width: sCols[i] - pad - (align === 'right' ? 6 : pad), align, lineBreak: false,
            });
        }
        x += sCols[i];
      }
      return rowY + rowH;
    }

    y = drawSummaryRow(sHeaders, y, true, false);
    let grandTotal = 0;
    const grandCompare = compareData.map(() => 0);
    for (const { vendor, pos: vpos } of vendors) {
      const curTotal = vpos.reduce((s: number, p: any) => s + Number(p.total_amount), 0);
      grandTotal += curTotal;
      const compareCells = compareData.map((cd, ci) => {
        const t = cd.totals.get(vendor.id) ?? 0;
        grandCompare[ci] += t;
        return t > 0 ? t.toLocaleString('ko-KR') : '-';
      });
      // 업체명에 분류 괄호 추가: "유한메디칼(의료소모품)"
      const tpl = getVendorTemplate(vendor);
      const vendorDisplay = tpl.vendorCategory ? `${vendor.name}(${tpl.vendorCategory})` : vendor.name;
      y = drawSummaryRow([vendorDisplay, ...compareCells, curTotal.toLocaleString('ko-KR')], y, false, false);
    }
    drawSummaryRow(['총    액', ...grandCompare.map(t => t > 0 ? t.toLocaleString('ko-KR') : '-'), grandTotal.toLocaleString('ko-KR')], y, false, true);

    // ── PAGE 3~N: 업체별 상세 ─────────────────────────────────────────
    const bW = 53, bH = 58, bStartY = 50;
    // 컬럼 너비 — 양식 비율에 맞춤. 비고 50→60 (8병동,2병동 같은 텍스트 잘림 방지)
    //          NO  품명  규격  수량 단가 금액 비고
    const dCols = [25, 130, 65, 50, 80, 90, 55];

    for (const { vendor, pos: vpos } of vendors) {
      doc.addPage();

      // 업체별 양식 설정
      const tpl = getVendorTemplate(vendor);

      // ── 양식 순서: 제목(top) → 결재란+안내 → 작성일자 → 구매담당자 → 격자(청구부서·병원명) → 분류라벨 → 표 ──

      // 1. 제목 (맨 위 가운데, 22pt bold)
      y = 50;
      doc.font('KB').fontSize(22).fillColor('#000')
        .text(`${vendor.name} 구매 결의서`, 50, y, { width: 495, align: 'center', lineBreak: false });
      y += 36;

      // 2. 결재란 (우측, 6칸: 결재 + 5라벨) + 좌측 3줄 정보
      // 양식 구조:
      //   좌측 3줄:                              | [결][담당][부서장][행정원장][상임이사][이사장]
      //   * 하기 물품을 구매하고자 합니다.       | [재][   ][   ][   ][   ][   ]
      //   2026년 02월 02일                       | [  ][   ][   ][   ][   ][   ]
      //   구매 담당자 :  ○ ○ ○                  |
      const aplY = y;
      const aplLabelW = 18;             // 좌측 "결재" 칸 너비
      const aplCellW = 48;              // 라벨 칸 너비
      const aplLabelRowH = 18;          // 라벨 행 높이
      const aplStampRowH = 40;          // 도장 영역 높이
      const aplTotalH = aplLabelRowH + aplStampRowH;
      const aplTotalW = aplLabelW + aplCellW * 5;
      const aplStartX = 545 - aplTotalW;

      // "결재" 라벨 칸 (좌측, 세로 글자 — 양식 상으로 "결\n\n재")
      doc.lineWidth(1.5);
      doc.rect(aplStartX, aplY, aplLabelW, aplTotalH).stroke('#000');
      doc.font('KB').fontSize(10).fillColor('#000')
        .text('결\n재', aplStartX, aplY + 8, { width: aplLabelW, align: 'center' });

      // 5 라벨 칸 (담당, 부서장 등) — 라벨 행
      tpl.approvalLabels.forEach((label, i) => {
        const x = aplStartX + aplLabelW + i * aplCellW;
        doc.lineWidth(1.5).rect(x, aplY, aplCellW, aplLabelRowH).stroke('#000');
        doc.font('KB').fontSize(9).fillColor('#000')
          .text(label, x, aplY + (aplLabelRowH - 9) / 2 - 1, { width: aplCellW, align: 'center', lineBreak: false });
      });

      // 5 도장 칸 (라벨 아래 빈 영역)
      tpl.approvalLabels.forEach((_, i) => {
        const x = aplStartX + aplLabelW + i * aplCellW;
        doc.lineWidth(1.5).rect(x, aplY + aplLabelRowH, aplCellW, aplStampRowH).stroke('#000');
      });

      // 좌측 3줄 정보 (결재란과 같은 라인)
      const leftStartY = aplY + 4;
      const today = new Date();
      const todayStr = `${today.getFullYear()}년 ${String(today.getMonth() + 1).padStart(2, '0')}월 ${String(today.getDate()).padStart(2, '0')}일`;
      doc.font('K').fontSize(11).fillColor('#000')
        .text('* 하기 물품을 구매하고자 합니다.', 50, leftStartY, { width: aplStartX - 60, align: 'left', lineBreak: false });
      doc.font('K').fontSize(11)
        .text(todayStr, 50, leftStartY + 18, { width: aplStartX - 60, align: 'center', lineBreak: false });
      doc.font('K').fontSize(11)
        .text(`구매 담당자 :  ${userName}`, 50, leftStartY + 36, { width: aplStartX - 60, align: 'center', lineBreak: false });

      y = aplY + aplTotalH + 6;

      // 5. 격자 — 청구부서 row + 병원명·납품일자 row (테두리 있는 표)
      const earliestDate = vpos.reduce((min: any, p: any) => {
        const d = p.expected_at ?? p.ordered_at;
        return new Date(d) < new Date(min) ? d : min;
      }, vpos[0].expected_at ?? vpos[0].ordered_at);
      const _delDate = new Date(earliestDate);
      const deliveryStr = `${_delDate.getFullYear()}년 ${String(_delDate.getMonth() + 1).padStart(2, '0')}월 ${String(_delDate.getDate()).padStart(2, '0')}일`;

      const gridTotalW = 495;
      const gridRowH = 24;

      // drawGridRow — 로우별 컬럼 너비 다름 (양식 일치).
      //   Row 1 (청구부서): [라벨 좁음] [값 중] [phone 매우 넓음]
      //   Row 2 (병원명):    [병원명 넓음] [라벨 중] [date 넓음]
      function drawGridRow(cells: { text: string; bold: boolean }[], colW: number[], rowY: number, isFirstRow: boolean, isLastRow: boolean) {
        // 외곽 medium
        doc.lineWidth(1.5);
        doc.moveTo(50, rowY).lineTo(50, rowY + gridRowH).stroke('#000');
        doc.moveTo(50 + gridTotalW, rowY).lineTo(50 + gridTotalW, rowY + gridRowH).stroke('#000');
        if (isFirstRow) doc.moveTo(50, rowY).lineTo(50 + gridTotalW, rowY).stroke('#000');
        if (isLastRow) doc.moveTo(50, rowY + gridRowH).lineTo(50 + gridTotalW, rowY + gridRowH).stroke('#000');
        // 내부 thin
        doc.lineWidth(0.5);
        let x = 50;
        for (let i = 0; i < cells.length - 1; i++) {
          x += colW[i];
          doc.moveTo(x, rowY).lineTo(x, rowY + gridRowH).stroke('#000');
        }
        if (!isLastRow) doc.moveTo(50, rowY + gridRowH).lineTo(50 + gridTotalW, rowY + gridRowH).stroke('#000');
        // 텍스트
        x = 50;
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i];
          doc.font(cell.bold ? 'KB' : 'K').fontSize(11).fillColor('#000')
            .text(cell.text, x + 4, rowY + (gridRowH - 11) / 2 - 1, { width: colW[i] - 8, align: 'center', lineBreak: false });
          x += colW[i];
        }
      }

      // 격자 셀 경계를 표 컬럼과 정렬 — 양식 일치.
      // 표 컬럼: NO(25) + 품명(130) + 규격(65) = 220 → 규격 컬럼 우측 = x=270 (50 마진 기준)
      //   - Row 1 의 총무부 우측 경계 = 270
      //   - Row 2 의 호남THE선요양병원 우측 경계 = 270
      // 청구부서 + 총무부 = 220 (= 규격 컬럼 우측까지)
      // 병원명 = 220 (= 규격 컬럼 우측까지)
      // 나머지 phone / 납품일자 + date = 275

      // Row 1 — 청구부서 100 | 총무부 120 (오른쪽 경계 x=270) | phone 275
      drawGridRow([
        { text: '청 구 부 서', bold: true },
        { text: tpl.deptLabel, bold: true },
        { text: HOSPITAL_PHONE, bold: false },
      ], [100, 120, 275], y, true, false);
      y += gridRowH;

      // Row 2 — 병원명 220 (오른쪽 경계 x=270) | 납품일자 100 | date 175
      drawGridRow([
        { text: hospitalName, bold: true },
        { text: '납품 일자', bold: true },
        { text: deliveryStr, bold: false },
      ], [220, 100, 175], y, false, true);
      y += gridRowH + 4;

      // 양식 일치 — 분류 라벨 행 제거 (사용자 요청). 표 헤더로 바로 진입.
      const totalRowW = dCols.reduce((a, b) => a + b, 0);

      // 표 헤더 (양식: NO|품명|규격|수량|단가|금액|비고|코드)
      const dHdrs = ['NO', '품   명', '규   격', '수 량', '단 가', '금   액', tpl.lastColLabel];

      // 양식·요구사항 적용:
      //  - 단가(i=4)·금액(i=5) → right align (숫자)
      //  - 그 외 (NO, 품명, 규격, 수량, 비고) → center
      //  - 모든 셀 vertical center
      //  - 외곽 medium(1.5pt), 내부 thin(0.5pt)
      //  - 비고 컬럼만 줄바꿈 허용
      function drawDetailRow(cells: string[], rowY: number, isHeader: boolean, isFirstDataRow: boolean = false, isLastRow: boolean = false): number {
        let rowH = isHeader ? 22 : 18;
        if (!isHeader) {
          const bigoText = cells[6] ?? '';
          const bigoLines = Math.max(1, Math.ceil((bigoText.length * 5) / (dCols[6] - 4)));
          if (bigoLines > 1) rowH = Math.max(rowH, bigoLines * 12 + 4);
        }
        if (isHeader) {
          doc.rect(50, rowY, totalRowW, rowH).fill('#e8edf5');
        }
        let x = 50;
        for (let i = 0; i < dCols.length; i++) {
          // 셀 내부 가는 선
          doc.lineWidth(0.5);
          doc.moveTo(x + dCols[i], rowY).lineTo(x + dCols[i], rowY + rowH).stroke('#000');
          if (!isLastRow) {
            doc.moveTo(x, rowY + rowH).lineTo(x + dCols[i], rowY + rowH).stroke('#000');
          }
          const fs = isHeader ? 11 : 9;
          // 정렬 결정: 헤더는 항상 center, 데이터는 단가(4)·금액(5) right, 나머지 center
          const align: 'left' | 'center' | 'right' =
            isHeader ? 'center'
            : (i === 4 || i === 5) ? 'right'
            : 'center';
          const padL = 4;
          const padR = (align === 'right') ? 6 : 4;
          // 비고 컬럼(i=6) 만 lineBreak 허용
          const allowWrap = !isHeader && i === 6;
          // 세로 가운데 — 행 높이 안에서 텍스트 자체 높이 빼고 정확히 가운데로
          const textY = rowY + (rowH - fs) / 2;
          doc.font(isHeader ? 'KB' : 'K').fontSize(fs).fillColor('#000')
            .text(cells[i] ?? '', x + padL, textY - 1, {
              width: dCols[i] - padL - padR, align, lineBreak: allowWrap,
            });
          x += dCols[i];
        }
        // 외곽 굵은 선 — 좌·상 (행 단위로 그리고 마지막에 우·하 그림)
        doc.lineWidth(1.5);
        doc.moveTo(50, rowY).lineTo(50, rowY + rowH).stroke('#000');  // 좌측 외곽
        doc.moveTo(50 + totalRowW, rowY).lineTo(50 + totalRowW, rowY + rowH).stroke('#000');  // 우측 외곽
        if (isFirstDataRow || isHeader) {
          doc.moveTo(50, rowY).lineTo(50 + totalRowW, rowY).stroke('#000');  // 상단 외곽
        }
        if (isLastRow) {
          doc.moveTo(50, rowY + rowH).lineTo(50 + totalRowW, rowY + rowH).stroke('#000');  // 하단 외곽
        }
        return rowY + rowH;
      }

      const itemMap = new Map<string, { name: string; spec: string; qty: number; price: number; itemId: string }>();
      for (const po of vpos) {
        for (const it of po.po_items ?? []) {
          const iid = it.item_id;
          if (!itemMap.has(iid)) {
            const sub = (it.item as any)?.sub_category ?? '';
            let displayName = it.item?.name ?? '';
            // 품명에 sub_category 가 괄호로 포함된 경우 제거 (예: "D/Needle (18G)" → "D/Needle")
            // (MLS-11) 같은 모델명은 sub_category 와 다르므로 유지됨.
            if (sub) {
              const suffix = `(${sub})`;
              if (displayName.endsWith(suffix)) {
                displayName = displayName.slice(0, -suffix.length).trim();
              } else if (displayName.endsWith(` ${suffix}`)) {
                displayName = displayName.slice(0, -(suffix.length + 1)).trim();
              }
            }
            itemMap.set(iid, {
              name: displayName,
              spec: sub || it.item?.purchase_uom || it.item?.uom || '',
              qty: 0,
              price: Number(it.unit_price),
              itemId: iid,
            });
          }
          itemMap.get(iid)!.qty += Number(it.ordered_qty);
        }
      }

      y = drawDetailRow(dHdrs, y, true, true);
      let vendorTotal = 0;
      let rowIdx = 1;
      const items = Array.from(itemMap.values());

      // ── 페이지 분할 정책 ──
      //  - 한 페이지 안전 데이터행 한도: 약 35행 (헤더·결재란·격자·표헤더 등 위에 차지된 공간 고려)
      //  - 페이지 2+ 는 헤더 영역 없이 표 헤더만 → 더 많은 행 가능 (약 45행)
      //  - 마지막 페이지에 합계 + 합계금액 + 로고가 들어갈 공간 (~80pt) 미리 확보
      //  - 고아 행(orphan) 방지: 페이지 끝에 1~3행만 남겨두지 않고 다음 페이지로 함께 보냄
      const TABLE_BOTTOM_RESERVE = 80;  // 합계+합계금액+로고 공간
      const PAGE_BOTTOM = 800;
      const ROW_H = 18;
      const MIN_ORPHAN = 4;  // 마지막 페이지에 최소 이만큼 행 + 합계

      function continueOnNextPage() {
        doc.addPage();
        y = 50;
        // 페이지 2+ 는 표 헤더만 다시 그림 (제목/결재란/격자/분류 라벨 X)
        y = drawDetailRow(dHdrs, y, true, true);
      }

      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        const remaining = items.length - idx;
        const isLast = remaining <= MIN_ORPHAN;
        // 합계 들어갈 공간이 필요한 마지막 그룹이면 reserve 적용, 아니면 일반 행 공간만
        const limit = isLast ? PAGE_BOTTOM - TABLE_BOTTOM_RESERVE - ROW_H : PAGE_BOTTOM - ROW_H;
        if (y > limit) {
          continueOnNextPage();
        }
        const amt = it.qty * it.price;
        vendorTotal += amt;
        const depts = itemDeptMap.get(it.itemId);
        const bigoStr = depts ? Array.from(depts).join(',') : '';
        y = drawDetailRow(
          [String(rowIdx++), it.name, it.spec, it.qty.toLocaleString('ko-KR'), it.price.toLocaleString('ko-KR'), amt.toLocaleString('ko-KR'), bigoStr],
          y,
          false,
          false,
          false,
        );
      }

      // 합계 영역 공간 부족하면 새 페이지로 (고아 합계 방지)
      const sH = 22;  // 원래 행 높이 유지
      if (y + sH + 30 > PAGE_BOTTOM) {
        continueOnNextPage();
      }

      // 합 계 금 액 행 — 2 셀 (라벨 / 금액)
      const labelW = dCols[0] + dCols[1] + dCols[2] + dCols[3] + dCols[4];
      const amountW = dCols[5] + dCols[6];
      // 외곽 medium
      doc.lineWidth(1.5).rect(50, y, totalRowW, sH).stroke('#000');
      // 셀 분리선
      doc.lineWidth(0.5);
      doc.moveTo(50 + labelW, y).lineTo(50 + labelW, y + sH).stroke('#000');
      // 세로 가운데 — 11pt 폰트(다른 셀과 동일), 22pt 행. (sH - fs) / 2 + 약간의 베이스라인 보정
      const totalFs = 11;
      const totalTextY = y + (sH - totalFs) / 2;
      // 라벨 — 가로 가운데
      doc.font('KB').fontSize(totalFs).fillColor('#000')
        .text('합  계  금  액', 50, totalTextY, { width: labelW, align: 'center', lineBreak: false, baseline: 'top' });
      // 금액 — 가로 우측
      doc.font('KB').fontSize(totalFs).fillColor('#000')
        .text(`${vendorTotal.toLocaleString('ko-KR')}`, 50 + labelW, totalTextY, { width: amountW - 8, align: 'right', lineBreak: false, baseline: 'top' });
      y += sH + 20;
      if (fs.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, 545 - 150, y - 2, { width: 150 });
      } else {
        doc.font('KB').fontSize(10).fillColor('#000').text(hospitalName, 50, y, { width: 495, align: 'right', lineBreak: false });
      }
    }

    doc.end();
  } catch (err) {
    console.error('구매결의서 PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'PDF 생성 실패' });
  }
});

// ── POST /gian-pdf — 기안서 PDF (실제 양식 기반) ──────────────────
router.post('/gian-pdf', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: '발주서를 선택해주세요.' });

    const poList = await (prisma as any).purchaseOrder.findMany({
      where: { id: { in: ids }, deleted_at: null },
      include: { vendor: true, po_items: { include: { item: true }, orderBy: { item: { item_code: 'asc' } } } },
      orderBy: { ordered_at: 'asc' },
    });
    if (poList.length === 0) return res.status(400).json({ error: '조회된 발주서가 없습니다.' });

    const setting = await (prisma as any).appSetting.findUnique({ where: { key: 'HOSPITAL_NAME' } });
    const hospitalName = (setting?.value as string) ?? '병원';
    const fonts = getFonts();
    const userName: string = (req.user as any)?.display_name ?? '';

    // Form inputs
    const docType = String(req.body?.doc_type || 'poomui');
    const docNo = String(req.body?.doc_no || '').trim();
    const docDateInput = String(req.body?.doc_date || '').trim();
    const enforceDate = String(req.body?.enforce_date || '재가 후 즉시').trim();
    const coopDept = String(req.body?.coop_dept || '').trim();
    const retention = String(req.body?.retention || '1년').trim();
    const titleInput = String(req.body?.title || '').trim() || '물품 구매의 건';
    const contentInput = String(req.body?.content || '').trim();
    const paymentMethod = String(req.body?.payment_method || '').trim();
    const attachment = String(req.body?.attachment || '').trim();

    const docDate = docDateInput ? new Date(docDateInput) : new Date();
    const docDateStr = `${docDate.getFullYear()}년 ${String(docDate.getMonth() + 1).padStart(2, '0')}월 ${String(docDate.getDate()).padStart(2, '0')}일`;

    // Merge items grouped by vendor
    const vendorItemMap = new Map<string, { vendorName: string; items: { name: string; uom: string; qty: number; price: number }[] }>();
    for (const po of poList) {
      const vid = po.vendor_id;
      if (!vendorItemMap.has(vid)) vendorItemMap.set(vid, { vendorName: po.vendor?.name ?? '', items: [] });
      for (const it of po.po_items ?? []) {
        const existing = vendorItemMap.get(vid)!.items.find(x => x.name === (it.item?.name ?? ''));
        if (existing) { existing.qty += Number(it.ordered_qty); }
        else { vendorItemMap.get(vid)!.items.push({ name: it.item?.name ?? '', uom: it.item?.purchase_uom ?? it.item?.uom ?? '', qty: Number(it.ordered_qty), price: Number(it.unit_price) }); }
      }
    }

    // PDF setup
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="gian.pdf"`);
    doc.pipe(res);
    doc.registerFont('K', fonts.regular).registerFont('KB', fonts.bold);

    const LX = 40;            // left margin
    const RX = 555;           // right edge
    const TW = RX - LX;      // total width
    const STROKE = '#555';

    // ── "기 안 서" 제목 ──
    doc.font('KB').fontSize(22).fillColor('#000')
      .text('기  안  서', LX, 40, { width: TW, align: 'center', lineBreak: false });

    // ── 상단 정보 테이블 + 결재란 ──
    const tblTop = 80;
    const leftLabelW = 70;    // 기안구분, 문서번호 등 라벨 칸
    const leftValW = 140;     // 값 칸
    const leftW = leftLabelW + leftValW;  // 210
    const rightW = TW - leftW;            // 305
    const rowH = 22;
    const infoRows = 6;       // 기안구분, 문서번호, 기안일자, 시행일자, 기안부서, 기안자
    const infoH = infoRows * rowH;        // 132

    // 결재란 dimensions
    const APPROVAL_LABELS = ['담당', '부서장', '행정원장', '상임이사', '이사장'];
    const apprLabelW = 28;    // "결재" 세로 라벨
    const apprCellW = (rightW - apprLabelW) / APPROVAL_LABELS.length;
    const apprHeaderH = 20;
    const apprBodyH = 3 * rowH - apprHeaderH; // 결재란 = 상단 3행과 높이 맞춤

    // Draw info rows (left side)
    const infoLabels = ['기안구분', '문서번호', '기안일자', '시행일자', '기안부서', '기 안 자'];
    const docTypeLabel = docType === 'bogo' ? '■보고  □품의  □협조' : docType === 'hyupjo' ? '■협조  □품의  □보고' : '■품의  □보고  □협조';
    const infoValues = [docTypeLabel, docNo || '-', docDateStr, enforceDate, '총 무 부', userName];

    for (let i = 0; i < infoRows; i++) {
      const ry = tblTop + i * rowH;
      // label cell
      doc.rect(LX, ry, leftLabelW, rowH).stroke(STROKE);
      doc.font('KB').fontSize(9).fillColor('#000')
        .text(infoLabels[i], LX + 4, ry + (rowH - 9) / 2, { width: leftLabelW - 8, align: 'center', lineBreak: false });
      // value cell
      doc.rect(LX + leftLabelW, ry, leftValW, rowH).stroke(STROKE);
      doc.font('K').fontSize(9).fillColor('#000')
        .text(infoValues[i], LX + leftLabelW + 6, ry + (rowH - 9) / 2, { width: leftValW - 12, lineBreak: false });
    }

    // Draw approval area (right side, top portion)
    const apprTop = tblTop;
    // "결재" vertical label
    doc.rect(LX + leftW, apprTop, apprLabelW, apprHeaderH + apprBodyH).stroke(STROKE);
    doc.font('KB').fontSize(9).fillColor('#000')
      .text('결', LX + leftW + 2, apprTop + 10, { width: apprLabelW - 4, align: 'center', lineBreak: false });
    doc.font('KB').fontSize(9)
      .text('재', LX + leftW + 2, apprTop + 24, { width: apprLabelW - 4, align: 'center', lineBreak: false });

    // Approval header + body cells
    for (let i = 0; i < APPROVAL_LABELS.length; i++) {
      const ax = LX + leftW + apprLabelW + i * apprCellW;
      // header
      doc.rect(ax, apprTop, apprCellW, apprHeaderH).stroke(STROKE);
      doc.font('KB').fontSize(8).fillColor('#000')
        .text(APPROVAL_LABELS[i], ax, apprTop + (apprHeaderH - 8) / 2, { width: apprCellW, align: 'center', lineBreak: false });
      // body (signature space)
      doc.rect(ax, apprTop + apprHeaderH, apprCellW, apprBodyH).stroke(STROKE);
    }

    // Draw 협조부서 area (right side, below approval)
    const coopTop = apprTop + apprHeaderH + apprBodyH;
    const coopH = infoH - apprHeaderH - apprBodyH; // remaining height
    const coopLabelW = apprLabelW;  // 28
    const retLabelW = 60;
    const retValW = rightW - coopLabelW - retLabelW;

    // "협조부서" vertical label
    doc.rect(LX + leftW, coopTop, coopLabelW, coopH).stroke(STROKE);
    const coopChars = ['협', '조', '부', '서'];
    coopChars.forEach((ch, ci) => {
      doc.font('KB').fontSize(9).fillColor('#000')
        .text(ch, LX + leftW + 2, coopTop + 4 + ci * 12, { width: coopLabelW - 4, align: 'center', lineBreak: false });
    });

    // Coop dept content area
    doc.rect(LX + leftW + coopLabelW, coopTop, rightW - coopLabelW, coopH).stroke(STROKE);
    if (coopDept) {
      doc.font('K').fontSize(9).fillColor('#000')
        .text(coopDept, LX + leftW + coopLabelW + 6, coopTop + 6, { width: rightW - coopLabelW - 12 });
    }

    // 보존연한 (inside coop area, top-right)
    const retTop = coopTop;
    const retX = RX - retLabelW - retValW;
    doc.font('KB').fontSize(8).fillColor('#555')
      .text('보존년한', retX, retTop + 4, { width: retLabelW, align: 'right', lineBreak: false });
    doc.font('K').fontSize(9).fillColor('#000')
      .text(retention, retX + retLabelW + 4, retTop + 4, { width: retValW - 8, lineBreak: false });

    // ── 제목 행 (전체 너비) ──
    const titleRowY = tblTop + infoH;
    doc.rect(LX, titleRowY, leftLabelW, rowH).stroke(STROKE);
    doc.font('KB').fontSize(9).fillColor('#000')
      .text('제  목', LX + 4, titleRowY + (rowH - 9) / 2, { width: leftLabelW - 8, align: 'center', lineBreak: false });
    doc.rect(LX + leftLabelW, titleRowY, TW - leftLabelW, rowH).stroke(STROKE);
    doc.font('K').fontSize(9).fillColor('#000')
      .text(titleInput, LX + leftLabelW + 8, titleRowY + (rowH - 9) / 2, { width: TW - leftLabelW - 16, lineBreak: false });

    // ── 본문 영역 (외곽선) ──
    let y = titleRowY + rowH;
    const bodyTop = y;

    // 본문 내용
    y += 16;
    if (contentInput) {
      const contentOpts = { width: TW - 40, lineGap: 4 };
      doc.font('K').fontSize(9).fillColor('#000').text(contentInput, LX + 20, y, contentOpts);
      y += doc.font('K').fontSize(9).heightOfString(contentInput, contentOpts) + 12;
    }

    // "- 아 래 -"
    y += 8;
    doc.font('KB').fontSize(9).fillColor('#000')
      .text('-  아  래  -', LX, y, { width: TW, align: 'center', lineBreak: false });
    y += 22;

    // "1. 구매내용"  + "(단위: 원)"
    doc.font('KB').fontSize(9).fillColor('#000').text('1. 구매내용', LX + 16, y, { lineBreak: false });
    doc.font('K').fontSize(8).fillColor('#555').text('(단위: 원)', RX - 60, y + 1, { width: 50, align: 'right', lineBreak: false });
    y += 18;

    // ── 품목 테이블 ──
    const tCols = [25, 80, 120, 55, 75, 100];  // No, 업체, 내용, 수량, 단가, 금액
    const tHdrs = ['No', '업체', '내용', '수량', '단가', '금액'];
    const tblLX = LX + 16;
    const tblW = tCols.reduce((a, b) => a + b, 0);
    const tRowH = 20;

    function drawTblRow(cells: string[], rowY: number, isHeader: boolean): number {
      const rh = isHeader ? 22 : tRowH;
      if (isHeader) { doc.rect(tblLX, rowY, tblW, rh).fill('#e8edf5'); }
      let x = tblLX;
      for (let i = 0; i < tCols.length; i++) {
        doc.rect(x, rowY, tCols[i], rh).stroke(isHeader ? '#555' : '#bbb');
        // 헤더: 전체 가운데, 데이터: No/업체/내용/수량 = 가운데, 단가/금액 = 오른쪽
        const align: 'left' | 'center' | 'right' = isHeader ? 'center' : (i >= 4 ? 'right' : 'center');
        const fs = isHeader ? 9 : 8;
        const padL = 4;
        const padR = i >= 4 ? 6 : 4;
        doc.font(isHeader ? 'KB' : 'K').fontSize(fs).fillColor('#000')
          .text(cells[i] ?? '', x + padL, rowY + (rh - fs) / 2 - 1, { width: tCols[i] - padL - padR, align, lineBreak: false });
        x += tCols[i];
      }
      return rowY + rh;
    }

    y = drawTblRow(tHdrs, y, true);
    let grandTotal = 0;
    let rowNo = 1;
    for (const [, vg] of vendorItemMap) {
      for (const it of vg.items) {
        if (y > 720) { doc.addPage(); y = 40; y = drawTblRow(tHdrs, y, true); }
        const amt = it.qty * it.price;
        grandTotal += amt;
        y = drawTblRow([String(rowNo++), vg.vendorName, it.name, it.qty.toLocaleString('ko-KR'), it.price.toLocaleString('ko-KR'), amt.toLocaleString('ko-KR')], y, false);
      }
    }

    // 합계 row
    {
      const rh = tRowH;
      const sumLabelW = tCols[0] + tCols[1] + tCols[2] + tCols[3] + tCols[4];
      doc.rect(tblLX, y, sumLabelW, rh).stroke('#555');
      doc.rect(tblLX + sumLabelW, y, tCols[5], rh).stroke('#555');
      doc.font('KB').fontSize(9).fillColor('#000')
        .text('합계(VAT포함)', tblLX, y + (rh - 9) / 2, { width: sumLabelW, align: 'center', lineBreak: false });
      doc.font('KB').fontSize(9)
        .text(grandTotal.toLocaleString('ko-KR'), tblLX + sumLabelW + 4, y + (rh - 9) / 2, { width: tCols[5] - 10, align: 'right', lineBreak: false });
      y += rh;
    }

    y += 16;

    // "2. 결제방법"
    if (paymentMethod) {
      doc.font('KB').fontSize(9).fillColor('#000').text(`2. 결제방법: `, LX + 16, y, { continued: true, lineBreak: false });
      doc.font('K').fontSize(9).text(paymentMethod, { lineBreak: false });
      y += 20;
    }

    y += 12;

    // 붙임
    if (attachment) {
      doc.font('KB').fontSize(9).fillColor('#000').text('붙  임: ', LX + 4, y, { continued: true, lineBreak: false });
      doc.font('K').fontSize(9).text(`${attachment}.  끝`, { lineBreak: false });
      y += 20;
    }

    // 본문 영역 외곽선 (bodyTop ~ y+10)
    const bodyBottom = Math.max(y + 20, 700);
    doc.rect(LX, bodyTop, TW, bodyBottom - bodyTop).stroke(STROKE);

    // ── 로고 (우하단) ──
    y = bodyBottom + 10;
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, RX - 150, y - 2, { width: 150 });
    } else {
      doc.font('KB').fontSize(10).fillColor('#000')
        .text(hospitalName, LX, y, { width: TW, align: 'right', lineBreak: false });
    }

    doc.end();
  } catch (err) {
    console.error('기안서 PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'PDF 생성 실패' });
  }
});

// ── GET /:id/pdf — 발주서 PDF 생성 ──────────────────────────────────
router.get('/:id/pdf', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const poId = String(req.params.id);
    const po = await (prisma as any).purchaseOrder.findUnique({
      where: { id: poId },
      include: {
        vendor: true,
        creator: true,
        po_items: { include: { item: true } },
        sources: { include: { ward_request: { include: {
          department: true,
          items: true,
          approval_actions: { include: { items: true }, orderBy: { created_at: 'desc' as const }, take: 1 },
        } } } },
      },
    });
    if (!po) return res.status(404).json({ error: 'Purchase order not found.' });

    // 기저귀(DIAPER) 신청 source 들에서 품목별 부서 분배 누적 — 비고 sub-row 표시용
    const itemDeptQtyMap = new Map<string, Map<string, number>>(); // itemId → (deptName → 팩수)
    for (const src of (po.sources ?? [])) {
      const wr = src.ward_request;
      if (!wr || wr.request_type !== 'DIAPER') continue;
      const deptName: string = wr.department?.name ?? '';
      if (!deptName) continue;
      const action = (wr.approval_actions ?? [])[0];
      const approvedMap = new Map<string, number>();
      for (const ai of (action?.items ?? [])) {
        if (ai.item_id) approvedMap.set(ai.item_id, Number(ai.approved_qty));
      }
      for (const ri of wr.items ?? []) {
        if (!ri.item_id) continue;
        const qty = approvedMap.get(ri.item_id) ?? Number(ri.requested_qty);
        if (qty <= 0) continue;
        if (!itemDeptQtyMap.has(ri.item_id)) itemDeptQtyMap.set(ri.item_id, new Map());
        const dm = itemDeptQtyMap.get(ri.item_id)!;
        dm.set(deptName, (dm.get(deptName) ?? 0) + qty);
      }
    }

    function formatQtyAsBoxPack(qty: number, packSize: number): string {
      const ps = Math.max(1, packSize);
      const box = Math.floor(qty / ps);
      const pack = qty - box * ps;
      if (box > 0 && pack > 0) return `${box}박스 ${pack}팩`;
      if (box > 0) return `${box}박스`;
      return `${pack}팩`;
    }

    const setting = await (prisma as any).appSetting.findUnique({ where: { key: 'HOSPITAL_NAME' } });
    const hospitalName = (setting?.value as string) ?? '병원';
    const fonts = getFonts();

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${po.po_no}.pdf"`);
    doc.pipe(res);

    doc.registerFont('K', fonts.regular).registerFont('KB', fonts.bold);

    // ── 결재란 (우측 상단) ────────────────────────────────────────────
    const APPROVAL_LABELS = ['담당', '부서장', '행정원장', '상임이사', '이사장'];
    const bW2 = 53, bH2 = 58, bStartY2 = 50;
    const bStartX2 = 545 - APPROVAL_LABELS.length * bW2;
    APPROVAL_LABELS.forEach((label, i) => {
      const x = bStartX2 + i * bW2;
      doc.rect(x, bStartY2, bW2, bH2).stroke('#888888');
      doc.moveTo(x, bStartY2 + 20).lineTo(x + bW2, bStartY2 + 20).stroke('#999999');
      doc.font('KB').fontSize(9).fillColor('#000')
        .text(label, x, bStartY2 + 5, { width: bW2, align: 'center', lineBreak: false });
    });

    // ── 제목 ─────────────────────────────────────────────────────────
    let y = bStartY2 + bH2 + 14;
    doc.font('KB').fontSize(20).fillColor('#000')
      .text('발  주  서', 50, y, { width: 495, align: 'center', lineBreak: false });
    y += 28;
    doc.font('K').fontSize(10)
      .text(`발주번호: ${po.po_no}`, 50, y, { width: 495, align: 'center', lineBreak: false });
    y += 18;

    doc.moveTo(50, y).lineTo(545, y).stroke('#cccccc');
    y += 12;

    // ── 수신 / 발주일 / 납기일 / 담당자 ─────────────────────────────
    const ordered = new Date(po.ordered_at).toLocaleDateString('ko-KR');
    const expected = po.expected_at ? new Date(po.expected_at).toLocaleDateString('ko-KR') : '-';
    const vendorName: string = po.vendor?.name ?? '';
    const creatorName: string = po.creator?.display_name ?? '';

    doc.font('K').fontSize(10).fillColor('#000')
      .text(`수  신:  ${vendorName}`, 50, y, { width: 260, lineBreak: false });
    doc.font('K').fontSize(10)
      .text(`발  주  일:  ${ordered}`, 330, y, { width: 215, lineBreak: false });
    y += 16;
    doc.font('K').fontSize(10).fillColor('#000')
      .text(`납  기  일:  ${expected}`, 50, y, { width: 260, lineBreak: false });
    doc.font('K').fontSize(10)
      .text(`담  당  자:  ${creatorName}`, 330, y, { width: 215, lineBreak: false });
    y += 20;

    doc.moveTo(50, y).lineTo(545, y).stroke('#cccccc');
    y += 12;

    doc.font('K').fontSize(10).fillColor('#000')
      .text('아래와 같이 발주합니다.', 50, y, { lineBreak: false });
    y += 18;

    // ── 품목 테이블 ──────────────────────────────────────────────────
    // 컬럼: 번호(30) + 품목명(195) + 단위(45) + 수량(55) + 단가(80) + 금액(90) = 495
    const cols = [30, 195, 45, 55, 80, 90];
    const hdrs = ['번호', '품목명', '단위', '수량', '단가', '금액'];

    function drawRow(cells: string[], rowY: number, isHeader: boolean): number {
      const rowH = isHeader ? 20 : 16;
      if (isHeader) {
        doc.rect(50, rowY, 495, rowH).fill('#f0f0f0');
        doc.rect(50, rowY, 495, rowH).stroke('#999999');
      }
      let x = 50;
      for (let i = 0; i < cols.length; i++) {
        doc.rect(x, rowY, cols[i], rowH).stroke(isHeader ? '#999999' : '#cccccc');
        const align: 'left' | 'center' | 'right' = i >= 3 ? 'right' : i === 1 ? 'left' : 'center';
        const padL = 3, padR = i >= 3 ? 5 : 3;
        doc.font(isHeader ? 'KB' : 'K').fontSize(8).fillColor('#000')
          .text(cells[i] ?? '', x + padL, rowY + (rowH - 9) / 2, {
            width: cols[i] - padL - padR,
            align,
            lineBreak: false,
          });
        x += cols[i];
      }
      return rowY + rowH;
    }

    y = drawRow(hdrs, y, true);

    const items: any[] = po.po_items ?? [];
    let totalAmt = 0;

    for (let idx = 0; idx < items.length; idx++) {
      if (y > 740) { doc.addPage(); y = 50; y = drawRow(hdrs, y, true); }
      const it = items[idx];
      const qty = Number(it.ordered_qty);
      const price = Number(it.unit_price);
      const amt = qty * price;
      totalAmt += amt;
      // 단위 — 발주 단위(purchase_uom). 없으면 legacy uom 폴백.
      const unit = it.item?.purchase_uom || it.item?.uom || '';
      y = drawRow([
        String(idx + 1),
        it.item?.name ?? '',
        unit,
        qty.toLocaleString('ko-KR'),
        price.toLocaleString('ko-KR'),
        amt.toLocaleString('ko-KR'),
      ], y, false);
    }

    // 합계 행
    const sumH = 18;
    const labelEndX = 50 + cols[0] + cols[1] + cols[2] + cols[3]; // 325
    const priceEndX = labelEndX + cols[4]; // 405
    doc.rect(50, y, labelEndX - 50, sumH).stroke('#999999');
    doc.rect(labelEndX, y, cols[4], sumH).stroke('#999999');
    doc.rect(priceEndX, y, cols[5], sumH).stroke('#999999');
    doc.font('KB').fontSize(8).fillColor('#000')
      .text('합  계', 50, y + (sumH - 9) / 2, { width: labelEndX - 54, align: 'right', lineBreak: false });
    doc.font('KB').fontSize(8).fillColor('#000')
      .text(totalAmt.toLocaleString('ko-KR'), priceEndX + 3, y + (sumH - 9) / 2, { width: cols[5] - 8, align: 'right', lineBreak: false });
    y += sumH;

    // ── 병동별 기저귀 분배 매트릭스 테이블 ───────────────────────────────────
    const diaperItems = Array.from(itemDeptQtyMap.entries())
      .filter(([itemId]) => {
        const item = po.po_items?.find(pi => pi.item_id === itemId);
        return item && String(item.item?.category ?? '').startsWith('DIAPER');
      })
      .sort((a, b) => {
        const nameA = po.po_items?.find(pi => pi.item_id === a[0])?.item?.name ?? '';
        const nameB = po.po_items?.find(pi => pi.item_id === b[0])?.item?.name ?? '';
        return nameA.localeCompare(nameB, 'ko');
      });

    if (diaperItems.length > 0) {
      y += 16;

      // 모든 부서 수집 및 정렬
      const allDepts = new Set<string>();
      for (const [, deptMap] of diaperItems) {
        for (const dept of deptMap.keys()) allDepts.add(dept);
      }
      const sortedDepts = Array.from(allDepts).sort((a, b) => a.localeCompare(b, 'ko'));

      // 매트릭스 테이블 크기 계산
      const matrixColCount = sortedDepts.length + 2; // 품목명 + 각 부서 + 합계
      const matrixColWidths: number[] = [220, ...sortedDepts.map(() => 35), 50]; // 품목명(220) + 부서(35) + 합계(50)
      const totalMatrixWidth = matrixColWidths.reduce((a, b) => a + b, 0);
      const matrixStartX = 50 + (495 - totalMatrixWidth) / 2;

      // 헤더 행: 품목명 + 부서들 + 합계
      const headerCells = ['품목명', ...sortedDepts, '합계'];
      let matrixY = y;
      for (let i = 0; i < headerCells.length; i++) {
        const x = matrixStartX + matrixColWidths.slice(0, i).reduce((a, b) => a + b, 0);
        const w = matrixColWidths[i];
        const h = 18;
        doc.rect(x, matrixY, w, h).fill('#f0f0f0').stroke('#999999');
        doc.font('KB').fontSize(7).fillColor('#000')
          .text(headerCells[i], x + 2, matrixY + (h - 8) / 2, {
            width: w - 4,
            align: 'center',
            lineBreak: false,
          });
      }
      matrixY += 18;

      // 데이터 행: 각 기저귀 품목
      for (const [itemId, deptMap] of diaperItems) {
        const item = po.po_items?.find(pi => pi.item_id === itemId)?.item;
        if (!item) continue;

        // 부서별 수량 행
        const packSize = Math.max(1, Number(item.pack_size ?? 1));
        let rowTotal = 0;
        for (const qty of deptMap.values()) rowTotal += qty;

        // 품목명 셀
        let x = matrixStartX;
        let h = 16;
        doc.rect(x, matrixY, matrixColWidths[0], h).stroke('#cccccc');
        doc.font('K').fontSize(7).fillColor('#000')
          .text((item.name ?? '').substring(0, 30), x + 2, matrixY + (h - 7) / 2, {
            width: matrixColWidths[0] - 4,
            align: 'left',
            lineBreak: false,
          });

        // 부서별 수량 셀
        for (let i = 0; i < sortedDepts.length; i++) {
          x += matrixColWidths[i];
          const dept = sortedDepts[i];
          const qty = deptMap.get(dept) ?? 0;
          const label = qty > 0 ? formatQtyAsBoxPack(qty, packSize) : '-';
          doc.rect(x, matrixY, matrixColWidths[i + 1], h).stroke('#cccccc');
          doc.font('K').fontSize(7).fillColor('#000')
            .text(label, x + 1, matrixY + (h - 7) / 2, {
              width: matrixColWidths[i + 1] - 2,
              align: 'center',
              lineBreak: false,
            });
        }

        // 합계 셀
        x += matrixColWidths[sortedDepts.length];
        const totalLabel = formatQtyAsBoxPack(rowTotal, packSize);
        doc.rect(x, matrixY, matrixColWidths[matrixColCount - 1], h).stroke('#cccccc');
        doc.font('KB').fontSize(7).fillColor('#000')
          .text(totalLabel, x + 1, matrixY + (h - 7) / 2, {
            width: matrixColWidths[matrixColCount - 1] - 2,
            align: 'center',
            lineBreak: false,
          });

        matrixY += h;
      }
      y = matrixY;
    }

    // ── 비고 ─────────────────────────────────────────────────────────
    if (po.note) {
      y += 12;
      doc.font('K').fontSize(9).fillColor('#000')
        .text(`비  고:  ${po.note}`, 50, y, { width: 495, lineBreak: false });
      y += 16;
    }

    // ── 병원명 (우측) ────────────────────────────────────────────────
    y += 24;
    doc.font('KB').fontSize(11).fillColor('#000')
      .text(hospitalName, 50, y, { width: 495, align: 'right', lineBreak: false });

    doc.end();
  } catch (err) {
    console.error('PDF generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'PDF 생성 실패' });
  }
});

export default router;




