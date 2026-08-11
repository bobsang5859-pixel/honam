/**
 * 발주 라우팅 (OrderRouting) — "발주 준비 작업대".
 *
 * 승인된 (신청×품목) 수요 단위를 품목별로 어느 경로로 보낼지 명시 추적한다.
 *   - DECISION : 구매결의서 작성 → 발주
 *   - GIAN     : 기안서 (문서 미생성, 기안 대상 표시 + 발주 직접)
 *   - HOLD     : 재고보유 (발주 안 함, 보류 목록 → 해제 가능)
 *
 * 대기풀 = 승인된 (wr×item) 중 ACTIVE OrderRouting 도 없고, 레거시 결의서
 * 처리쌍(getProcessedWrItemPairs)에도 없는 것. (백필 + 레거시 안전망 병행)
 *
 * 권한: PURCHASE_MANAGE / SYSTEM_ADMIN
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit, generateNo } from '../utils/audit';
import { loadSchedulesByType, resolveScheduleLabel, monthLabel } from '../utils/period-label';
import {
  nextDecisionSeq, splitItemName, format, INCLUDE,
} from './purchase-decisions';

const router = Router();
router.use(authMiddleware);

const pk = (wrId: string, itemId: string) => `${wrId}::${itemId}`;

type PoolPair = { wr_id: string; item_id: string; qty_pack: number };
type PoolRow = {
  item_id: string;
  item_code: string;
  name: string;
  spec: string;
  category: string;
  uom: string;
  pack_size: number;
  period_label: string;          // 이 행이 속한 신청주기
  period_start: string;          // 정렬용 (ISO)
  vendor_id: string | null;
  vendor_name: string | null;
  depts: { dept_name: string; qty_pack: number }[];
  total_qty_pack: number;
  total_qty_box: number;
  central_stock_pack: number;
  central_stock_box: number;
  unit_price: number;
  est_amount: number;
  suggested_route: 'HOLD' | 'DECISION';
  pairs: PoolPair[];
};

// 대기풀 계산 — GET /pool 과 POST /route 가 공유. DB 변경 없음.
async function computePool(): Promise<{ rows: PoolRow[] }> {
  // 1) 이미 라우팅된 (wr×item) — ACTIVE OrderRouting
  const activeRoutings: any[] = await (prisma as any).orderRouting.findMany({
    where: { status: 'ACTIVE' },
    select: { ward_request_id: true, item_id: true },
  });
  const routed = new Set<string>();
  for (const r of activeRoutings) {
    if (r.item_id) routed.add(pk(r.ward_request_id, r.item_id));
  }
  // ※ 레거시 getProcessedWrItemPairs(JSON 블롭 cartesian) 는 의도적으로 쓰지 않음.
  //    그 cartesian 곱이 실제로 같이 승인된 적 없는 (wr,item) 유령쌍까지 만들어
  //    진짜 대기 품목을 가려버리기 때문(재설계가 없애려던 바로 그 버그).
  //    단일 진실원 = OrderRouting 테이블. 기존 결의서는 정밀 백필로 ACTIVE 행이 들어가 있음.

  // 2) 승인된 신청 — 라인 단위로 미처리 여부 판단
  const wrs = await prisma.wardRequest.findMany({
    where: { status: { in: ['APPROVED', 'PARTIAL_APPROVED'] }, deleted_at: null },
    include: {
      approval_actions: { orderBy: { created_at: 'desc' as const }, take: 1, include: { items: true } },
      department: { select: { name: true } },
    },
  });

  const allItemIds = new Set<string>();
  for (const wr of wrs) {
    const action = (wr as any).approval_actions[0];
    if (!action) continue;
    for (const ai of action.items) if (ai.item_id) allItemIds.add(ai.item_id);
  }
  const itemIdArr = Array.from(allItemIds);

  const items = await prisma.item.findMany({
    where: { id: { in: itemIdArr } },
    include: { default_vendor: { select: { id: true, name: true } } },
  });
  const itemById = new Map(items.map((i: any) => [i.id, i]));

  // 최근 단가 (item × vendor)
  const priceRows = await prisma.priceHistory.findMany({
    where: { item_id: { in: itemIdArr }, effective_to: null },
    orderBy: { effective_from: 'desc' },
  });
  const lastPrice = new Map<string, number>();
  for (const p of priceRows) {
    const k = `${p.item_id}::${p.vendor_id}`;
    if (!lastPrice.has(k)) lastPrice.set(k, Number(p.price));
  }

  // 품목별 "마지막으로 실제 발송된 발주서의 거래처" — 다음 주기 기본 추천.
  // 발송 이상(SENT/PARTIAL_RECEIVED/CLOSED) 만 인정, 취소·삭제 제외. 최신 ordered_at 1건.
  const poItemRows = await prisma.purchaseOrderItem.findMany({
    where: {
      item_id: { in: itemIdArr },
      purchase_order: {
        deleted_at: null,
        status: { in: ['SENT', 'PARTIAL_RECEIVED', 'CLOSED'] },
      },
    },
    select: { item_id: true, purchase_order: { select: { vendor_id: true, ordered_at: true } } },
    orderBy: { purchase_order: { ordered_at: 'desc' } },
  });
  const lastVendorByItem = new Map<string, string>();
  for (const r of poItemRows as any[]) {
    if (!lastVendorByItem.has(r.item_id) && r.purchase_order?.vendor_id) {
      lastVendorByItem.set(r.item_id, r.purchase_order.vendor_id);
    }
  }
  // 최종 거래처(마지막발주처 우선, 없으면 기본거래처) 이름 매핑
  const resolvedVendorIds = new Set<string>();
  for (const it of items as any[]) {
    const vid = lastVendorByItem.get(it.id) ?? it.default_vendor_id ?? null;
    if (vid) resolvedVendorIds.add(vid);
  }
  const vendorRows = resolvedVendorIds.size
    ? await prisma.vendor.findMany({ where: { id: { in: Array.from(resolvedVendorIds) } }, select: { id: true, name: true } })
    : [];
  const vendorNameById = new Map(vendorRows.map((v: any) => [v.id, v.name]));

  // 중앙창고 재고
  const central = await (prisma as any).inventoryLocation.findFirst({ where: { code: 'CENTRAL', deleted_at: null } });
  const stockByItem = new Map<string, number>();
  if (central) {
    const invs = await prisma.inventory.findMany({
      where: { item_id: { in: itemIdArr }, location_id: central.id },
      select: { item_id: true, on_hand_qty: true },
    });
    for (const iv of invs) stockByItem.set(iv.item_id, Number(iv.on_hand_qty ?? 0));
  }

  // 신청주기 라벨 — 승인 화면과 동일한 단일 진실원(period-label.ts). wr 마다 1개.
  const schedulesByType = await loadSchedulesByType(prisma);
  const wrLabel = new Map<string, { label: string; start: number }>();
  for (const wr of wrs) {
    const ps = (wr as any).period_start ? new Date((wr as any).period_start) : null;
    const { period_label } = resolveScheduleLabel(String((wr as any).request_type ?? ''), ps, schedulesByType);
    const label = (period_label && period_label.trim())
      ? period_label
      : (ps ? monthLabel(ps) : '주기 미지정');
    wrLabel.set(wr.id, { label, start: ps ? ps.getTime() : 0 });
  }

  // 3) (품목 × 신청주기) 단위 집계 — 같은 품목이라도 주기가 다르면 별도 행/별도 결의서
  type Agg = {
    item: any;
    period_label: string;
    period_start: number;
    depts: Map<string, number>;
    total: number;
    pairs: Map<string, PoolPair>;
  };
  const byItemPeriod = new Map<string, Agg>();
  for (const wr of wrs) {
    const action = (wr as any).approval_actions[0];
    if (!action) continue;
    const deptName: string = (wr as any).department?.name ?? '미지정';
    const wl = wrLabel.get(wr.id) ?? { label: '주기 미지정', start: 0 };
    for (const ai of action.items) {
      if (!ai.item_id) continue; // 자유입력은 풀 대상 아님 (직접입력 탭에서 별도 처리)
      const pairKey = pk(wr.id, ai.item_id);
      if (routed.has(pairKey)) continue;
      const item = itemById.get(ai.item_id);
      if (!item) continue;
      const qty = Number(ai.approved_qty);
      if (qty <= 0) continue;
      const aggKey = `${ai.item_id}::${wl.label}`;
      let a = byItemPeriod.get(aggKey);
      if (!a) {
        a = { item, period_label: wl.label, period_start: wl.start, depts: new Map(), total: 0, pairs: new Map() };
        byItemPeriod.set(aggKey, a);
      }
      a.depts.set(deptName, (a.depts.get(deptName) ?? 0) + qty);
      a.total += qty;
      const ex = a.pairs.get(pairKey);
      if (ex) ex.qty_pack += qty;
      else a.pairs.set(pairKey, { wr_id: wr.id, item_id: ai.item_id, qty_pack: qty });
    }
  }

  const rows: PoolRow[] = Array.from(byItemPeriod.values()).map(a => {
    const item = a.item;
    const ps = Math.max(1, Number(item.pack_size ?? 1));
    // 거래처 = 마지막 실제 발주처 우선, 없으면 품목 기본거래처
    const vendorId: string | null = lastVendorByItem.get(item.id) ?? item.default_vendor_id ?? null;
    const stockPack = stockByItem.get(item.id) ?? 0;
    const unitPrice = vendorId ? (lastPrice.get(`${item.id}::${vendorId}`) ?? 0) : 0;
    const totalBox = Math.ceil(a.total / ps);
    const origSpec = item.sub_category || item.purchase_uom || item.uom || '';
    const split = splitItemName(item.name ?? '', origSpec);
    return {
      item_id: item.id,
      item_code: item.item_code,
      name: split.name,
      spec: split.spec,
      category: String(item.category ?? ''),
      uom: item.purchase_uom || item.uom || '',
      pack_size: ps,
      period_label: a.period_label,
      period_start: a.period_start ? new Date(a.period_start).toISOString() : '',
      vendor_id: vendorId,
      vendor_name: vendorId ? (vendorNameById.get(vendorId) ?? item.default_vendor?.name ?? '거래처') : null,
      depts: Array.from(a.depts.entries())
        .map(([dept_name, qty_pack]) => ({ dept_name, qty_pack }))
        .sort((x, y) => x.dept_name.localeCompare(y.dept_name, 'ko')),
      total_qty_pack: a.total,
      total_qty_box: totalBox,
      central_stock_pack: stockPack,
      central_stock_box: Math.floor(stockPack / ps),
      unit_price: unitPrice,
      est_amount: Math.round(totalBox * unitPrice),
      // 스마트 기본값: 중앙창고 재고(팩) ≥ 승인 합계(팩) → 재고보유, 아니면 구매결의서
      suggested_route: stockPack >= a.total ? 'HOLD' : 'DECISION',
      pairs: Array.from(a.pairs.values()),
    } as PoolRow;
  }).sort((x, y) =>
    // 최신 주기 위로, 같은 주기 안에서는 코드순
    (y.period_start || '').localeCompare(x.period_start || '')
    || (x.item_code ?? '').localeCompare(y.item_code ?? '', 'ko', { numeric: true }),
  );

  return { rows };
}

// GET /api/order-routing/pool
router.get('/pool', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (_req: AuthRequest, res) => {
  try {
    const { rows } = await computePool();
    // 신청주기 → (거래처 미지정 / 거래처별) 2단 구조로 미리 묶어 전달
    const periodMap = new Map<string, { period_label: string; period_start: string; no_vendor: any[]; vendorMap: Map<string, { vendor_id: string; vendor_name: string; rows: any[] }> }>();
    for (const r of rows) {
      let g = periodMap.get(r.period_label);
      if (!g) { g = { period_label: r.period_label, period_start: r.period_start, no_vendor: [], vendorMap: new Map() }; periodMap.set(r.period_label, g); }
      if (!r.vendor_id) { g.no_vendor.push(r); continue; }
      let v = g.vendorMap.get(r.vendor_id);
      if (!v) { v = { vendor_id: r.vendor_id, vendor_name: r.vendor_name ?? '거래처', rows: [] }; g.vendorMap.set(r.vendor_id, v); }
      v.rows.push(r);
    }
    const periods = Array.from(periodMap.values())
      .map(g => ({
        period_label: g.period_label,
        period_start: g.period_start,
        no_vendor: g.no_vendor,
        vendors: Array.from(g.vendorMap.values()).sort((a, b) => a.vendor_name.localeCompare(b.vendor_name, 'ko')),
      }))
      .sort((a, b) => (b.period_start || '').localeCompare(a.period_start || ''));
    res.json({ periods });
  } catch (e: any) {
    console.error('[GET /order-routing/pool] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// POST /api/order-routing/route
// body: { targets: [{ item_id, period_label, route, vendor_id?, hold_reason? }] }
// item_id 만으로는 행이 유일하지 않음 — (품목 × 신청주기) 가 키.
router.post('/route', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const targets: any[] = Array.isArray(req.body?.targets) ? req.body.targets : [];
    if (targets.length === 0) return res.status(400).json({ error: '선택된 품목이 없습니다.' });

    const { rows } = await computePool();
    const rowByKey = new Map(rows.map(r => [`${r.item_id}::${r.period_label}`, r]));
    const now = new Date();

    // 결과 누적
    const created_routings: string[] = [];
    let hold_count = 0;
    let gian_count = 0;
    // (거래처 × 신청주기) 로 모아서 결의서 생성 — 회차가 섞이지 않게
    type VBucket = { vendor_id: string; period_label: string; lines: any[]; wr_ids: Set<string>; dept_names: Set<string>; routing_ids: string[] };
    const byVendorPeriod = new Map<string, VBucket>();
    const skipped: { item_id: string; reason: string }[] = [];

    for (const t of targets) {
      const itemId = String(t.item_id ?? '');
      const periodLabel = String(t.period_label ?? '');
      const route = String(t.route ?? '');
      const row = rowByKey.get(`${itemId}::${periodLabel}`);
      if (!row) { skipped.push({ item_id: itemId, reason: '이미 처리되었거나 풀에 없음' }); continue; }
      if (!['DECISION', 'GIAN', 'HOLD'].includes(route)) { skipped.push({ item_id: itemId, reason: `알 수 없는 경로 ${route}` }); continue; }

      const vendorId: string | null = route === 'HOLD'
        ? null
        : (t.vendor_id ? String(t.vendor_id) : row.vendor_id);
      if (route !== 'HOLD' && !vendorId) {
        skipped.push({ item_id: itemId, reason: '거래처 미지정 — 거래처 지정 후 다시 시도' });
        continue;
      }
      const holdReason = route === 'HOLD' ? String(t.hold_reason ?? '재고 있음') : '';

      // (wr×item) 페어마다 OrderRouting 행 생성
      const thisRoutingIds: string[] = [];
      for (const p of row.pairs) {
        const id = uuidv4();
        await (prisma as any).orderRouting.create({
          data: {
            id,
            ward_request_id: p.wr_id,
            item_id: p.item_id,
            custom_key: '',
            route,
            status: 'ACTIVE',
            approved_qty: p.qty_pack,
            vendor_id: vendorId,
            period_label: row.period_label,
            hold_reason: holdReason,
            routed_by: req.user!.id,
            routed_at: now,
          },
        });
        thisRoutingIds.push(id);
        created_routings.push(id);
      }

      if (route === 'HOLD') { hold_count++; continue; }
      if (route === 'GIAN') { gian_count++; continue; }

      // DECISION → 거래처별 결의서 라인 구성
      const ps = Math.max(1, row.pack_size);
      const boxQty = Math.ceil(row.total_qty_pack / ps);
      const line = {
        item_id: row.item_id,
        item_code: row.item_code,
        name: row.name,
        spec: row.spec,
        unit: row.uom,
        pack_size: ps,
        category: row.category,
        qty: boxQty,
        unit_price: row.unit_price,
        comment: '',
      };
      const bKey = `${vendorId}::${row.period_label}`;
      let b = byVendorPeriod.get(bKey);
      if (!b) { b = { vendor_id: vendorId!, period_label: row.period_label, lines: [], wr_ids: new Set(), dept_names: new Set(), routing_ids: [] }; byVendorPeriod.set(bKey, b); }
      b.lines.push(line);
      for (const p of row.pairs) b.wr_ids.add(p.wr_id);
      for (const d of row.depts) b.dept_names.add(d.dept_name);
      b.routing_ids.push(...thisRoutingIds);
    }

    // (거래처 × 주기) 별 결의서 생성/추가 — 같은 거래처·같은 주기 DRAFT 결의서 있으면 거기에 라인 추가
    const decisions: any[] = [];
    for (const b of byVendorPeriod.values()) {
      const vendor = await prisma.vendor.findUnique({ where: { id: b.vendor_id }, select: { name: true } });
      const vendorName = vendor?.name ?? '거래처';
      const sortLines = (arr: any[]) => arr.slice().sort((x, y) =>
        (x.item_code ?? '').localeCompare(y.item_code ?? '', 'ko', { numeric: true }));

      const existing: any = await (prisma as any).purchaseDecision.findFirst({
        where: { vendor_id: b.vendor_id, period_label: b.period_label, status: 'DRAFT', deleted_at: null },
        orderBy: { created_at: 'desc' },
      });

      let decId: string;
      let decisionRow: any;
      if (existing) {
        const prevLines: any[] = (() => { try { return JSON.parse(existing.items_json ?? '[]'); } catch { return []; } })();
        const prevWr: string[] = (() => { try { return JSON.parse(existing.source_ward_request_ids ?? '[]'); } catch { return []; } })();
        const mergedWr = Array.from(new Set([...prevWr, ...Array.from(b.wr_ids)]));
        decisionRow = await (prisma as any).purchaseDecision.update({
          where: { id: existing.id },
          data: {
            items_json: JSON.stringify(sortLines([...prevLines, ...b.lines])),
            source_ward_request_ids: JSON.stringify(mergedWr),
            dept_label: Array.from(new Set([
              ...String(existing.dept_label ?? '').split(',').map((s: string) => s.trim()).filter(Boolean),
              ...Array.from(b.dept_names),
            ])).join(', '),
          },
          include: INCLUDE,
        });
        decId = existing.id;
      } else {
        const seq = await nextDecisionSeq();
        decId = uuidv4();
        decisionRow = await (prisma as any).purchaseDecision.create({
          data: {
            id: decId,
            decision_no: generateNo('PD', seq),
            title: `${vendorName} 구매결의서`,
            vendor_id: b.vendor_id,
            doc_date: now,
            period_label: b.period_label,
            period_from: now,
            period_to: now,
            dept_label: Array.from(b.dept_names).join(', '),
            approver_lines: JSON.stringify(['담당', '부서장', '행정원장', '상임이사', '이사장']),
            items_json: JSON.stringify(sortLines(b.lines)),
            source_ward_request_ids: JSON.stringify(Array.from(b.wr_ids)),
            status: 'DRAFT',
            created_by: req.user!.id,
          },
          include: INCLUDE,
        });
      }
      // 생성/연결된 결의서를 라우팅 행에 기록
      await (prisma as any).orderRouting.updateMany({
        where: { id: { in: b.routing_ids } },
        data: { decision_id: decId },
      });
      decisions.push(format(decisionRow));
    }

    await audit({
      actor_user_id: req.user!.id,
      action: 'ROUTE',
      entity_type: 'order_routings',
      entity_id: 'BULK',
      after: { targets: targets.length, routings: created_routings.length, decisions: decisions.length, gian: gian_count, hold: hold_count, skipped: skipped.length },
    });

    res.status(201).json({
      routings_created: created_routings.length,
      decisions,
      gian_count,
      hold_count,
      skipped,
    });
  } catch (e: any) {
    console.error('[POST /order-routing/route] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// GET /api/order-routing/held — 재고보유(HOLD) 목록
router.get('/held', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (_req: AuthRequest, res) => {
  try {
    const held: any[] = await (prisma as any).orderRouting.findMany({
      where: { route: 'HOLD', status: 'ACTIVE' },
      orderBy: { routed_at: 'desc' },
    });
    if (held.length === 0) return res.json({ items: [] });

    const itemIds = Array.from(new Set(held.map(h => h.item_id).filter(Boolean)));
    const wrIds = Array.from(new Set(held.map(h => h.ward_request_id)));
    const items = await prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, item_code: true, name: true, pack_size: true, category: true } });
    const itemById = new Map(items.map((i: any) => [i.id, i]));
    const wrs = await prisma.wardRequest.findMany({
      where: { id: { in: wrIds } },
      select: { id: true, request_no: true, period_start: true, request_type: true, department: { select: { name: true } } },
    });
    const wrById = new Map(wrs.map((w: any) => [w.id, w]));
    const schedulesByType = await loadSchedulesByType(prisma);
    const periodOf = (h: any): string => {
      if (h.period_label && String(h.period_label).trim()) return h.period_label;
      const wr = wrById.get(h.ward_request_id);
      const ps = wr?.period_start ? new Date(wr.period_start) : null;
      const { period_label } = resolveScheduleLabel(String(wr?.request_type ?? ''), ps, schedulesByType);
      return (period_label && period_label.trim()) ? period_label : (ps ? monthLabel(ps) : '주기 미지정');
    };
    const periodStartOf = (h: any): string => {
      const wr = wrById.get(h.ward_request_id);
      return wr?.period_start ? new Date(wr.period_start).toISOString() : '';
    };

    type H = { item_id: string; period_label: string; period_start: string; item_code: string; name: string; category: string; pack_size: number; total_qty_pack: number; hold_reason: string; routed_at: any; routing_ids: string[]; sources: { dept_name: string; wr_no: string; qty_pack: number }[] };
    const byKey = new Map<string, H>();
    for (const h of held) {
      const it = itemById.get(h.item_id);
      const wr = wrById.get(h.ward_request_id);
      const period_label = periodOf(h);
      const key = `${h.item_id}::${period_label}`;
      let g = byKey.get(key);
      if (!g) {
        g = {
          item_id: h.item_id,
          period_label,
          period_start: periodStartOf(h),
          item_code: it?.item_code ?? '',
          name: it?.name ?? '(품목)',
          category: String(it?.category ?? ''),
          pack_size: Math.max(1, Number(it?.pack_size ?? 1)),
          total_qty_pack: 0,
          hold_reason: h.hold_reason ?? '',
          routed_at: h.routed_at,
          routing_ids: [],
          sources: [],
        };
        byKey.set(key, g);
      }
      g.total_qty_pack += Number(h.approved_qty ?? 0);
      g.routing_ids.push(h.id);
      g.sources.push({ dept_name: wr?.department?.name ?? '미지정', wr_no: wr?.request_no ?? '', qty_pack: Number(h.approved_qty ?? 0) });
    }
    const list = Array.from(byKey.values()).sort((a, b) =>
      (a.period_label ?? '').localeCompare(b.period_label ?? '', 'ko')
      || (a.item_code ?? '').localeCompare(b.item_code ?? '', 'ko', { numeric: true }));
    res.json({ items: list });
  } catch (e: any) {
    console.error('[GET /order-routing/held] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// GET /api/order-routing/routed?route=DECISION|GIAN — 처리된 라우팅 (상태 배지용)
router.get('/routed', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const route = String(req.query.route ?? '');
    const where: any = { status: 'ACTIVE' };
    if (route) where.route = route;
    else where.route = { in: ['DECISION', 'GIAN'] };
    const rows: any[] = await (prisma as any).orderRouting.findMany({ where, orderBy: { routed_at: 'desc' } });
    const itemIds = Array.from(new Set(rows.map(r => r.item_id).filter(Boolean)));
    const decIds = Array.from(new Set(rows.map(r => r.decision_id).filter(Boolean)));
    const items = await prisma.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, item_code: true, name: true } });
    const itemById = new Map(items.map((i: any) => [i.id, i]));
    const decs: any[] = decIds.length
      ? await (prisma as any).purchaseDecision.findMany({ where: { id: { in: decIds } }, select: { id: true, decision_no: true } })
      : [];
    const decById = new Map(decs.map((d: any) => [d.id, d]));
    // 거래처명 매핑 — 결의서 헤더에 "(거래처명)" 표시용
    const vendorIds = Array.from(new Set(rows.map(r => r.vendor_id).filter(Boolean)));
    const vendors = vendorIds.length
      ? await prisma.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, name: true } })
      : [];
    const vendorNameById = new Map(vendors.map((v: any) => [v.id, v.name]));
    const wrIds = Array.from(new Set(rows.map(r => r.ward_request_id).filter(Boolean)));
    const wrs2 = await prisma.wardRequest.findMany({
      where: { id: { in: wrIds } },
      select: { id: true, period_start: true, request_type: true },
    });
    const wrById2 = new Map(wrs2.map((w: any) => [w.id, w]));
    const schedulesByType = await loadSchedulesByType(prisma);
    const periodOf = (r: any): string => {
      if (r.period_label && String(r.period_label).trim()) return r.period_label;
      const wr = wrById2.get(r.ward_request_id);
      const ps = wr?.period_start ? new Date(wr.period_start) : null;
      const { period_label } = resolveScheduleLabel(String(wr?.request_type ?? ''), ps, schedulesByType);
      return (period_label && period_label.trim()) ? period_label : (ps ? monthLabel(ps) : '주기 미지정');
    };
    const periodStartOf2 = (r: any): string => {
      const wr = wrById2.get(r.ward_request_id);
      return wr?.period_start ? new Date(wr.period_start).toISOString() : '';
    };

    type R = { item_id: string; period_label: string; period_start: string; item_code: string; name: string; route: string; total_qty_pack: number; decision_no: string | null; vendor_id: string | null; vendor_name: string | null };
    const byKey = new Map<string, R>();
    for (const r of rows) {
      const period_label = periodOf(r);
      const k = `${r.item_id}::${period_label}::${r.route}::${r.decision_id ?? ''}`;
      const it = itemById.get(r.item_id);
      let g = byKey.get(k);
      if (!g) {
        g = {
          item_id: r.item_id,
          period_label,
          period_start: periodStartOf2(r),
          item_code: it?.item_code ?? '',
          name: it?.name ?? '(품목)',
          route: r.route,
          total_qty_pack: 0,
          decision_no: r.decision_id ? (decById.get(r.decision_id)?.decision_no ?? null) : null,
          vendor_id: r.vendor_id ?? null,
          vendor_name: r.vendor_id ? (vendorNameById.get(r.vendor_id) ?? null) : null,
        };
        byKey.set(k, g);
      }
      g.total_qty_pack += Number(r.approved_qty ?? 0);
    }
    const list = Array.from(byKey.values()).sort((a, b) =>
      (a.period_label ?? '').localeCompare(b.period_label ?? '', 'ko')
      || (a.item_code ?? '').localeCompare(b.item_code ?? '', 'ko', { numeric: true }));
    res.json({ items: list });
  } catch (e: any) {
    console.error('[GET /order-routing/routed] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// POST /api/order-routing/release — 보류(HOLD) 해제 → 풀 복귀
// body: { routing_ids?: string[], item_id?: string }
router.post('/release', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const ids: string[] = Array.isArray(req.body?.routing_ids) ? req.body.routing_ids : [];
    const itemId = req.body?.item_id ? String(req.body.item_id) : '';
    if (ids.length === 0 && !itemId) return res.status(400).json({ error: 'routing_ids 또는 item_id 가 필요합니다.' });

    const where: any = { route: 'HOLD', status: 'ACTIVE' };
    if (ids.length > 0) where.id = { in: ids };
    else where.item_id = itemId;

    const result = await (prisma as any).orderRouting.updateMany({
      where,
      data: { status: 'RELEASED', released_at: new Date() },
    });
    await audit({
      actor_user_id: req.user!.id,
      action: 'RELEASE',
      entity_type: 'order_routings',
      entity_id: itemId || `BULK(${ids.length})`,
      after: { released: result.count },
    });
    res.json({ released: result.count });
  } catch (e: any) {
    console.error('[POST /order-routing/release] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// POST /api/order-routing/backfill — 기존 결의서 → OrderRouting(DECISION,ACTIVE) 정밀 재구성.
// 멱등 + 교정: 이전 백필행(routed_by='BACKFILL')을 먼저 비우고, 결의서가 묶은
// (wr,item) 중 "그 wr 의 실제 승인내역에 그 item 이 있는" 페어만 마킹(= cartesian 오염 제거).
// 정상 라우팅(/route, routed_by=실유저)은 건드리지 않음.
router.post('/backfill', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const purged = await (prisma as any).orderRouting.deleteMany({ where: { routed_by: 'BACKFILL' } });

    const decisions: any[] = await (prisma as any).purchaseDecision.findMany({
      where: { deleted_at: null },
      select: { id: true, vendor_id: true, source_ward_request_ids: true, items_json: true },
    });

    // 결의서가 참조하는 모든 source WR 의 최신 승인내역(품목별 승인팩) 사전 적재
    const allWrIds = new Set<string>();
    const decParsed = decisions.map((d: any) => {
      let wrIds: string[] = []; let items: any[] = [];
      try { wrIds = JSON.parse(d.source_ward_request_ids ?? '[]'); } catch {}
      try { items = JSON.parse(d.items_json ?? '[]'); } catch {}
      for (const w of wrIds) allWrIds.add(w);
      return { d, wrIds, itemIds: new Set(items.map((i: any) => i.item_id).filter(Boolean)) };
    });
    const wrs = await prisma.wardRequest.findMany({
      where: { id: { in: Array.from(allWrIds) } },
      include: { approval_actions: { orderBy: { created_at: 'desc' as const }, take: 1, include: { items: true } } },
    });
    const approvedByWr = new Map<string, Map<string, number>>(); // wrId → (itemId → 승인팩합)
    const schedulesByType = await loadSchedulesByType(prisma);
    const periodByWr = new Map<string, string>();
    for (const wr of wrs as any[]) {
      const act = wr.approval_actions[0];
      const m = new Map<string, number>();
      if (act) for (const ai of act.items) {
        if (!ai.item_id || Number(ai.approved_qty) <= 0) continue;
        m.set(ai.item_id, (m.get(ai.item_id) ?? 0) + Number(ai.approved_qty));
      }
      approvedByWr.set(wr.id, m);
      const ps = wr.period_start ? new Date(wr.period_start) : null;
      const { period_label } = resolveScheduleLabel(String(wr.request_type ?? ''), ps, schedulesByType);
      periodByWr.set(wr.id, (period_label && period_label.trim()) ? period_label : (ps ? monthLabel(ps) : '주기 미지정'));
    }

    let inserted = 0;
    let skippedPhantom = 0;
    const seen = new Set<string>(); // 결의서간 중복 (wr,item) 1회만
    for (const { d, wrIds, itemIds } of decParsed) {
      for (const wrId of wrIds) {
        const approved = approvedByWr.get(wrId);
        if (!approved) continue;
        for (const itemId of itemIds) {
          if (!approved.has(itemId)) { skippedPhantom++; continue; } // cartesian 유령 — 스킵
          const key = `${wrId}::${itemId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await (prisma as any).orderRouting.create({
            data: {
              id: uuidv4(),
              ward_request_id: wrId,
              item_id: itemId,
              custom_key: '',
              route: 'DECISION',
              status: 'ACTIVE',
              approved_qty: approved.get(itemId) ?? 0,
              vendor_id: d.vendor_id ?? null,
              period_label: periodByWr.get(wrId) ?? '',
              decision_id: d.id,
              routed_by: 'BACKFILL',
              routed_at: new Date(),
            },
          });
          inserted++;
        }
      }
    }
    await audit({
      actor_user_id: req.user!.id,
      action: 'BACKFILL',
      entity_type: 'order_routings',
      entity_id: 'BACKFILL',
      after: { purged: purged.count, inserted, skipped_phantom: skippedPhantom, decisions: decisions.length },
    });
    res.json({ purged: purged.count, inserted, skipped_phantom: skippedPhantom, decisions: decisions.length });
  } catch (e: any) {
    console.error('[POST /order-routing/backfill] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

export default router;
