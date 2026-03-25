import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';

const router = Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const baselines = await prisma.usageBaseline.findMany({
      where: { deleted_at: null },
      include: { item: true, creator: true },
      orderBy: [{ item: { item_code: 'asc' } }, { version: 'desc' }],
    });
    res.json(baselines.map(b => ({
      id: b.id,
      item_id: b.item_id,
      item_code: b.item.item_code,
      item_name: b.item.name,
      department_scope: b.department_scope,
      period_type: b.period_type,
      qty_per_patient: Number(b.qty_per_patient),
      version: b.version,
      effective_from: b.effective_from,
      effective_to: b.effective_to,
      creator_name: b.creator.display_name,
    })));
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

router.post('/', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  const { item_id, department_scope, period_type, qty_per_patient, effective_from } = req.body;
  if (!item_id || qty_per_patient === undefined) return res.status(400).json({ error: '품목과 기준량은 필수입니다.' });
  try {
    // 최대 버전 조회
    const maxVer = await prisma.usageBaseline.findFirst({
      where: { item_id, department_scope: department_scope ?? 'ALL', period_type: period_type ?? 'MONTH', deleted_at: null },
      orderBy: { version: 'desc' },
    });
    const nextVersion = (maxVer?.version ?? 0) + 1;

    // 이전 기준의 effective_to 마감
    if (maxVer) {
      await prisma.usageBaseline.update({
        where: { id: maxVer.id },
        data: { effective_to: new Date(effective_from ?? new Date()) },
      });
    }

    const baseline = await prisma.usageBaseline.create({
      data: {
        id: uuidv4(),
        item_id,
        department_scope: department_scope ?? 'ALL',
        period_type: period_type ?? 'MONTH',
        qty_per_patient,
        version: nextVersion,
        effective_from: effective_from ? new Date(effective_from) : new Date(),
        created_by: req.user!.id,
      },
    });
    await audit({ actor_user_id: req.user!.id, action: 'CREATE', entity_type: 'usage_baselines', entity_id: baseline.id, after: baseline });
    res.status(201).json(baseline);
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

router.delete('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const baseline = await prisma.usageBaseline.findUnique({ where: { id: req.params.id } });
    if (!baseline) return res.status(404).json({ error: '기준을 찾을 수 없습니다.' });
    await prisma.usageBaseline.update({ where: { id: req.params.id }, data: { deleted_at: new Date() } });
    await audit({ actor_user_id: req.user!.id, action: 'SOFT_DELETE', entity_type: 'usage_baselines', entity_id: req.params.id, before: baseline });
    res.json({ message: '삭제되었습니다.' });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

export default router;
