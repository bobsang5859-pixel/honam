import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, resolveDeptScope, isCustomMenuUser, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('inventory', 'PURCHASE_MANAGE', 'REQUEST_USE'));

router.get('/', requirePermission('PURCHASE_MANAGE', 'REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const { location_id, category, search } = req.query;
    const scope = resolveDeptScope(req);
    const canViewAll = (req.user?.permissions.includes('SYSTEM_ADMIN') || req.user?.permissions.includes('PURCHASE_MANAGE')) ?? false;
    const isRestricted = !canViewAll;
    const deptId = scope.department_id;

    const inv = await prisma.inventory.findMany({
      where: {
        ...(location_id
          ? { location_id: String(location_id) }
          : isRestricted && deptId
          ? { location: { department_id: deptId } }
          : {}),
        item: {
          is_active: true,
          deleted_at: null,
          ...(category && { category: String(category) }),
          ...(search && { name: { contains: String(search) } }),
        },
      },
      include: {
        item: {
          include: {
            default_vendor: true,
            price_history: { orderBy: { effective_from: 'desc' }, take: 1 },
          },
        },
        location: true,
      },
      orderBy: [{ item: { category: 'asc' } }, { item: { item_code: 'asc' } }],
    });

    const result = inv.map((i: any) => {
      const onHand = Number(i.on_hand_qty);
      const avgCost = Number(i.avg_unit_cost);
      const latestPrice = i.item.price_history?.[0] ? Number(i.item.price_history[0].price) : avgCost;
      const isLowStock = onHand <= i.item.reorder_days_threshold;

      return {
        id: i.id,
        item_id: i.item_id,
        item_code: i.item.item_code,
        item_name: i.item.name,
        category: i.item.category,
        uom: i.item.uom,
        pack_size: i.item.pack_size ?? 1,
        location_id: i.location_id,
        location_code: i.location.code,
        location_name: i.location.name,
        on_hand_qty: onHand,
        avg_unit_cost: avgCost,
        latest_price: latestPrice,
        total_value: onHand * avgCost,
        updated_at: i.updated_at,
        is_low_stock: isLowStock,
        default_vendor_name: i.item.default_vendor?.name ?? '',
      };
    });

    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/low-stock', requirePermission('PURCHASE_MANAGE', 'REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const scope = resolveDeptScope(req);
    const canViewAll = (req.user?.permissions.includes('SYSTEM_ADMIN') || req.user?.permissions.includes('PURCHASE_MANAGE')) ?? false;
    const isRestricted = !canViewAll;
    const deptId = scope.department_id;

    const inv = await prisma.inventory.findMany({
      where: isRestricted && deptId ? { location: { department_id: deptId } } : undefined,
      include: {
        item: { include: { default_vendor: true } },
        location: true,
      },
    });

    const lowStock = inv.filter((i: any) => Number(i.on_hand_qty) <= i.item.reorder_days_threshold);
    res.json(
      lowStock.map((i: any) => ({
        item_id: i.item_id,
        item_code: i.item.item_code,
        item_name: i.item.name,
        uom: i.item.uom,
        location_name: i.location.name,
        on_hand_qty: Number(i.on_hand_qty),
        threshold: i.item.reorder_days_threshold,
        vendor_name: i.item.default_vendor?.name ?? '',
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/locations', async (req: AuthRequest, res) => {
  try {
    const scope = resolveDeptScope(req);
    const canViewAll = (req.user?.permissions.includes('SYSTEM_ADMIN') || req.user?.permissions.includes('PURCHASE_MANAGE')) ?? false;
    const isRestricted = !canViewAll;
    const deptId = scope.department_id;

    const locs = await prisma.inventoryLocation.findMany({
      where: {
        deleted_at: null,
        is_active: true,
        ...(isRestricted && deptId ? { department_id: deptId } : {}),
      },
      include: { department: true },
      orderBy: { code: 'asc' },
    });

    res.json(
      locs.map((l) => ({
        id: l.id,
        code: l.code,
        name: l.name,
        department_id: l.department_id,
        department_name: (l as any).department?.name ?? null,
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/locations', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { code, name, department_id } = req.body;
  if (!code || !name) return res.status(400).json({ error: '코드와 이름은 필수입니다.' });

  if (isCustomMenuUser(req.user) && !req.user?.permissions.includes('SYSTEM_ADMIN')) {
    return res.status(403).json({ error: '관리자만 재고 위치를 생성할 수 있습니다.' });
  }

  try {
    const loc = await prisma.inventoryLocation.create({
      data: { id: uuidv4(), code, name, department_id: department_id || null },
    });
    res.status(201).json(loc);
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 위치 코드입니다.' });
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;



