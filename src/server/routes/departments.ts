import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';

const router = Router();
router.use(authMiddleware);

router.get('/', async (_req, res) => {
  try {
    const depts = await prisma.department.findMany({
      where: { deleted_at: null },
      orderBy: { name: 'asc' },
    });
    res.json(depts);
  } catch {
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  const { name, parent_id, module_id } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: '이름은 필수입니다.' });
  const code = uuidv4();

  try {
    const normalizedParentId = parent_id || null;
    if (normalizedParentId) {
      const parent = await prisma.department.findFirst({
        where: { id: normalizedParentId, deleted_at: null },
        select: { id: true },
      });
      if (!parent) return res.status(400).json({ error: '상위 부서를 찾을 수 없습니다.' });
    }

    const dept = await prisma.department.create({
      data: { id: uuidv4(), code, name: String(name).trim(), parent_id: normalizedParentId, module_id: module_id || null },
    });
    await audit({
      actor_user_id: req.user!.id,
      action: 'CREATE',
      entity_type: 'departments',
      entity_id: dept.id,
      after: dept,
    });
    res.status(201).json(dept);
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 코드입니다.' });
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  const { name, is_active, parent_id, module_id } = req.body;
  const id = String(req.params.id);

  try {
    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({ error: '이름은 필수입니다.' });
    }

    const before = await prisma.department.findUnique({ where: { id } });
    if (!before) return res.status(404).json({ error: '부서를 찾을 수 없습니다.' });

    let normalizedParentId: string | null | undefined = undefined;
    if (parent_id !== undefined) {
      normalizedParentId = parent_id || null;
      if (normalizedParentId === id) {
        return res.status(400).json({ error: '상위 부서로 자신을 지정할 수 없습니다.' });
      }
      if (normalizedParentId) {
        const parent = await prisma.department.findFirst({
          where: { id: normalizedParentId, deleted_at: null },
          select: { id: true },
        });
        if (!parent) return res.status(400).json({ error: '상위 부서를 찾을 수 없습니다.' });
      }
    }

    const after = await prisma.department.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(is_active !== undefined && { is_active }),
        ...(normalizedParentId !== undefined && { parent_id: normalizedParentId }),
        ...(module_id !== undefined && { module_id: module_id || null }),
      },
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'UPDATE',
      entity_type: 'departments',
      entity_id: after.id,
      before,
      after,
    });
    res.json(after);
  } catch {
    res.status(500).json({ error: '서버 오류' });
  }
});

router.delete('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  const id = String(req.params.id);
  try {
    const before = await prisma.department.findUnique({ where: { id } });
    if (!before) return res.status(404).json({ error: '부서를 찾을 수 없습니다.' });

    const childCount = await prisma.department.count({
      where: { parent_id: id, deleted_at: null },
    });
    if (childCount > 0) {
      return res.status(400).json({ error: '하위 부서가 있어 삭제할 수 없습니다. 먼저 하위 부서를 정리해주세요.' });
    }

    const activeUserCount = await prisma.user.count({
      where: { department_id: id, deleted_at: null, is_active: true },
    });
    if (activeUserCount > 0) {
      return res.status(400).json({ error: '활성 사용자 소속 부서는 삭제할 수 없습니다. 먼저 사용자 소속을 변경해주세요.' });
    }

    await prisma.department.update({
      where: { id },
      data: { deleted_at: new Date(), is_active: false },
    });
    await audit({
      actor_user_id: req.user!.id,
      action: 'SOFT_DELETE',
      entity_type: 'departments',
      entity_id: id,
      before,
    });
    res.json({ message: '삭제되었습니다.' });
  } catch {
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;
