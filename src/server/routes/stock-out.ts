import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, resolveDeptScope, AuthRequest } from '../middleware/auth';
import { audit, generateNo, nextSeq } from '../utils/audit';
import { allocateFifo, ensureFifoTables, getAvailableLotQty, reverseAllocationsByStockOut } from '../utils/fifo';
import { generateEquipmentSerial } from '../utils/serial';
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
const SCHEDULED_REQUEST_TYPES = new Set(['CONSUMABLE_REGULAR', 'DIAPER', 'NIGHT_SNACK']);
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

function formatMonthLabel(dateLike: Date | string | null | undefined): string {
  const d = dateLike ? new Date(dateLike) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
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

async function createStockOutWithLines(params: {
  department_id: string;
  ward_request_id?: string | null;
  issued_by: string;
  note?: string;
  lines: CreateIssueLineInput[];
}): Promise<{ id: string; so_no: string }> {
  const { department_id, ward_request_id, issued_by, note, lines } = params;
  if (!department_id) throw new Error('department_id is required.');
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('At least one issue line is required.');

  // 기본 입력값 검증 (트랜잭션 전에 빠른 실패)
  for (const line of lines) {
    const qty = toNumber(line.issue_qty);
    if (!line.item_id || !line.location_id || qty <= 0) {
      throw new Error('Invalid issue line.');
    }
  }

  const seq = await nextSeq('stock_out');
  const so_no = generateNo('SO', seq);

  // 재고 검증 + 출고 + FIFO + 장비 유닛을 하나의 트랜잭션으로 처리
  const so = await prisma.$transaction(async (tx) => {
    await ensureFifoTables(tx as any);

    // 트랜잭션 안에서 재고/LOT 검증 (동시 요청 시 직렬화 보장)
    for (const line of lines) {
      const qty = toNumber(line.issue_qty);
      const inv = await tx.inventory.findUnique({
        where: { item_id_location_id: { item_id: line.item_id, location_id: line.location_id } },
      });
      const current = toNumber(inv?.on_hand_qty ?? 0);
      if (current < qty) {
        const item = await tx.item.findUnique({ where: { id: line.item_id }, select: { name: true } });
        throw new Error(`재고 부족 ${item?.name ?? line.item_id} (현재 ${current}, 요청 ${qty})`);
      }
      const lotQty = await getAvailableLotQty(tx as any, line.item_id, line.location_id);
      if (lotQty < qty) {
        const item = await tx.item.findUnique({ where: { id: line.item_id }, select: { name: true } });
        throw new Error(`FIFO LOT 부족 ${item?.name ?? line.item_id} (LOT ${lotQty}, 요청 ${qty})`);
      }
    }

    const stockOut = await tx.stockOut.create({
      data: {
        id: uuidv4(),
        so_no,
        department_id,
        ward_request_id: ward_request_id || null,
        issued_by,
        status: 'RECEIPT_PENDING',
        note: note ?? '',
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
        },
      });
      await allocateFifo(tx as any, {
        stockOutId: stockOut.id,
        stockOutItemId: createdLine.id,
        itemId: line.item_id,
        locationId: line.location_id,
        issueQty,
      });
      await tx.inventory.update({
        where: { item_id_location_id: { item_id: line.item_id, location_id: line.location_id } },
        data: { on_hand_qty: { decrement: issueQty } },
      });
    }

    // 비품 품목 → EquipmentUnit 자동 생성 (트랜잭션 안에서 처리)
    const itemIds = lines.map(l => l.item_id);
    const equipItems = await tx.item.findMany({
      where: { id: { in: itemIds }, category: { startsWith: 'EQUIP_' } },
      select: { id: true },
    });
    if (equipItems.length > 0) {
      const equipItemIds = new Set(equipItems.map(i => i.id));
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
        items: { include: { item: true, location: true } },
      },
      orderBy: { issued_at: 'desc' },
    });

    res.json(
      sos.map((so: any) => ({
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
        item_count: so.items.length,
        total_qty: so.items.reduce((sum: number, it: any) => sum + Number(it.issued_qty), 0),
        items: so.items.map((it: any) => ({
          id: it.id,
          item_id: it.item_id,
          item_name: it.item?.name,
          item_code: it.item?.item_code,
          uom: it.item?.uom,
          issued_qty: Number(it.issued_qty),
          location_id: it.location_id,
          location_name: it.location?.name,
          received_qty: it.received_qty == null ? null : Number(it.received_qty),
          receipt_note: it.receipt_note ?? '',
          receipt_confirmed_at: it.receipt_confirmed_at,
          receipt_confirmed_by: it.receipt_confirmed_by,
        })),
      }))
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
    const topLocationByItem = new Map<string, { location_id: string; location_name: string; qty: number }>();
    for (const inv of inventoryRows as any[]) {
      const itemId = String(inv.item_id);
      onHandByItem.set(itemId, (onHandByItem.get(itemId) ?? 0) + toNumber(inv.on_hand_qty));
      if (!topLocationByItem.has(itemId) && toNumber(inv.on_hand_qty) > 0) {
        topLocationByItem.set(itemId, {
          location_id: String(inv.location_id),
          location_name: String(inv.location?.name ?? ''),
          qty: toNumber(inv.on_hand_qty),
        });
      }
    }

    const rows: any[] = [];
    for (const wr of requests as any[]) {
      const wrId = String(wr.id);
      const periodStart = wr.period_start ? new Date(wr.period_start) : null;
      const periodInfo = resolvePeriodLabel(String(wr.request_type ?? ''), periodStart, schedulesByType);
      const periodLabel = periodInfo.period_label || formatMonthLabel(periodStart);
      if (periodLabelQuery && periodLabelQuery !== periodLabel) continue;

      const approvedMap = approvedByRequest.get(wrId) ?? new Map<string, number>();
      for (const line of wr.items ?? []) {
        const itemId = String(line.item_id);
        const approvedQty = approvedMap.has(itemId) ? toNumber(approvedMap.get(itemId)) : toNumber(line.requested_qty);
        const issuedQty = issuedByRequestItem.get(`${wrId}::${itemId}`) ?? 0;
        const remainingQty = Math.max(approvedQty - issuedQty, 0);
        if (remainingQty <= 0) continue;

        const packSize = Math.max(1, Number(line.item?.pack_size ?? 1));
        const onHandQty = onHandByItem.get(itemId) ?? 0;
        const recommended = topLocationByItem.get(itemId);
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
          uom: line.item?.uom ?? '',
          pack_size: packSize,
          approved_qty: approvedQty,
          issued_qty_sum: issuedQty,
          remaining_qty: remainingQty,
          on_hand_qty: onHandQty,
          recommended_box_qty: Math.ceil(remainingQty / Math.max(packSize, 1)),
          recommended_location_id: recommended?.location_id ?? '',
          recommended_location_name: recommended?.location_name ?? '',
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
    for (const line of rawLines) {
      const itemId = String(line?.item_id ?? '');
      const issueQty = toNumber(line?.issue_qty);
      const locationId = String(line?.location_id ?? '');
      if (!itemId || !locationId || issueQty <= 0) {
        return res.status(400).json({ error: '불출 라인 형식이 올바르지 않습니다.' });
      }
      lineMap.set(itemId, { item_id: itemId, issue_qty: issueQty, location_id: locationId });
    }

    const approvedByRequest = await getLatestApprovedQtyMap([wardRequestId]);
    const issuedByRequestItem = await getIssuedQtyMapByRequestItem([wardRequestId]);
    const approvedMap = approvedByRequest.get(wardRequestId) ?? new Map<string, number>();
    const requestItemMap = new Map<string, any>();
    for (const it of (wardRequest as any).items ?? []) {
      requestItemMap.set(String(it.item_id), it);
    }

    for (const [itemId, line] of lineMap.entries()) {
      const reqItem = requestItemMap.get(itemId);
      if (!reqItem) return res.status(400).json({ error: '신청 품목이 아닌 항목이 포함되어 있습니다.' });
      const approvedQty = approvedMap.has(itemId) ? toNumber(approvedMap.get(itemId)) : toNumber(reqItem.requested_qty);
      const issuedQty = issuedByRequestItem.get(`${wardRequestId}::${itemId}`) ?? 0;
      const remainingQty = Math.max(approvedQty - issuedQty, 0);
      if (toNumber(line.issue_qty) > remainingQty) {
        return res.status(400).json({
          error: `${reqItem.item?.name ?? itemId} 불출수량이 잔여수량을 초과합니다. (잔여 ${remainingQty}, 입력 ${line.issue_qty})`,
        });
      }
    }

    const created = await createStockOutWithLines({
      department_id: wardRequest.department_id,
      ward_request_id: wardRequestId,
      issued_by: req.user!.id,
      note: String(req.body?.note ?? '').trim() || '[WORKBOARD] 신청기준 불출',
      lines: Array.from(lineMap.values()),
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'POST',
      entity_type: 'stock_out_workboard_issue',
      entity_id: created.id,
      after: {
        so_no: created.so_no,
        ward_request_id: wardRequestId,
        department_id: wardRequest.department_id,
        line_count: lineMap.size,
      },
    });

    res.status(201).json({
      id: created.id,
      so_no: created.so_no,
      ward_request_id: wardRequestId,
      department_id: wardRequest.department_id,
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
        uom: row.item?.uom ?? '',
        action_type: row.action_type,
        diff_qty: toNumber(row.diff_qty),
        status: row.status,
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

router.post('/follow-ups/:id/resolve', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
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
        status: 'RESOLVED',
        note: note || followUp.note,
        resolved_at: new Date(),
        resolved_by: req.user!.id,
      } as any,
    });

    res.json({ message: '후속작업을 처리했습니다.' });
  } catch {
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

    const preferredLocationId = String(req.body?.location_id ?? '').trim();
    let selectedLocationId = preferredLocationId;
    if (!selectedLocationId) {
      const invRows = await prisma.inventory.findMany({
        where: { item_id: followUp.item_id, on_hand_qty: { gt: 0 } },
        orderBy: { on_hand_qty: 'desc' },
        take: 10,
      });
      const needed = toNumber(followUp.diff_qty);
      const candidate = invRows.find((inv: any) => {
        const available = toNumber(inv.on_hand_qty);
        return available >= needed;
      });
      if (!candidate) return res.status(400).json({ error: '추가불출 가능한 재고 위치를 찾지 못했습니다.' });
      selectedLocationId = String(candidate.location_id);
    }

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

router.get('/:id', requirePermission('PURCHASE_MANAGE'), async (req, res) => {
  try {
    const so = await prisma.stockOut.findUnique({
      where: { id: String(req.params.id) },
      include: {
        department: true,
        issuer: true,
        items: { include: { item: true, location: true } },
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
      items: (so.items ?? []).map((it: any) => ({
        id: it.id,
        item_id: it.item_id,
        item_name: it.item?.name,
        item_code: it.item?.item_code,
        uom: it.item?.uom,
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
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'POST',
      entity_type: 'stock_out',
      entity_id: created.id,
      after: { so_no: created.so_no, department_id, item_count: items.length, status: 'RECEIPT_PENDING' },
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
