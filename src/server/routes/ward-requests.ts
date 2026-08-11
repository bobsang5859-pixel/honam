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
import { pickDeptLocationId, setInventoryQty } from '../utils/inventory-helpers';
import { inferUsageKind, getGroupKey, type UsageKind } from '../../shared/usage-kind';
import { inferRecommendedQty } from '../services/inferDemand';

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
  items: { include: { item: { include: { price_history: { orderBy: { effective_from: 'desc' as const }, take: 1 }, inventory: { include: { location: true } } } } } },
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
    is_test: !!r.is_test,
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
      purchase_uom: it.item?.purchase_uom ?? it.item?.uom ?? '',
      issue_uom: it.item?.issue_uom ?? it.item?.uom ?? '',
      pack_size: Number(it.item?.pack_size ?? 1),
      requested_qty: Number(it.requested_qty),
      current_stock_qty: it.current_stock_qty != null ? Number(it.current_stock_qty) : null,
      baseline_qty: Number(it.baseline_qty),
      diff_pct: Number(it.diff_pct),
      policy_flags: JSON.parse(it.policy_flags ?? '[]'),
      note: it.note,
      is_test: !!r.is_test,
      latest_price: it.item?.price_history?.[0] ? Number(it.item.price_history[0].price) : 0,
      on_hand_qty: it.item?.inventory?.filter((inv: any) => inv.location?.department_id === r.department_id).reduce((s: number, inv: any) => s + Number(inv.on_hand_qty), 0) ?? 0,
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

// POST /api/ward-requests/register-stock
// 부서 재고수량 단독 등록 — 신청서 제출 없이 부서 Inventory 만 갱신.
// 정기 소모품 신청 시점이 아니더라도 재고 카운트를 빠르게 등록할 수 있게 한다.
//
// 입력: { items: [{ item_id: string, current_stock_qty: number }] }
// 동작: 본인 부서의 활성 InventoryLocation 에 setInventoryQty 일괄 적용.
//
// 보안 가드 (A 보강):
//   - 부서 권한 카테고리(DeptItemPermission) 미허용 품목 거절
//   - 수량 상한(MAX_STOCK_QTY=999_999) 초과 거절
//   - 배치 크기 상한(MAX_BATCH_SIZE=500) 초과 거절
//   - 변경 전/후 스냅샷 + 품목 목록 감사 로그
const REGISTER_STOCK_MAX_QTY = 999_999;
const REGISTER_STOCK_MAX_BATCH = 500;

