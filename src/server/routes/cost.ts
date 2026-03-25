import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, resolveDeptScope, isCustomMenuUser, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';
import { ensureFifoTables } from '../utils/fifo';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('cost', 'STATS_VIEW', 'PURCHASE_MANAGE', 'ACCOUNTING_CLOSE'));

const ACTIVE_STOCK_OUT_STATUSES = ['POSTED', 'RECEIPT_PENDING', 'RECEIPT_CONFIRMED', 'RECEIPT_DIFF'];

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

router.get('/statistics', requirePermission('STATS_VIEW'), async (req: AuthRequest, res) => {
  try {
    const { year_month, department_id } = req.query;
    let scopedDeptId = '';
    try {
      scopedDeptId = resolveRequestedDept(req, department_id);
    } catch {
      return res.status(403).json({ error: '해당 부서 데이터에 접근할 수 없습니다.' });
    }

    const stats = await prisma.costStatistic.findMany({
      where: {
        ...(year_month && { year_month: String(year_month) }),
        ...(scopedDeptId && { department_id: scopedDeptId }),
      },
      include: { department: true, item: true },
      orderBy: [{ year_month: 'desc' }, { issued_amount: 'desc' }],
    });

    res.json(
      stats.map((s) => ({
        id: s.id,
        year_month: s.year_month,
        department_id: s.department_id,
        department_name: (s as any).department?.name,
        item_id: s.item_id,
        item_code: (s as any).item?.item_code,
        item_name: (s as any).item?.name,
        issued_qty: Number(s.issued_qty),
        issued_amount: Number(s.issued_amount),
        avg_unit_price: Number(s.avg_unit_price),
        overuse_count: s.overuse_count,
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/materialize', requirePermission('ACCOUNTING_CLOSE'), async (req: AuthRequest, res) => {
  const { year_month } = req.body;
  if (!year_month) return res.status(400).json({ error: 'year_month is required.' });

  if (isCustomMenuUser(req.user) && !req.user?.permissions.includes('SYSTEM_ADMIN')) {
    return res.status(403).json({ error: '관리자만 마감을 실행할 수 있습니다.' });
  }

  const [y, m] = String(year_month).split('-');
  const monthStart = new Date(`${y}-${m}-01`);
  const monthEnd = new Date(Number(y), Number(m), 0);

  try {
    const stockOuts = await prisma.stockOut.findMany({
      where: {
        status: { in: ACTIVE_STOCK_OUT_STATUSES as any },
        issued_at: { gte: monthStart, lte: monthEnd },
      },
      include: {
        items: {
          include: {
            item: { include: { price_history: { orderBy: { effective_from: 'desc' }, take: 1 } } },
          },
        },
      },
    });

    const aggregate = new Map<string, { dept: string; item: string; qty: number; amount: number; overuse: number }>();

    for (const so of stockOuts) {
      for (const it of so.items) {
        const key = `${so.department_id}__${it.item_id}`;
        const price = it.item.price_history?.[0] ? Number(it.item.price_history[0].price) : 0;
        const qty = Number(it.issued_qty);
        const amount = qty * price;
        const existing = aggregate.get(key);
        if (existing) {
          existing.qty += qty;
          existing.amount += amount;
        } else {
          aggregate.set(key, { dept: so.department_id, item: it.item_id, qty, amount, overuse: 0 });
        }
      }
    }

    for (const [, v] of aggregate) {
      await prisma.costStatistic.upsert({
        where: { year_month_department_id_item_id: { year_month, department_id: v.dept, item_id: v.item } },
        update: {
          issued_qty: v.qty,
          issued_amount: v.amount,
          avg_unit_price: v.qty > 0 ? v.amount / v.qty : 0,
          overuse_count: v.overuse,
        },
        create: {
          id: uuidv4(),
          year_month,
          department_id: v.dept,
          item_id: v.item,
          issued_qty: v.qty,
          issued_amount: v.amount,
          avg_unit_price: v.qty > 0 ? v.amount / v.qty : 0,
          overuse_count: v.overuse,
        },
      });
    }

    await audit({
      actor_user_id: req.user!.id,
      action: 'CREATE',
      entity_type: 'cost_statistics',
      entity_id: String(year_month),
      reason: `${year_month} 월마감`,
    });
    res.json({ message: `${year_month} 마감 완료`, count: aggregate.size });
  } catch (e) {
    console.error(e);
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

    const [ordersCurrent, ordersPrev] = await Promise.all([
      prisma.purchaseOrder.findMany({ where: orderWhereCurrent, include: { vendor: true } }),
      prisma.purchaseOrder.findMany({ where: orderWherePrev, include: { vendor: true } }),
    ]);

    const mapCurrent = new Map<string, { vendor_id: string; vendor_name: string; amount: number }>();
    for (const po of ordersCurrent as any[]) {
      const key = po.vendor_id;
      const cur = mapCurrent.get(key) ?? { vendor_id: key, vendor_name: po.vendor?.name ?? '미정', amount: 0 };
      cur.amount += Number(po.total_amount || 0);
      mapCurrent.set(key, cur);
    }

    const mapPrev = new Map<string, number>();
    for (const po of ordersPrev as any[]) {
      mapPrev.set(po.vendor_id, (mapPrev.get(po.vendor_id) ?? 0) + Number(po.total_amount || 0));
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
    const deptParams = departmentId ? [departmentId] : [];
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
        ${deptCond}
      GROUP BY COALESCE(l.vendor_id, i.default_vendor_id), COALESCE(v.name, dv.name, '미정')
      ORDER BY inventory_amount_fifo DESC
    `, ...deptParams);

    const vendor_inventory_amounts = (lots || []).map((r: any) => ({
      vendor_id: r.vendor_id ?? '',
      vendor_name: r.vendor_name ?? '미정',
      inventory_amount_fifo: Number(Number(r.inventory_amount_fifo ?? 0).toFixed(2)),
      lot_count: Number(r.lot_count ?? 0),
      item_count: Number(r.item_count ?? 0),
    }));

    const order_total_current = ordersCurrent.reduce((s: number, po: any) => s + Number(po.total_amount || 0), 0);
    const order_total_previous = ordersPrev.reduce((s: number, po: any) => s + Number(po.total_amount || 0), 0);
    const inventory_total_fifo = vendor_inventory_amounts.reduce((s: number, r: any) => s + Number(r.inventory_amount_fifo || 0), 0);

    res.json({
      period: {
        current: { date_from: dateFrom.toISOString().slice(0, 10), date_to: dateTo.toISOString().slice(0, 10) },
        previous: { date_from: prevFrom.toISOString().slice(0, 10), date_to: prevTo.toISOString().slice(0, 10) },
      },
      vendor_order_amounts,
      vendor_inventory_amounts,
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

export default router;
