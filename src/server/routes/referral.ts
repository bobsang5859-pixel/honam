import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';

const router = Router();

// 파일 업로드 설정
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.env.USER_DATA_PATH || '.', 'uploads', 'referrals');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `ref-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('이미지 또는 PDF 파일만 업로드 가능합니다.'));
  },
});

const AI_SERVER_URL = process.env.AI_SERVER_URL || 'http://localhost:8000';

// ── 인증 필요한 엔드포인트 ──
router.use(authMiddleware);

// 접수 목록 조회
router.get('/', async (req: AuthRequest, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : '';
    const where: any = { deleted_at: null };
    if (status) where.status = status;

    const referrals = await (prisma as any).referral.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 100,
      include: {
        uploader: { select: { display_name: true } },
        approver: { select: { display_name: true } },
      },
    });
    res.json(referrals);
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// 접수 상세
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const referral = await (prisma as any).referral.findUnique({
      where: { id: req.params.id },
      include: {
        uploader: { select: { display_name: true } },
        approver: { select: { display_name: true } },
        patient: { select: { id: true, name: true, department: { select: { name: true } } } },
      },
    });
    if (!referral || referral.deleted_at) return res.status(404).json({ error: '접수 건을 찾을 수 없습니다.' });
    res.json(referral);
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// 의뢰서 업로드 → AI 분석
router.post('/upload', upload.single('file'), async (req: AuthRequest, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

    // Referral 레코드 생성
    const referral = await (prisma as any).referral.create({
      data: {
        id: uuidv4(),
        file_path: `/uploads/referrals/${req.file.filename}`,
        file_name: req.file.originalname,
        mime_type: req.file.mimetype,
        memo: String(req.body?.memo ?? ''),
        uploaded_by: req.user!.id,
        status: 'UPLOADED',
      },
    });

    // Python AI 서버로 분석 요청
    try {
      const FormData = (await import('form-data')).default;
      const formData = new FormData();
      formData.append('file', fs.createReadStream(req.file.path), {
        filename: req.file.originalname,
        contentType: req.file.mimetype,
      });
      formData.append('memo', String(req.body?.memo ?? ''));

      const fetch = (await import('node-fetch')).default;
      const aiRes = await fetch(`${AI_SERVER_URL}/analyze`, {
        method: 'POST',
        body: formData as any,
        headers: formData.getHeaders(),
      });

      if (aiRes.ok) {
        const aiData = await aiRes.json() as any;
        if (aiData.success && aiData.data) {
          const d = aiData.data;

          // 빈 병상 자동 탐색
          const suggested = await findAvailableBed();

          await (prisma as any).referral.update({
            where: { id: referral.id },
            data: {
              status: 'REVIEW',
              patient_name: d.patientName || '',
              diagnosis: d.diagnosis || '',
              condition: d.condition || '',
              admission_possible: d.admissionPossible ?? true,
              ai_summary: d.aiSummary || '',
              suggested_ward: suggested?.wardName || d.suggestedWard || '',
              suggested_room: suggested?.roomNo || d.suggestedRoom || '',
              room_reason: suggested?.reason || d.roomReason || '',
            },
          });

          const updated = await (prisma as any).referral.findUnique({ where: { id: referral.id } });
          return res.json({ success: true, referral: updated, aiMode: aiData.mode });
        }
      }

      // AI 서버 응답 실패 → UPLOADED 상태 유지
      await (prisma as any).referral.update({ where: { id: referral.id }, data: { status: 'UPLOADED', ai_summary: 'AI 서버 응답 실패. 수동 입력이 필요합니다.' } });
      res.json({ success: true, referral: { ...referral, status: 'UPLOADED' }, aiMode: 'failed' });

    } catch (aiErr) {
      // AI 서버 연결 실패 → UPLOADED 상태 유지 (파일은 저장됨)
      console.error('[Referral] AI server error:', aiErr);
      await (prisma as any).referral.update({ where: { id: referral.id }, data: { ai_summary: 'AI 서버에 연결할 수 없습니다. 수동 입력이 필요합니다.' } });
      res.json({ success: true, referral, aiMode: 'offline' });
    }
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// 담당자 승인 → 환자 자동 등록
router.post('/:id/approve', requirePermission('PATIENT_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const referral = await (prisma as any).referral.findUnique({ where: { id: req.params.id } });
    if (!referral || referral.deleted_at) return res.status(404).json({ error: '접수 건을 찾을 수 없습니다.' });
    if (referral.status === 'APPROVED') return res.status(400).json({ error: '이미 승인된 건입니다.' });

    const { finalWard, finalRoom, finalBed, departmentId, memo } = req.body;

    // 환자 자동 등록
    const patient = await (prisma as any).patient.create({
      data: {
        id: uuidv4(),
        name: req.body.patientName || referral.patient_name || '',
        chart_no: req.body.chartNo || '',
        patient_no: req.body.chartNo || '',
        department_id: departmentId || '',
        room_no: finalRoom || referral.suggested_room || '',
        bed_no: finalBed ? Number(finalBed) : null,
        insurance_type: req.body.insuranceType || 'HEALTH',
        copay_reduction: req.body.copayReduction || 'NONE',
        prev_hospital: referral.prevHospital || req.body.prevHospital || '',
        status: 'ADMITTED',
        admitted_at: new Date(),
        created_by: req.user!.id,
        gender: req.body.gender || 'UNKNOWN',
        patient_group: req.body.patientGroup || 'UNRATED',
        mobility_type: req.body.mobilityType || 'BEDRIDDEN',
        note: referral.diagnosis || '',
      } as any,
    });

    // Referral 업데이트
    await (prisma as any).referral.update({
      where: { id: referral.id },
      data: {
        status: 'APPROVED',
        final_ward: finalWard || referral.suggested_ward,
        final_room: finalRoom || referral.suggested_room,
        approved_by: req.user!.id,
        approved_at: new Date(),
        patient_id: patient.id,
      },
    });

    await audit({ actor_user_id: req.user!.id, action: 'REFERRAL_APPROVE', entity_type: 'referrals', entity_id: referral.id, after: { patient_id: patient.id } });

    res.json({ success: true, patientId: patient.id });
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// 반려
router.post('/:id/reject', requirePermission('PATIENT_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const referral = await (prisma as any).referral.findUnique({ where: { id: req.params.id } });
    if (!referral || referral.deleted_at) return res.status(404).json({ error: '접수 건을 찾을 수 없습니다.' });

    await (prisma as any).referral.update({
      where: { id: referral.id },
      data: {
        status: 'REJECTED',
        reject_reason: req.body.reason || '',
        approved_by: req.user!.id,
        approved_at: new Date(),
      },
    });

    await audit({ actor_user_id: req.user!.id, action: 'REFERRAL_REJECT', entity_type: 'referrals', entity_id: referral.id });

    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// ── 빈 병상 탐색 헬퍼 ──
async function findAvailableBed(): Promise<{ wardName: string; roomNo: string; bedNo: number; reason: string } | null> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rooms = await (prisma as any).wardRoom.findMany({
      where: { deleted_at: null, is_active: true, is_hospice: false },
      include: { department: { select: { id: true, name: true } } },
      orderBy: [{ department: { name: 'asc' } }, { room_no: 'asc' }],
    });

    for (const room of rooms) {
      for (let bed = 1; bed <= room.capacity; bed++) {
        const occupied = await (prisma as any).wardRoomBoard.findFirst({
          where: {
            board_date: new Date(today),
            ward_room_id: room.id,
            bed_no: bed,
            deleted_at: null,
            patient_name: { not: '' },
          },
        });
        if (!occupied) {
          return {
            wardName: room.department?.name ?? '',
            roomNo: room.room_no,
            bedNo: bed,
            reason: `${room.department?.name ?? ''} ${room.room_no}호 ${bed}번 병상 비어있음`,
          };
        }
      }
    }
  } catch (e) { console.error('[Referral] findAvailableBed error:', e); }
  return null;
}

export default router;
