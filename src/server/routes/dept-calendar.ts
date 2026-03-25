import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

const VALID_TYPES = ['TASK', 'MEETING', 'EVENT', 'OTHER'];
const VALID_VIS   = ['PRIVATE', 'DEPARTMENT', 'ALL', 'SPECIFIC'];

// GET /api/dept-calendar?year=2026&month=2
router.get('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const deptId = req.user?.department_id;
    const year = parseInt(String(req.query.year ?? new Date().getFullYear()));
    const month = parseInt(String(req.query.month ?? new Date().getMonth() + 1));
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0, 23, 59, 59);

    const events = await prisma.deptCalendarEvent.findMany({
      where: {
        OR: [
          { event_date: { gte: from, lte: to } },
          { end_date: { gte: from, lte: to } },
          { event_date: { lte: from }, end_date: { gte: to } },
        ],
      },
      include: {
        department: { select: { id: true, name: true } },
        creator: { select: { id: true, display_name: true } },
      },
      orderBy: [{ event_date: 'asc' }, { created_at: 'asc' }],
    });

    // Visibility filtering
    const filtered = events.filter((e: any) => {
      const vis = e.visibility ?? 'DEPARTMENT';
      if (vis === 'ALL') return true;
      if (vis === 'PRIVATE') return e.created_by === userId;
      if (vis === 'DEPARTMENT') return e.department_id === deptId || e.created_by === userId;
      if (vis === 'SPECIFIC') {
        const ids: string[] = e.shared_user_ids ? JSON.parse(e.shared_user_ids) : [];
        return e.created_by === userId || ids.includes(userId!);
      }
      return true;
    });

    res.json(filtered.map((e: any) => ({
      id: e.id,
      department_id: e.department_id,
      department_name: e.department?.name ?? '',
      title: e.title,
      event_date: e.event_date,
      end_date: e.end_date,
      color: e.color,
      event_type: e.event_type ?? 'EVENT',
      visibility: e.visibility ?? 'DEPARTMENT',
      shared_user_ids: e.shared_user_ids ?? null,
      start_time: e.start_time ?? null,
      end_time: e.end_time ?? null,
      created_by: e.created_by,
      creator_name: e.creator?.display_name ?? '',
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// POST /api/dept-calendar
router.post('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const deptId = req.user?.department_id;
    if (!userId || !deptId) return res.status(403).json({ error: '부서 소속 계정만 등록할 수 있습니다.' });

    const title = String(req.body?.title ?? '').trim();
    if (!title) return res.status(400).json({ error: '제목을 입력하세요.' });

    const eventDate = req.body?.event_date ? new Date(req.body.event_date) : null;
    if (!eventDate || isNaN(eventDate.getTime())) return res.status(400).json({ error: '날짜를 입력하세요.' });

    const endDate = req.body?.end_date ? new Date(req.body.end_date) : null;
    const color = String(req.body?.color ?? '#86efac').trim();
    const event_type = VALID_TYPES.includes(req.body?.event_type) ? req.body.event_type : 'EVENT';
    const visibility = VALID_VIS.includes(req.body?.visibility) ? req.body.visibility : 'DEPARTMENT';
    const shared_user_ids =
      visibility === 'SPECIFIC' && Array.isArray(req.body?.shared_user_ids)
        ? JSON.stringify(req.body.shared_user_ids)
        : null;
    const start_time = req.body?.start_time ? String(req.body.start_time).trim() : null;
    const end_time   = req.body?.end_time   ? String(req.body.end_time).trim()   : null;

    const event = await prisma.deptCalendarEvent.create({
      data: {
        id: uuidv4(),
        department_id: deptId,
        title,
        event_date: eventDate,
        end_date: endDate && !isNaN(endDate.getTime()) ? endDate : null,
        color,
        event_type,
        visibility,
        shared_user_ids,
        start_time: start_time || null,
        end_time: end_time || null,
        created_by: userId,
      },
      include: {
        department: { select: { id: true, name: true } },
        creator: { select: { id: true, display_name: true } },
      },
    });

    res.status(201).json({
      id: event.id,
      department_id: event.department_id,
      department_name: (event as any).department?.name ?? '',
      title: event.title,
      event_date: event.event_date,
      end_date: event.end_date,
      color: event.color,
      event_type: event.event_type,
      visibility: event.visibility,
      shared_user_ids: event.shared_user_ids ?? null,
      start_time: event.start_time ?? null,
      end_time: event.end_time ?? null,
      created_by: event.created_by,
      creator_name: (event as any).creator?.display_name ?? '',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류' });
  }
});

// DELETE /api/dept-calendar/:id
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    const isAdmin = (req.user as any)?.permissions?.includes('SYSTEM_ADMIN');
    const id = String(req.params.id);
    const event = await prisma.deptCalendarEvent.findUnique({ where: { id } });
    if (!event) return res.status(404).json({ error: '일정을 찾을 수 없습니다.' });

    const isMine = event.created_by === userId || event.department_id === req.user?.department_id;
    if (!isMine && !isAdmin) return res.status(403).json({ error: '삭제 권한이 없습니다.' });

    await prisma.deptCalendarEvent.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;
