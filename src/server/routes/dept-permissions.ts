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
// Returns allowed item_ids for the calling user's department.
// 매트릭스 UI 모델:
//   - dept_item_permissions 테이블에 어떤 품목의 row가 0개면 → 그 품목은 "전체 허용(open)" — 모든 부서에서 신청 가능
//   - row가 1건 이상이면 → 그 품목은 "일부 허용(restricted)" — 등록된 부서만 신청 가능
// 이 모델을 my-items 응답에서도 그대로 적용해야 한다.
//   visible = (모든 활성 품목 중 restricted 가 아닌 것) ∪ (이 부서가 명시적으로 허용된 restricted 품목)
// null = 매트릭스에 아무 제약도 등록돼 있지 않음 — 모든 품목 허용
router.get('/my-items', async (req: AuthRequest, res) => {
  try {
    const deptId = req.user?.department_id;
    if (!deptId) return res.json({ item_ids: null });
    const dipx = (prisma as any).deptItemPermission;

    // restricted 품목 ID 집합 (어떤 부서든 row가 한 건이라도 있는 품목)
    const restrictedRows: { item_id: string }[] = await dipx.findMany({
      distinct: ['item_id'],
      select: { item_id: true },
    });
    if (restrictedRows.length === 0) {
      // 매트릭스에 어떤 제약도 없음 → 모두 허용
      return res.json({ item_ids: null });
    }
    const restrictedIds = new Set(restrictedRows.map(r => r.item_id));

    // 이 부서가 허용된 restricted 품목들
    const allowedRows: { item_id: string }[] = await dipx.findMany({
      where: { department_id: deptId, item_id: { in: [...restrictedIds] } },
      select: { item_id: true },
    });
    const allowedRestrictedIds = new Set(allowedRows.map(r => r.item_id));

    // 모든 활성 품목에서 (open 또는 부서 허용된 restricted)만 남김
    const allItems = await prisma.item.findMany({
      where: { is_active: true, deleted_at: null },
      select: { id: true },
    });
    const visibleIds = allItems
      .filter(it => !restrictedIds.has(it.id) || allowedRestrictedIds.has(it.id))
      .map(it => it.id);

    res.json({ item_ids: visibleIds });
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// GET /api/dept-permissions/items/all
// Returns full matrix of (item_id, department_id) pairs (admin)
router.get('/items/all', requirePermission('BASIC_MANAGE'), async (_req, res) => {
  try {
    const perms = await (prisma as any).deptItemPermission.findMany({
      select: { item_id: true, department_id: true },
    });
    res.json({ permissions: perms });
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// GET /api/dept-permissions/items/:dept_id
// Returns allowed item_ids for a specific department (admin)
router.get('/items/:dept_id', requirePermission('BASIC_MANAGE'), async (req, res) => {
  try {
    const perms = await (prisma as any).deptItemPermission.findMany({ where: { department_id: req.params.dept_id } });
    res.json({ item_ids: perms.map((p: any) => p.item_id) });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// POST /api/dept-permissions/items/bulk
// Body: { changes: [{ item_id, add?: string[], remove?: string[], clear?: boolean }] }
// Applies dirty-cell changes from the matrix UI in a single transaction.
router.post('/items/bulk', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  const { changes } = req.body as {
    changes?: Array<{ item_id: string; add?: string[]; remove?: string[]; clear?: boolean }>;
  };
  if (!Array.isArray(changes)) return res.status(400).json({ error: 'changes 배열이 필요합니다.' });
  if (changes.length === 0) return res.json({ ok: true, changed_items: 0 });

  try {
    // 트랜잭션 안에서 순차 처리. SQLite + Prisma 환경에서 안전하게 가도록
    // skipDuplicates 의존을 제거하고, 추가 전에 중복(item_id+dept_id)을 직접 걸러낸다.
    await prisma.$transaction(async (tx) => {
      const dipx = (tx as any).deptItemPermission;
      for (const c of changes) {
        if (!c.item_id) continue;
        if (c.clear) {
          await dipx.deleteMany({ where: { item_id: c.item_id } });
          continue;
        }
        if (Array.isArray(c.remove) && c.remove.length > 0) {
          await dipx.deleteMany({
            where: { item_id: c.item_id, department_id: { in: c.remove } },
          });
        }
        if (Array.isArray(c.add) && c.add.length > 0) {
          const existing = await dipx.findMany({
            where: { item_id: c.item_id, department_id: { in: c.add } },
            select: { department_id: true },
          });
          const already = new Set(existing.map((p: any) => p.department_id));
          const data = c.add
            .filter(dept_id => !already.has(dept_id))
            .map(dept_id => ({ id: uuidv4(), department_id: dept_id, item_id: c.item_id }));
          if (data.length > 0) await dipx.createMany({ data });
        }
      }
    }, { timeout: 30000 });

    await audit({
      actor_user_id: req.user!.id,
      action: 'BULK_UPDATE',
      entity_type: 'dept_item_permissions',
      entity_id: 'BULK',
      after: { changed_items: changes.length },
    });

    res.json({ ok: true, changed_items: changes.length });
  } catch (e: any) {
    console.error('[dept-permissions/items/bulk] failed:', e);
    const detail = e?.message ?? String(e);
    res.status(500).json({ error: `저장 실패: ${detail}` });
  }
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
