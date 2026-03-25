import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, AuthRequest } from '../middleware/auth';
import { audit, generateNo, nextSeq } from '../utils/audit';
import { checkReceiptLotsReversible, createInventoryLot, ensureFifoTables } from '../utils/fifo';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('receipts', 'PURCHASE_MANAGE'));

const CONFIRMED_STATUSES = ['CONFIRMED', 'DIFF_CONFIRMED'] as const;
const getParam = (v: string | string[]) => (Array.isArray(v) ? v[0] : v);

async function recalculatePurchaseOrderStatus(tx: any, purchaseOrderId: string) {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: { po_items: true },
  });
  if (!po) return;

  const confirmedRows = await tx.stockInItem.groupBy({
    by: ['item_id'],
    where: {
      goods_receipt: {
        purchase_order_id: purchaseOrderId,
        status: { in: [...CONFIRMED_STATUSES] },
        deleted_at: null,
      },
    },
    _sum: { confirmed_qty: true },
  });
  const confirmedMap = new Map<string, number>();
  for (const row of confirmedRows) confirmedMap.set(row.item_id, Number(row._sum.confirmed_qty ?? 0));

  let hasAny = false;
  let fullyReceived = po.po_items.length > 0;
  for (const line of po.po_items) {
    const confirmed = Number(confirmedMap.get(line.item_id) ?? 0);
    if (confirmed > 0) hasAny = true;
    if (confirmed < Number(line.ordered_qty)) fullyReceived = false;
  }

  const nextStatus = fullyReceived ? 'CLOSED' : hasAny ? 'PARTIAL_RECEIVED' : (po.status === 'DRAFT' ? 'DRAFT' : 'SENT');
  if (po.status !== nextStatus) {
    await tx.purchaseOrder.update({ where: { id: purchaseOrderId }, data: { status: nextStatus } });
  }
}

