import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, isCustomMenuUser, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';
import { performDirectStockOut } from '../services/stock-out-service';
import { inferUsageKind, getGroupKey, type UsageKind } from '../../shared/usage-kind';
import { ceilToPurchaseQty } from '../../shared/units';
import { inferRecommendedQty } from '../services/inferDemand';
import { inferRequestReason } from '../services/inferReason';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('approvals', 'PURCHASE_MANAGE'));

function isScopedToSelfDepartment(req: AuthRequest): boolean {
  const customMenuUser = isCustomMenuUser(req.user);
  const isAdmin = req.user?.permissions.includes('SYSTEM_ADMIN') ?? false;
  return customMenuUser && !isAdmin;
}

// 부서별·품목별 사용 환자 명단 (PatientTreatment × TreatmentSupplyMap 조인)
// 응답: { [department_id]: { [item_id]: [{ id, name, room_no }, ...] } }
router.get('/patient-usage', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const deptParam = String(req.query.department_ids ?? '').trim();
    const deptIds = deptParam ? deptParam.split(',').map(s => s.trim()).filter(Boolean) : [];

    // 부서 필터가 있으면 해당 부서의 입원 환자만, 없으면 전체 입원 환자
    const patients = await prisma.patient.findMany({
      where: {
        status: 'ADMITTED',
        deleted_at: null,
        ...(deptIds.length > 0 ? { department_id: { in: deptIds } } : {}),
      },
      select: { id: true, name: true, room_no: true, bed_no: true, department_id: true, diaper_state: true },
    });

    // 환자별 활성 처치 조회
    const patientIds = patients.map(p => p.id);
    const treatments = patientIds.length > 0 ? await (prisma as any).patientTreatment.findMany({
      where: {
        patient_id: { in: patientIds },
        deleted_at: null,
        OR: [{ ended_at: null }, { ended_at: { gt: new Date() } }],
      },
      select: { patient_id: true, treatment_type_id: true },
    }) : [];

    // 처치-품목 매핑
    const supplyMaps = await (prisma as any).treatmentSupplyMap.findMany({
      select: { treatment_type_id: true, item_id: true },
    });
    const supplyByTreatment: Record<string, string[]> = {};
    for (const sm of supplyMaps) {
      (supplyByTreatment[sm.treatment_type_id] ||= []).push(sm.item_id);
    }

    // 기저귀 카테고리 품목 ID 목록 — 기저귀 사용자(diaper_state != '')를 모두 매핑
    const diaperItems = await prisma.item.findMany({
      where: { category: { startsWith: 'DIAPER' }, deleted_at: null },
      select: { id: true },
    });
    const diaperItemIds = diaperItems.map(it => it.id);

    // 결과: { dept_id: { item_id: [patient,...] } }
    const result: Record<string, Record<string, Array<{ id: string; name: string; room_no: string; bed_no: number | null }>>> = {};
    for (const p of patients) {
      const myTreatments = treatments.filter((t: any) => t.patient_id === p.id);
      const itemIds = new Set<string>();
      for (const t of myTreatments) {
        const items = supplyByTreatment[t.treatment_type_id] ?? [];
        for (const id of items) itemIds.add(id);
      }
      // 원내 기저귀 사용자(diaper_state='IN_HOUSE')만 우리가 공급 대상 → 모든 기저귀 품목에 자동 매핑
      // (PERSONAL=본인 기저귀, NONE=미사용 은 시스템 공급 대상 아님)
      if (p.diaper_state === 'IN_HOUSE') {
        for (const itemId of diaperItemIds) itemIds.add(itemId);
      }
      if (itemIds.size === 0) continue;
      const deptKey = p.department_id;
      if (!result[deptKey]) result[deptKey] = {};
      for (const itemId of itemIds) {
        if (!result[deptKey][itemId]) result[deptKey][itemId] = [];
        result[deptKey][itemId].push({ id: p.id, name: p.name, room_no: p.room_no, bed_no: p.bed_no });
      }
    }

    // ─── usage_kind 매핑(호흡·삽관 / 카테터·튜브 / 장루(드레싱) / 한방재료) ───
    const airwayCathItems = await prisma.item.findMany({
      where: {
        deleted_at: null,
        is_active: true,
        category: { in: ['MED_AIRWAY', 'MED_CATHETER', 'MED_DRESSING', 'MED_HANBANG'] },
      },
      select: { id: true, name: true, category: true, sub_category: true },
    });
    const itemUsageInfo = new Map<string, { kind: UsageKind; group: string; size: string }>();
    for (const it of airwayCathItems) {
      const kind = inferUsageKind({ name: it.name, category: it.category });
      if (!kind) continue;
      itemUsageInfo.set(it.id, { kind, group: getGroupKey(kind), size: String(it.sub_category ?? '').trim() });
    }
    if (itemUsageInfo.size > 0 && patientIds.length > 0) {
      const usageRows = await prisma.patientItemUsage.findMany({
        where: { patient_id: { in: patientIds }, ended_at: null },
        select: { patient_id: true, usage_kind: true, size: true, group_key: true },
      });
      const patientById = new Map(patients.map((p: any) => [p.id, p]));
      for (const [itemId, info] of itemUsageInfo) {
        for (const r of usageRows) {
          if (r.group_key !== info.group) continue;
          if (r.usage_kind === info.kind && r.size !== info.size) continue;
          const p = patientById.get(r.patient_id) as any;
          if (!p) continue;
          const deptKey = p.department_id;
          if (!result[deptKey]) result[deptKey] = {};
          if (!result[deptKey][itemId]) result[deptKey][itemId] = [];
          // 중복 방지
          if (result[deptKey][itemId].some(e => e.id === p.id)) continue;
          result[deptKey][itemId].push({ id: p.id, name: p.name, room_no: p.room_no, bed_no: p.bed_no });
        }
      }
    }

    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 승인 대기(SUBMITTED) 신청 전체를 가상 발주로 환산해 거래처별로 합산.
// 자유입력 라인(item_id=null), 비품 폐기/수리 신청(EQUIPMENT/DISPOSAL/REPAIR) 은 제외.
// 응답에 라인 단위 정보(ward_request_id, requested_qty, unit_price, default_vendor_id)를 같이 실어
// 클라이언트가 "현재 열린 신청은 사용자 편집 중인 approved_qty 로 오버라이드" 후 재합산할 수 있게 한다.
router.get('/po-forecast', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const wrs = await prisma.wardRequest.findMany({
      where: {
        deleted_at: null,
        status: 'SUBMITTED',
        ...(isScopedToSelfDepartment(req) && req.user?.department_id ? { department_id: req.user.department_id } : {}),
      },
      include: {
        items: {
          include: {
            item: {
              include: {
                price_history: { orderBy: { effective_from: 'desc' }, take: 1 },
                default_vendor: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    type Line = {
      ward_request_id: string;
      wr_item_id: string;
      item_id: string;
      item_name: string;
      requested_qty: number;   // 팩(issue_uom) 수량
      pack_size: number;       // 1박스 = pack_size 팩
      unit_price: number;      // 박스(purchase_uom) 단가 (price_history)
      default_vendor_id: string | null;
      default_vendor_name: string | null;
    };
    const lines: Line[] = [];
    for (const wr of wrs as any[]) {
      // 비품 폐기/수리 신청은 발주 대상 아님
      if (wr.request_type === 'EQUIPMENT' && (wr.equipment_request_type === 'DISPOSAL' || wr.equipment_request_type === 'REPAIR')) continue;
      for (const it of wr.items) {
        if (!it.item_id) continue; // 자유입력 라인 스킵
        const unitPrice = it.item?.price_history?.[0] ? Number(it.item.price_history[0].price) : 0;
        lines.push({
          ward_request_id: wr.id,
          wr_item_id: it.id,
          item_id: it.item_id,
          item_name: it.item?.name ?? '',
          requested_qty: Number(it.requested_qty),
          pack_size: Math.max(1, Number(it.item?.pack_size ?? 1)),
          unit_price: unitPrice,
          default_vendor_id: it.item?.default_vendor?.id ?? null,
          default_vendor_name: it.item?.default_vendor?.name ?? null,
        });
      }
    }

    // 거래처별 합산 (편의용 — 클라이언트도 자체 합산하지만 초기 표시용)
    type Bucket = { vendor_id: string | null; vendor_name: string; line_count: number; total_amount: number; request_ids: Set<string> };
    const byVendor = new Map<string, Bucket>();
    for (const ln of lines) {
      const key = ln.default_vendor_id ?? '__UNASSIGNED__';
      let bucket = byVendor.get(key);
      if (!bucket) {
        bucket = {
          vendor_id: ln.default_vendor_id,
          vendor_name: ln.default_vendor_name ?? '거래처 미지정',
          line_count: 0,
          total_amount: 0,
          request_ids: new Set<string>(),
        };
        byVendor.set(key, bucket);
      }
      // 팩 수량을 박스로 환산 후 박스 단가를 곱해 단위 일치 (ForecastCard 와 동일 방식)
      bucket.line_count += 1;
      bucket.total_amount += ceilToPurchaseQty(ln.requested_qty, ln.pack_size) * ln.unit_price;
      bucket.request_ids.add(ln.ward_request_id);
    }

    const vendors = Array.from(byVendor.values())
      .filter((b) => b.vendor_id !== null)
      .map((b) => ({
        vendor_id: b.vendor_id,
        vendor_name: b.vendor_name,
        line_count: b.line_count,
        request_count: b.request_ids.size,
        total_amount: Math.round(b.total_amount),
      }))
      .sort((a, b) => b.total_amount - a.total_amount);

    const unassignedBucket = byVendor.get('__UNASSIGNED__');
    const unassigned = unassignedBucket
      ? {
          line_count: unassignedBucket.line_count,
          request_count: unassignedBucket.request_ids.size,
          total_amount: Math.round(unassignedBucket.total_amount),
        }
      : { line_count: 0, request_count: 0, total_amount: 0 };

    const totalAmount = lines.reduce((s, ln) => s + ceilToPurchaseQty(ln.requested_qty, ln.pack_size) * ln.unit_price, 0);

    res.json({
      vendors,
      unassigned,
      total_amount: Math.round(totalAmount),
      lines, // 클라이언트 재합산용
      as_of: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[GET /approvals/po-forecast] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 승인 목록 조회
router.get('/', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { status, request_type } = req.query;
    const statusVal    = status ? String(status) : 'SUBMITTED';
    const statusFilter = statusVal === 'ALL' ? undefined : statusVal;
    const requests = await prisma.wardRequest.findMany({
      where: {
        deleted_at: null,
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(request_type ? { request_type: String(request_type) } : {}),
        ...(isScopedToSelfDepartment(req) && req.user?.department_id ? { department_id: req.user.department_id } : {}),
      },
      include: {
        department: true,
        requester: true,
        items: {
          include: {
            item: {
              include: {
                price_history: { orderBy: { effective_from: 'desc' }, take: 1 },
                inventory: true,
              },
            },
          },
        },
        approval_actions: {
          include: { approver: true },
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
      orderBy: [{ is_emergency: 'desc' }, { submitted_at: 'asc' }],
    });

    // 신청주기 라벨 매핑 — WR(request_type, period_start) 가 RequestSchedule [open_from, open_to] 안이면 그 라벨 사용
    const schedules: any[] = await (prisma as any).requestSchedule.findMany({
      select: { request_type: true, open_from: true, open_to: true, period_label: true },
    });
    const resolvePeriodLabel = (rt: string | null, ps: Date | null): string => {
      if (!rt || !ps) return '';
      const ts = new Date(ps).getTime();
      const found = schedules.find(s =>
        s.request_type === rt &&
        new Date(s.open_from).getTime() <= ts &&
        ts <= new Date(s.open_to).getTime() + 86400 * 1000,
      );
      return found?.period_label ?? '';
    };

    res.json(requests.map(r => ({
      id: r.id,
      request_no: r.request_no,
      department_id: r.department_id,
      department_name: (r as any).department?.name,
      requester_name: (r as any).requester?.display_name,
      period_start: r.period_start,
      period_end: r.period_end,
      period_label: resolvePeriodLabel(r.request_type, r.period_start),
      status: r.status,
      request_type: r.request_type,
      is_emergency: r.is_emergency,
      submitted_at: r.submitted_at,
      item_count: r.items.length,
      has_flags: r.items.some((it: any) => {
        const flags = JSON.parse(it.policy_flags ?? '[]');
        return flags.length > 0;
      }),
      last_action: (r as any).approval_actions?.[0] ? {
        action: (r as any).approval_actions[0].action,
        approver_name: (r as any).approval_actions[0].approver?.display_name,
      } : null,
    })));
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// 승인 상세 (품목별 diff 포함)
router.get('/:requestId', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const r: any = await prisma.wardRequest.findUnique({
      where: { id: String(req.params.requestId) },
      include: {
        department: true,
        requester: true,
        items: {
          include: {
            item: {
              include: {
                price_history: { orderBy: { effective_from: 'desc' }, take: 1 },
                inventory: { include: { location: true } },
                vendor_maps: { include: { vendor: true }, where: { priority: 1 }, take: 1 },
                default_vendor: { select: { id: true, name: true } },
              },
            },
          },
        },
        approval_actions: {
          include: { approver: true, items: { include: { item: true } } },
          orderBy: { created_at: 'desc' },
        },
      },
    });
    if (!r) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });

    // 최근 3개월 평균 단가 비교 (가격 변동 감지)
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    if (isScopedToSelfDepartment(req) && req.user?.department_id !== r.department_id) {
      return res.status(403).json({ error: '타 부서 신청은 조회할 수 없습니다.' });
    }

    // 마지막 ApprovalAction 의 items — wr_item_id 매칭에 쓸 수 없어
    // (item_id, custom_name) 조합으로 가장 최근 approved_qty/메모 lookup
    const lastAction = (r as any).approval_actions?.[0];
    const lastByItem = new Map<string, any>();
    if (lastAction) {
      for (const ai of lastAction.items ?? []) {
        const key = ai.item_id ?? `custom::${ai.custom_name ?? ''}`;
        // 같은 키 여러개 있으면 최신(마지막) 우선 — items 는 보통 정렬 보장 X 라 아무거나 OK
        lastByItem.set(key, ai);
      }
    }

    const enrichedItems = await Promise.all(
      r.items.map(async (it: any) => {
        // 자유입력(free-input) 라인은 item_id 가 null → priceHistory 조회 스킵
        // (priceHistory.item_id 는 String 필수 필드이므로 null 로 쿼리하면 Prisma 가 throw)
        const recentPrices = it.item_id ? await prisma.priceHistory.findMany({
          where: { item_id: it.item_id, effective_from: { gte: threeMonthsAgo } },
          orderBy: { effective_from: 'desc' },
        }) : [];
        const avgPrice = recentPrices.length > 0
          ? recentPrices.reduce((s, p) => s + Number(p.price), 0) / recentPrices.length
          : 0;
        const latestPrice = it.item?.price_history?.[0] ? Number(it.item.price_history[0].price) : 0;
        const flags = JSON.parse(it.policy_flags ?? '[]');
        if (avgPrice > 0 && latestPrice > avgPrice * 1.1) flags.push('PRICE_UP_10PCT');

        // 자체 추론 — 의료 가이드라인 기반 권장량 + 자동 사유
        let inference: any = null;
        let autoReason: any = null;
        if (it.item_id) {
          try {
            const inf = await inferRecommendedQty(r.department_id, it.item_id, 30);
            if (inf) {
              inference = {
                recommended: inf.recommended,
                min: inf.min,
                max: inf.max,
                patients: inf.basis.patients,
                confidence: inf.basis.confidence,
                cold_start: inf.basis.cold_start,
              };
              const reqQty = Number(it.requested_qty);
              autoReason = inferRequestReason({
                requested_qty: reqQty,
                inference: inf,
                request_type: r.request_type,
              });
            }
          } catch {
            // 가이드라인 매핑 없는 품목 — 무시
          }
        }
        // latestPrice 는 박스(purchase_uom) 단가, requested_qty 는 팩(issue_uom) 수량.
        // 박스 환산 수량 × 박스 단가 로 단위 일치 (ForecastCard 와 동일 방식).
        const lcPackSize = Math.max(1, Number(it.item?.pack_size ?? 1));
        const lineCost = latestPrice * ceilToPurchaseQty(Number(it.requested_qty), lcPackSize);
        const variancePct = inference && inference.recommended > 0
          ? ((Number(it.requested_qty) - inference.recommended) / inference.recommended) * 100
          : 0;

        const lookupKey = it.item_id ?? `custom::${it.custom_name ?? ''}`;
        const lastAi = lastByItem.get(lookupKey);
        return {
          id: it.id,
          item_id: it.item_id,
          item_code: it.item?.item_code,
          item_name: it.item?.name,
          // 자유입력(품목 마스터 없음) 라인 — 검토 모달/직접입력 탭에서 품명·규격·링크 표시용
          is_custom: !it.item_id,
          custom_name: it.custom_name ?? '',
          custom_spec: it.custom_spec ?? '',
          custom_link: it.custom_link ?? '',
          uom: it.item?.uom,
          purchase_uom: it.item?.purchase_uom ?? it.item?.uom,
          issue_uom: it.item?.issue_uom ?? it.item?.uom,
          pack_size: Number(it.item?.pack_size ?? 1),
          category: it.item?.category,
          requested_qty: Number(it.requested_qty),
          baseline_qty: Number(it.baseline_qty),
          diff_pct: Number(it.diff_pct),
          policy_flags: flags,
          note: it.note,
          latest_price: latestPrice,
          avg_3m_price: avgPrice,
          // 정책: 승인 검토 시 "재고" = 신청 부서 보관함 재고만 (전체 합산 X — 검토자가 부서 보유량 기준 판단)
          on_hand_qty: it.item?.inventory
            ?.filter((inv: any) => inv.location?.department_id === r.department_id)
            .reduce((s: number, inv: any) => s + Number(inv.on_hand_qty), 0) ?? 0,
          vendor_name: it.item?.vendor_maps?.[0]?.vendor?.name ?? '',
          default_vendor_id: it.item?.default_vendor?.id ?? null,
          default_vendor_name: it.item?.default_vendor?.name ?? null,
          inference,
          variance_pct: Math.round(variancePct * 10) / 10,
          line_cost: Math.round(lineCost),
          auto_reason: autoReason,
          // 마지막 승인 결과 (수정 모드 prefill 용)
          last_approved_qty: lastAi ? Number(lastAi.approved_qty) : null,
          last_approver_note: lastAi?.approver_note ?? '',
        };
      })
    );

    // 검토 중 임시저장 — stale prisma client 대비 raw SELECT 로 안전하게 조회
    let reviewDraft: any = null;
    try {
      const dr: any[] = await (prisma as any).$queryRawUnsafe(
        `SELECT review_draft FROM ward_requests WHERE id = ?`, r.id);
      if (dr?.[0]?.review_draft) reviewDraft = JSON.parse(dr[0].review_draft);
    } catch { /* draft 파싱 실패는 무시 (없는 것으로 취급) */ }

    res.json({
      id: r.id,
      request_no: r.request_no,
      review_draft: reviewDraft,
      department_id: r.department_id,
      department_name: (r as any).department?.name,
      requester_name: (r as any).requester?.display_name,
      period_start: r.period_start,
      period_end: r.period_end,
      status: r.status,
      request_type: r.request_type,
      equipment_request_type: (r as any).equipment_request_type ?? null,
      is_emergency: r.is_emergency,
      submitted_at: r.submitted_at,
      items: enrichedItems,
      approval_history: (r as any).approval_actions.map((a: any) => ({
        id: a.id,
        action: a.action,
        reason: a.reason,
        approver_name: a.approver?.display_name,
        created_at: a.created_at,
        items: a.items.map((ai: any) => ({
          item_name: ai.item?.name ?? ai.custom_name ?? '',
          custom_name: ai.custom_name ?? '',
          requested_qty: Number(ai.requested_qty),
          approved_qty: Number(ai.approved_qty),
          diff_pct: Number(ai.diff_pct),
          policy_flags: JSON.parse(ai.policy_flags ?? '[]'),
          approver_note: ai.approver_note ?? '',
        })),
      })),
    });
  } catch (e: any) {
    console.error('[GET /approvals/:requestId] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// 승인/조정/반려 처리
//
// 요청 바디 (신 계약):
// {
//   action: 'APPROVE' | 'ADJUST' | 'REJECT',
//   reason: string,
//   approval_method?: 'PO' | 'STOCK_OUT',   // ADHOC / EQUIPMENT-ADDITION 에만 의미
//   items: Array<{
//     wr_item_id?: string,       // 원 WardRequestItem.id (편집·삭제 판별용). 없으면 승인자 추가 품목
//     item_id: string | null,    // 품목 마스터 ID. null 이면 자유입력
//     custom_name?: string,
//     approved_qty: number,      // 0 이면 반려/삭제 처리
//     approver_note?: string,    // 승인자 메모 (라인별)
//   }>
// }
// 승인 결과:
// - incoming items[] 에 있는 행 → ApprovalActionItem 으로 기록
// - 원 신청에 있으나 incoming 에 없는 행 → approved_qty=0 으로 기록 (삭제 감사)
// - PO 는 생성하지 않음 (승인/발주 분리). 구매담당자가 별도로 작성함.
// ─── 검토 중 임시저장 (draft) ────────────────────────────────────
// SUBMITTED 상태에서 조정한 승인수량/메모를 상태 변경·발주 없이 보관.
// 승인 처리(/decide)되면 자동으로 비워짐. wr_item_id 기준으로 라인 매칭.
router.post('/:requestId/draft', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.requestId);
    const wr: any = await prisma.wardRequest.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    if (wr.status !== 'SUBMITTED')
      return res.status(400).json({ error: 'SUBMITTED 상태에서만 임시저장할 수 있습니다.' });
    const items: any[] = Array.isArray(req.body?.items) ? req.body.items : [];
    const removedIn: any[] = Array.isArray(req.body?.removed) ? req.body.removed : [];
    const addedIn: any[] = Array.isArray(req.body?.added) ? req.body.added : [];
    const draft = {
      saved_at: new Date().toISOString(),
      saved_by: req.user?.id ?? null,
      // 원 신청 라인 (조정 수량/메모)
      items: items
        .filter((r) => r && r.wr_item_id)
        .map((r) => ({
          wr_item_id: String(r.wr_item_id),
          approved_qty: Math.max(0, Number(r.approved_qty ?? 0)),
          approver_note: String(r.approver_note ?? ''),
        })),
      // 검토자가 삭제한 원 신청 라인 (wr_item_id)
      removed: removedIn.map((x) => String(x)).filter(Boolean),
      // 검토자가 추가한 품목 (다시 열 때 그대로 복원)
      added: addedIn
        .filter((a) => a && a.item_id)
        .map((a) => ({
          item_id: String(a.item_id),
          item_name: String(a.item_name ?? ''),
          item_code: String(a.item_code ?? ''),
          uom: String(a.uom ?? ''),
          category: String(a.category ?? ''),
          latest_price: Number(a.latest_price ?? 0),
          approved_qty: Math.max(0, Number(a.approved_qty ?? 0)),
          approver_note: String(a.approver_note ?? ''),
        })),
    };
    await (prisma as any).$executeRawUnsafe(
      `UPDATE ward_requests SET review_draft = ? WHERE id = ?`, JSON.stringify(draft), id);
    res.json({ ok: true, saved_at: draft.saved_at, count: draft.items.length + draft.added.length, removed: draft.removed.length });
  } catch (e: any) {
    console.error('[POST /approvals/:requestId/draft] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── 자유입력 라인 → 새로 등록한 품목으로 교체 (같은 줄 유지) ──────────────
// "품목등록" 시 원 자유입력 라인을 삭제하고 별개의 라인으로 추가하면, 그 새 라인은
// ward_request_items 에 행이 없어서 불출(워크보드)에서 영원히 안 보이는 문제가 있었음
// (워크보드는 ward_request_items 를 순회하며 만들어짐 — stock-out.ts 참고).
// 그래서 새로 삭제/추가하지 않고, 원래 있던 그 줄의 item_id 를 그대로 채워넣어
// 같은 wr_item_id 가 계속 유지되도록 함.
router.post('/:requestId/items/:wrItemId/relink', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const requestId = String(req.params.requestId);
    const wrItemId = String(req.params.wrItemId);
    const itemId = String(req.body?.item_id ?? '');
    if (!itemId) return res.status(400).json({ error: 'item_id 가 필요합니다.' });

    const wr = await prisma.wardRequest.findUnique({ where: { id: requestId }, select: { id: true, status: true } });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    if (wr.status !== 'SUBMITTED')
      return res.status(400).json({ error: 'SUBMITTED 상태에서만 품목을 교체할 수 있습니다.' });

    const wrItem = await prisma.wardRequestItem.findUnique({ where: { id: wrItemId } });
    if (!wrItem || wrItem.ward_request_id !== requestId)
      return res.status(404).json({ error: '자유입력 라인을 찾을 수 없습니다.' });
    if (wrItem.item_id)
      return res.status(400).json({ error: '이미 품목이 연결된 라인입니다.' });

    const item = await prisma.item.findUnique({ where: { id: itemId } });
    if (!item) return res.status(404).json({ error: '등록한 품목을 찾을 수 없습니다.' });

    await prisma.wardRequestItem.update({
      where: { id: wrItemId },
      data: { item_id: item.id, custom_name: '', custom_spec: '', custom_link: '' },
    });

    res.json({ ok: true, item_id: item.id, item_name: item.name, item_code: item.item_code });
  } catch (e: any) {
    console.error('[POST /approvals/:requestId/items/:wrItemId/relink] error', e);
    res.status(500).json({ error: e.message || '서버 오류' });
  }
});

router.post('/:requestId/decide', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { action, reason, items, approval_method } = req.body;
  const approvalMethod = String(approval_method ?? 'PO').toUpperCase() === 'STOCK_OUT' ? 'STOCK_OUT' : 'PO';
  const reasonText = String(reason ?? '').trim();
  const incomingItems: any[] = Array.isArray(items) ? items : [];

  if (!['APPROVE', 'ADJUST', 'REJECT'].includes(action))
    return res.status(400).json({ error: '유효하지 않은 액션입니다.' });
  if ((action === 'ADJUST' || action === 'REJECT') && !reasonText)
    return res.status(400).json({ error: '사유는 필수입니다.' });

  try {
    const wr: any = await prisma.wardRequest.findUnique({
      where: { id: String(req.params.requestId) },
      include: { items: true },
    });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    if (isScopedToSelfDepartment(req) && req.user?.department_id !== wr.department_id) {
      return res.status(403).json({ error: '타 부서 신청은 처리할 수 없습니다.' });
    }
    if (wr.status !== 'SUBMITTED')
      return res.status(400).json({ error: 'SUBMITTED 상태에서만 승인/반려 가능합니다.' });

    const hasFlag = wr.items.some((it: any) => {
      try { return JSON.parse(it.policy_flags ?? '[]').length > 0; } catch { return false; }
    });
    if ((action === 'ADJUST' || action === 'REJECT') && hasFlag && reasonText.length < 5)
      return res.status(400).json({ error: '정책 위반 항목이 있습니다. 5자 이상의 사유를 입력하세요.' });

    // ─── 원 신청 vs incoming 매칭 ─────────────────────────────
    const originalMap = new Map<string, any>(wr.items.map((it: any) => [it.id, it]));
    const incomingWrItemIds = new Set<string>(
      incomingItems.map((r: any) => String(r.wr_item_id ?? '')).filter(Boolean)
    );

    // incoming 중 wr_item_id 가 없거나 원에 없는 것 = 승인자 추가
    const addedIncoming = incomingItems.filter(
      (r: any) => !r.wr_item_id || !originalMap.has(String(r.wr_item_id))
    );
    // 원 라인 중 incoming 에서 빠진 것 = 승인자 삭제 (REJECT 는 전원 삭제라 구조변경 아님)
    const removedOriginals = action === 'REJECT'
      ? []
      : wr.items.filter((it: any) => !incomingWrItemIds.has(it.id));

    const hasStructuralChange = addedIncoming.length > 0 || removedOriginals.length > 0;
    if (hasStructuralChange && reasonText.length < 5)
      return res.status(400).json({ error: '품목 추가/삭제 시 5자 이상의 사유가 필요합니다.' });

    const newStatus = action === 'REJECT' ? 'REJECTED'
      : (action === 'ADJUST' || hasStructuralChange) ? 'PARTIAL_APPROVED'
      : 'APPROVED';

    const isAdhoc = wr.request_type === 'ADHOC';
    const isEquipAddition = wr.request_type === 'EQUIPMENT' && (wr as any).equipment_request_type === 'ADDITION';
    const needStockOut = (isAdhoc || isEquipAddition) && approvalMethod === 'STOCK_OUT' && (action === 'APPROVE' || action === 'ADJUST');

    // ─── ApprovalActionItem row 생성 목록 ──────────────────────
    type AaiRow = {
      item_id: string | null;
      custom_name: string;
      requested_qty: number;
      approved_qty: number;
      baseline_qty: number;
      policy_flags: string;
      approver_note: string;
    };
    const aaiRows: AaiRow[] = [];

    // 1) incoming (수정 및 추가)
    for (const r of incomingItems) {
      const wrItemId = r.wr_item_id ? String(r.wr_item_id) : '';
      const original = wrItemId ? originalMap.get(wrItemId) : undefined;
      const approvedQty = action === 'REJECT' ? 0 : Math.max(0, Number(r.approved_qty ?? 0));
      aaiRows.push({
        item_id: (r.item_id ?? original?.item_id) || null,
        custom_name: String(r.custom_name ?? original?.custom_name ?? ''),
        requested_qty: original ? Number(original.requested_qty) : 0, // 승인자 추가분은 0
        approved_qty: approvedQty,
        baseline_qty: original ? Number(original.baseline_qty) : 0,
        policy_flags: original?.policy_flags ?? '[]',
        approver_note: String(r.approver_note ?? ''),
      });
    }

    // 2) 원 라인 중 incoming 에서 빠진 것 (승인자 삭제 감사)
    for (const orig of removedOriginals) {
      aaiRows.push({
        item_id: orig.item_id ?? null,
        custom_name: orig.custom_name ?? '',
        requested_qty: Number(orig.requested_qty),
        approved_qty: 0,
        baseline_qty: Number(orig.baseline_qty),
        policy_flags: orig.policy_flags ?? '[]',
        approver_note: '',
      });
    }

    // ─── 자유입력(품목 미등록) 줄에는 0보다 큰 승인수량을 매길 수 없음 ─────────
    // item_id 없이 승인수량>0 이면, 그 수요가 발주/불출 어디로도 이어질 방법이 없이 붕 뜬 채로 남음.
    // "품목등록"으로 최소한 item_id 를 가진 정식 품목으로 만든 뒤에만 승인수량을 매길 수 있게 막음
    // (거래처·단가까지 다 정할 필요는 없음 — 그건 발주 단계에서 채워도 되는 정보).
    const blockedCustom = aaiRows.filter(r => !r.item_id && r.approved_qty > 0);
    if (blockedCustom.length > 0) {
      return res.status(400).json({
        error: `아직 정식 품목으로 등록되지 않은 자유입력 품목엔 승인수량을 매길 수 없습니다: ${blockedCustom.map(r => r.custom_name || '(이름없음)').join(', ')} — "품목등록"으로 먼저 정식 품목으로 만들거나, 승인수량을 0으로 입력해주세요.`,
      });
    }

    // ─── 즉시불출 대상 (item_id 있고 승인수량 > 0) ─────────────
    const stockOutItems = needStockOut
      ? aaiRows
          .filter(r => r.item_id && r.approved_qty > 0)
          .map(r => ({ item_id: r.item_id as string, approved_qty: r.approved_qty }))
      : [];

    // ─── 트랜잭션: 승인기록 + 상태전이 + (즉시불출 / 비품폐기). PO 는 생성하지 않음.
    await prisma.$transaction(async (tx) => {
      if (needStockOut && stockOutItems.length > 0) {
        await performDirectStockOut({
          items: stockOutItems,
          department_id: wr.department_id,
          ward_request_id: String(req.params.requestId),
          issued_by: req.user!.id,
          tx,
        });
      }

      await tx.approvalAction.create({
        data: {
          id: uuidv4(),
          ward_request_id: String(req.params.requestId),
          approver_id: req.user!.id,
          action,
          reason: reasonText,
          items: {
            create: aaiRows.map((r) => {
              const diffQty = r.approved_qty - r.requested_qty;
              const diffPct = r.requested_qty > 0 ? (diffQty / r.requested_qty) * 100 : 0;
              return {
                id: uuidv4(),
                item_id: r.item_id,
                custom_name: r.custom_name,
                requested_qty: r.requested_qty,
                approved_qty: r.approved_qty,
                baseline_qty: r.baseline_qty,
                diff_qty: diffQty,
                diff_pct: diffPct,
                policy_flags: r.policy_flags,
                approver_note: r.approver_note,
              };
            }),
          },
        },
      });

      await tx.wardRequest.update({
        where: { id: String(req.params.requestId) },
        data: { status: newStatus },
      });

      // 비품 폐기 승인 → EquipmentUnit DISPOSED (유지)
      if (wr.request_type === 'EQUIPMENT' && (wr as any).equipment_request_type === 'DISPOSAL'
          && (action === 'APPROVE' || action === 'ADJUST') && newStatus !== 'REJECTED') {
        const unitIds: string[] = (() => {
          try { return JSON.parse((wr as any).equipment_unit_ids ?? '[]'); } catch { return []; }
        })();
        if (unitIds.length > 0) {
          await (tx as any).equipmentUnit.updateMany({
            where: { id: { in: unitIds } },
            data: { status: 'DISPOSED' },
          });
        }
      }
    });

    // 승인 처리 완료 → 검토 중 임시저장 비움 (더 이상 의미 없음)
    try {
      await (prisma as any).$executeRawUnsafe(
        `UPDATE ward_requests SET review_draft = NULL WHERE id = ?`, String(req.params.requestId));
    } catch { /* draft 정리 실패는 승인 결과에 영향 없음 */ }

    await audit({
      actor_user_id: req.user!.id,
      action,
      entity_type: 'ward_requests',
      entity_id: String(req.params.requestId),
      before: { status: 'SUBMITTED' },
      after: { status: newStatus },
      reason: reasonText,
    });

    res.json({ message: '처리되었습니다.', action, new_status: newStatus });
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// ─── 승인 취소 (reopen) ──────────────────────────────────────
// 이미 처리된(APPROVED / PARTIAL_APPROVED / REJECTED) 신청을 다시 SUBMITTED 로 되돌려
// 다시 검토할 수 있도록 한다. 기존 ApprovalAction 은 그대로 두어 감사 기록을 보존.
//
// 안전장치 — 다음 중 하나라도 해당하면 거부:
//   1) 활성 PO(취소되지 않고 삭제되지 않은 PurchaseOrderSource) 가 있음 → 발주가 진행 중
//   2) 활성 StockOut(REVERSED 가 아니고 삭제되지 않은) 이 있음 → 즉시불출 진행됨
//   3) 비품 DISPOSAL/REPAIR — equipment_unit 상태까지 전이되어 단순 되돌리기로 일관성 깨짐
router.post('/:requestId/reopen', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const wr: any = await prisma.wardRequest.findUnique({
      where: { id: String(req.params.requestId) },
      include: {
        po_sources: { include: { po: { select: { po_no: true, status: true, deleted_at: true } } } } as any,
        stock_outs: { select: { id: true, so_no: true, status: true, deleted_at: true } },
      },
    });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });

    if (isScopedToSelfDepartment(req) && req.user?.department_id !== wr.department_id) {
      return res.status(403).json({ error: '타 부서 신청은 처리할 수 없습니다.' });
    }
    if (!['APPROVED', 'PARTIAL_APPROVED', 'REJECTED'].includes(wr.status)) {
      return res.status(400).json({ error: '이미 처리된 신청만 취소할 수 있습니다.' });
    }

    const activePo = (wr.po_sources ?? []).find(
      (s: any) => s.po && s.po.status !== 'CANCELLED' && !s.po.deleted_at,
    );
    if (activePo) {
      return res.status(400).json({
        error: `이미 발주서(${activePo.po.po_no})에 연결되어 있어 취소할 수 없습니다. 발주서를 먼저 취소하세요.`,
      });
    }

    const activeStockOut = (wr.stock_outs ?? []).find(
      (s: any) => s.status !== 'REVERSED' && !s.deleted_at,
    );
    if (activeStockOut) {
      return res.status(400).json({
        error: `이미 불출(${activeStockOut.so_no})이 진행되어 취소할 수 없습니다. 불출을 먼저 취소하세요.`,
      });
    }

    if (wr.request_type === 'EQUIPMENT' && (wr.equipment_request_type === 'DISPOSAL' || wr.equipment_request_type === 'REPAIR')) {
      return res.status(400).json({
        error: '비품 폐기/수리 신청은 직접 취소할 수 없습니다. 비품관리에서 처리하세요.',
      });
    }

    await prisma.wardRequest.update({
      where: { id: wr.id },
      data: { status: 'SUBMITTED' },
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'REOPEN',
      entity_type: 'ward_requests',
      entity_id: wr.id,
      before: { status: wr.status },
      after: { status: 'SUBMITTED' },
      reason: '승인 취소(되돌리기)',
    });

    res.json({ message: '승인이 취소되어 다시 검토 대기 상태가 되었습니다.', new_status: 'SUBMITTED' });
  } catch (e) {
    console.error('[POST /approvals/:requestId/reopen] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── 승인 후 수정 (amend) ────────────────────────────────────
// 이미 APPROVED / PARTIAL_APPROVED 인 신청의 승인 품목을 다시 편집한다.
// /reopen 처럼 SUBMITTED 로 돌리지 않고 승인 상태를 유지한 채 새 ApprovalAction(action='ADJUST') 추가.
//
// 안전장치: /reopen 과 동일 — 활성 PO/StockOut/비품처리 진행 중이면 수정 불가.
router.post('/:requestId/amend', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { reason, items } = req.body;
  const reasonText = String(reason ?? '').trim();
  const incomingItems: any[] = Array.isArray(items) ? items : [];

  try {
    const wr: any = await prisma.wardRequest.findUnique({
      where: { id: String(req.params.requestId) },
      include: {
        items: true,
        po_sources: { include: { po: { select: { po_no: true, status: true, deleted_at: true } } } } as any,
        stock_outs: { select: { id: true, so_no: true, status: true, deleted_at: true } },
      },
    });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });

    if (isScopedToSelfDepartment(req) && req.user?.department_id !== wr.department_id) {
      return res.status(403).json({ error: '타 부서 신청은 처리할 수 없습니다.' });
    }
    if (!['APPROVED', 'PARTIAL_APPROVED'].includes(wr.status)) {
      return res.status(400).json({ error: '이미 승인된 신청만 수정할 수 있습니다.' });
    }

    const activePo = (wr.po_sources ?? []).find(
      (s: any) => s.po && s.po.status !== 'CANCELLED' && !s.po.deleted_at,
    );
    if (activePo) {
      return res.status(400).json({
        error: `이미 발주서(${activePo.po.po_no})에 연결되어 있어 수정할 수 없습니다.`,
      });
    }
    const activeStockOut = (wr.stock_outs ?? []).find(
      (s: any) => s.status !== 'REVERSED' && !s.deleted_at,
    );
    if (activeStockOut) {
      return res.status(400).json({
        error: `이미 불출(${activeStockOut.so_no})이 진행되어 수정할 수 없습니다.`,
      });
    }
    if (wr.request_type === 'EQUIPMENT' && (wr.equipment_request_type === 'DISPOSAL' || wr.equipment_request_type === 'REPAIR')) {
      return res.status(400).json({
        error: '비품 폐기/수리 신청은 직접 수정할 수 없습니다.',
      });
    }

    // 결의서/PO 체크는 위에서 활성 PO/StockOut 으로 이미 차단함.
    // 결의서가 LOCKED 라도 amend 자체는 허용 — 사용자가 승인수량만 정정하는 케이스도 있음.
    // (결의서/PO 의 수량은 이미 발주에 박혀있으니 amend 와 무관하게 그대로 유지됨)

    // ── incoming items 처리 (decide 와 동일한 매칭 로직) ──
    const originalMap = new Map<string, any>(wr.items.map((it: any) => [it.id, it]));
    const incomingWrItemIds = new Set<string>(
      incomingItems.map((r: any) => String(r.wr_item_id ?? '')).filter(Boolean),
    );
    const addedIncoming = incomingItems.filter(
      (r: any) => !r.wr_item_id || !originalMap.has(String(r.wr_item_id)),
    );
    const removedOriginals = wr.items.filter((it: any) => !incomingWrItemIds.has(it.id));
    const hasStructuralChange = addedIncoming.length > 0 || removedOriginals.length > 0;

    if (hasStructuralChange && reasonText.length < 5) {
      return res.status(400).json({ error: '품목 추가/삭제 시 5자 이상의 사유가 필요합니다.' });
    }

    type AaiRow = {
      item_id: string | null;
      custom_name: string;
      requested_qty: number;
      approved_qty: number;
      baseline_qty: number;
      policy_flags: string;
      approver_note: string;
    };
    const aaiRows: AaiRow[] = [];
    for (const r of incomingItems) {
      const wrItemId = r.wr_item_id ? String(r.wr_item_id) : '';
      const original = wrItemId ? originalMap.get(wrItemId) : undefined;
      const approvedQty = Math.max(0, Number(r.approved_qty ?? 0));
      aaiRows.push({
        item_id: (r.item_id ?? original?.item_id) || null,
        custom_name: String(r.custom_name ?? original?.custom_name ?? ''),
        requested_qty: original ? Number(original.requested_qty) : 0,
        approved_qty: approvedQty,
        baseline_qty: original ? Number(original.baseline_qty) : 0,
        policy_flags: original?.policy_flags ?? '[]',
        approver_note: String(r.approver_note ?? ''),
      });
    }
    for (const orig of removedOriginals) {
      aaiRows.push({
        item_id: orig.item_id ?? null,
        custom_name: orig.custom_name ?? '',
        requested_qty: Number(orig.requested_qty),
        approved_qty: 0,
        baseline_qty: Number(orig.baseline_qty),
        policy_flags: orig.policy_flags ?? '[]',
        approver_note: '',
      });
    }

    // ─── 자유입력(품목 미등록) 줄에는 0보다 큰 승인수량을 매길 수 없음 (decide 와 동일 규칙) ───
    const blockedCustom = aaiRows.filter(r => !r.item_id && r.approved_qty > 0);
    if (blockedCustom.length > 0) {
      return res.status(400).json({
        error: `아직 정식 품목으로 등록되지 않은 자유입력 품목엔 승인수량을 매길 수 없습니다: ${blockedCustom.map(r => r.custom_name || '(이름없음)').join(', ')} — "품목등록"으로 먼저 정식 품목으로 만들거나, 승인수량을 0으로 입력해주세요.`,
      });
    }

    const newStatus = hasStructuralChange ? 'PARTIAL_APPROVED' : wr.status;

    await prisma.$transaction(async (tx) => {
      await tx.approvalAction.create({
        data: {
          id: uuidv4(),
          ward_request_id: wr.id,
          approver_id: req.user!.id,
          action: 'ADJUST',
          reason: reasonText || '승인 후 수정',
          items: {
            create: aaiRows.map((r) => {
              const diffQty = r.approved_qty - r.requested_qty;
              const diffPct = r.requested_qty > 0 ? (diffQty / r.requested_qty) * 100 : 0;
              return {
                id: uuidv4(),
                item_id: r.item_id,
                custom_name: r.custom_name,
                requested_qty: r.requested_qty,
                approved_qty: r.approved_qty,
                baseline_qty: r.baseline_qty,
                diff_qty: diffQty,
                diff_pct: diffPct,
                policy_flags: r.policy_flags,
                approver_note: r.approver_note,
              };
            }),
          },
        },
      });

      if (newStatus !== wr.status) {
        await tx.wardRequest.update({ where: { id: wr.id }, data: { status: newStatus } });
      }
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'AMEND',
      entity_type: 'ward_requests',
      entity_id: wr.id,
      before: { status: wr.status },
      after: { status: newStatus },
      reason: reasonText || '승인 후 수정',
    });

    res.json({ message: '수정이 저장되었습니다.', new_status: newStatus });
  } catch (e) {
    console.error('[POST /approvals/:requestId/amend] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;


