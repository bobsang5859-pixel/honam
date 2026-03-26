import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';

const router = Router();

// 목록 조회
router.get('/', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const { complaint_type, status, department_id } = req.query;
    const where: any = { deleted_at: null };
    if (complaint_type) where.complaint_type = String(complaint_type);
    if (status) where.status = String(status);
    if (department_id) where.department_id = String(department_id);

    const rows = await (prisma as any).complaint.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 등록
router.post('/', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const { complaint_type, title, content, patient_id, department_id } = req.body;
    if (!complaint_type || !title) return res.status(400).json({ error: '유형과 제목은 필수입니다.' });

    const row = await (prisma as any).complaint.create({
      data: {
        id: uuidv4(),
        complaint_type: String(complaint_type),
        title: String(title),
        content: String(content ?? ''),
        patient_id: patient_id ? String(patient_id) : null,
        department_id: department_id ? String(department_id) : (req.user as any)?.department_id || null,
        created_by: req.user!.id,
      },
    });
    await audit({ actor_user_id: req.user!.id, action: 'CREATE', entity_type: 'complaints', entity_id: row.id });
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 수정/상태변경
router.put('/:id', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const { title, content, status, resolved_at } = req.body;
    const data: any = {};
    if (title !== undefined) data.title = String(title);
    if (content !== undefined) data.content = String(content);
    if (status !== undefined) {
      data.status = String(status);
      if (status === 'CLOSED' && !resolved_at) data.resolved_at = new Date();
    }
    if (resolved_at !== undefined) data.resolved_at = resolved_at ? new Date(resolved_at) : null;

    const row = await (prisma as any).complaint.update({ where: { id: req.params.id }, data });
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'complaints', entity_id: row.id });
    res.json(row);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 삭제
router.delete('/:id', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    await (prisma as any).complaint.update({ where: { id: req.params.id }, data: { deleted_at: new Date() } });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 통계 (민원/상담 건수 집계)
router.get('/stats', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const { date_from, date_to, department_id } = req.query;
    const where: any = { deleted_at: null };
    if (date_from) where.created_at = { ...(where.created_at || {}), gte: new Date(String(date_from)) };
    if (date_to) where.created_at = { ...(where.created_at || {}), lte: new Date(String(date_to) + 'T23:59:59.999Z') };
    if (department_id) where.department_id = String(department_id);

    const all = await (prisma as any).complaint.findMany({ where });
    const complaints = all.filter((c: any) => c.complaint_type === 'COMPLAINT');
    const counsels = all.filter((c: any) => c.complaint_type === 'COUNSEL');

    res.json({
      total: all.length,
      complaint_count: complaints.length,
      counsel_count: counsels.length,
      open: all.filter((c: any) => c.status === 'OPEN').length,
      in_progress: all.filter((c: any) => c.status === 'IN_PROGRESS').length,
      closed: all.filter((c: any) => c.status === 'CLOSED').length,
      resolution_rate: all.length > 0 ? Number(((all.filter((c: any) => c.status === 'CLOSED').length / all.length) * 100).toFixed(1)) : 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;
