import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';

const router = Router();
router.use(authMiddleware);

const SCHEDULED_TYPES = ['CONSUMABLE_MEDICAL', 'CONSUMABLE_REGULAR', 'DIAPER', 'NIGHT_SNACK'] as const;

function formatSchedule(s: any) {
  const now = new Date();
  const from = new Date(s.open_from);
  const to = new Date(s.open_to);
  return {
    id: s.id,
    request_type: s.request_type,
    open_from: s.open_from,
    open_to: s.open_to,
    period_label: s.period_label,
    note: s.note,
    created_by: s.created_by,
    created_at: s.created_at,
    updated_at: s.updated_at,
    is_active: from <= now && now <= to,
    is_upcoming: from > now,
    is_past: to < now,
  };
}

// GET /api/request-schedules — 모든 인증 사용자
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { request_type, include_past } = req.query;
    const now = new Date();
    const where: any = {};
    if (request_type) where.request_type = String(request_type);
    // 기본: 과거 스케줄 제외 (현재 + 미래만)
    if (include_past !== 'true') {
      where.open_to = { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) }; // 7일 전까지 포함
    }
    const schedules = await (prisma as any).requestSchedule.findMany({
      where,
      orderBy: [{ open_from: 'asc' }],
    });
    res.json(schedules.map(formatSchedule));
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// POST /api/request-schedules — 인증된 사용자
router.post('/', async (req: AuthRequest, res) => {
  const { request_type, open_from, open_to, period_label, note } = req.body;
  if (!SCHEDULED_TYPES.includes(request_type)) {
    return res.status(400).json({ error: `유효한 신청 유형이 아닙니다. (${SCHEDULED_TYPES.join('|')})` });
  }
  if (!open_from || !open_to) return res.status(400).json({ error: '신청 시작/마감일은 필수입니다.' });
  if (new Date(open_from) >= new Date(open_to)) {
    return res.status(400).json({ error: '시작일이 마감일보다 늦을 수 없습니다.' });
  }

  try {
    const created = await (prisma as any).requestSchedule.create({
      data: {
        id: uuidv4(),
        request_type,
        open_from: new Date(open_from),
        open_to: new Date(open_to),
        period_label: period_label ?? '',
        note: note ?? '',
        created_by: req.user!.id,
      },
    });
    await audit({
      actor_user_id: req.user!.id,
      action: 'CREATE',
      entity_type: 'request_schedules',
      entity_id: created.id,
      after: { request_type, open_from, open_to, period_label },
    });
    res.status(201).json(formatSchedule(created));
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// PUT /api/request-schedules/:id — 인증된 사용자
router.put('/:id', async (req: AuthRequest, res) => {
  const { request_type, open_from, open_to, period_label, note } = req.body;
  if (request_type && !SCHEDULED_TYPES.includes(request_type)) {
    return res.status(400).json({ error: `유효한 신청 유형이 아닙니다.` });
  }
  if (open_from && open_to && new Date(open_from) >= new Date(open_to)) {
    return res.status(400).json({ error: '시작일이 마감일보다 늦을 수 없습니다.' });
  }

  try {
    const existing = await (prisma as any).requestSchedule.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: '스케줄을 찾을 수 없습니다.' });

    const updated = await (prisma as any).requestSchedule.update({
      where: { id: req.params.id },
      data: {
        ...(request_type && { request_type }),
        ...(open_from && { open_from: new Date(open_from) }),
        ...(open_to && { open_to: new Date(open_to) }),
        ...(period_label !== undefined && { period_label }),
        ...(note !== undefined && { note }),
      },
    });
    await audit({
      actor_user_id: req.user!.id,
      action: 'UPDATE',
      entity_type: 'request_schedules',
      entity_id: req.params.id,
      before: existing,
      after: updated,
    });
    res.json(formatSchedule(updated));
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// DELETE /api/request-schedules/:id — 인증된 사용자
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const existing = await (prisma as any).requestSchedule.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: '스케줄을 찾을 수 없습니다.' });

    await (prisma as any).requestSchedule.delete({ where: { id: req.params.id } });
    await audit({
      actor_user_id: req.user!.id,
      action: 'DELETE',
      entity_type: 'request_schedules',
      entity_id: req.params.id,
      before: existing,
    });
    res.json({ message: '삭제되었습니다.' });
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

export default router;
