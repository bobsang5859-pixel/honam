/**
 * 발주/구매 통계 API
 * - 업체별 리드타임
 * - 납품 정확도 / 납기 준수율
 * - 품목별 가격 추이
 */
import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { authMiddleware } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

/**
 * GET /lead-time — 업체별 평균 리드타임(일)
 * query: date_from, date_to
 */
router.get('/lead-time', async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const dateFrom = req.query.date_from
      ? new Date(req.query.date_from as string)
      : new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const dateTo = req.query.date_to
      ? new Date(req.query.date_to as string)
      : now;

    const receipts = await prisma.goodsReceipt.findMany({
      where: {
        received_at: { gte: dateFrom, lte: dateTo },
        deleted_at: null,
        purchase_order_id: { not: null },
      },
      include: {
        purchase_order: {
          include: { vendor: { select: { id: true, name: true } } },
        },
      },
    });

    const vendorMap = new Map<string, { name: string; totalDays: number; count: number; diffZero: number }>();

    for (const gr of receipts) {
      const po = gr.purchase_order;
      if (!po) continue;
      const vid = po.vendor_id;
      const vname = po.vendor?.name || vid;

      const days = Math.max(0, Math.floor(
        (gr.received_at.getTime() - po.ordered_at.getTime()) / (1000 * 60 * 60 * 24)
      ));

      const entry = vendorMap.get(vid) || { name: vname, totalDays: 0, count: 0, diffZero: 0 };
      entry.totalDays += days;
      entry.count += 1;
      if (gr.diff_count === 0) entry.diffZero += 1;
      vendorMap.set(vid, entry);
    }

    const data = Array.from(vendorMap.entries()).map(([id, v]) => ({
      vendor_id: id,
      vendor_name: v.name,
      avg_lead_days: v.count > 0 ? Math.round(v.totalDays / v.count * 10) / 10 : 0,
      total_receipts: v.count,
      accuracy_rate: v.count > 0 ? Math.round(v.diffZero / v.count * 1000) / 10 : 0,
    }));

    data.sort((a, b) => b.total_receipts - a.total_receipts);
    res.json(data);
  } catch (e) {
    console.error('po-stats lead-time error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /delivery-compliance — 업체별 납기 준수율
 * query: date_from, date_to
 */
router.get('/delivery-compliance', async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const dateFrom = req.query.date_from
      ? new Date(req.query.date_from as string)
      : new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const dateTo = req.query.date_to
      ? new Date(req.query.date_to as string)
      : now;

    const pos = await prisma.purchaseOrder.findMany({
      where: {
        ordered_at: { gte: dateFrom, lte: dateTo },
        deleted_at: null,
        expected_at: { not: null },
      },
      include: {
        vendor: { select: { id: true, name: true } },
        receipts: {
          where: { deleted_at: null },
          select: { received_at: true },
          take: 1,
          orderBy: { received_at: 'asc' },
        },
      },
    });

    const vendorMap = new Map<string, { name: string; total: number; onTime: number; late: number }>();

    for (const po of pos) {
      if (!po.expected_at || po.receipts.length === 0) continue;
      const vid = po.vendor_id;
      const vname = po.vendor?.name || vid;
      const entry = vendorMap.get(vid) || { name: vname, total: 0, onTime: 0, late: 0 };

      const receivedAt = po.receipts[0].received_at;
      if (receivedAt <= po.expected_at) {
        entry.onTime += 1;
      } else {
        entry.late += 1;
      }
      entry.total += 1;
      vendorMap.set(vid, entry);
    }

    const data = Array.from(vendorMap.entries()).map(([id, v]) => ({
      vendor_id: id,
      vendor_name: v.name,
      total: v.total,
      on_time: v.onTime,
      late: v.late,
      compliance_rate: v.total > 0 ? Math.round(v.onTime / v.total * 1000) / 10 : 0,
    }));

    data.sort((a, b) => b.total - a.total);
    res.json(data);
  } catch (e) {
    console.error('po-stats delivery-compliance error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /price-trend — 품목별 가격 추이
 * query: item_id (required), months (default 12)
 */
router.get('/price-trend', async (req: Request, res: Response) => {
  try {
    const itemId = req.query.item_id as string;
    if (!itemId) return res.status(400).json({ error: 'item_id required' });

    const months = Number(req.query.months) || 12;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);

    const history = await prisma.priceHistory.findMany({
      where: {
        item_id: itemId,
        effective_from: { gte: cutoff },
      },
      include: {
        vendor: { select: { name: true } },
      },
      orderBy: { effective_from: 'asc' },
    });

    const data = history.map(h => ({
      date: h.effective_from.toISOString().slice(0, 10),
      price: Number(h.price),
      vendor_name: h.vendor?.name || '',
    }));

    res.json(data);
  } catch (e) {
    console.error('po-stats price-trend error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /items — 가격추이용 품목 목록
 */
router.get('/items', async (_req: Request, res: Response) => {
  try {
    const items = await prisma.item.findMany({
      where: { deleted_at: null },
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
