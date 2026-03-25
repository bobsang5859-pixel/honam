import { Router } from 'express';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

router.get('/', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { entity_type, entity_id, limit = '100', offset = '0' } = req.query;
    const logs = await prisma.auditLog.findMany({
      where: {
        ...(entity_type && { entity_type: String(entity_type) }),
        ...(entity_id && { entity_id: String(entity_id) }),
      },
      include: { actor: true },
      orderBy: { occurred_at: 'desc' },
      take: Number(limit),
      skip: Number(offset),
    });
    res.json(logs.map(l => ({
      id: l.id,
      occurred_at: l.occurred_at,
      actor_name: (l as any).actor?.display_name ?? '시스템',
      actor_role: l.actor_role_snapshot,
      action: l.action,
      entity_type: l.entity_type,
      entity_id: l.entity_id,
      before_json: l.before_json,
      after_json: l.after_json,
      reason: l.reason,
      ip: l.ip,
    })));
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

export default router;
