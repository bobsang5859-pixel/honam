import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest, resolveDeptScope } from '../middleware/auth';
import { audit, generateNo, nextSeq } from '../utils/audit';
import {
  confirmReceipt,
  saveReceiptLine,
  ReceiptServiceError,
} from '../services/stock-out-receipt-service';
import { ALL_CATEGORIES } from '../../shared/types';

// ─── 비품 신청 첨부파일 업로드 설정 ───────────────────────────────────────
const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.env.USER_DATA_PATH || '.', 'uploads', 'equipment-attachments');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `eq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`);
  },
});
const uploadAttachment = multer({
  storage: attachmentStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('이미지 파일만 업로드 가능합니다.'));
  },
});

const router = Router();
router.use(authMiddleware);

const catLabelMap: Record<string, string> = Object.fromEntries(
  ALL_CATEGORIES.map(c => [c.value, c.label])
);

const INCLUDE_FULL = {
  department: true,
  requester: true,
  items: { include: { item: { include: { price_history: { orderBy: { effective_from: 'desc' as const }, take: 1 }, inventory: true } } } },
  approval_actions: { include: { approver: true, items: true }, orderBy: { created_at: 'desc' as const }, take: 1 },
};

// 자유 입력 품목 허용 신청 유형
const CUSTOM_ITEM_TYPES = ['CONSUMABLE_REGULAR', 'CONSUMABLE_MEDICAL'];

function formatRequest(r: any) {
  return {
    id: r.id,
    request_no: r.request_no,
    department_id: r.department_id,
    department_name: r.department?.name,
    requester_name: r.requester?.display_name,
    period_type: r.period_type,
    period_start: r.period_start,
    period_end: r.period_end,
    status: r.status,
    request_type: r.request_type ?? 'CONSUMABLE',
    is_emergency: r.is_emergency,
    equipment_request_type: r.equipment_request_type ?? null,
    note: r.note ?? null,
    attachment_urls: (() => { try { return JSON.parse(r.attachment_urls ?? '[]'); } catch { return []; } })(),
    submitted_at: r.submitted_at,
    items: (r.items ?? []).map((it: any) => ({
      id: it.id,
      item_id: it.item_id ?? null,
      item_code: it.item?.item_code ?? '',
      item_name: it.item?.name ?? it.custom_name ?? '',
      custom_name: it.custom_name ?? '',
      custom_spec: it.custom_spec ?? '',
      custom_link: it.custom_link ?? '',
      is_custom: !it.item_id,
      uom: it.item?.uom ?? '',
      requested_qty: Number(it.requested_qty),
      baseline_qty: Number(it.baseline_qty),
      diff_pct: Number(it.diff_pct),
      policy_flags: JSON.parse(it.policy_flags ?? '[]'),
      note: it.note,
      latest_price: it.item?.price_history?.[0] ? Number(it.item.price_history[0].price) : 0,
      on_hand_qty: it.item?.inventory?.reduce((s: number, inv: any) => s + Number(inv.on_hand_qty), 0) ?? 0,
    })),
    last_action: r.approval_actions?.[0] ? {
      action: r.approval_actions[0].action,
      reason: r.approval_actions[0].reason,
      approver_name: r.approval_actions[0].approver?.display_name,
      created_at: r.approval_actions[0].created_at,
    } : null,
  };
}

// POST /api/ward-requests/upload-attachment — 첨부파일 업로드 (request 생성 전에도 사용)
router.post('/upload-attachment', uploadAttachment.single('file'), async (req: AuthRequest, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
    const url = `/uploads/equipment-attachments/${req.file.filename}`;
    res.json({ url });
  } catch (e: any) { console.error(e); res.status(500).json({ error: e.message || '서버 오류' }); }
});