router.post('/register-stock', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const dept_id = req.user?.department_id;
    if (!dept_id) return res.status(400).json({ error: '소속 부서가 없습니다.' });

    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (rawItems.length === 0) return res.status(400).json({ error: '등록할 품목이 없습니다.' });
    if (rawItems.length > REGISTER_STOCK_MAX_BATCH) {
      return res.status(400).json({ error: `한 번에 ${REGISTER_STOCK_MAX_BATCH}개 이하만 등록할 수 있습니다.` });
    }

    // 1차 — 형식·범위 검증
    type StockRow = { item_id: string; current_stock_qty: number };
    const validRows: StockRow[] = rawItems
      .map((it: any): StockRow => ({
        item_id: String(it?.item_id ?? '').trim(),
        current_stock_qty: Number(it?.current_stock_qty),
      }))
      .filter((it: StockRow) =>
        it.item_id.length > 0
        && Number.isFinite(it.current_stock_qty)
        && it.current_stock_qty >= 0
        && it.current_stock_qty <= REGISTER_STOCK_MAX_QTY,
      );
    if (validRows.length === 0) {
      return res.status(400).json({ error: `유효한 입력이 없습니다. (수량 0~${REGISTER_STOCK_MAX_QTY} 범위)` });
    }

    // 2차 — 부서 품목 권한 체크 (DeptItemPermission)
    const perms: Array<{ item_id: string }> = await (prisma as any).deptItemPermission.findMany({
      where: { department_id: dept_id },
      select: { item_id: true },
    });
    const allowedItemIds: Set<string> | null = perms.length === 0 ? null : new Set(perms.map(p => p.item_id));
    const targetIds = validRows.map(r => r.item_id);

    // 품목 존재 여부 + 카테고리 정보
    const itemsInDb = await prisma.item.findMany({
      where: { id: { in: targetIds }, deleted_at: null },
      select: { id: true, name: true, category: true },
    });
    const dbItemMap = new Map(itemsInDb.map(i => [i.id, i]));

    const blocked: Array<{ item_id: string; reason: string }> = [];
    const allowedRows = validRows.filter(r => {
      if (!dbItemMap.has(r.item_id)) {
        blocked.push({ item_id: r.item_id, reason: 'NOT_FOUND' });
        return false;
      }
      if (allowedItemIds && !allowedItemIds.has(r.item_id)) {
        blocked.push({ item_id: r.item_id, reason: 'PERMISSION_DENIED' });
        return false;
      }
      return true;
    });
    if (allowedRows.length === 0) {
      return res.status(403).json({ error: '권한이 있는 품목이 없습니다.', blocked });
    }

    const locationId = await pickDeptLocationId(dept_id);
    if (!locationId) return res.status(400).json({ error: '부서의 활성 보관함이 없습니다. 시스템 관리자에게 문의하세요.' });

    // 변경 전 스냅샷 (감사용)
    const beforeRows = await prisma.inventory.findMany({
      where: { location_id: locationId, item_id: { in: allowedRows.map(r => r.item_id) } },
      select: { item_id: true, on_hand_qty: true },
    });
    const beforeMap = new Map(beforeRows.map(r => [r.item_id, Number(r.on_hand_qty)]));

    await prisma.$transaction(async (tx) => {
      for (const r of allowedRows) {
        await setInventoryQty(tx, r.item_id, locationId, r.current_stock_qty);
      }
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'UPDATE',
      entity_type: 'inventory',
      entity_id: locationId,
      before: {
        items: allowedRows.map(r => ({
          item_id: r.item_id,
          name: dbItemMap.get(r.item_id)?.name,
          on_hand_qty: beforeMap.get(r.item_id) ?? null,
        })),
      },
      after: {
        department_id: dept_id,
        location_id: locationId,
        source: 'register_stock',
        items: allowedRows.map(r => ({
          item_id: r.item_id,
          name: dbItemMap.get(r.item_id)?.name,
          on_hand_qty: r.current_stock_qty,
        })),
        blocked_count: blocked.length,
      },
    });

    res.json({
      updated: allowedRows.length,
      blocked: blocked.length > 0 ? blocked : undefined,
    });
  } catch (e) {
    console.error('[register-stock] error:', e);
    res.status(500).json({ error: '재고 등록 중 오류가 발생했습니다.' });
  }
});

