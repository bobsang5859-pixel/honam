import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { getMajor, type MajorGroup } from '../../shared/types';

const RECEIPT_EDITABLE_STATUSES = new Set(['RECEIPT_PENDING', 'RECEIPT_DIFF']);
const DEFAULT_RECEIPT_STATUSES = ['RECEIPT_PENDING', 'RECEIPT_DIFF'] as const;
const SLA_HOURS = 24;
const SLA_MS = SLA_HOURS * 60 * 60 * 1000;

const SCHEDULED_REQUEST_TYPES = new Set([
  'CONSUMABLE_MEDICAL',
  'CONSUMABLE_REGULAR',
  'CONSUMABLE_OFFICE',
  'DIAPER',
  'NIGHT_SNACK',
]);

function formatMonthLabel(dateLike: Date | string | null | undefined): string {
  const d = dateLike ? new Date(dateLike) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function pickDeptLocationId(tx: any, departmentId: string): Promise<string | null> {
  const existing = await tx.inventoryLocation.findFirst({
    where: { department_id: departmentId, deleted_at: null, is_active: true },
    select: { id: true },
    orderBy: { code: 'asc' },
  });
  if (existing) return existing.id;

  const dept = await tx.department.findUnique({ where: { id: departmentId }, select: { name: true } });
  const loc = await tx.inventoryLocation.create({
    data: {
      id: uuidv4(),
      code: `DEPT-${departmentId.slice(0, 8).toUpperCase()}`,
      name: `${dept?.name ?? '부서'} 보관함`,
      department_id: departmentId,
      is_active: true,
    } as any,
  });
  return loc.id;
}

export class ReceiptServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ReceiptViewer = {
  user_id: string;
  department_id: string | null;
  is_admin_like: boolean;
};

export type StockOutReceiptQueueRow = {
  id: string;
  so_no: string;
  department_id: string;
  department_name: string;
  issued_at: Date;
  status: string;
  receipt_confirmed_at: Date | null;
  receipt_diff_count: number;
  item_count: number;
  sla_due_at: Date;
  is_overdue: boolean;
  ward_request_id: string | null;
  request_type: string | null;
  period_label: string | null;
  period_start: Date | null;
  category_breakdown: Partial<Record<MajorGroup, number>>;
};

export type StockOutReceiptQueueResponse = {
  meta: {
    pending_count: number;
    overdue_count: number;
    total_count: number;
  };
  rows: StockOutReceiptQueueRow[];
};

function canAccessDepartment(viewer: ReceiptViewer, departmentId: string): boolean {
  if (viewer.is_admin_like) return true;
  return viewer.department_id === departmentId;
}

function parseStatusQuery(statusQuery?: string): string[] {
  const raw = String(statusQuery ?? '').trim();
  if (!raw) return [...DEFAULT_RECEIPT_STATUSES];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseTruthy(value: unknown): boolean {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'y' || raw === 'yes';
}

function ensureCanConfirmDepartment(viewer: ReceiptViewer, departmentId: string) {
  if (viewer.department_id !== departmentId) {
    throw new ReceiptServiceError(403, 'Only the target department can confirm receipt.');
  }
}

export async function listReceiptQueue(params: {
  status_query?: string;
  department_id_query?: string;
  overdue_only?: unknown;
  viewer: ReceiptViewer;
  now?: Date;
}): Promise<StockOutReceiptQueueResponse> {
  const statuses = parseStatusQuery(params.status_query);
  const overdueOnly = parseTruthy(params.overdue_only);

  const where: any = {
    deleted_at: null,
    status: { in: statuses },
  };

  if (!params.viewer.is_admin_like) {
    if (!params.viewer.department_id) {
      return {
        meta: { pending_count: 0, overdue_count: 0, total_count: 0 },
        rows: [],
      };
    }
    where.department_id = params.viewer.department_id;
  } else if (params.department_id_query) {
    where.department_id = String(params.department_id_query);
  }

  const rows = await prisma.stockOut.findMany({
    where,
    include: {
      department: true,
      items: { include: { item: { select: { category: true } } } },
      ward_request: { select: { id: true, request_type: true, period_start: true } },
    } as any,
    orderBy: { issued_at: 'desc' },
  });

  // 주차 라벨 매핑 — workboard 와 동일한 RequestSchedule 기반
  const neededTypes = Array.from(
    new Set(
      rows
        .map((so: any) => String(so.ward_request?.request_type ?? ''))
        .filter((t: string) => t && SCHEDULED_REQUEST_TYPES.has(t)),
    ),
  );
  const schedules: any[] = neededTypes.length > 0
    ? await (prisma as any).requestSchedule.findMany({
        where: { request_type: { in: neededTypes } },
        orderBy: { open_from: 'asc' },
      })
    : [];
  const schedulesByType = new Map<string, { open_from: Date; open_to: Date; period_label: string }[]>();
  for (const s of schedules) {
    const arr = schedulesByType.get(String(s.request_type)) ?? [];
    arr.push({
      open_from: new Date(s.open_from),
      open_to: new Date(s.open_to),
      period_label: String(s.period_label ?? ''),
    });
    schedulesByType.set(String(s.request_type), arr);
  }
  const resolvePeriodLabel = (rt: string, periodStart: Date | null) => {
    if (!periodStart) return '';
    if (SCHEDULED_REQUEST_TYPES.has(rt)) {
      const arr = schedulesByType.get(rt) ?? [];
      const m = arr.find((s) => s.open_from <= periodStart && periodStart <= s.open_to);
      if (m) return m.period_label || formatMonthLabel(periodStart);
    }
    return formatMonthLabel(periodStart);
  };

  const now = params.now ?? new Date();
  const mappedRows: StockOutReceiptQueueRow[] = rows.map((so: any) => {
    const issuedAt = new Date(so.issued_at);
    const dueAt = new Date(issuedAt.getTime() + SLA_MS);
    const isOverdue = String(so.status) === 'RECEIPT_PENDING' && dueAt.getTime() < now.getTime();
    const wr = so.ward_request ?? null;
    const requestType = String(wr?.request_type ?? '');
    const periodStart = wr?.period_start ? new Date(wr.period_start) : null;
    // 수동 라벨이 있으면 우선 — ADHOC 등 ward_request 가 없거나 사용자가 직접 주차 지정한 경우
    const manualLabel = String((so as any).manual_period_label ?? '').trim();
    const periodLabel = manualLabel || (wr ? resolvePeriodLabel(requestType, periodStart) : '');

    // 카테고리 분포 (의료/일반/사무/기저귀/비품)
    const breakdown: Partial<Record<MajorGroup, number>> = {};
    for (const it of so.items ?? []) {
      const cat = String(it.item?.category ?? '');
      const major = getMajor(cat);
      breakdown[major] = (breakdown[major] ?? 0) + 1;
    }

    return {
      id: String(so.id),
      so_no: String(so.so_no),
      department_id: String(so.department_id),
      department_name: String(so.department?.name ?? ''),
      issued_at: issuedAt,
      status: String(so.status),
      receipt_confirmed_at: so.receipt_confirmed_at ?? null,
      receipt_diff_count: Number(so.receipt_diff_count ?? 0),
      item_count: (so.items ?? []).length,
      sla_due_at: dueAt,
      is_overdue: isOverdue,
      ward_request_id: wr?.id ?? null,
      request_type: requestType || null,
      period_label: periodLabel || null,
      period_start: periodStart,
      category_breakdown: breakdown,
    };
  });

  const pendingCount = mappedRows.filter((row) => row.status === 'RECEIPT_PENDING').length;
  const overdueCount = mappedRows.filter((row) => row.is_overdue).length;
  const filteredRows = overdueOnly ? mappedRows.filter((row) => row.is_overdue) : mappedRows;

  return {
    meta: {
      pending_count: pendingCount,
      overdue_count: overdueCount,
      total_count: mappedRows.length,
    },
    rows: filteredRows,
  };
}

export async function getReceiptDetail(stockOutId: string, viewer: ReceiptViewer) {
  const so = await prisma.stockOut.findUnique({
    where: { id: stockOutId },
    include: {
      department: true,
      items: {
        include: { item: true, location: true },
        orderBy: { item: { item_code: 'asc' } },
      },
    },
  });
  if (!so || so.deleted_at) throw new ReceiptServiceError(404, 'Stock-out not found.');
  if (!canAccessDepartment(viewer, so.department_id)) throw new ReceiptServiceError(403, 'No permission.');

  // FIFO 분할 내역 — stock_out_lot_allocations + inventory_lots(received_at, gr.note 로 기초재고 표시)
  // 사용자가 "이 라인은 어느 lot 에서 얼마씩 차감, 평균 단가는?" 을 볼 수 있게 함께 반환.
  const stockOutItemIds = (so.items ?? []).map((it: any) => String(it.id));
  type AllocRow = {
    id: string; stock_out_item_id: string; inventory_lot_id: string | null;
    issued_qty: number; unit_cost: number; line_amount: number;
    lot_received_at: string | null; lot_is_base: number;
  };
  const allocRows: AllocRow[] = stockOutItemIds.length
    ? await (prisma as any).$queryRawUnsafe(
        `SELECT a.id, a.stock_out_item_id, a.inventory_lot_id,
                a.issued_qty, a.unit_cost, a.line_amount,
                l.received_at AS lot_received_at,
                CASE WHEN gr.note LIKE '[기초재고]%' OR gr.note LIKE '[실사 신규 lot]%' THEN 1 ELSE 0 END AS lot_is_base
           FROM stock_out_lot_allocations a
           LEFT JOIN inventory_lots l   ON l.id = a.inventory_lot_id
           LEFT JOIN goods_receipts gr  ON gr.id = l.goods_receipt_id
          WHERE a.stock_out_item_id IN (${stockOutItemIds.map(() => '?').join(',')})
          ORDER BY a.stock_out_item_id, l.received_at ASC, a.id ASC`,
        ...stockOutItemIds,
      )
    : [];
  const allocByItem = new Map<string, AllocRow[]>();
  for (const r of allocRows) {
    const k = String(r.stock_out_item_id);
    const arr = allocByItem.get(k) ?? [];
    arr.push(r);
    allocByItem.set(k, arr);
  }

  const items = (so.items ?? []).map((it: any) => {
    const issued = Number(it.issued_qty);
    const received = it.received_qty == null ? null : Number(it.received_qty);
    const allocs = allocByItem.get(String(it.id)) ?? [];
    const totalAmount = allocs.reduce((s, a) => s + Number(a.line_amount || 0), 0);
    const totalQty = allocs.reduce((s, a) => s + Number(a.issued_qty || 0), 0);
    const avgUnitCost = totalQty > 0 ? totalAmount / totalQty : 0;
    const isMultiLot = allocs.length > 1;
    const hasFallback = allocs.some(a => !a.inventory_lot_id);
    return {
      id: String(it.id),
      item_id: String(it.item_id),
      item_name: it.item?.name,
      item_code: it.item?.item_code,
      uom: it.item?.uom,
      location_id: String(it.location_id),
      location_name: it.location?.name,
      issued_qty: issued,
      received_qty: received,
      diff_qty: received == null ? 0 : received - issued,
      receipt_note: String(it.receipt_note ?? ''),
      receipt_confirmed_at: it.receipt_confirmed_at,
      // FIFO 비용 정보 — 사용자가 "어느 단가가 비용으로 잡혔는지" 직접 확인 가능
      fifo_total_amount: Number(totalAmount.toFixed(2)),
      fifo_avg_unit_cost: Number(avgUnitCost.toFixed(4)),
      fifo_is_multi_lot: isMultiLot,
      fifo_has_fallback: hasFallback,
      fifo_allocations: allocs.map(a => ({
        lot_id: a.inventory_lot_id,
        is_base: !!a.lot_is_base,
        received_at: a.lot_received_at,
        issued_qty: Number(a.issued_qty),
        unit_cost: Number(a.unit_cost),
        line_amount: Number(a.line_amount),
      })),
    };
  });

  return {
    id: String(so.id),
    so_no: String(so.so_no),
    department_id: String(so.department_id),
    department_name: (so as any).department?.name,
    issued_at: so.issued_at,
    status: String(so.status),
    receipt_confirmed_at: so.receipt_confirmed_at,
    receipt_diff_count: Number(so.receipt_diff_count ?? 0),
    items,
  };
}

export async function saveReceiptLine(params: {
  stock_out_id: string;
  item_id: string;
  received_qty: number;
  receipt_note: string;
  viewer: ReceiptViewer;
}) {
  if (!Number.isFinite(params.received_qty) || params.received_qty < 0) {
    throw new ReceiptServiceError(400, 'received_qty must be a non-negative number.');
  }

  const so = await prisma.stockOut.findUnique({ where: { id: params.stock_out_id } });
  if (!so || so.deleted_at) throw new ReceiptServiceError(404, 'Stock-out not found.');
  if (!canAccessDepartment(params.viewer, so.department_id)) throw new ReceiptServiceError(403, 'No permission.');
  ensureCanConfirmDepartment(params.viewer, so.department_id);
  if (!RECEIPT_EDITABLE_STATUSES.has(so.status)) {
    throw new ReceiptServiceError(400, `Cannot edit receipt in status ${so.status}.`);
  }

  const line = await prisma.stockOutItem.findUnique({
    where: { stock_out_id_item_id: { stock_out_id: params.stock_out_id, item_id: params.item_id } },
  });
  if (!line) throw new ReceiptServiceError(404, 'Stock-out item not found.');

  const updated = await prisma.stockOutItem.update({
    where: { id: line.id },
    data: {
      received_qty: params.received_qty,
      receipt_note: params.receipt_note,
    } as any,
  });

  return {
    id: String(updated.id),
    item_id: String(updated.item_id),
    issued_qty: Number(updated.issued_qty),
    received_qty: updated.received_qty == null ? null : Number(updated.received_qty),
    receipt_note: String(updated.receipt_note ?? ''),
  };
}

export async function confirmReceipt(params: {
  stock_out_id: string;
  viewer: ReceiptViewer;
}): Promise<{
  status: 'RECEIPT_DIFF' | 'RECEIPT_CONFIRMED';
  receipt_diff_count: number;
  follow_up_count: number;
  follow_up_ids: string[];
}> {
  const so = await prisma.stockOut.findUnique({
    where: { id: params.stock_out_id },
    include: { items: { include: { item: true } } },
  });

  if (!so || so.deleted_at) throw new ReceiptServiceError(404, 'Stock-out not found.');
  if (!canAccessDepartment(params.viewer, so.department_id)) throw new ReceiptServiceError(403, 'No permission.');
  ensureCanConfirmDepartment(params.viewer, so.department_id);
  if (so.status === 'REVERSED') throw new ReceiptServiceError(400, 'Reversed stock-out cannot be confirmed.');
  if (!RECEIPT_EDITABLE_STATUSES.has(so.status)) {
    throw new ReceiptServiceError(400, `Cannot confirm receipt in status ${so.status}.`);
  }

  const missingLine = so.items.find((it: any) => it.received_qty == null);
  if (missingLine) {
    throw new ReceiptServiceError(400, `모든 품목의 실수령수량을 입력해주세요. (${missingLine.item?.name ?? missingLine.item_id})`);
  }

  const diffLines = so.items.filter((it: any) => Number(it.received_qty) !== Number(it.issued_qty));
  const missingReasonLine = diffLines.find((it: any) => !String(it.receipt_note ?? '').trim());
  if (missingReasonLine) {
    throw new ReceiptServiceError(400, `차이 품목의 사유를 입력해주세요. (${missingReasonLine.item?.name ?? missingReasonLine.item_id})`);
  }

  const now = new Date();
  const nextStatus: 'RECEIPT_DIFF' | 'RECEIPT_CONFIRMED' = diffLines.length > 0 ? 'RECEIPT_DIFF' : 'RECEIPT_CONFIRMED';
  const createdFollowUpIds: string[] = [];

  await prisma.$transaction(async (tx) => {
    await tx.stockOutItem.updateMany({
      where: { stock_out_id: params.stock_out_id },
      data: {
        receipt_confirmed_at: now,
        receipt_confirmed_by: params.viewer.user_id,
      } as any,
    });

    await tx.stockOut.update({
      where: { id: params.stock_out_id },
      data: {
        status: nextStatus,
        receipt_confirmed_at: now,
        receipt_confirmed_by: params.viewer.user_id,
        receipt_diff_count: diffLines.length,
      } as any,
    });

    await tx.stockOutFollowUp.updateMany({
      where: {
        stock_out_id: params.stock_out_id,
        status: 'OPEN',
      } as any,
      data: {
        status: 'CANCELLED',
        resolved_at: now,
        resolved_by: params.viewer.user_id,
        note: '[AUTO] 재검수로 기존 후속작업 자동취소',
      } as any,
    });

    for (const line of diffLines as any[]) {
      const issued = toNumber(line.issued_qty);
      const received = toNumber(line.received_qty);
      const diffAbs = Math.abs(received - issued);
      if (diffAbs <= 0) continue;
      const actionType = received < issued ? 'ISSUE_ADD' : 'COLLECT_BACK';
      const created = await tx.stockOutFollowUp.create({
        data: {
          id: uuidv4(),
          stock_out_id: params.stock_out_id,
          department_id: so.department_id,
          item_id: String(line.item_id),
          action_type: actionType,
          diff_qty: diffAbs,
          status: 'OPEN',
          note: String(line.receipt_note ?? '').trim(),
          created_by: params.viewer.user_id,
        } as any,
      });
      createdFollowUpIds.push(String(created.id));
    }

    // 수령검수 확정 시 부서 보관함에 받은 수량 전체를 누적 (자산 아닌 가시화용 — 회계는 출고 시점 비용 인식).
    // 부서 자체 소비분은 시스템이 추적 안 하며, 정기 신청 시 register-stock 으로 절대값 덮어쓰기되어 자동 보정됨.
    const deptLocId = await pickDeptLocationId(tx, so.department_id);
    if (deptLocId) {
      for (const line of so.items as any[]) {
        const receivedQty = toNumber(line.received_qty);
        if (receivedQty <= 0) continue;

        // 가중평균 단가 계산 — 이 라인의 lot allocation 평균 단가 사용
        const allocRows = await tx.$queryRawUnsafe<{ qty: number; amount: number }[]>(
          `SELECT COALESCE(SUM(issued_qty), 0) AS qty, COALESCE(SUM(line_amount), 0) AS amount
           FROM stock_out_lot_allocations WHERE stock_out_item_id = ?`,
          String(line.id),
        );
        const lineAvgCost = allocRows?.[0]?.qty > 0
          ? Number(allocRows[0].amount) / Number(allocRows[0].qty)
          : 0;

        const itemId = String(line.item_id);
        const existing = await tx.inventory.findUnique({
          where: { item_id_location_id: { item_id: itemId, location_id: deptLocId } },
        });
        if (existing) {
          const oldQty = Number(existing.on_hand_qty);
          const oldAvg = Number(existing.avg_unit_cost);
          const newQty = oldQty + receivedQty;
          const newAvg = newQty > 0
            ? (oldQty * oldAvg + receivedQty * lineAvgCost) / newQty
            : 0;
          await tx.inventory.update({
            where: { item_id_location_id: { item_id: itemId, location_id: deptLocId } },
            data: { on_hand_qty: newQty, avg_unit_cost: newAvg } as any,
          });
        } else {
          await tx.inventory.create({
            data: { id: uuidv4(), item_id: itemId, location_id: deptLocId, on_hand_qty: receivedQty, avg_unit_cost: lineAvgCost } as any,
          });
        }
      }
    }
  });

  return {
    status: nextStatus,
    receipt_diff_count: diffLines.length,
    follow_up_count: createdFollowUpIds.length,
    follow_up_ids: createdFollowUpIds,
  };
}

export async function listReceiptFollowUps(stockOutId: string, viewer: ReceiptViewer) {
  const so = await prisma.stockOut.findUnique({
    where: { id: stockOutId },
    select: { id: true, deleted_at: true, department_id: true },
  });
  if (!so || so.deleted_at) throw new ReceiptServiceError(404, 'Stock-out not found.');
  if (!canAccessDepartment(viewer, so.department_id)) throw new ReceiptServiceError(403, 'No permission.');

  const rows = await prisma.stockOutFollowUp.findMany({
    where: { stock_out_id: stockOutId },
    include: {
      item: true,
    },
    orderBy: { created_at: 'desc' },
  });

  return rows.map((row: any) => ({
    id: String(row.id),
    stock_out_id: String(row.stock_out_id),
    item_id: String(row.item_id),
    item_name: row.item?.name ?? '',
    item_code: row.item?.item_code ?? '',
    uom: row.item?.uom ?? '',
    action_type: String(row.action_type),
    diff_qty: toNumber(row.diff_qty),
    status: String(row.status),
    note: String(row.note ?? ''),
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  }));
}