// DELETE /api/ward-requests/delete-attachment — 첨부파일 삭제
router.delete('/delete-attachment', async (req: AuthRequest, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url 필수' });
    const baseDir = path.resolve(process.env.USER_DATA_PATH || '.');
    const filePath = path.resolve(baseDir, url);
    if (!filePath.startsWith(baseDir)) return res.status(400).json({ error: '잘못된 경로입니다.' });
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (e: any) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// GET /api/ward-requests
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { status, department_id, type, include_depts } = req.query;
    const canViewAll = req.user?.permissions.includes('PURCHASE_MANAGE') || req.user?.permissions.includes('SYSTEM_ADMIN');
    const includeDepts = String(include_depts ?? '') === 'true';
    const where: any = { deleted_at: null };
    if (status && String(status) !== 'ALL') where.status = String(status);
    if (type) where.request_type = String(type);
    if (department_id) where.department_id = String(department_id);
    else if (!canViewAll) where.department_id = req.user?.department_id;
    else if (!includeDepts) {
      // keep existing admin behavior: all departments when no explicit department_id
    }

    const requests = await prisma.wardRequest.findMany({
      where,
      include: {
        department: true,
        requester: true,
        items: true,
        approval_actions: { include: { approver: true }, orderBy: { created_at: 'desc' }, take: 1 },
      },
      orderBy: { submitted_at: 'desc' },
    });
    res.json(requests.map(r => ({
      id: r.id,
      request_no: r.request_no,
      department_id: r.department_id,
      department_name: (r as any).department?.name,
      requester_name: (r as any).requester?.display_name,
      period_type: r.period_type,
      period_start: r.period_start,
      period_end: r.period_end,
      status: r.status,
      request_type: (r as any).request_type ?? 'CONSUMABLE',
      is_emergency: r.is_emergency,
      equipment_request_type: (r as any).equipment_request_type ?? null,
      note: (r as any).note ?? null,
      attachment_urls: (() => { try { return JSON.parse((r as any).attachment_urls ?? '[]'); } catch { return []; } })(),
      submitted_at: r.submitted_at,
      item_count: r.items.length,
      last_action: (r as any).approval_actions?.[0] ? {
        action: (r as any).approval_actions[0].action,
        approver_name: (r as any).approval_actions[0].approver?.display_name,
        created_at: (r as any).approval_actions[0].created_at,
      } : null,
    })));
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// GET /api/ward-requests/:id
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const r = await prisma.wardRequest.findUnique({ where: { id: req.params.id }, include: INCLUDE_FULL as any });
    if (!r) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    const canViewAll = req.user?.permissions.includes('PURCHASE_MANAGE') || req.user?.permissions.includes('SYSTEM_ADMIN');
    if (!canViewAll && r.department_id !== req.user?.department_id)
      return res.status(403).json({ error: '권한이 없습니다.' });
    res.json(formatRequest(r));
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// Helper: validate items against dept item-level permissions
// Returns null if OK, error message if blocked
async function validateItemPermissions(dept_id: string, item_ids: string[]): Promise<string | null> {
  const perms = await (prisma as any).deptItemPermission.findMany({ where: { department_id: dept_id } });
  if (perms.length === 0) return null; // 권한 미설정 = 전체 허용
  const allowed = new Set(perms.map((p: any) => p.item_id));
  const blocked_ids = item_ids.filter(id => !allowed.has(id));
  if (blocked_ids.length === 0) return null;
  const blockedItems = await prisma.item.findMany({ where: { id: { in: blocked_ids } }, select: { name: true } });
  return `신청 권한이 없는 품목이 포함되어 있습니다: ${blockedItems.map(b => b.name).join(', ')}`;
}

// POST /api/ward-requests — DRAFT 생성
router.post('/', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  const { period_type, period_start, period_end, is_emergency, request_type, equipment_request_type, note, attachment_urls, items } = req.body;

  const dept_id = req.user!.department_id;
  if (!dept_id) return res.status(400).json({ error: '소속 부서가 없습니다.' });

  const itemList: any[] = Array.isArray(items) ? items : [];
  const SCHEDULED_TYPES = ['CONSUMABLE_MEDICAL', 'CONSUMABLE_REGULAR', 'DIAPER', 'NIGHT_SNACK'];
  const reqType = request_type ?? 'CONSUMABLE_REGULAR';

  // 스케줄이 있는 유형 → 현재 활성 스케줄 검증
  let schedulePeriodStart = period_start;
  let schedulePeriodEnd = period_end;

  try {
    if (SCHEDULED_TYPES.includes(reqType)) {
      const now = new Date();
      const activeSchedule = await (prisma as any).requestSchedule.findFirst({
        where: {
          request_type: reqType,
          open_from: { lte: now },
          open_to: { gte: now },
        },
        orderBy: { open_from: 'asc' },
      });

      if (!activeSchedule) {
        const nextSchedule = await (prisma as any).requestSchedule.findFirst({
          where: { request_type: reqType, open_from: { gt: now } },
          orderBy: { open_from: 'asc' },
        });
        const typeLabel: Record<string, string> = {
          CONSUMABLE_MEDICAL: '의료소모품',
          CONSUMABLE_REGULAR: '일반소모품',
          DIAPER: '기저귀',
          NIGHT_SNACK: '야간당직간식',
        };
        const nextInfo = nextSchedule
          ? ` 다음 신청 기간: ${new Date(nextSchedule.open_from).toLocaleDateString('ko-KR')} ~ ${new Date(nextSchedule.open_to).toLocaleDateString('ko-KR')}`
          : ' 관리자에게 문의하세요.';
        return res.status(403).json({ error: `현재 ${typeLabel[reqType] ?? reqType} 신청 기간이 아닙니다.${nextInfo}` });
      }

      // 스케줄의 기간으로 period 자동 설정
      schedulePeriodStart = activeSchedule.open_from;
      schedulePeriodEnd = activeSchedule.open_to;
    }

    if (!schedulePeriodStart || !schedulePeriodEnd) {
      return res.status(400).json({ error: '기간은 필수입니다.' });
    }

    // 비품/수시 신청은 중복 체크 제외 (같은 날 여러 건 신청 가능)
    if (reqType !== 'EQUIPMENT' && reqType !== 'ADHOC') {
      const dupCheckOnCreate = await prisma.wardRequest.findFirst({
        where: {
          department_id: dept_id,
          request_type: reqType,
          period_start: new Date(schedulePeriodStart),
          status: { in: ['SUBMITTED', 'APPROVED', 'PARTIAL_APPROVED'] },
          deleted_at: null,
        },
      });
      if (dupCheckOnCreate) {
        return res.status(409).json({ error: `Duplicate request exists for this period (${dupCheckOnCreate.request_no}).` });
      }
    }

    // 자유 입력 품목과 기존 품목 분리
    const allowCustom = CUSTOM_ITEM_TYPES.includes(reqType);
    const masterItems = itemList.filter((it: any) => it.item_id);
    const customItems = allowCustom ? itemList.filter((it: any) => !it.item_id && it.custom_name) : [];

    if (!allowCustom && itemList.some((it: any) => !it.item_id)) {
      return res.status(400).json({ error: '이 신청 유형에서는 자유 입력 품목을 사용할 수 없습니다.' });
    }

    if (masterItems.length > 0) {
      const catErr = await validateItemPermissions(dept_id, masterItems.map((it: any) => it.item_id));
      if (catErr) return res.status(403).json({ error: catErr });
    }

    const seq = await nextSeq('ward_requests');
    const request_no = generateNo('WR', seq);

    const allCreateItems = [
      ...masterItems.map((it: any) => ({
        id: uuidv4(),
        item_id: it.item_id,
        requested_qty: it.requested_qty,
        note: it.note ?? '',
      })),
      ...customItems.map((it: any) => ({
        id: uuidv4(),
        item_id: null,
        custom_name: String(it.custom_name).trim(),
        custom_spec: String(it.custom_spec ?? '').trim(),
        custom_link: String(it.custom_link ?? '').trim(),
        requested_qty: it.requested_qty,
        note: it.note ?? '',
      })),
    ];

    const created = await prisma.wardRequest.create({
      data: {
        id: uuidv4(),
        request_no,
        department_id: dept_id,
        requester_id: req.user!.id,
        period_type: period_type ?? 'MONTH',
        period_start: new Date(schedulePeriodStart),
        period_end: new Date(schedulePeriodEnd),
        request_type: reqType,
        is_emergency: Boolean(is_emergency),
        ...(equipment_request_type && { equipment_request_type: String(equipment_request_type) }),
        ...(note && { note: String(note) }),
        attachment_urls: Array.isArray(attachment_urls) ? JSON.stringify(attachment_urls) : '[]',
        ...(allCreateItems.length > 0 && {
          items: { create: allCreateItems },
        }),
      },
      include: INCLUDE_FULL as any,
    });

    await audit({ actor_user_id: req.user!.id, action: 'CREATE', entity_type: 'ward_requests', entity_id: created.id, after: { request_no, status: 'DRAFT', request_type: reqType } });
    res.status(201).json(formatRequest(created));
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// PUT /api/ward-requests/:id — DRAFT 상태에서 품목 수정 (버그 수정: /:id/items → /:id)
router.put('/:id', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  const { items } = req.body;
  try {
    const wr = await prisma.wardRequest.findUnique({ where: { id: req.params.id } });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    if (wr.department_id !== req.user!.department_id) return res.status(403).json({ error: '권한이 없습니다.' });
    if (wr.status !== 'DRAFT') return res.status(400).json({ error: 'DRAFT 상태에서만 수정 가능합니다.' });

    const allowCustom = CUSTOM_ITEM_TYPES.includes(wr.request_type ?? '');
    const masterItems = (items ?? []).filter((it: any) => it.item_id);
    const customItems = allowCustom ? (items ?? []).filter((it: any) => !it.item_id && it.custom_name) : [];

    if (masterItems.length > 0) {
      const catErr = await validateItemPermissions(wr.department_id, masterItems.map((it: any) => it.item_id));
      if (catErr) return res.status(403).json({ error: catErr });
    }

    const allItems = [
      ...masterItems.map((it: any) => ({
        id: uuidv4(),
        ward_request_id: req.params.id,
        item_id: it.item_id,
        requested_qty: it.requested_qty,
        note: it.note ?? '',
      })),
      ...customItems.map((it: any) => ({
        id: uuidv4(),
        ward_request_id: req.params.id,
        item_id: null,
        custom_name: String(it.custom_name).trim(),
        custom_spec: String(it.custom_spec ?? '').trim(),
        custom_link: String(it.custom_link ?? '').trim(),
        requested_qty: it.requested_qty,
        note: it.note ?? '',
      })),
    ];
    await prisma.$transaction(async (tx) => {
      await tx.wardRequestItem.deleteMany({ where: { ward_request_id: req.params.id } });
      if (allItems.length > 0) {
        await (tx.wardRequestItem.createMany as any)({ data: allItems });
      }
    });
    const updated = await prisma.wardRequest.findUnique({ where: { id: req.params.id }, include: INCLUDE_FULL as any });
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'ward_requests', entity_id: req.params.id, reason: '품목 수정' });
    res.json(formatRequest(updated));
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// POST /api/ward-requests/:id/submit — 제출
router.post('/:id/submit', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const wr = await prisma.wardRequest.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { item: true } } },
    });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    if (wr.department_id !== req.user!.department_id) return res.status(403).json({ error: '권한이 없습니다.' });
    if (wr.status !== 'DRAFT') return res.status(400).json({ error: 'DRAFT 상태에서만 제출 가능합니다.' });
    if (wr.items.length === 0) return res.status(400).json({ error: '품목을 1개 이상 추가한 후 제출하세요.' });

    const requestType = (wr as any).request_type ?? 'CONSUMABLE_REGULAR';

    // 중복 신청 방지: 같은 부서·유형·기간에 이미 SUBMITTED/APPROVED 신청이 있으면 거부
    // 비품/수시 신청은 중복 체크 제외
    if (requestType !== 'EQUIPMENT' && requestType !== 'ADHOC') {
      const dupCheck = await prisma.wardRequest.findFirst({
        where: {
          id: { not: req.params.id },
          department_id: wr.department_id,
          request_type: requestType,
          period_start: wr.period_start,
          status: { in: ['SUBMITTED', 'APPROVED', 'PARTIAL_APPROVED'] },
          deleted_at: null,
        },
      });
      if (dupCheck) {
        return res.status(409).json({ error: `이미 해당 기간에 ${requestType} 신청(${dupCheck.request_no})이 존재합니다.` });
      }
    }

    // baseline 계산 + 상태 업데이트를 트랜잭션으로 처리
    const updated = await prisma.$transaction(async (tx) => {
      // 비품 신청은 baseline 계산 생략
      if (requestType !== 'EQUIPMENT') {
        const patientStat = await tx.patientStat.findFirst({
          where: {
            department_id: wr.department_id,
            period_type: 'MONTH',
            period_start: { lte: new Date(wr.period_start) },
            period_end: { gte: new Date(wr.period_end) },
            deleted_at: null,
          },
        });
        const patientCount = patientStat?.patient_count ?? 0;

        const overPct = 0.15;
        for (const item of wr.items) {
          const baseline = await tx.usageBaseline.findFirst({
            where: {
              item_id: item.item_id,
              deleted_at: null,
              effective_from: { lte: new Date() },
              OR: [{ effective_to: null }, { effective_to: { gte: new Date() } }],
            },
            orderBy: { version: 'desc' },
          });

          let baselineQty = 0;
          const flags: string[] = [];
          if (!baseline || patientCount === 0) {
            flags.push('BASELINE_MISSING');
          } else {
            baselineQty = Number(baseline.qty_per_patient) * patientCount;
            const diff = Math.abs(Number(item.requested_qty) - baselineQty);
            if (baselineQty > 0 && diff / baselineQty > overPct) flags.push('OVER_15PCT');
          }
          const diffPct = baselineQty > 0 ? ((Number(item.requested_qty) - baselineQty) / baselineQty) * 100 : 0;

          await tx.wardRequestItem.update({
            where: { id: item.id },
            data: { baseline_qty: baselineQty, diff_pct: diffPct, policy_flags: JSON.stringify(flags) },
          });
        }
      }

      return await tx.wardRequest.update({
        where: { id: req.params.id },
        data: { status: 'SUBMITTED', submitted_at: new Date() },
        include: INCLUDE_FULL as any,
      });
    });

    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'ward_requests', entity_id: req.params.id, reason: '신청 제출', after: { status: 'SUBMITTED' } });
    res.json(formatRequest(updated));
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// POST /api/ward-requests/:id/cancel
router.post('/:id/cancel', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const wr = await prisma.wardRequest.findUnique({ where: { id: req.params.id } });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    if (wr.department_id !== req.user!.department_id && !req.user?.permissions.includes('SYSTEM_ADMIN'))
      return res.status(403).json({ error: '권한이 없습니다.' });
    if (!['DRAFT', 'SUBMITTED'].includes(wr.status))
      return res.status(400).json({ error: 'DRAFT/SUBMITTED 상태에서만 취소 가능합니다.' });

    await prisma.wardRequest.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } });
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'ward_requests', entity_id: req.params.id, before: { status: wr.status }, after: { status: 'CANCELLED' }, reason: '신청 취소' });
    res.json({ message: '취소되었습니다.' });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// ─── 부서 수령확인 ─────────────────────────────────────────────────────────────