// GET /api/ward-requests/recommendations
// 수량 자동 추천 — 기준량(qty_per_patient × 현재 환자수) + 지난 3개월 불출 이력 하이브리드
router.get('/recommendations', async (req: AuthRequest, res) => {
  try {
    const department_id = String(req.query.department_id ?? req.user?.department_id ?? '');
    if (!department_id) return res.status(400).json({ error: '부서 정보가 없습니다.' });

    // 현재 입원 환자 수
    const patientCount = await (prisma as any).patient.count({
      where: { department_id, status: 'ADMITTED', deleted_at: null },
    });

    // 활성 품목 목록 (부서 권한 반영 — permission은 items 필터)
    const items = await (prisma as any).item.findMany({
      where: { is_active: true, deleted_at: null },
      include: { inventory: true },
    });

    // 부서 권한 체크: dept_category_permissions 존재 여부
    // (모든 권한 없으면 전 품목, 있으면 필터) — 간단화: 제한 없는 전체 반환
    // 필요시 dept-permissions/my-items 로직 재사용 가능

    // 모든 품목의 최신 기준량 한 번에 조회
    const itemIds = items.map((i: any) => i.id);
    const baselines = await (prisma as any).usageBaseline.findMany({
      where: {
        item_id: { in: itemIds },
        deleted_at: null,
        effective_from: { lte: new Date() },
        OR: [{ effective_to: null }, { effective_to: { gte: new Date() } }],
      },
      orderBy: [{ item_id: 'asc' }, { version: 'desc' }],
    });
    const baselineByItem: Record<string, number> = {};
    for (const b of baselines) {
      if (baselineByItem[b.item_id] === undefined) {
        baselineByItem[b.item_id] = Number(b.qty_per_patient);
      }
    }

    // 지난 3개월 부서별 불출 이력 집계 (월별 합계)
    const now = new Date();
    const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    // 테이블명: StockOut → stock_out (schema @@map). 파라미터 바인딩으로 SQL 인젝션 방지.
    // 테스트 데이터(is_test=1)는 추천 알고리즘에서 제외.
    const history: Array<{ item_id: string; month: string; total: number }> = await prisma.$queryRaw`
      SELECT soi.item_id as item_id,
             strftime('%Y-%m', so.issued_at) as month,
             CAST(SUM(soi.issued_qty) AS REAL) as total
      FROM stock_out_items soi
      JOIN stock_out so ON so.id = soi.stock_out_id
      WHERE so.department_id = ${department_id}
        AND so.issued_at >= ${threeMonthsAgo}
        AND so.deleted_at IS NULL
        AND so.is_test = 0
      GROUP BY soi.item_id, month
    ` as any;

    // 품목별로 history 재구성
    const historyByItem: Record<string, { months: string[]; totals: number[] }> = {};
    for (const h of history) {
      if (!historyByItem[h.item_id]) historyByItem[h.item_id] = { months: [], totals: [] };
      historyByItem[h.item_id].months.push(h.month);
      historyByItem[h.item_id].totals.push(Number(h.total));
    }

    const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

    // 가이드라인 기반 fallback — AppSetting 'inference:enabled' true 일 때만 작동.
    // 운영자가 데이터가 충분히 쌓였다고 판단 후 비용분석 화면의 "추천 시작" 버튼으로 활성화.
    // 기본값 false — 가이드라인 추정값이 실사용량과 격차 클 수 있어 운영자 결정 후 적용.
    const inferenceFlag = await (prisma as any).appSetting.findUnique({
      where: { key: 'inference:enabled' },
    });
    const inferenceEnabled = inferenceFlag?.value === 'true';

    const guidelineQtyByItem: Record<string, number> = {};
    if (inferenceEnabled) {
      await Promise.all(
        items.map(async (item: any) => {
          try {
            const inf = await inferRecommendedQty(department_id, item.id, 30);
            if (inf && inf.recommended > 0) guidelineQtyByItem[item.id] = inf.recommended;
          } catch {
            // 가이드라인 매핑 없는 품목 패스
          }
        })
      );
    }

    const recommendations = items.map((item: any) => {
      // item.inventory는 location별 배열 — 모든 위치 합산이 현재 보유량
      const onHand = Array.isArray(item.inventory)
        ? item.inventory.reduce((sum: number, inv: any) => sum + Number(inv?.on_hand_qty ?? 0), 0)
        : Number(item.inventory?.on_hand_qty ?? item.on_hand_qty ?? 0);
      const perPatient = baselineByItem[item.id] ?? 0;
      const baselineQty = perPatient * patientCount;

      const hist = historyByItem[item.id];
      const histMonths = hist?.totals.length ?? 0;
      const histAvg = histMonths > 0 ? hist!.totals.reduce((a, b) => a + b, 0) / histMonths : 0;
      // 가장 최근 월을 lastMonth로
      let lastMonth = 0;
      if (hist && hist.months.length > 0) {
        const maxIdx = hist.months.reduce((best, cur, i) => cur > hist.months[best] ? i : best, 0);
        lastMonth = hist.totals[maxIdx];
      }
      const trendPct = (lastMonth > 0 && histAvg > 0) ? ((lastMonth / histAvg) - 1) * 100 : 0;
      const trendCapped = clamp(trendPct, -30, 30);

      const guidelineQty = guidelineQtyByItem[item.id] ?? 0;

      let raw = 0;
      let source: 'BASELINE' | 'HISTORY' | 'HYBRID' | 'GUIDELINE' | 'NONE' = 'NONE';
      if (baselineQty > 0 && histMonths >= 2) {
        raw = baselineQty * (1 + trendCapped / 100);
        source = 'HYBRID';
      } else if (baselineQty > 0) {
        raw = baselineQty;
        source = 'BASELINE';
      } else if (histAvg > 0) {
        raw = histAvg * (1 + trendCapped / 100);
        source = 'HISTORY';
      } else if (guidelineQty > 0) {
        // BASELINE/HISTORY 둘 다 없을 때 의료 가이드라인 prior 활용
        raw = guidelineQty;
        source = 'GUIDELINE';
      }

      const need = Math.round(raw);
      const recommendedQty = Math.max(0, need - onHand);

      // 월별 이력을 정렬된 배열로 정리 (최근 순)
      const historyMonthly: Array<{ month: string; total: number }> = [];
      if (hist) {
        for (let i = 0; i < hist.months.length; i++) {
          historyMonthly.push({ month: hist.months[i], total: Math.round(hist.totals[i] * 10) / 10 });
        }
        historyMonthly.sort((a, b) => a.month.localeCompare(b.month));
      }

      // 신뢰도 — LOW: 이력 없음 / MEDIUM: 이력 1~2개월 / HIGH: 이력 3개월+
      let confidence: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
      if (histMonths >= 3) confidence = 'HIGH';
      else if (histMonths >= 1) confidence = 'MEDIUM';
      // baseline 만 있고 이력 없어도 MEDIUM 으로 격상
      if (source === 'BASELINE' && confidence === 'LOW') confidence = 'MEDIUM';

      return {
        item_id: item.id,
        on_hand_qty: onHand,
        baseline_per_patient: perPatient,
        baseline_qty: Math.round(baselineQty),
        history_avg_monthly: Math.round(histAvg * 10) / 10,
        history_monthly: historyMonthly,
        confidence,
        history_trend_pct: Math.round(trendCapped * 10) / 10,
        recommended_qty: recommendedQty,
        source,
      };
    });

    res.json({
      current_patient_count: patientCount,
      items: recommendations,
    });
  } catch (e) {
    console.error('[recommendations] error:', e);
    res.status(500).json({ error: '추천 조회 중 오류가 발생했습니다.' });
  }
});

