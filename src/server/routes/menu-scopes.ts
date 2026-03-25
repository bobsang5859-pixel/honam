import { Router } from 'express';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { prisma } from '../index';
import { getMenuScopeDepartments, setMenuScopeDepartments } from '../utils/menu-scope';

const router = Router();
router.use(authMiddleware);

router.get('/:menuKey', requirePermission('BASIC_MANAGE', 'SYSTEM_ADMIN'), async (req, res) => {
  try {
    const menuKey = String(req.params.menuKey || '').trim();
    if (!menuKey) return res.status(400).json({ error: 'menuKey is required.' });
    const department_ids = await getMenuScopeDepartments(menuKey);
    res.json({ menu_key: menuKey, department_ids });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:menuKey', requirePermission('BASIC_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const menuKey = String(req.params.menuKey || '').trim();
    const departmentIds = Array.isArray(req.body?.department_ids)
      ? req.body.department_ids.map((v: any) => String(v)).filter(Boolean)
      : [];
    if (!menuKey) return res.status(400).json({ error: 'menuKey is required.' });

    const validDepartments = await prisma.department.findMany({
      where: { id: { in: departmentIds }, deleted_at: null, is_active: true },
      select: { id: true },
    });
    const validIds = validDepartments.map((d) => d.id);
    await setMenuScopeDepartments(menuKey, validIds, req.user?.id);
    res.json({ menu_key: menuKey, department_ids: validIds });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;