// GET /api/ward-requests/:id/receipt — 해당 신청서의 불출 + 수령 상태 조회
router.get('/:id/receipt', async (req: AuthRequest, res) => {
  try {
    const wr = await prisma.wardRequest.findUnique({ where: { id: req.params.id } });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    // 본인 부서 또는 관리자만
    const isAdmin = req.user?.permissions.includes('SYSTEM_ADMIN');
    if (wr.department_id !== req.user!.department_id && !isAdmin)
      return res.status(403).json({ error: '권한이 없습니다.' });

    const stockOuts = await prisma.stockOut.findMany({
      where: { ward_request_id: wr.id, deleted_at: null },
      include: {
        items: { include: { item: true } },
      },
      orderBy: { issued_at: 'desc' },
    });

    const result = stockOuts.map((so: any) => ({
      id: so.id,
      so_no: so.so_no,
      status: so.status,
      issued_at: so.issued_at,
      receipt_confirmed_at: so.receipt_confirmed_at,
      receipt_diff_count: Number(so.receipt_diff_count ?? 0),
      items: (so.items ?? []).map((it: any) => ({
        id: it.id,
        item_id: it.item_id,
        item_name: it.item?.name,
        item_code: it.item?.item_code,
        uom: it.item?.uom,
        issued_qty: Number(it.issued_qty),
        received_qty: it.received_qty == null ? null : Number(it.received_qty),
        receipt_note: it.receipt_note ?? '',
        receipt_confirmed_at: it.receipt_confirmed_at,
      })),
    }));

    res.json(result);
  } catch (e: any) { res.status(500).json({ error: '서버 오류' }); }
});

