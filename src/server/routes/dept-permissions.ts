import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';
import { ALL_CATEGORY_VALUES } from '../../shared/types';

const router = Router();
router.use(authMiddleware);

const CATEGORIES = [...ALL_CATEGORY_VALUES] as string[];

// GET /api/dept-permissions
// Returns: [{ department_id, department_name, categories: string[] }]
router.get('/', requirePermission('BASIC_MANAGE'), async (_req, res) => {
  try {
    const [departments, perms] = await Promise.all([
      prisma.department.findMany({
        where: { deleted_at: null, is_active: true, code: { not: 'CENTRAL' } },
        orderBy: { name: 'asc' },
      }),
      prisma.deptCategoryPermission.findMany(),
    ]);

    const permMap: Record<string, string[]> = {};
    for (const p of perms) {
      if (!permMap[p.department_id]) permMap[p.department_id] = [];
      permMap[p.department_id].push(p.category);
    }

    res.json(departments.map(d => ({
      department_id: d.id,
      department_name: d.name,
      parent_id: d.parent_id,
      categories: permMap[d.id] ?? [],
    })));
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// GET /api/dept-permissions/my-items
// Returns allowed item_ids for the calling user's department
// null = all allowed (no restrictions set)
router.get('/my-items', async (req: AuthRequest, res) => {
  try {
    const deptId = req.user?.department_id;
    if (!deptId) return res.json({ item_ids: null });
    const perms = await (prisma as any).deptItemPermission.findMany({ where: { department_id: deptId } });
    if (perms.length === 0) return res.json({ item_ids: null });
    res.json({ item_ids: perms.map((p: any) => p.item_id) });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// GET /api/dept-permissions/items/:dept_id
// Returns allowed item_ids for a specific department (admin)
router.get('/items/:dept_id', requirePermission('BASIC_MANAGE'), async (req, res) => {
  try {
    const perms = await (prisma as any).deptItemPermission.findMany({ where: { department_id: req.params.dept_id } });
    res.json({ item_ids: perms.map((p: any) => p.item_id) });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// PUT /api/dept-permissions/items/:dept_id
// Body: { item_ids: string[] } — replaces all item permissions for that dept
router.put('/items/:dept_id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  const { dept_id } = req.params;
  const { item_ids } = req.body;
  if (!Array.isArray(item_ids)) return res.status(400).json({ error: 'item_ids 배열이 필요합니다.' });
  try {
    const dept = await prisma.department.findUnique({ where: { id: dept_id } });
    if (!dept) return res.status(404).json({ error: '부서를 찾을 수 없습니다.' });

    await (prisma as any).deptItemPermission.deleteMany({ where: { department_id: dept_id } });
    if (item_ids.length > 0) {
      const { v4: uuidv4 } = await import('uuid');
      await (prisma as any).deptItemPermission.createMany({
        data: item_ids.map((id: string) => ({ id: uuidv4(), department_id: dept_id, item_id: id })),
      });
    }

    res.json({ department_id: dept_id, item_ids });
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// GET /api/dept-permissions/my
// Returns allowed categories for the calling user's department (no admin perm required)
router.get('/my', async (req: AuthRequest, res) => {
  try {
    const deptId = req.user?.department_id;
    if (!deptId) return res.json({ categories: [...CATEGORIES] });

    const perms = await prisma.deptCategoryPermission.findMany({
      where: { department_id: deptId },
    });

    // If no permissions set → all categories allowed (default open)
    if (perms.length === 0) return res.json({ categories: [...CATEGORIES] });
    res.json({ categories: perms.map(p => p.category) });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// PUT /api/dept-permissions/:dept_id
// Body: { categories: string[] }  — replaces all perms for that dept
router.put('/:dept_id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  const { dept_id } = req.params;
  const { categories } = req.body;
  if (!Array.isArray(categories)) return res.status(400).json({ error: 'categories 배열이 필요합니다.' });

  const validCats = categories.filter(c => CATEGORIES.includes(c));

  try {
    const dept = await prisma.department.findUnique({ where: { id: dept_id } });
    if (!dept) return res.status(404).json({ error: '부서를 찾을 수 없습니다.' });

    // Replace: delete all then insert
    await prisma.deptCategoryPermission.deleteMany({ where: { department_id: dept_id } });
    if (validCats.length > 0) {
      await prisma.deptCategoryPermission.createMany({
        data: validCats.map(c => ({ id: uuidv4(), department_id: dept_id, category: c })),
      });
    }

    await audit({
      actor_user_id: req.user!.id,
      action: 'UPDATE',
      entity_type: 'dept_category_permissions',
      entity_id: dept_id,
      after: { department_name: dept.name, categories: validCats },
    });

    res.json({ department_id: dept_id, categories: validCats });
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

export default router;