router.get('/', requirePermission('PURCHASE_MANAGE'), async (_req, res) => {
  try {
    const receipts = await prisma.goodsReceipt.findMany({
      where: { deleted_at: null },
      include: {
        purchase_order: true,
        receiver: true,
        stock_in_items: { include: { item: true, location: true } },
      },
      orderBy: { received_at: 'desc' },
    });

    res.json(receipts.map((r: any) => ({
      id: r.id,
      gr_no: r.gr_no,
      purchase_order_id: r.purchase_order_id,
      po_no: r.purchase_order?.po_no ?? null,
      receiver_name: r.receiver?.display_name ?? '',
      received_at: r.received_at,
      status: r.status,
      note: r.note,
      confirmed_at: r.confirmed_at,
      confirmed_by: r.confirmed_by,
      diff_count: Number(r.diff_count ?? 0),
      item_count: r.stock_in_items.length,
      total_amount: r.stock_in_items.reduce((s: number, it: any) => s + Number(it.received_qty) * Number(it.unit_price), 0),
      items: r.stock_in_items.map((it: any) => ({
        id: it.id,
        item_id: it.item_id,
        item_code: it.item?.item_code,
        item_name: it.item?.name,
        uom: it.item?.uom,
        received_qty: Number(it.received_qty),
        expected_qty: it.expected_qty == null ? null : Number(it.expected_qty),
        confirmed_qty: it.confirmed_qty == null ? null : Number(it.confirmed_qty),
        diff_qty: it.diff_qty == null ? null : Number(it.diff_qty),
        diff_note: it.diff_note ?? '',
        unit_price: Number(it.unit_price),
        location_id: it.location_id,
        location_name: it.location?.name,
      })),
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/follow-ups', requirePermission('PURCHASE_MANAGE'), async (req, res) => {
  try {
    const status = String(req.query.status || 'OPEN');
    const where = status ? { status } : undefined;
    const rows = await prisma.pendingReceiptFollowUp.findMany({
      where,
      include: {
        purchase_order: { select: { id: true, po_no: true } },
        vendor: { select: { id: true, name: true } },
        item: { select: { id: true, item_code: true, name: true, uom: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    res.json(rows.map((r: any) => ({
      id: r.id,
      goods_receipt_id: r.goods_receipt_id,
      purchase_order_id: r.purchase_order_id,
      po_no: r.purchase_order?.po_no ?? null,
      vendor_id: r.vendor_id,
      vendor_name: r.vendor?.name ?? '',
      item_id: r.item_id,
      item_code: r.item?.item_code ?? '',
      item_name: r.item?.name ?? '',
      uom: r.item?.uom ?? '',
      missing_qty: Number(r.missing_qty),
      status: r.status,
      note: r.note,
      created_at: r.created_at,
      resolved_at: r.resolved_at,
      resolved_by: r.resolved_by,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/follow-ups/:id/resolve', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { note } = req.body || {};
    const followUpId = getParam(req.params.id);
    const row = await prisma.pendingReceiptFollowUp.findUnique({ where: { id: followUpId } });
    if (!row) return res.status(404).json({ error: '미입고 대기건을 찾을 수 없습니다.' });
    if (row.status !== 'OPEN') return res.status(400).json({ error: 'OPEN 상태만 처리할 수 있습니다.' });

    await prisma.pendingReceiptFollowUp.update({
      where: { id: row.id },
      data: {
        status: 'RESOLVED',
        note: note ?? row.note ?? '',
        resolved_at: new Date(),
        resolved_by: req.user!.id,
      },
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'RESOLVE',
      entity_type: 'pending_receipt_followups',
      entity_id: row.id,
      after: { status: 'RESOLVED' },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/follow-ups/:id/cancel', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { note } = req.body || {};
    const followUpId = getParam(req.params.id);
    const row = await prisma.pendingReceiptFollowUp.findUnique({ where: { id: followUpId } });
    if (!row) return res.status(404).json({ error: '미입고 대기건을 찾을 수 없습니다.' });
    if (row.status !== 'OPEN') return res.status(400).json({ error: 'OPEN 상태만 처리할 수 있습니다.' });

    await prisma.pendingReceiptFollowUp.update({
      where: { id: row.id },
      data: {
        status: 'CANCELLED',
        note: note ?? row.note ?? '',
        resolved_at: new Date(),
        resolved_by: req.user!.id,
      },
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'CANCEL',
      entity_type: 'pending_receipt_followups',
      entity_id: row.id,
      after: { status: 'CANCELLED' },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/:id/verify', requirePermission('PURCHASE_MANAGE'), async (req, res) => {
  try {
    const receiptId = getParam(req.params.id);
    const r = await prisma.goodsReceipt.findUnique({
      where: { id: receiptId },
      include: {
        purchase_order: true,
        receiver: true,
        stock_in_items: {
          include: {
            item: true,
            location: true,
          },
        },
      },
    });
    if (!r || r.deleted_at) return res.status(404).json({ error: '입고를 찾을 수 없습니다.' });

    res.json({
      id: r.id,
      gr_no: r.gr_no,
      purchase_order_id: r.purchase_order_id,
      po_no: (r as any).purchase_order?.po_no ?? null,
      vendor_id: (r as any).purchase_order?.vendor_id ?? null,
      receiver_name: (r as any).receiver?.display_name ?? '',
      received_at: r.received_at,
      status: r.status,
      note: r.note,
      confirmed_at: r.confirmed_at,
      confirmed_by: r.confirmed_by,
      diff_count: Number(r.diff_count ?? 0),
      items: (r as any).stock_in_items.map((it: any) => ({
        id: it.id,
        item_id: it.item_id,
        item_code: it.item?.item_code,
        item_name: it.item?.name,
        uom: it.item?.uom,
        location_id: it.location_id,
        location_name: it.location?.name,
        unit_price: Number(it.unit_price),
        received_qty: Number(it.received_qty),
        expected_qty: it.expected_qty == null ? Number(it.received_qty) : Number(it.expected_qty),
        confirmed_qty: it.confirmed_qty == null ? Number(it.received_qty) : Number(it.confirmed_qty),
        diff_qty: it.diff_qty == null ? 0 : Number(it.diff_qty),
        diff_note: it.diff_note ?? '',
        confirmed_at: it.confirmed_at,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/:id/verify/lines/:itemId', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const receiptId = getParam(req.params.id);
    const itemId = getParam(req.params.itemId);
    const confirmedQtyRaw = Number(req.body?.confirmed_qty);
    const diffNote = String(req.body?.diff_note ?? '');
    if (!Number.isFinite(confirmedQtyRaw) || confirmedQtyRaw < 0) {
      return res.status(400).json({ error: '실입고수량은 0 이상이어야 합니다.' });
    }

    const gr = await prisma.goodsReceipt.findUnique({ where: { id: receiptId } });
    if (!gr || gr.deleted_at) return res.status(404).json({ error: '입고를 찾을 수 없습니다.' });
    if (gr.status !== 'PENDING') return res.status(400).json({ error: 'PENDING 상태에서만 라인 수정이 가능합니다.' });

    const line = await prisma.stockInItem.findFirst({
      where: { goods_receipt_id: receiptId, item_id: itemId },
    });
    if (!line) return res.status(404).json({ error: '입고 품목을 찾을 수 없습니다.' });

    const expectedQty = Number(line.expected_qty ?? line.received_qty ?? 0);
    const diffQty = confirmedQtyRaw - expectedQty;
    if (diffQty !== 0 && !diffNote.trim()) {
      return res.status(400).json({ error: '차이가 있는 경우 사유를 입력해야 합니다.' });
    }

    await prisma.stockInItem.update({
      where: { id: line.id },
      data: {
        confirmed_qty: confirmedQtyRaw,
        diff_qty: diffQty,
        diff_note: diffNote,
      },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/:id/verify/confirm', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const receiptId = getParam(req.params.id);
    const result = await prisma.$transaction(async (tx) => {
      await ensureFifoTables(tx as any);
      const gr = await tx.goodsReceipt.findUnique({
        where: { id: receiptId },
        include: {
          purchase_order: true,
          stock_in_items: {
            include: { item: true },
          },
        },
      });
      if (!gr || gr.deleted_at) throw new Error('입고를 찾을 수 없습니다.');
      if (gr.status !== 'PENDING') throw new Error('PENDING 상태에서만 검수확정이 가능합니다.');

      if (!gr.stock_in_items.length) throw new Error('검수할 품목이 없습니다.');

      let diffCount = 0;
      const now = new Date();
      for (const line of gr.stock_in_items as any[]) {
        const expectedQty = Number(line.expected_qty ?? line.received_qty ?? 0);
        const confirmedQtyRaw = line.confirmed_qty == null ? Number(line.received_qty ?? 0) : Number(line.confirmed_qty);
        if (!Number.isFinite(confirmedQtyRaw) || confirmedQtyRaw < 0) throw new Error('실입고수량이 유효하지 않습니다.');
        const diffQty = confirmedQtyRaw - expectedQty;
        if (diffQty !== 0 && !String(line.diff_note ?? '').trim()) throw new Error(`${line.item?.name ?? line.item_id} 차이사유를 입력하세요.`);
        if (diffQty !== 0) diffCount += 1;

        await tx.stockInItem.update({
          where: { id: line.id },
          data: {
            expected_qty: expectedQty,
            confirmed_qty: confirmedQtyRaw,
            diff_qty: diffQty,
            confirmed_at: now,
            confirmed_by: req.user!.id,
          },
        });

        if (confirmedQtyRaw > 0) {
          await createInventoryLot(tx as any, {
            stockInItemId: line.id,
            goodsReceiptId: gr.id,
            itemId: line.item_id,
            locationId: line.location_id,
            vendorId: (gr as any).purchase_order?.vendor_id ?? line.item?.default_vendor_id ?? null,
            receivedAt: gr.received_at,
            unitCost: Number(line.unit_price ?? 0),
            receivedQty: confirmedQtyRaw,
          });

          const inv = await tx.inventory.findUnique({
            where: { item_id_location_id: { item_id: line.item_id, location_id: line.location_id } },
          });
          const oldQty = Number(inv?.on_hand_qty ?? 0);
          const oldCost = Number(inv?.avg_unit_cost ?? 0);
          const newQty = oldQty + confirmedQtyRaw;
          const newCost = newQty > 0 ? Number(((oldCost * oldQty) + Number(line.unit_price) * confirmedQtyRaw) / newQty) : 0;
          const roundedCost = Number(newCost.toFixed(4));

          await tx.inventory.upsert({
            where: { item_id_location_id: { item_id: line.item_id, location_id: line.location_id } },
            update: { on_hand_qty: newQty, avg_unit_cost: roundedCost },
            create: {
              id: uuidv4(),
              item_id: line.item_id,
              location_id: line.location_id,
              on_hand_qty: confirmedQtyRaw,
              avg_unit_cost: Number(line.unit_price ?? 0),
            },
          });
        }

        const missingQty = Math.max(0, expectedQty - confirmedQtyRaw);
        if (missingQty > 0) {
          await tx.pendingReceiptFollowUp.create({
            data: {
              id: uuidv4(),
              goods_receipt_id: gr.id,
              purchase_order_id: gr.purchase_order_id ?? null,
              vendor_id: (gr as any).purchase_order?.vendor_id ?? null,
              item_id: line.item_id,
              missing_qty: missingQty,
              status: 'OPEN',
              note: line.diff_note ?? '',
            },
          });
        }
      }

      const nextStatus = diffCount > 0 ? 'DIFF_CONFIRMED' : 'CONFIRMED';
      await tx.goodsReceipt.update({
        where: { id: gr.id },
        data: {
          status: nextStatus,
          diff_count: diffCount,
          confirmed_at: now,
          confirmed_by: req.user!.id,
        },
      });

      if (gr.purchase_order_id) {
        await recalculatePurchaseOrderStatus(tx, gr.purchase_order_id);
      }

      return { id: gr.id, status: nextStatus, diff_count: diffCount };
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'CONFIRM',
      entity_type: 'goods_receipts',
      entity_id: receiptId,
      after: result,
    });
    res.json(result);
  } catch (e: any) {
    console.error(e);
    res.status(400).json({ error: e.message || '검수확정 처리 실패' });
  }
});

router.get('/:id', requirePermission('PURCHASE_MANAGE'), async (req, res) => {
  try {
    const receiptId = getParam(req.params.id);
    const r = await prisma.goodsReceipt.findUnique({
      where: { id: receiptId },
      include: {
        purchase_order: true,
        receiver: true,
        stock_in_items: { include: { item: true, location: true } },
      },
    });
    if (!r || r.deleted_at) return res.status(404).json({ error: '입고를 찾을 수 없습니다.' });
    res.json({
      id: r.id,
      gr_no: r.gr_no,
      purchase_order_id: r.purchase_order_id,
      po_no: (r as any).purchase_order?.po_no,
      receiver_name: (r as any).receiver?.display_name,
      received_at: r.received_at,
      status: r.status,
      note: r.note,
      confirmed_at: r.confirmed_at,
      confirmed_by: r.confirmed_by,
      diff_count: Number(r.diff_count ?? 0),
      items: (r as any).stock_in_items.map((it: any) => ({
        id: it.id,
        item_id: it.item_id,
        item_code: it.item?.item_code,
        item_name: it.item?.name,
        uom: it.item?.uom,
        received_qty: Number(it.received_qty),
        expected_qty: it.expected_qty == null ? null : Number(it.expected_qty),
        confirmed_qty: it.confirmed_qty == null ? null : Number(it.confirmed_qty),
        diff_qty: it.diff_qty == null ? null : Number(it.diff_qty),
        diff_note: it.diff_note ?? '',
        unit_price: Number(it.unit_price),
        location_id: it.location_id,
        location_name: it.location?.name,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { purchase_order_id, note, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '품목을 1개 이상 입력하세요.' });
  if (items.some((it: any) => Number(it.received_qty) < 0 || Number(it.unit_price) < 0 || !it.item_id || !it.location_id)) {
    return res.status(400).json({ error: '품목 입력값을 확인하세요.' });
  }

  try {
    const seq = await nextSeq('goods_receipts');
    const gr_no = generateNo('GR', seq);

    const po = purchase_order_id
      ? await prisma.purchaseOrder.findUnique({
          where: { id: purchase_order_id },
          include: { po_items: true },
        })
      : null;

    const orderedQtyMap = new Map<string, number>();
    for (const line of po?.po_items ?? []) orderedQtyMap.set(line.item_id, Number(line.ordered_qty));

    const gr = await prisma.goodsReceipt.create({
      data: {
        id: uuidv4(),
        gr_no,
        purchase_order_id: purchase_order_id || null,
        received_by: req.user!.id,
        status: 'PENDING',
        note: note ?? '',
        stock_in_items: {
          create: items.map((it: any) => ({
            id: uuidv4(),
            item_id: it.item_id,
            received_qty: Number(it.received_qty),
            expected_qty: orderedQtyMap.has(it.item_id) ? Number(orderedQtyMap.get(it.item_id) ?? 0) : Number(it.received_qty),
            confirmed_qty: Number(it.received_qty),
            diff_qty: 0,
            unit_price: Number(it.unit_price),
            location_id: it.location_id,
          })),
        },
      },
      include: { stock_in_items: true },
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'POST',
      entity_type: 'goods_receipts',
      entity_id: gr.id,
      after: { gr_no, item_count: items.length, status: 'PENDING' },
    });
    res.status(201).json({ id: gr.id, gr_no });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/:id/reverse', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) return res.status(400).json({ error: '취소 사유는 필수입니다.' });

  try {
    const receiptId = getParam(req.params.id);
    await ensureFifoTables(prisma as any);
    const gr = await prisma.goodsReceipt.findUnique({
      where: { id: receiptId },
      include: { stock_in_items: true },
    });
    if (!gr || gr.deleted_at) return res.status(404).json({ error: '입고를 찾을 수 없습니다.' });
    if (gr.status === 'REVERSED') return res.status(400).json({ error: '이미 역전된 입고입니다.' });

    await prisma.$transaction(async (tx) => {
      await ensureFifoTables(tx as any);
      if (gr.status === 'PENDING') {
        await tx.goodsReceipt.update({ where: { id: gr.id }, data: { status: 'REVERSED' } });
        await tx.pendingReceiptFollowUp.updateMany({
          where: { goods_receipt_id: gr.id, status: 'OPEN' },
          data: { status: 'CANCELLED', resolved_at: new Date(), resolved_by: req.user!.id },
        });
        if (gr.purchase_order_id) await recalculatePurchaseOrderStatus(tx, gr.purchase_order_id);
        return;
      }

      if (!CONFIRMED_STATUSES.includes(gr.status as any)) {
        throw new Error('해당 상태는 역전할 수 없습니다.');
      }

      const reversible = await checkReceiptLotsReversible(tx as any, gr.stock_in_items.map((it: any) => it.id));
      if (!reversible.ok) {
        throw new Error('해당 입고 LOT가 이미 불출되어 역전할 수 없습니다.');
      }

      await tx.goodsReceipt.update({ where: { id: gr.id }, data: { status: 'REVERSED' } });

      for (const it of gr.stock_in_items as any[]) {
        await (tx as any).$executeRawUnsafe(
          `UPDATE inventory_lots SET deleted_at = datetime('now'), remaining_qty = 0 WHERE stock_in_item_id = ? AND deleted_at IS NULL`,
          String(it.id),
        );
        const confirmedQty = Number(it.confirmed_qty ?? 0);
        if (confirmedQty <= 0) continue;
        const inv = await tx.inventory.findUnique({
          where: { item_id_location_id: { item_id: it.item_id, location_id: it.location_id } },
        });
        if (!inv) continue;
        const newQty = Math.max(0, Number(inv.on_hand_qty) - confirmedQty);
        await tx.inventory.update({
          where: { item_id_location_id: { item_id: it.item_id, location_id: it.location_id } },
          data: { on_hand_qty: newQty },
        });
      }

      await tx.pendingReceiptFollowUp.updateMany({
        where: { goods_receipt_id: gr.id, status: 'OPEN' },
        data: { status: 'CANCELLED', resolved_at: new Date(), resolved_by: req.user!.id },
      });
      if (gr.purchase_order_id) await recalculatePurchaseOrderStatus(tx, gr.purchase_order_id);
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'REVERSE',
      entity_type: 'goods_receipts',
      entity_id: receiptId,
      reason,
    });
    res.json({ message: '입고가 역전 처리되었습니다.' });
  } catch (e: any) {
    console.error(e);
    res.status(400).json({ error: e.message || '역전 처리 실패' });
  }
});

export default router;