// POST /api/ward-requests/:id/receipt — 수령확인 처리 (저장 + 확정)
router.post('/:id/receipt', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const wr = await prisma.wardRequest.findUnique({ where: { id: req.params.id } });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    if (wr.department_id !== req.user!.department_id)
      return res.status(403).json({ error: '본인 부서 신청서만 수령확인 가능합니다.' });

    const { stock_out_id, items } = req.body;
    if (!stock_out_id || !Array.isArray(items))
      return res.status(400).json({ error: 'stock_out_id와 items 배열이 필요합니다.' });

    const viewer = {
      user_id: req.user!.id,
      department_id: req.user!.department_id ?? null,
      is_admin_like: false,
    };

    // 각 품목 수령수량 저장
    for (const line of items) {
      await saveReceiptLine({
        stock_out_id: String(stock_out_id),
        item_id: String(line.item_id),
        received_qty: Number(line.received_qty),
        receipt_note: String(line.note ?? '').trim(),
        viewer,
      });
    }

    // 수령 확정
    const result = await confirmReceipt({ stock_out_id: String(stock_out_id), viewer });

    await audit({
      actor_user_id: req.user!.id,
      action: 'CONFIRM_RECEIPT',
      entity_type: 'stock_out',
      entity_id: stock_out_id,
      after: {
        status: result.status,
        receipt_diff_count: result.receipt_diff_count,
        follow_up_count: result.follow_up_count,
        via: 'ward-request-receipt',
      },
    });

    res.json({
      message: '수령확인 완료',
      status: result.status,
      receipt_diff_count: result.receipt_diff_count,
      follow_up_count: result.follow_up_count,
    });
  } catch (e: any) {
    if (e instanceof ReceiptServiceError) {
      return res.status(e.status).json({ error: e.message });
    }
    res.status(500).json({ error: e?.message || '서버 오류' });
  }
});

export default router;
