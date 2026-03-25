import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { nextSeq, generateNo } from '../utils/audit';
import { generateEquipmentSerial } from '../utils/serial';

const router = Router();
router.use(authMiddleware);

// ─── 헬퍼 ────────────────────────────────────────────────────────

function formatUnit(u: any) {
  return {
    id: u.id,
    serial_no: u.serial_no,
    item_id: u.item_id,
    item_name: u.item?.name ?? '',
    item_code: u.item?.item_code ?? '',
    department_id: u.department_id,
    department_name: u.department?.name ?? '',
    stock_out_id: u.stock_out_id,
    location: u.location,
    is_primary: u.is_primary,
    status: u.status,
    notes: u.notes,
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

const UNIT_INCLUDE = {
  item: { select: { name: true, item_code: true } },
  department: { select: { name: true } },
};

// ─── GET /my-dept — 내 부서 비품 목록 ────────────────────────────
router.get('/my-dept', async (req: AuthRequest, res) => {
  try {
    const deptId = req.user!.department_id;
    if (!deptId) return res.json([]);
    const units = await (prisma as any).equipmentUnit.findMany({
      where: { department_id: deptId },
      include: UNIT_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
    res.json(units.map(formatUnit));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET / — 전체 목록 (관리자) ──────────────────────────────────
router.get('/', requirePermission('PURCHASE_MANAGE'), async (_req, res) => {
  try {
    const units = await (prisma as any).equipmentUnit.findMany({
      include: UNIT_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
    res.json(units.map(formatUnit));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /repairs/list — 관리과용 수리 요청 전체 목록 ────────────
// ⚠ /:id 보다 먼저 정의해야 /repairs/list 가 /:id에 먹히지 않음
router.get('/repairs/list', async (req: AuthRequest, res) => {
  try {
    const { status } = req.query;
    const where: any = {};
    if (status) where.status = status;
    const repairs = await (prisma as any).equipmentRepair.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: {
        equipment_unit: { include: { item: { select: { name: true, item_code: true } }, department: { select: { name: true } } } },
        requesting_dept: { select: { name: true } },
      },
    });
    res.json(repairs);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /repairs/:repairId — 수리 처리 (관리과) ────────────────
router.put('/repairs/:repairId', async (req: AuthRequest, res) => {
  try {
    const { status, result_note } = req.body;
    if (!['IN_PROGRESS', 'COMPLETED', 'DISPOSED'].includes(status)) {
      return res.status(400).json({ error: '유효하지 않은 상태값입니다.' });
    }

    const repair = await (prisma as any).equipmentRepair.findUnique({
      where: { id: req.params.repairId },
      include: {
        equipment_unit: { include: { item: true, department: true } },
      },
    });
    if (!repair) return res.status(404).json({ error: '수리 내역을 찾을 수 없습니다.' });

    await (prisma as any).equipmentRepair.update({
      where: { id: req.params.repairId },
      data: { status, result_note: result_note ?? '' },
    });

    if (status === 'COMPLETED') {
      // 수리 완료 → 비품 상태 ACTIVE 복원
      await (prisma as any).equipmentUnit.update({
        where: { id: repair.equipment_unit_id },
        data: { status: 'ACTIVE' },
      });
    } else if (status === 'DISPOSED') {
      // 수리불가 → 비품 폐기 처리
      await (prisma as any).equipmentUnit.update({
        where: { id: repair.equipment_unit_id },
        data: { status: 'DISPOSED' },
      });

      const unit = repair.equipment_unit;
      const today = new Date();

      // 1. 폐기 WardRequest 자동 생성 (수리신청 첨부사진 그대로)
      const dispSeq = await nextSeq('ward_requests');
      const dispNo = generateNo('WR', dispSeq);
      const dispWr = await prisma.wardRequest.create({
        data: {
          id: uuidv4(),
          request_no: dispNo,
          department_id: unit.department_id,
          requester_id: req.user!.id,
          period_type: 'MONTH',
          period_start: today,
          period_end: today,
          request_type: 'EQUIPMENT',
          equipment_request_type: 'DISPOSAL',
          note: '수리불가',
          attachment_urls: repair.attachment_urls,
          equipment_unit_ids: JSON.stringify([unit.id]),
          source_repair_id: repair.id,
          status: 'APPROVED',
          submitted_at: today,
          items: {
            create: [{ id: uuidv4(), item_id: unit.item_id, requested_qty: 1, note: unit.serial_no }],
          },
        } as any,
      });

      // 수리 내역에 disposal WardRequest ID 연결
      await (prisma as any).equipmentRepair.update({
        where: { id: repair.id },
        data: { disposal_ward_request_id: dispWr.id },
      });
    }

    res.json({ ok: true });
  } catch (e: any) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ─── GET /:id — 단일 조회 + 수리이력 ────────────────────────────
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const unit = await (prisma as any).equipmentUnit.findUnique({
      where: { id: req.params.id },
      include: {
        ...UNIT_INCLUDE,
        repairs: {
          orderBy: { created_at: 'desc' },
          include: { requesting_dept: { select: { name: true } } },
        },
      },
    });
    if (!unit) return res.status(404).json({ error: '비품을 찾을 수 없습니다.' });
    res.json({ ...formatUnit(unit), repairs: unit.repairs });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /:id — 위치·정부·notes·status 수정 ─────────────────────
router.put('/:id', async (req: AuthRequest, res) => {
  try {
    const { location, is_primary, notes, status } = req.body;
    const unit = await (prisma as any).equipmentUnit.findUnique({ where: { id: req.params.id } });
    if (!unit) return res.status(404).json({ error: '비품을 찾을 수 없습니다.' });

    const isAdmin = req.user!.permissions.includes('SYSTEM_ADMIN') || req.user!.permissions.includes('PURCHASE_MANAGE');
    if (!isAdmin && unit.department_id !== req.user!.department_id) {
      return res.status(403).json({ error: '권한이 없습니다.' });
    }

    const data: any = {};
    if (location !== undefined) data.location = location;
    if (is_primary !== undefined) data.is_primary = Boolean(is_primary);
    if (notes !== undefined) data.notes = notes;
    if (status !== undefined && isAdmin) data.status = status;

    const updated = await (prisma as any).equipmentUnit.update({
      where: { id: req.params.id },
      data,
      include: UNIT_INCLUDE,
    });
    res.json(formatUnit(updated));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /:id/dispose — 폐기 신청 ───────────────────────────────
router.post('/:id/dispose', async (req: AuthRequest, res) => {
  try {
    const unit = await (prisma as any).equipmentUnit.findUnique({
      where: { id: req.params.id },
      include: { item: true },
    });
    if (!unit) return res.status(404).json({ error: '비품을 찾을 수 없습니다.' });
    if (unit.department_id !== req.user!.department_id && !req.user!.permissions.includes('SYSTEM_ADMIN')) {
      return res.status(403).json({ error: '자기 부서 비품만 폐기신청 가능합니다.' });
    }
    if (unit.status === 'DISPOSED') return res.status(400).json({ error: '이미 폐기된 비품입니다.' });

    const { note, attachment_urls } = req.body;
    const seq = await nextSeq('ward_requests');
    const request_no = generateNo('WR', seq);
    const today = new Date();

    const wr = await prisma.wardRequest.create({
      data: {
        id: uuidv4(),
        request_no,
        department_id: req.user!.department_id!,
        requester_id: req.user!.id,
        period_type: 'MONTH',
        period_start: today,
        period_end: today,
        request_type: 'EQUIPMENT',
        equipment_request_type: 'DISPOSAL',
        note: note ?? `비품 폐기신청 (${unit.serial_no})`,
        attachment_urls: Array.isArray(attachment_urls) ? JSON.stringify(attachment_urls) : '[]',
        equipment_unit_ids: JSON.stringify([unit.id]),
        submitted_at: today,
        items: {
          create: [{
            id: uuidv4(),
            item_id: unit.item_id,
            requested_qty: 1,
            note: unit.serial_no,
          }],
        },
      } as any,
    });

    // 자동 SUBMITTED 상태로 제출
    await prisma.wardRequest.update({ where: { id: wr.id }, data: { status: 'SUBMITTED' } });

    res.json({ ok: true, ward_request_id: wr.id, request_no });
  } catch (e: any) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ─── POST /:id/repair — 수리 신청 ────────────────────────────────
router.post('/:id/repair', async (req: AuthRequest, res) => {
  try {
    const unit = await (prisma as any).equipmentUnit.findUnique({ where: { id: req.params.id } });
    if (!unit) return res.status(404).json({ error: '비품을 찾을 수 없습니다.' });
    if (unit.department_id !== req.user!.department_id && !req.user!.permissions.includes('SYSTEM_ADMIN')) {
      return res.status(403).json({ error: '자기 부서 비품만 수리신청 가능합니다.' });
    }
    if (unit.status === 'DISPOSED') return res.status(400).json({ error: '폐기된 비품은 수리신청 불가합니다.' });
    if (unit.status === 'IN_REPAIR') return res.status(400).json({ error: '이미 수리 중인 비품입니다.' });

    const { description, attachment_urls } = req.body;

    const repair = await (prisma as any).equipmentRepair.create({
      data: {
        id: uuidv4(),
        equipment_unit_id: unit.id,
        requesting_dept_id: req.user!.department_id!,
        description: description ?? '',
        attachment_urls: Array.isArray(attachment_urls) ? JSON.stringify(attachment_urls) : '[]',
        status: 'PENDING',
      },
    });

    // 비품 상태를 IN_REPAIR로 변경
    await (prisma as any).equipmentUnit.update({
      where: { id: unit.id },
      data: { status: 'IN_REPAIR' },
    });

    res.json(repair);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /:id/repairs — 수리 이력 ───────────────────────────────
router.get('/:id/repairs', async (req, res) => {
  try {
    const repairs = await (prisma as any).equipmentRepair.findMany({
      where: { equipment_unit_id: req.params.id },
      orderBy: { created_at: 'desc' },
      include: { requesting_dept: { select: { name: true } } },
    });
    res.json(repairs);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
