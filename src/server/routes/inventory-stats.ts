/**
 * 재고 회전 통계 API
 * - 재고 회전율
 * - 로트 체류일수
 */
import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { authMiddleware } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

/**
 * GET /turnover — 재고 회전율
 * query: date_from, date_to
 */
router.get('/turnover', async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const dateFrom = req.query.date_from
      ? new Date(req.query.date_from as string)
      : new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const dateTo = req.query.date_to
      ? new Date(req.query.date_to as string)
      : now;

    // 기간 내 출고 금액 (품목별)
    const allocations = await prisma.stockOutLotAllocation.findMany({
      where: {
        created_at: { gte: dateFrom, lte: dateTo },
      },
      include: {
        inventory_lot: {
          select: { item_id: true },
        },
        stock_out_item: {
          select: {
            item: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });

    const itemMap = new Map<string, {
      code: string; name: string; issuedAmount: number; issuedQty: number;
    }>();

    for (const a of allocations) {
      const itemId = a.inventory_lot?.item_id || a.stock_out_item?.item?.id || '';
      const item = a.stock_out_item?.item;
      if (!itemId || !item) continue;

      const entry = itemMap.get(itemId) || { code: item.code, name: item.name, issuedAmount: 0, issuedQty: 0 };
      entry.issuedAmount += Number(a.line_amount);
      entry.issuedQty += Number(a.issued_qty);
      itemMap.set(itemId, entry);
    }

    // 현재 재고 금액 (품목별)
    const lots = await prisma.inventoryLot.findMany({
      where: { deleted_at: null, remaining_qty: { gt: 0 } },
      select: { item_id: true, remaining_qty: true, unit_cost: true },
    });

    const invMap = new Map<string, number>();
    for (const lot of lots) {
      const val = Number(lot.remaining_qty) * Number(lot.unit_cost);
      invMap.set(lot.item_id, (invMap.get(lot.item_id) || 0) + val);
    }

    const data = Array.from(itemMap.entries()).map(([id, item]) => {
      const avgInventory = invMap.get(id) || 0;
      return {
        item_id: id,
        item_code: item.code,
        item_name: item.name,
        issued_amount: Math.round(item.issuedAmount),
        issued_qty: Math.round(item.issuedQty),
        current_inventory_value: Math.round(avgInventory),
        turnover_rate: avgInventory > 0
          ? Math.round(item.issuedAmount / avgInventory * 100) / 100
          : item.issuedAmount > 0 ? 999 : 0,
      };
    });

    data.sort((a, b) => b.issued_amount - a.issued_amount);

    const totalIssued = data.reduce((s, d) => s + d.issued_amount, 0);
    const totalInventory = data.reduce((s, d) => s + d.current_inventory_value, 0);

    res.json({
      summary: {
        total_issued_amount: totalIssued,
        total_inventory_value: totalInventory,
        overall_turnover: totalInventory > 0
          ? Math.round(totalIssued / totalInventory * 100) / 100
          : 0,
        item_count: data.length,
      },
      items: data.slice(0, 100),
    });
  } catch (e) {
    console.error('inventory-stats turnover error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /lot-dwell — 품목별 평균 로트 체류일수
 * query: months (default 6)
 */
router.get('/lot-dwell', async (req: Request, res: Response) => {
  try {
    const months = Number(req.query.months) || 6;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);

    // 완전 소진된 로트 (remaining_qty = 0)
    const consumedLots = await prisma.inventoryLot.findMany({
      where: {
        deleted_at: null,
        remaining_qty: { equals: 0 },
        received_at: { gte: cutoff },
      },
      select: {
        id: true,
        item_id: true,
        received_at: true,
      },
    });

    if (consumedLots.length === 0) {
      return res.json({ items: [] });
    }

    // 각 로트의 마지막 출고 할당 시점
    const lotIds = consumedLots.map(l => l.id);
    const lastAllocations = await prisma.stockOutLotAllocation.groupBy({
      by: ['inventory_lot_id'],
      where: { inventory_lot_id: { in: lotIds } },
      _max: { created_at: true },
    });

    const lastDateMap = new Map<string, Date>();
    for (const a of lastAllocations) {
      if (a.inventory_lot_id && a._max.created_at) {
        lastDateMap.set(a.inventory_lot_id, a._max.created_at);
      }
    }

    // 품목별 체류일수 집계
    const itemMap = new Map<string, { totalDays: number; count: number }>();
    for (const lot of consumedLots) {
      const lastDate = lastDateMap.get(lot.id);
      if (!lastDate) continue;
      const dwellDays = Math.max(0,
        Math.floor((lastDate.getTime() - lot.received_at.getTime()) / (1000 * 60 * 60 * 24))
      );
      const entry = itemMap.get(lot.item_id) || { totalDays: 0, count: 0 };
      entry.totalDays += dwellDays;
      entry.count += 1;
      itemMap.set(lot.item_id, entry);
    }

    const itemIds = Array.from(itemMap.keys());
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, code: true, name: true },
    });
    const itemInfo = new Map(items.map(i => [i.id, i]));

    const data = Array.from(itemMap.entries()).map(([id, d]) => ({
      item_id: id,
      item_code: itemInfo.get(id)?.code || '',
      item_name: itemInfo.get(id)?.name || '',
      avg_dwell_days: d.count > 0 ? Math.round(d.totalDays / d.count * 10) / 10 : 0,
      lot_count: d.count,
    }));

    data.sort((a, b) => b.avg_dwell_days - a.avg_dwell_days);
    res.json({ items: data.slice(0, 100) });
  } catch (e) {
    console.error('inventory-stats lot-dwell error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
