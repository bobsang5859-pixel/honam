import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);
const ALLOWED_CODE_TYPES = ['MAIN', 'SEVERE', 'RARE'] as const;
const V_CODE_TYPES = ['SEVERE', 'RARE'] as const;

// ──────────────────────────────────────────────────────────
// DiseaseCode (V코드 마스터) CRUD
// ──────────────────────────────────────────────────────────

// GET /disease-codes — 목록 조회
router.get('/', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE'), async (req, res) => {
  try {
    const { code_type, includeInactive } = req.query;
    const where: any = { deleted_at: null };
    if (code_type) where.code_type = String(code_type).toUpperCase();
    if (!includeInactive || includeInactive === 'false') where.is_active = true;

    const rows = await (prisma as any).diseaseCode.findMany({
      where,
      orderBy: [{ code_type: 'asc' }, { code: 'asc' }],
    });
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// POST /disease-codes — 신규 등록
router.post('/', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  const code = String(req.body?.code ?? '').trim().toUpperCase();
  const name = String(req.body?.name ?? '').trim();
  const code_type = String(req.body?.code_type ?? '').trim().toUpperCase();
  if (!code || !name || !code_type) return res.status(400).json({ error: '코드, 질환명, 유형은 필수입니다.' });
  if (!(ALLOWED_CODE_TYPES as readonly string[]).includes(code_type)) {
    return res.status(400).json({ error: '유형은 MAIN, SEVERE 또는 RARE이어야 합니다.' });
  }
  try {
    const created = await (prisma as any).diseaseCode.create({
      data: { id: uuidv4(), code, name, code_type, is_active: true },
    });
    res.status(201).json(created);
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 코드입니다.' });
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// PUT /disease-codes/:id — 수정
router.put('/:id', requirePermission('REQUEST_USE'), async (req, res) => {
  const { code, name, code_type, is_active } = req.body;
  try {
    const existing = await (prisma as any).diseaseCode.findFirst({
      where: { id: req.params.id, deleted_at: null },
    });
    if (!existing) return res.status(404).json({ error: '코드를 찾을 수 없습니다.' });

    const data: any = {};
    if (code !== undefined) data.code = String(code).trim().toUpperCase();
    if (name !== undefined) data.name = String(name).trim();
    if (code_type !== undefined) {
      const codeTypeNormalized = String(code_type).trim().toUpperCase();
      if (!(ALLOWED_CODE_TYPES as readonly string[]).includes(codeTypeNormalized)) {
        return res.status(400).json({ error: '유형은 MAIN, SEVERE 또는 RARE이어야 합니다.' });
      }
      data.code_type = codeTypeNormalized;
    }
    if (is_active !== undefined) data.is_active = Boolean(is_active);

    const updated = await (prisma as any).diseaseCode.update({ where: { id: req.params.id }, data });
    res.json(updated);
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 코드입니다.' });
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// DELETE /disease-codes/:id — 소프트 삭제
router.delete('/:id', requirePermission('REQUEST_USE'), async (req, res) => {
  try {
    const existing = await (prisma as any).diseaseCode.findFirst({
      where: { id: req.params.id, deleted_at: null },
    });
    if (!existing) return res.status(404).json({ error: '코드를 찾을 수 없습니다.' });
    await (prisma as any).diseaseCode.update({
      where: { id: req.params.id },
      data: { deleted_at: new Date(), is_active: false },
    });
    res.json({ message: '삭제되었습니다.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ──────────────────────────────────────────────────────────
// PatientDiseaseCode (환자별 V코드 이력) CRUD
// ──────────────────────────────────────────────────────────

// GET /patient-disease-codes — 이력 목록 조회
router.get('/patient-registrations', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE'), async (req, res) => {
  try {
    const { patient_id, code_type } = req.query;
    const where: any = { deleted_at: null };
    if (patient_id) where.patient_id = String(patient_id);

    const rows = await (prisma as any).patientDiseaseCode.findMany({
      where,
      include: {
        patient: {
          include: { department: true },
        },
        disease_code: true,
      },
      orderBy: [{ registered_at: 'desc' }],
    });

    const result = rows
      .filter((r: any) => {
        const rowCodeType = String(r.disease_code?.code_type ?? '').toUpperCase();
        if (!(V_CODE_TYPES as readonly string[]).includes(rowCodeType)) return false;
        return !code_type || rowCodeType === String(code_type).toUpperCase();
      })
      .map((r: any) => ({
        id: r.id,
        patient_id: r.patient_id,
        patient_name: r.patient?.name ?? '',
        chart_no: r.patient?.chart_no ?? '',
        department_name: r.patient?.department?.name ?? '',
        room_no: r.patient?.room_no ?? '',
        insurance_type: r.patient?.insurance_type ?? '',
        status: r.patient?.status ?? '',
        disease_code_id: r.disease_code_id,
        code: r.disease_code?.code ?? '',
        name: r.disease_code?.name ?? '',
        code_type: r.disease_code?.code_type ?? '',
        registered_at: r.registered_at ? r.registered_at.toISOString().slice(0, 10) : '',
        expires_at: r.expires_at ? r.expires_at.toISOString().slice(0, 10) : null,
        is_active: r.is_active,
        note: r.note ?? '',
      }));

    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// POST /disease-codes/patient-registrations — 새 이력 등록
router.post('/patient-registrations', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  const { patient_id, disease_code_id, registered_at, expires_at, note } = req.body;
  if (!patient_id || !disease_code_id || !registered_at) {
    return res.status(400).json({ error: '환자, 코드, 등록일은 필수입니다.' });
  }
  try {
    const patient = await (prisma as any).patient.findFirst({ where: { id: String(patient_id), deleted_at: null } });
    if (!patient) return res.status(404).json({ error: '환자를 찾을 수 없습니다.' });
    const dc = await (prisma as any).diseaseCode.findFirst({ where: { id: String(disease_code_id), deleted_at: null } });
    if (!dc) return res.status(404).json({ error: 'V코드를 찾을 수 없습니다.' });
    if (!(V_CODE_TYPES as readonly string[]).includes(String(dc.code_type ?? '').toUpperCase())) {
      return res.status(400).json({ error: '재등록 이력은 V코드(SEVERE/RARE)만 등록할 수 있습니다.' });
    }

    const created = await (prisma as any).patientDiseaseCode.create({
      data: {
        id: uuidv4(),
        patient_id: String(patient_id),
        disease_code_id: String(disease_code_id),
        registered_at: new Date(registered_at),
        expires_at: expires_at ? new Date(expires_at) : null,
        note: String(note ?? ''),
        is_active: true,
      },
    });

    // 환자의 현재 V코드 필드 동기화 (최신 등록 기준)
    await (prisma as any).patient.update({
      where: { id: String(patient_id) },
      data: {
        disease_code_id: String(disease_code_id),
        disease_code_registered_at: new Date(registered_at),
        disease_code_expires_at: expires_at ? new Date(expires_at) : null,
      } as any,
    });

    res.status(201).json(created);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// PUT /disease-codes/patient-registrations/:id — 이력 수정
router.put('/patient-registrations/:id', requirePermission('REQUEST_USE'), async (req, res) => {
  try {
    const existing = await (prisma as any).patientDiseaseCode.findFirst({
      where: { id: req.params.id, deleted_at: null },
    });
    if (!existing) return res.status(404).json({ error: '등록 이력을 찾을 수 없습니다.' });

    const { disease_code_id, registered_at, expires_at, note, is_active } = req.body;
    const data: any = {};
    if (disease_code_id !== undefined) {
      const nextDc = await (prisma as any).diseaseCode.findFirst({
        where: { id: String(disease_code_id), deleted_at: null },
      });
      if (!nextDc) return res.status(404).json({ error: '코드를 찾을 수 없습니다.' });
      if (!(V_CODE_TYPES as readonly string[]).includes(String(nextDc.code_type ?? '').toUpperCase())) {
        return res.status(400).json({ error: '재등록 이력은 V코드(SEVERE/RARE)만 등록할 수 있습니다.' });
      }
      data.disease_code_id = String(disease_code_id);
    }
    if (registered_at !== undefined) data.registered_at = new Date(registered_at);
    if (expires_at !== undefined) data.expires_at = expires_at ? new Date(expires_at) : null;
    if (note !== undefined) data.note = String(note);
    if (is_active !== undefined) data.is_active = Boolean(is_active);

    const updated = await (prisma as any).patientDiseaseCode.update({
      where: { id: req.params.id },
      data,
    });

    // 환자의 현재 V코드 필드 동기화 (이 기록이 is_active인 경우)
    if (updated.is_active) {
      await (prisma as any).patient.update({
        where: { id: existing.patient_id },
        data: {
          disease_code_id: updated.disease_code_id,
          disease_code_registered_at: updated.registered_at,
          disease_code_expires_at: updated.expires_at ?? null,
        } as any,
      });
    }

    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// DELETE /disease-codes/patient-registrations/:id — 소프트 삭제
router.delete('/patient-registrations/:id', requirePermission('REQUEST_USE'), async (req, res) => {
  try {
    const existing = await (prisma as any).patientDiseaseCode.findFirst({
      where: { id: req.params.id, deleted_at: null },
    });
    if (!existing) return res.status(404).json({ error: '등록 이력을 찾을 수 없습니다.' });
    await (prisma as any).patientDiseaseCode.update({
      where: { id: req.params.id },
      data: { deleted_at: new Date(), is_active: false },
    });
    res.json({ message: '삭제되었습니다.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;