// ─── 신청 작성 화면 컨텍스트 ─────────────────────────────────
// 한 번의 호출로: 부서 위치 재고 + 환자×품목 자동 매핑 + 부서 환자 명단 + 활성 처치
// 클라이언트가 라인별 prefill 과 환자 추가 popup 을 모두 그릴 수 있도록 컨텍스트 일괄 제공.
router.get('/draft-context', async (req: AuthRequest, res) => {
  try {
    const deptId = String(req.query.department_id ?? '').trim()
      || (req.user?.department_id ?? '');
    if (!deptId) return res.status(400).json({ error: 'department_id 가 필요합니다.' });

    // 1) 부서 위치 재고 합계 (여러 location 가능)
    const locations = await prisma.inventoryLocation.findMany({
      where: { department_id: deptId, deleted_at: null, is_active: true },
      select: { id: true },
    });
    const locationIds = locations.map(l => l.id);
    const inventoryRows = locationIds.length > 0
      ? await prisma.inventory.findMany({
          where: { location_id: { in: locationIds } },
          select: { item_id: true, on_hand_qty: true },
        })
      : [];
    const inventoryByItem: Record<string, number> = {};
    for (const inv of inventoryRows) {
      inventoryByItem[inv.item_id] = (inventoryByItem[inv.item_id] ?? 0) + Number(inv.on_hand_qty);
    }

    // 2) 부서 입원 환자 + 활성 처치
    const patients = await prisma.patient.findMany({
      where: {
        department_id: deptId,
        deleted_at: null,
        status: 'ADMITTED',
      },
      select: { id: true, name: true, room_no: true, bed_no: true, diaper_state: true },
    });
    const patientIds = patients.map(p => p.id);
    const treatments = patientIds.length > 0 ? await prisma.patientTreatment.findMany({
      where: {
        patient_id: { in: patientIds },
        deleted_at: null,
        OR: [{ ended_at: null }, { ended_at: { gt: new Date() } }],
      },
      include: { treatment_type: { select: { id: true, name: true } } },
    }) : [];

    // 3) 처치-품목 매핑 + 기저귀 카테고리 품목 ID 목록
    const supplyMaps = await prisma.treatmentSupplyMap.findMany({
      select: { treatment_type_id: true, item_id: true },
    });
    const itemsByTreatment: Record<string, string[]> = {};
    const treatableItemIds = new Set<string>();
    for (const sm of supplyMaps) {
      (itemsByTreatment[sm.treatment_type_id] ||= []).push(sm.item_id);
      treatableItemIds.add(sm.item_id);
    }
    const diaperItems = await prisma.item.findMany({
      where: { category: { startsWith: 'DIAPER' }, deleted_at: null },
      select: { id: true },
    });
    const diaperItemIds = new Set(diaperItems.map(it => it.id));
    for (const id of diaperItemIds) treatableItemIds.add(id);

    // 4) 환자×품목 자동 매핑 — 처치 기반 + 기저귀 상태 기반 + usage_kind 매핑
    type PUSource = 'TREATMENT' | 'DIAPER' | 'USAGE_KIND';
    type PUEntry = { id: string; name: string; room_no: string; bed_no: number | null; source: PUSource };
    const patientUsage: Record<string, PUEntry[]> = {};
    for (const p of patients) {
      const itemIds = new Set<string>();
      const myTreatments = treatments.filter(t => t.patient_id === p.id);
      for (const t of myTreatments) {
        for (const itemId of itemsByTreatment[t.treatment_type_id] ?? []) itemIds.add(itemId);
      }
      // 원내 기저귀 사용자(IN_HOUSE) 만 우리가 공급. PERSONAL/NONE 은 제외.
      const isDiaperUser = p.diaper_state === 'IN_HOUSE';
      if (isDiaperUser) {
        for (const id of diaperItemIds) itemIds.add(id);
      }
      for (const itemId of itemIds) {
        const source: PUSource = (isDiaperUser && diaperItemIds.has(itemId)) ? 'DIAPER' : 'TREATMENT';
        (patientUsage[itemId] ||= []).push({
          id: p.id, name: p.name, room_no: p.room_no, bed_no: p.bed_no, source,
        });
      }
    }

    // 4-B) usage_kind 매핑(호흡·삽관 / 카테터·튜브 / 장루(드레싱) / 한방재료)
    //      — group_key 기준으로 그룹 안의 모든 품목에 같은 환자 표시
    const airwayCathItems = await prisma.item.findMany({
      where: {
        deleted_at: null,
        is_active: true,
        category: { in: ['MED_AIRWAY', 'MED_CATHETER', 'MED_DRESSING', 'MED_HANBANG'] },
      },
      select: { id: true, name: true, category: true, sub_category: true },
    });
    // 각 품목의 (usage_kind, group_key, size) 를 미리 계산
    const itemUsageInfo = new Map<string, { kind: UsageKind; group: string; size: string; itemId: string }>();
    for (const it of airwayCathItems) {
      const kind = inferUsageKind({ name: it.name, category: it.category });
      if (!kind) continue; // 마스크/넬라톤/렉털 등은 매핑 X
      const size = String(it.sub_category ?? '').trim();
      itemUsageInfo.set(it.id, { kind, group: getGroupKey(kind), size, itemId: it.id });
      treatableItemIds.add(it.id);
    }
    // 환자 매핑 row 가져오기
    const usageRows = patientIds.length > 0 ? await prisma.patientItemUsage.findMany({
      where: { patient_id: { in: patientIds }, ended_at: null },
      select: { patient_id: true, usage_kind: true, size: true, group_key: true },
    }) : [];
    // 환자 → group_key → [{usage_kind, size}, ...]
    const usageByPatientGroup = new Map<string, Array<{ usage_kind: string; size: string }>>();
    for (const r of usageRows) {
      const k = `${r.patient_id}::${r.group_key}`;
      const arr = usageByPatientGroup.get(k) ?? [];
      arr.push({ usage_kind: r.usage_kind, size: r.size });
      usageByPatientGroup.set(k, arr);
    }
    const patientById = new Map(patients.map(p => [p.id, p]));
    // 각 품목 라인 → 같은 group_key 의 환자들 표시
    for (const [itemId, info] of itemUsageInfo) {
      for (const r of usageRows) {
        if (r.group_key !== info.group) continue;
        // 정확한 사이즈 매칭이 우선이지만, 그룹 안의 환자는 모두 표시 (사이즈 없는 보조 품목 대응)
        // 같은 usage_kind 라면 사이즈가 맞아야 표시 (다른 사이즈는 별도 라인의 환자)
        if (r.usage_kind === info.kind && r.size !== info.size) continue;
        const p = patientById.get(r.patient_id);
        if (!p) continue;
        (patientUsage[itemId] ||= []).push({
          id: p.id, name: p.name, room_no: p.room_no, bed_no: p.bed_no, source: 'USAGE_KIND',
        });
      }
      // 중복 제거 (한 환자가 여러 source 로 잡힐 수 있음)
      const seen = new Set<string>();
      patientUsage[itemId] = (patientUsage[itemId] ?? []).filter(e => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      });
    }

    // 5) 환자 응답용 (활성 처치 포함)
    const patientsResponse = patients.map(p => ({
      id: p.id,
      name: p.name,
      room_no: p.room_no,
      bed_no: p.bed_no,
      diaper_state: p.diaper_state,
      treatments: treatments.filter(t => t.patient_id === p.id).map(t => ({
        treatment_type_id: t.treatment_type_id,
        name: (t as any).treatment_type?.name ?? '',
      })),
    }));

    res.json({
      department_id: deptId,
      inventory_by_item: inventoryByItem,
      patient_usage: patientUsage,
      patients: patientsResponse,
      treatable_item_ids: Array.from(treatableItemIds),
    });
  } catch (e) {
    console.error('[draft-context] error:', e);
    res.status(500).json({ error: '신청 작성 컨텍스트 조회 중 오류가 발생했습니다.' });
  }
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
//
// 매트릭스 모델 (my-items 와 동일하게 품목 단위로 판정):
//   - 품목에 dept_item_permissions row 가 0건 → 전체 허용 (모든 부서 OK)
//   - 품목에 row 가 1건 이상 → 그 row 의 부서들만 허용 (다른 부서는 차단)
async function validateItemPermissions(dept_id: string, item_ids: string[]): Promise<string | null> {
  if (item_ids.length === 0) return null;
  const perms = await (prisma as any).deptItemPermission.findMany({
    where: { item_id: { in: item_ids } },
    select: { item_id: true, department_id: true },
  });
  // item_id → 허용된 dept_id 집합
  const allowedByItem = new Map<string, Set<string>>();
  for (const p of perms) {
    if (!allowedByItem.has(p.item_id)) allowedByItem.set(p.item_id, new Set());
    allowedByItem.get(p.item_id)!.add(p.department_id);
  }
  const blocked_ids = item_ids.filter(id => {
    const allowed = allowedByItem.get(id);
    if (!allowed || allowed.size === 0) return false; // 품목에 row 없음 = 전체 허용
    return !allowed.has(dept_id); // 부서 미포함 → 차단
  });
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
  const SCHEDULED_TYPES = ['CONSUMABLE_MEDICAL', 'CONSUMABLE_REGULAR', 'CONSUMABLE_OFFICE', 'DIAPER', 'NIGHT_SNACK'];
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
          CONSUMABLE_OFFICE: '사무용품',
          DIAPER: '기저귀',
          NIGHT_SNACK: '야간간식',
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

    // 재고 입력은 옵션 — 사용자가 채워넣으면 그 값을 함께 저장하지만 강제하지 않음.
    // (이전엔 정기 소모품(CONSUMABLE_REGULAR) 신청 시 강제였으나 운영상 부담으로 풀음)

    const seq = await nextSeq('ward_requests');
    const request_no = generateNo('WR', seq);

    const allCreateItems = [
      ...masterItems.map((it: any) => ({
        id: uuidv4(),
        item_id: it.item_id,
        requested_qty: it.requested_qty,
        current_stock_qty: it.current_stock_qty != null && it.current_stock_qty !== '' && Number.isFinite(Number(it.current_stock_qty)) ? Number(it.current_stock_qty) : null,
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

    // 입력된 재고 값이 있는 품목만 부서 Inventory 동기화 (재고 입력은 옵션)
    const stocksToSync = masterItems.filter((it: any) =>
      it.current_stock_qty != null && it.current_stock_qty !== '' && Number.isFinite(Number(it.current_stock_qty)),
    );
    if (stocksToSync.length > 0) {
      try {
        const locationId = await pickDeptLocationId(dept_id);
        if (locationId) {
          await prisma.$transaction(async (tx) => {
            for (const it of stocksToSync) {
              const itemId = String(it.item_id);
              const counted = Number(it.current_stock_qty);
              await setInventoryQty(tx, itemId, locationId, counted);
            }
          });
        } else {
          console.warn(`[ward-requests POST] 부서 ${dept_id}의 활성 InventoryLocation이 없어 재고 동기화 스킵`);
        }
      } catch (syncErr) {
        // 신청 자체는 성공으로 처리하되 재고 동기화 실패는 로그만 남김 (사용자에게 신청 거절 막기)
        console.error('[ward-requests POST] 재고 동기화 실패:', syncErr);
      }
    }

    await audit({ actor_user_id: req.user!.id, action: 'CREATE', entity_type: 'ward_requests', entity_id: created.id, after: { request_no, status: 'DRAFT', request_type: reqType } });
    res.status(201).json(formatRequest(created));
  } catch (e: any) {
    console.error('[POST /ward-requests] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// PUT /api/ward-requests/:id — DRAFT 상태에서 품목 수정 (버그 수정: /:id/items → /:id)
router.put('/:id', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  const { items } = req.body;
  try {
    const wr = await prisma.wardRequest.findUnique({ where: { id: req.params.id } });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    if (wr.department_id !== req.user!.department_id) return res.status(403).json({ error: '권한이 없습니다.' });

    // DRAFT 는 언제든 수정 가능. SUBMITTED 는 신청 마감 기한(RequestSchedule.open_from~open_to) 안이면 수정 가능.
    if (wr.status === 'DRAFT') {
      // OK
    } else if (wr.status === 'SUBMITTED') {
      const now = new Date();
      const openSched = await (prisma as any).requestSchedule.findFirst({
        where: {
          request_type: wr.request_type,
          open_from: { lte: now },
          open_to: { gte: now },
        },
      });
      if (!openSched) {
        return res.status(400).json({ error: '신청 마감 기한이 지나 수정할 수 없습니다.' });
      }
    } else {
      return res.status(400).json({ error: `${wr.status} 상태에서는 수정할 수 없습니다.` });
    }

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
      // SUBMITTED 재편집 시: 승인자가 봐둔 임시저장(review_draft) 의 wr_item_id 참조가 어긋나므로 비움.
      // 그리고 submitted_at 을 최신 편집 시각으로 갱신해 "마지막 제출" 시각을 정확히 추적.
      if (wr.status === 'SUBMITTED') {
        await (tx as any).$executeRawUnsafe(
          `UPDATE ward_requests SET review_draft = NULL, submitted_at = ? WHERE id = ?`,
          new Date(), req.params.id,
        );
      }
    });
    const updated = await prisma.wardRequest.findUnique({ where: { id: req.params.id }, include: INCLUDE_FULL as any });
    await audit({
      actor_user_id: req.user!.id,
      action: 'UPDATE',
      entity_type: 'ward_requests',
      entity_id: req.params.id,
      reason: wr.status === 'SUBMITTED' ? '제출 후 재편집 (신청기간 내)' : '품목 수정',
    });
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
          // 자유입력(custom) 품목은 item_id 가 null — usageBaseline.item_id 는 필수 String 이라
          // null 로 조회하면 Prisma 가 throw 한다 → 트랜잭션 전체 실패(제출 안 됨). 건너뛴다.
          const baseline = item.item_id ? await tx.usageBaseline.findFirst({
            where: {
              item_id: item.item_id,
              deleted_at: null,
              effective_from: { lte: new Date() },
              OR: [{ effective_to: null }, { effective_to: { gte: new Date() } }],
            },
            orderBy: { version: 'desc' },
          }) : null;

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
  } catch (e: any) {
    console.error('[POST /ward-requests/:id/submit] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
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

// POST /api/ward-requests/:id/discard — 제출 실패 등으로 남은 "본인 부서 DRAFT" 폐기(soft-delete).
// 신청자에겐 임시저장 개념이 없으므로, 제출 실패 시 클라이언트가 이 API로 잔여 DRAFT를 즉시 폐기한다.
router.post('/:id/discard', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const wr = await prisma.wardRequest.findUnique({ where: { id: req.params.id } });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    if (wr.department_id !== req.user!.department_id && !req.user?.permissions.includes('SYSTEM_ADMIN'))
      return res.status(403).json({ error: '권한이 없습니다.' });
    if (wr.status !== 'DRAFT')
      return res.status(400).json({ error: 'DRAFT 상태만 폐기할 수 있습니다.' });
    if (wr.deleted_at) return res.json({ message: '이미 폐기됨' });
    await prisma.wardRequest.update({ where: { id: req.params.id }, data: { deleted_at: new Date() } });
    await audit({ actor_user_id: req.user!.id, action: 'SOFT_DELETE', entity_type: 'ward_requests', entity_id: req.params.id, before: { status: 'DRAFT' }, reason: '제출 실패 자동 폐기' });
    res.json({ message: '폐기되었습니다.' });
  } catch (e) { console.error('[POST /ward-requests/:id/discard] error:', e); res.status(500).json({ error: '서버 오류' }); }
});

// DELETE /api/ward-requests/:id — 총무구매(PURCHASE_MANAGE) 또는 시스템 관리자만 소프트 삭제 가능.
// 활성 발주(po_sources) 또는 활성 불출(stock_outs) 이 있으면 거부.
router.delete('/:id', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const wr = await prisma.wardRequest.findUnique({
      where: { id: req.params.id },
      include: {
        department: { select: { name: true } },
        items: { select: { id: true } },
        stock_outs: { select: { id: true, deleted_at: true } },
        po_sources: { select: { id: true, po: { select: { deleted_at: true, status: true, po_no: true } } } },
      },
    });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    if (wr.deleted_at) return res.status(400).json({ error: '이미 삭제된 신청입니다.' });

    const activeStockOuts = wr.stock_outs.filter(s => !s.deleted_at);
    if (activeStockOuts.length > 0) {
      return res.status(409).json({
        error: `활성 불출이 ${activeStockOuts.length}건 있어 삭제할 수 없습니다. 불출을 먼저 취소해 주세요.`,
      });
    }
    const activePOs = (wr as any).po_sources.filter((s: any) => s.po && !s.po.deleted_at && s.po.status !== 'CANCELLED');
    if (activePOs.length > 0) {
      const poList = activePOs.map((s: any) => s.po.po_no).join(', ');
      return res.status(409).json({
        error: `활성 발주가 ${activePOs.length}건 연결되어 있어 삭제할 수 없습니다 (${poList}). 발주를 먼저 취소해 주세요.`,
      });
    }

    await prisma.wardRequest.update({
      where: { id: req.params.id },
      data: { deleted_at: new Date() },
    });
    await audit({
      actor_user_id: req.user!.id,
      action: 'DELETE',
      entity_type: 'ward_requests',
      entity_id: req.params.id,
      before: {
        request_no: wr.request_no,
        status: wr.status,
        department: (wr as any).department?.name,
        items: wr.items.length,
      },
      reason: req.body?.reason ?? '총무구매 신청 삭제',
    });
    res.json({ message: '삭제되었습니다.' });
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
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
        purchase_uom: it.item?.purchase_uom ?? it.item?.uom,
        issue_uom: it.item?.issue_uom ?? it.item?.uom,
        pack_size: Number(it.item?.pack_size ?? 1),
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
