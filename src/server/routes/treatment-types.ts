/**
 * 처치 유형 관리 API
 * - 처치 유형 CRUD
 * - 처치별 물품 매핑 (TreatmentSupplyMap)
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware } from '../middleware/auth';

const prisma = new PrismaClient();
const router = Router();
router.use(authMiddleware);

// ─── 처치 유형 CRUD ───

/** GET / — 처치 유형 목록 */
router.get('/', async (_req: Request, res: Response) => {
  const types = await prisma.treatmentType.findMany({
    orderBy: { code: 'asc' },
    include: {
      supply_maps: {
        include: { item: { select: { id: true, name: true, uom: true } } },
      },
      _count: { select: { patient_treatments: true } },
    },
  });
  res.json(types);
});

/** GET /:id — 처치 유형 상세 */
router.get('/:id', async (req: Request, res: Response) => {
  const t = await prisma.treatmentType.findUnique({
    where: { id: req.params.id as string },
    include: {
      supply_maps: {
        include: { item: { select: { id: true, name: true, uom: true, item_code: true } } },
      },
      _count: { select: { patient_treatments: true } },
    },
  });
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json(t);
});

/** POST / — 처치 유형 생성 */
router.post('/', async (req: Request, res: Response) => {
  const { code, name, category } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'code, name required' });

  try {
    const t = await prisma.treatmentType.create({
      data: { code, name, category: category || '' },
    });
    res.status(201).json(t);
  } catch (err: any) {
    if (err.code === 'P2002') return res.status(409).json({ error: '중복된 코드입니다.' });
    throw err;
  }
});

/** PUT /:id — 처치 유형 수정 */
router.put('/:id', async (req: Request, res: Response) => {
  const { code, name, category, is_active } = req.body;
  const t = await prisma.treatmentType.update({
    where: { id: req.params.id as string },
    data: {
      ...(code !== undefined && { code }),
      ...(name !== undefined && { name }),
      ...(category !== undefined && { category }),
      ...(is_active !== undefined && { is_active }),
    },
  });
  res.json(t);
});

/** DELETE /:id — 처치 유형 삭제 (비활성) */
router.delete('/:id', async (req: Request, res: Response) => {
  await prisma.treatmentType.update({
    where: { id: req.params.id as string },
    data: { is_active: false },
  });
  res.json({ ok: true });
});

// ─── 처치별 물품 매핑 ───

/** POST /:id/supply-maps — 물품 매핑 추가/수정 (upsert) */
router.post('/:id/supply-maps', async (req: Request, res: Response) => {
  const treatment_type_id = req.params.id as string;
  const { item_id, qty_per_day, qty_per_week, note } = req.body;
  if (!item_id) return res.status(400).json({ error: 'item_id required' });

  const map = await prisma.treatmentSupplyMap.upsert({
    where: {
      treatment_type_id_item_id: { treatment_type_id, item_id },
    },
    create: {
      treatment_type_id,
      item_id,
      qty_per_day: qty_per_day ?? 1,
      qty_per_week: qty_per_week ?? 0,
      note: note || '',
    },
    update: {
      qty_per_day: qty_per_day ?? 1,
      qty_per_week: qty_per_week ?? 0,
      note: note || '',
    },
  });
  res.json(map);
});

/** DELETE /:id/supply-maps/:mapId — 물품 매핑 삭제 */
router.delete('/:id/supply-maps/:mapId', async (req: Request, res: Response) => {
  await prisma.treatmentSupplyMap.delete({
    where: { id: req.params.mapId as string },
  });
  res.json({ ok: true });
});

// ─── 환자 처치 항목 ───

/** GET /patient-treatments/:patientId — 환자의 처치 목록 */
router.get('/patient-treatments/:patientId', async (req: Request, res: Response) => {
  const pts = await prisma.patientTreatment.findMany({
    where: {
      patient_id: req.params.patientId as string,
      deleted_at: null,
    },
    include: {
      treatment_type: { select: { id: true, code: true, name: true, category: true } },
    },
    orderBy: { started_at: 'desc' },
  });
  res.json(pts);
});

/** POST /patient-treatments — 환자 처치 등록 */
router.post('/patient-treatments', async (req: Request, res: Response) => {
  const { patient_id, treatment_type_id, started_at, note } = req.body;
  const user = (req as any).user;
  if (!patient_id || !treatment_type_id) {
    return res.status(400).json({ error: 'patient_id, treatment_type_id required' });
  }

  const pt = await prisma.patientTreatment.create({
    data: {
      patient_id,
      treatment_type_id,
      started_at: started_at ? new Date(started_at) : new Date(),
      note: note || '',
      created_by: user?.id || '',
    },
    include: {
      treatment_type: { select: { id: true, code: true, name: true } },
    },
  });
  res.status(201).json(pt);
});

/** PUT /patient-treatments/:id — 환자 처치 수정 (종료 등) */
router.put('/patient-treatments/:id', async (req: Request, res: Response) => {
  const { ended_at, note } = req.body;
  const pt = await prisma.patientTreatment.update({
    where: { id: req.params.id as string },
    data: {
      ...(ended_at !== undefined && { ended_at: ended_at ? new Date(ended_at) : null }),
      ...(note !== undefined && { note }),
    },
  });
  res.json(pt);
});

/** DELETE /patient-treatments/:id — 환자 처치 소프트 삭제 */
router.delete('/patient-treatments/:id', async (req: Request, res: Response) => {
  await prisma.patientTreatment.update({
    where: { id: req.params.id as string },
    data: { deleted_at: new Date() },
  });
  res.json({ ok: true });
});

export default router;
