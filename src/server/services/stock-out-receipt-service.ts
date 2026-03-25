import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';

const RECEIPT_EDITABLE_STATUSES = new Set(['RECEIPT_PENDING', 'RECEIPT_DIFF']);
const DEFAULT_RECEIPT_STATUSES = ['RECEIPT_PENDING', 'RECEIPT_DIFF'] as const;
const SLA_HOURS = 24;
const SLA_MS = SLA_HOURS * 60 * 60 * 1000;

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
      items: true,
    },
    orderBy: { issued_at: 'desc' },
  });

  const now = params.now ?? new Date();
  const mappedRows: StockOutReceiptQueueRow[] = rows.map((so: any) => {
    const issuedAt = new Date(so.issued_at);
    const dueAt = new Date(issuedAt.getTime() + SLA_MS);
    const isOverdue = String(so.status) === 'RECEIPT_PENDING' && dueAt.getTime() < now.getTime();
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
      items: { include: { item: true, location: true } },
    },
  });
  if (!so || so.deleted_at) throw new ReceiptServiceError(404, 'Stock-out not found.');
  if (!canAccessDepartment(viewer, so.department_id)) throw new ReceiptServiceError(403, 'No permission.');

  const items = (so.items ?? []).map((it: any) => {
    const issued = Number(it.issued_qty);
    const received = it.received_qty == null ? null : Number(it.received_qty);
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

    // 수령확정된 품목을 부서 재고에 추가
    const deptLocId = await pickDeptLocationId(tx, so.department_id);
    if (deptLocId) {
      for (const line of so.items as any[]) {
        const receivedQty = toNumber(line.received_qty);
        if (receivedQty <= 0) continue;
        const itemId = String(line.item_id);
        const existing = await tx.inventory.findUnique({
          where: { item_id_location_id: { item_id: itemId, location_id: deptLocId } },
        });
        if (existing) {
          await tx.inventory.update({
            where: { item_id_location_id: { item_id: itemId, location_id: deptLocId } },
            data: { on_hand_qty: Number(existing.on_hand_qty) + receivedQty } as any,
          });
        } else {
          await tx.inventory.create({
            data: { id: uuidv4(), item_id: itemId, location_id: deptLocId, on_hand_qty: receivedQty, avg_unit_cost: 0 } as any,
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
