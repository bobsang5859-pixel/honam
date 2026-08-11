import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, AuthRequest } from '../middleware/auth';
import { audit, generateNo, nextSeq } from '../utils/audit';
import { checkReceiptLotsReversible, createInventoryLot, ensureFifoTables } from '../utils/fifo';
import { normalizePackSize, toIssueQty, toIssueUnitCost } from '../../shared/units';

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
        purchase_order: { include: { vendor: true } },
        manual_vendor: true,
        receiver: true,
        stock_in_items: { include: { item: { select: { name: true, item_code: true, uom: true, purchase_uom: true, issue_uom: true, pack_size: true, category: true } }, location: true }, orderBy: { item: { item_code: 'asc' } } },
      } as any,
      orderBy: { received_at: 'desc' },
    });

    res.json(receipts.map((r: any) => {
      // 대분류 분포
      const breakdown: Record<string, number> = {};
      for (const it of r.stock_in_items ?? []) {
        const cat = String(it.item?.category ?? '').toUpperCase();
        let major = 'GENERAL';
        if (cat.startsWith('EQUIP_')) major = 'EQUIPMENT';
        else if (cat.startsWith('OFF_')) major = 'OFFICE';
        else if (cat.startsWith('MED_') || cat.startsWith('INFECT_')) major = 'MEDICAL';
        else if (cat.startsWith('DIAPER')) major = 'DIAPER';
        breakdown[major] = (breakdown[major] ?? 0) + 1;
      }
      return {
        id: r.id,
        gr_no: r.gr_no,
        purchase_order_id: r.purchase_order_id,
        po_no: r.purchase_order?.po_no ?? null,
        vendor_id: r.purchase_order?.vendor_id ?? r.manual_vendor_id ?? null,
        vendor_name: r.purchase_order?.vendor?.name ?? r.manual_vendor?.name ?? null,
        manual_vendor_id: r.manual_vendor_id ?? null,
        category_breakdown: breakdown,
        receiver_name: r.receiver?.display_name ?? '',
        received_at: r.received_at,
        status: r.status,
        note: r.note,
        confirmed_at: r.confirmed_at,
        confirmed_by: r.confirmed_by,
        diff_count: Number(r.diff_count ?? 0),
        item_count: r.stock_in_items.length,
        adjustment_amount: Number(r.adjustment_amount ?? 0),
        adjustment_note: String(r.adjustment_note ?? ''),
        // 라인 합계 - adjustment_amount = 최종 총액 (adjustment_amount 양수=절사, 음수=가산)
        total_amount: r.stock_in_items.reduce((s: number, it: any) => s + Number(it.received_qty) * Number(it.unit_price), 0)
          - Number(r.adjustment_amount ?? 0),
        items: r.stock_in_items.map((it: any) => ({
          id: it.id,
          item_id: it.item_id,
          item_code: it.item?.item_code,
          item_name: it.item?.name,
          uom: it.item?.uom,
          purchase_uom: it.item?.purchase_uom ?? it.item?.uom,
          issue_uom: it.item?.issue_uom ?? it.item?.uom,
          pack_size: Number(it.item?.pack_size ?? 1),
          received_qty: Number(it.received_qty),
          expected_qty: it.expected_qty == null ? null : Number(it.expected_qty),
          confirmed_qty: it.confirmed_qty == null ? null : Number(it.confirmed_qty),
          diff_qty: it.diff_qty == null ? null : Number(it.diff_qty),
          diff_note: it.diff_note ?? '',
          unit_price: Number(it.unit_price),
          location_id: it.location_id,
          location_name: it.location?.name,
        })),
      };
    }));
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
        item: { select: { id: true, item_code: true, name: true, uom: true, purchase_uom: true, issue_uom: true, pack_size: true } },
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
      purchase_uom: r.item?.purchase_uom ?? r.item?.uom ?? '',
      issue_uom: r.item?.issue_uom ?? r.item?.uom ?? '',
      pack_size: Number(r.item?.pack_size ?? 1),
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
        purchase_order: { include: { vendor: true } },
        manual_vendor: true,
        receiver: true,
        stock_in_items: {
          include: {
            item: true,
            location: true,
          },
          orderBy: { item: { item_code: 'asc' } },
        },
      } as any,
    });
    if (!r || r.deleted_at) return res.status(404).json({ error: '입고를 찾을 수 없습니다.' });
    const effectiveVendorId = (r as any).purchase_order?.vendor_id ?? (r as any).manual_vendor_id ?? null;
    const effectiveVendorName = (r as any).purchase_order?.vendor?.name ?? (r as any).manual_vendor?.name ?? null;

    res.json({
      id: r.id,
      gr_no: r.gr_no,
      purchase_order_id: r.purchase_order_id,
      po_no: (r as any).purchase_order?.po_no ?? null,
      vendor_id: effectiveVendorId,
      vendor_name: effectiveVendorName,
      manual_vendor_id: (r as any).manual_vendor_id ?? null,
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
        purchase_uom: it.item?.purchase_uom ?? it.item?.uom,
        issue_uom: it.item?.issue_uom ?? it.item?.uom,
        pack_size: Number(it.item?.pack_size ?? 1),
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
          // 발주/입고 수량은 purchase_uom 단위, 재고는 issue_uom 단위로 저장
          // 1 purchase_uom = pack_size issue_uom 변환 적용
          const packSize = normalizePackSize((line.item as any)?.pack_size ?? 1);
          const issueQtyDelta = toIssueQty(confirmedQtyRaw, packSize);
          const issueUnitCost = toIssueUnitCost(Number(line.unit_price ?? 0), packSize);
          const vendorId = (gr as any).purchase_order?.vendor_id ?? (gr as any).manual_vendor_id ?? line.item?.default_vendor_id ?? null;

          // 자동 lot 병합: 같은 (item, location, vendor, unit_cost) 의 활성 lot 이 있으면 잔량 합산
          // 정책 — 단가 변동 시점만 lot 분리되도록 (회계상 원가 단위 일치).
          const existingLot = await (tx as any).$queryRawUnsafe(
            `SELECT id FROM inventory_lots
             WHERE deleted_at IS NULL
               AND item_id = ? AND location_id = ?
               AND COALESCE(vendor_id, '') = COALESCE(?, '')
               AND unit_cost = ?
             ORDER BY datetime(received_at) DESC
             LIMIT 1`,
            line.item_id, line.location_id, vendorId, issueUnitCost,
          ) as any[];

          if (existingLot.length > 0) {
            // 기존 lot 에 합산 (단가 변동 없음 → 같은 원가 단위)
            await (tx as any).$executeRawUnsafe(
              `UPDATE inventory_lots
                 SET received_qty = received_qty + ?, remaining_qty = remaining_qty + ?
               WHERE id = ?`,
              issueQtyDelta, issueQtyDelta, existingLot[0].id,
            );
          } else {
            // 단가가 새로움 → 신규 lot 생성 (단가 변동 시점)
            await createInventoryLot(tx as any, {
              stockInItemId: line.id,
              goodsReceiptId: gr.id,
              itemId: line.item_id,
              locationId: line.location_id,
              vendorId,
              receivedAt: gr.received_at,
              unitCost: issueUnitCost,
              receivedQty: issueQtyDelta,
            });
          }

          const inv = await tx.inventory.findUnique({
            where: { item_id_location_id: { item_id: line.item_id, location_id: line.location_id } },
          });
          const oldQty = Number(inv?.on_hand_qty ?? 0);
          const oldCost = Number(inv?.avg_unit_cost ?? 0);
          const newQty = oldQty + issueQtyDelta;
          const newCost = newQty > 0 ? Number(((oldCost * oldQty) + issueUnitCost * issueQtyDelta) / newQty) : 0;
          const roundedCost = Number(newCost.toFixed(4));

          await tx.inventory.upsert({
            where: { item_id_location_id: { item_id: line.item_id, location_id: line.location_id } },
            update: { on_hand_qty: newQty, avg_unit_cost: roundedCost },
            create: {
              id: uuidv4(),
              item_id: line.item_id,
              location_id: line.location_id,
              on_hand_qty: issueQtyDelta,
              avg_unit_cost: issueUnitCost,
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
              vendor_id: (gr as any).purchase_order?.vendor_id ?? (gr as any).manual_vendor_id ?? null,
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
        purchase_uom: it.item?.purchase_uom ?? it.item?.uom,
        issue_uom: it.item?.issue_uom ?? it.item?.uom,
        pack_size: Number(it.item?.pack_size ?? 1),
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
  const { purchase_order_id, note, items, adjustment_amount, adjustment_note, received_at, vendor_id } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '품목을 1개 이상 입력하세요.' });
  // 라인별 검증 — 어느 라인의 어느 필드가 문제인지 명시.
  // 단가는 음수 허용 (절사를 품목으로 등록한 기존 데이터 호환). 새로 만들 땐 GR 의 adjustment 필드 사용 권장.
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as any;
    const issues: string[] = [];
    if (!it.item_id) issues.push('item_id 없음 (자유입력은 입고 등록 불가)');
    if (!it.location_id) issues.push('입고 위치 미선택');
    if (Number(it.received_qty) < 0) issues.push('수량 < 0');
    if (issues.length > 0) {
      return res.status(400).json({
        error: `${i + 1}번째 라인 (품목 ${it.item_name ?? '?'}) — ${issues.join(' / ')}`,
      });
    }
  }

  // 단가 환산 가드 — pack_size > 1 품목에서, 단가가 박스 단가의 1/pack_size 패턴이면 ea 단위로 잘못 입력된 것으로 의심하고 거부.
  // (이전 시스템에서 박스 단가/수량 대신 ea 단가/수량을 입력하여 lot.unit_cost 가 1/pack_size 로 저장되는 버그 재발 방지)
  const guardItemIds = items.map((it: any) => String(it.item_id)).filter(Boolean);
  if (guardItemIds.length > 0) {
    const guardMetas = await prisma.item.findMany({
      where: { id: { in: guardItemIds } },
      select: {
        id: true,
        name: true,
        pack_size: true,
        purchase_uom: true,
        price_history: { where: { source: 'PO' }, orderBy: { effective_from: 'desc' }, take: 1, select: { price: true } },
      },
    });
    const guardMetaById = new Map(guardMetas.map((m: any) => [m.id, m]));
    for (let i = 0; i < items.length; i++) {
      const it = items[i] as any;
      const meta: any = guardMetaById.get(String(it.item_id));
      if (!meta) continue;
      const ps = Math.max(1, Number(meta.pack_size || 1));
      if (ps <= 1) continue;
      const recentPoPrice = Number(meta.price_history?.[0]?.price || 0);
      if (recentPoPrice <= 0) continue;
      const inputPrice = Number(it.unit_price || 0);
      if (inputPrice > 0 && inputPrice <= (recentPoPrice / ps) * 1.5) {
        return res.status(400).json({
          error: `${i + 1}번째 라인 (${meta.name}) — 단가 ${inputPrice}원이 ${meta.purchase_uom || '박스'} 단가가 아닌 낱개(${ps}개입) 단가로 보입니다. ${meta.purchase_uom || '박스'} 단가로 입력해주세요. (참고: 최근 ${meta.purchase_uom || '박스'} 단가 ${recentPoPrice}원)`,
        });
      }
    }
  }
  // 최종금액 = 라인합계 - adjustment_amount. 양수=절사(차감), 음수=가산(발주금액 초과 등 추가비용).
  const adjustmentAmt = Number.isFinite(Number(adjustment_amount)) ? Number(adjustment_amount) : 0;
  const adjustmentNote = String(adjustment_note ?? '').trim();

  // 입고일자 — 수기 등록 시 사용자가 지정 가능 (과거 입고 소급 등록 케이스).
  // 미지정 또는 잘못된 값이면 현재 시각.
  let receivedAtDate: Date | undefined;
  if (received_at) {
    const parsed = new Date(received_at);
    if (!isNaN(parsed.getTime())) receivedAtDate = parsed;
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

    // is_test 자동 전파: parent PO가 test이면 GR도 test
    const isTest = !!po?.is_test;

    // 발주서 미연결 시에만 manual_vendor_id 적용 — 연결 시 purchase_order.vendor_id 가 우선.
    const manualVendorId = !purchase_order_id && vendor_id ? String(vendor_id) : null;
    const gr = await prisma.goodsReceipt.create({
      data: {
        id: uuidv4(),
        gr_no,
        purchase_order_id: purchase_order_id || null,
        ...(manualVendorId ? { manual_vendor_id: manualVendorId } as any : {}),
        received_by: req.user!.id,
        ...(receivedAtDate ? { received_at: receivedAtDate } : {}),
        status: 'PENDING',
        note: note ?? '',
        is_test: isTest,
        adjustment_amount: adjustmentAmt,
        adjustment_note: adjustmentNote,
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

// PATCH /:id — 입고 메타데이터 수정 (소급 등록 보정용).
// received_at: 연결된 InventoryLot.received_at 도 함께 갱신 — FIFO 정렬키이므로 정합성 유지 필요.
// vendor_id: 발주서 미연결(수기) 건의 거래처를 갱신. 관련 InventoryLot.vendor_id 도 일괄 갱신.
router.patch('/:id', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { received_at, vendor_id } = req.body || {};
  const hasReceivedAt = received_at !== undefined;
  const hasVendor = vendor_id !== undefined;
  if (!hasReceivedAt && !hasVendor) return res.status(400).json({ error: 'received_at 또는 vendor_id 가 필요합니다.' });

  let parsed: Date | undefined;
  if (hasReceivedAt) {
    if (!received_at) return res.status(400).json({ error: 'received_at 가 비어있습니다.' });
    parsed = new Date(received_at);
    if (isNaN(parsed.getTime())) return res.status(400).json({ error: '잘못된 날짜 형식입니다.' });
  }

  try {
    const gr = await prisma.goodsReceipt.findUnique({
      where: { id: req.params.id },
      include: { purchase_order: true },
    });
    if (!gr || gr.deleted_at) return res.status(404).json({ error: '입고를 찾을 수 없습니다.' });
    if (gr.status === 'REVERSED') return res.status(400).json({ error: '취소된 입고는 수정할 수 없습니다.' });
    if (hasVendor && gr.purchase_order_id) {
      return res.status(400).json({ error: '발주서 연결 입고는 거래처를 별도 지정할 수 없습니다.' });
    }

    const nextVendorId = hasVendor ? (vendor_id ? String(vendor_id) : null) : undefined;

    await prisma.$transaction(async (tx) => {
      const grData: any = {};
      if (parsed) grData.received_at = parsed;
      if (hasVendor) grData.manual_vendor_id = nextVendorId;
      await tx.goodsReceipt.update({ where: { id: req.params.id }, data: grData });

      const lotData: any = {};
      if (parsed) lotData.received_at = parsed;
      if (hasVendor) lotData.vendor_id = nextVendorId;
      if (Object.keys(lotData).length > 0) {
        await (tx as any).inventoryLot.updateMany({
          where: { goods_receipt_id: req.params.id, deleted_at: null },
          data: lotData,
        });
      }
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'PATCH',
      entity_type: 'goods_receipts',
      entity_id: req.params.id,
      before: {
        ...(hasReceivedAt ? { received_at: gr.received_at } : {}),
        ...(hasVendor ? { manual_vendor_id: (gr as any).manual_vendor_id ?? null } : {}),
      },
      after: {
        ...(parsed ? { received_at: parsed } : {}),
        ...(hasVendor ? { manual_vendor_id: nextVendorId } : {}),
      },
      reason: '입고 메타데이터 수정',
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('[PATCH /receipts/:id] error:', e);
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
      include: { stock_in_items: { include: { item: true } } },
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
        const packSize = normalizePackSize((it.item as any)?.pack_size ?? 1);
        const issueQtyDelta = toIssueQty(confirmedQty, packSize);
        const inv = await tx.inventory.findUnique({
          where: { item_id_location_id: { item_id: it.item_id, location_id: it.location_id } },
        });
        if (!inv) continue;
        const newQty = Math.max(0, Number(inv.on_hand_qty) - issueQtyDelta);
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
