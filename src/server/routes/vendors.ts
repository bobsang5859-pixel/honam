import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';

const router = Router();
router.use(authMiddleware);

router.get('/', async (req, res) => {
  try {
    const vendors = await prisma.vendor.findMany({
      where: { deleted_at: null },
      orderBy: { name: 'asc' },
    });
    res.json(vendors);
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

router.post('/', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  const { code, name, phone, email, lead_time_days } = req.body;
  if (!name) return res.status(400).json({ error: '업체명은 필수입니다.' });
  try {
    // 업체코드 자동 채번 — 미입력 시 V-#### 다음 일련번호(4자리)
    let finalCode = String(code ?? '').trim();
    if (!finalCode) {
      const rows = await prisma.vendor.findMany({
        where: { code: { startsWith: 'V-' } },
        select: { code: true },
      });
      let maxN = 0;
      for (const r of rows) {
        const m = /-(\d+)$/.exec(r.code);
        if (m) maxN = Math.max(maxN, Number(m[1]));
      }
      finalCode = `V-${String(maxN + 1).padStart(4, '0')}`;
    }
    const vendor = await prisma.vendor.create({
      data: { id: uuidv4(), code: finalCode, name, phone: phone ?? '', email: email ?? '', lead_time_days: lead_time_days ?? 3 },
    });
    await audit({ actor_user_id: req.user!.id, action: 'CREATE', entity_type: 'vendors', entity_id: vendor.id, after: vendor });
    res.status(201).json(vendor);
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 업체 코드입니다.' });
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  const { name, phone, email, lead_time_days, is_active } = req.body;
  try {
    const before = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: '업체를 찾을 수 없습니다.' });
    const after = await prisma.vendor.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(phone !== undefined && { phone }),
        ...(email !== undefined && { email }),
        ...(lead_time_days !== undefined && { lead_time_days }),
        ...(is_active !== undefined && { is_active }),
      },
    });
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'vendors', entity_id: after.id, before, after });
    res.json(after);
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

router.delete('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const before = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: '업체를 찾을 수 없습니다.' });
    await prisma.vendor.update({ where: { id: req.params.id }, data: { deleted_at: new Date(), is_active: false } });
    await audit({ actor_user_id: req.user!.id, action: 'SOFT_DELETE', entity_type: 'vendors', entity_id: req.params.id, before });
    res.json({ message: '삭제되었습니다.' });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

export default router;
