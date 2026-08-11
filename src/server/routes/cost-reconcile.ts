// 통계 금액 정산(점검) — 불출 실제원가(stock_out_lot_allocations.line_amount) 신뢰도 확인 + 재산정.
//
//  GET  /cost-reconcile/summary  : 월별 신뢰도 분해(확정/추정/원가미상) + 문제 품목 + 이상단가
//  POST /cost-reconcile/recost   : 단가 등록/수정 후 과거 allocation 재계산 (미리보기/적용)
//
// 비용 기준은 전 시스템과 동일하게 stock_out_lot_allocations.line_amount.
// 재산정 = lot 연결분은 그 lot 의 현재 unit_cost, 미할당분은 resolveFallbackUnitCost 로 재평가.
import { Router } from 'express';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';
import { resolveFallbackUnitCost } from '../utils/fifo';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('cost-reconcile', 'STATS_VIEW_ALL', 'ACCOUNTING_CLOSE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'));

const ACTIVE_STOCK_OUT_STATUSES = ['POSTED', 'RECEIPT_PENDING', 'RECEIPT_CONFIRMED', 'RECEIPT_DIFF'];

// 통계 스코프 — STATS_VIEW_ALL/SYSTEM_ADMIN 이면 전체, 그 외 본인 부서.
function statsScope(req: AuthRequest, requestedDeptRaw: unknown): { deptId: string } {
  const perms = req.user?.permissions ?? [];
  const canAll = perms.includes('SYSTEM_ADMIN') || perms.includes('STATS_VIEW_ALL');
  const requested = requestedDeptRaw ? String(requestedDeptRaw) : '';
  if (canAll) return { deptId: requested };
  return { deptId: req.user?.department_id ?? '__none__' };
}

function monthRange(req: AuthRequest): { selKey: string; start: Date; end: Date } {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  if (req.query.year && req.query.month) {
    y = Number(req.query.year);
    m = Number(req.query.month);
  } else if (req.query.year_month && /^\d{4}-\d{2}$/.test(String(req.query.year_month))) {
    const [yy, mm] = String(req.query.year_month).split('-');
    y = Number(yy); m = Number(mm);
  }
  return {
    selKey: `${y}-${String(m).padStart(2, '0')}`,
    start: new Date(y, m - 1, 1, 0, 0, 0, 0),
    end: new Date(y, m, 0, 23, 59, 59, 999),
  };
}

// 대상 월·스코프의 활성 불출 라인 전부 (allocation 단위) 로딩.
async function loadAllocations(req: AuthRequest, deptId: string, start: Date, end: Date) {
  const sos = await prisma.stockOut.findMany({
    where: {
      deleted_at: null,
      is_test: false,
      status: { in: ACTIVE_STOCK_OUT_STATUSES as any },
      issued_at: { gte: start, lte: end },
      ...(deptId && deptId !== '__none__' ? { department_id: deptId } : {}),
      ...(deptId === '__none__' ? { id: '__never__' } : {}),
    },
    select: {
      id: true, so_no: true, department_id: true,
      department: { select: { name: true } },
      items: { select: { id: true, item_id: true, item: { select: { item_code: true, name: true } } } },
      lot_allocations: { select: { id: true, stock_out_item_id: true, inventory_lot_id: true, issued_qty: true, unit_cost: true, line_amount: true } },
    },
  });
  type Row = {
    alloc_id: string; so_no: string; dept_id: string; dept_name: string;
    item_id: string; item_code: string; item_name: string;
    inventory_lot_id: string | null; qty: number; unit_cost: number; line_amount: number;
  };
  const rows: Row[] = [];
  for (const so of sos as any[]) {
    const siMap = new Map<string, any>();
    for (const si of so.items ?? []) siMap.set(si.id, si);
    for (const a of so.lot_allocations ?? []) {
      const si = siMap.get(a.stock_out_item_id);
      if (!si?.item_id) continue;
      rows.push({
        alloc_id: a.id, so_no: so.so_no, dept_id: so.department_id, dept_name: so.department?.name ?? '',
        item_id: si.item_id, item_code: si.item?.item_code ?? '', item_name: si.item?.name ?? '',
        inventory_lot_id: a.inventory_lot_id ?? null,
        qty: Number(a.issued_qty ?? 0), unit_cost: Number(a.unit_cost ?? 0), line_amount: Number(a.line_amount ?? 0),
      });
    }
  }
  return rows;
}

// 재산정 단가 결정: lot 연결분 = 그 lot 의 현재 unit_cost, 미할당분 = resolveFallbackUnitCost.
async function recostUnit(row: { inventory_lot_id: string | null; item_id: string }, lotCostCache: Map<string, number>): Promise<number> {
  if (row.inventory_lot_id) {
    if (!lotCostCache.has(row.inventory_lot_id)) {
      const lot = await prisma.inventoryLot.findUnique({ where: { id: row.inventory_lot_id }, select: { unit_cost: true } });
      lotCostCache.set(row.inventory_lot_id, Number(lot?.unit_cost ?? 0));
    }
    return lotCostCache.get(row.inventory_lot_id)!;
  }
  return resolveFallbackUnitCost(prisma as any, row.item_id);
}

// ─── GET /cost-reconcile/summary ─────────────────────────────────────────────
router.get('/summary', requirePermission('STATS_VIEW_ALL', 'ACCOUNTING_CLOSE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const { selKey, start, end } = monthRange(req);
    const { deptId } = statsScope(req, req.query.department_id);
    const rows = await loadAllocations(req, deptId, start, end);

    const bucket = { confirmed: { lines: 0, qty: 0, amount: 0 }, estimated: { lines: 0, qty: 0, amount: 0 }, unknown: { lines: 0, qty: 0, amount: 0 } };
    const itemAgg = new Map<string, { item_id: string; item_code: string; item_name: string; missing_lines: number; missing_qty: number; est_amount: number }>();
    for (const r of rows) {
      const kind = (r.line_amount === 0 || r.unit_cost === 0) ? 'unknown' : (r.inventory_lot_id ? 'confirmed' : 'estimated');
      bucket[kind].lines += 1; bucket[kind].qty += r.qty; bucket[kind].amount += r.line_amount;
      if (kind !== 'confirmed') {
        const it = itemAgg.get(r.item_id) ?? { item_id: r.item_id, item_code: r.item_code, item_name: r.item_name, missing_lines: 0, missing_qty: 0, est_amount: 0 };
        if (kind === 'unknown') { it.missing_lines += 1; it.missing_qty += r.qty; }
        it.est_amount += r.line_amount;
        itemAgg.set(r.item_id, it);
      }
    }

    // 문제 품목: 원가미상/추정 — price_history 보유 여부 + 추천 단가(재산정 시 적용될 값)
    const lotCache = new Map<string, number>();
    const problems = [];
    for (const it of itemAgg.values()) {
      const phCnt = await prisma.priceHistory.count({ where: { item_id: it.item_id } });
      const suggested = await resolveFallbackUnitCost(prisma as any, it.item_id);
      problems.push({
        ...it,
        has_price_history: phCnt > 0,
        suggested_unit_cost: Number(suggested.toFixed(2)),
        recoverable: suggested > 0,
      });
    }
    problems.sort((a, b) => (b.missing_qty - a.missing_qty) || (b.est_amount - a.est_amount));

    // 이상 단가: 같은 품목 내 nonzero unit_cost 평균 대비 3배↑ 또는 1/3↓ 인 라인
    const byItemCosts = new Map<string, number[]>();
    for (const r of rows) if (r.unit_cost > 0) (byItemCosts.get(r.item_id) ?? byItemCosts.set(r.item_id, []).get(r.item_id)!).push(r.unit_cost);
    const anomalies = [];
    for (const r of rows) {
      const arr = byItemCosts.get(r.item_id);
      if (!arr || arr.length < 3 || r.unit_cost <= 0) continue;
      const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
      if (avg > 0 && (r.unit_cost > avg * 3 || r.unit_cost < avg / 3)) {
        anomalies.push({ so_no: r.so_no, item_code: r.item_code, item_name: r.item_name, dept_name: r.dept_name, unit_cost: r.unit_cost, item_avg_unit_cost: Number(avg.toFixed(2)), qty: r.qty });
      }
    }
    anomalies.sort((a, b) => Math.abs(b.unit_cost - b.item_avg_unit_cost) - Math.abs(a.unit_cost - a.item_avg_unit_cost));

    const total = bucket.confirmed.amount + bucket.estimated.amount + bucket.unknown.amount;
    res.json({
      year_month: selKey,
      total_amount: Math.round(total),
      total_lines: rows.length,
      breakdown: {
        confirmed: { ...bucket.confirmed, amount: Math.round(bucket.confirmed.amount), pct: total > 0 ? Math.round((bucket.confirmed.amount / total) * 100) : 0 },
        estimated: { ...bucket.estimated, amount: Math.round(bucket.estimated.amount), pct: total > 0 ? Math.round((bucket.estimated.amount / total) * 100) : 0 },
        unknown: { ...bucket.unknown, amount: Math.round(bucket.unknown.amount) },
      },
      problem_items: problems.slice(0, 200),
      anomalies: anomalies.slice(0, 100),
    });
  } catch (e) {
    console.error('[cost-reconcile/summary] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── POST /cost-reconcile/recost ─────────────────────────────────────────────
// body: { year, month, item_ids?: string[], apply: boolean }
// apply=false → 미리보기(변경 라인·차액). apply=true → 트랜잭션 적용 + 감사로그.
router.post('/recost', requirePermission('ACCOUNTING_CLOSE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const apply = req.body?.apply === true;
    const itemIds: string[] = Array.isArray(req.body?.item_ids) ? req.body.item_ids.map(String) : [];
    const reqLike: any = { ...req, query: { year: req.body?.year, month: req.body?.month } };
    const { selKey, start, end } = monthRange(reqLike);
    const { deptId } = statsScope(req, req.body?.department_id);
    const rows = await loadAllocations(req, deptId, start, end);

    const targets = rows.filter((r) => itemIds.length === 0 || itemIds.includes(r.item_id));
    const lotCache = new Map<string, number>();
    const changes: any[] = [];
    let oldTotal = 0;
    let newTotal = 0;
    for (const r of targets) {
      const newUnit = await recostUnit(r, lotCache);
      const newAmt = Number((r.qty * newUnit).toFixed(2));
      oldTotal += r.line_amount;
      newTotal += newAmt;
      if (Math.abs(newAmt - r.line_amount) > 0.005 || Math.abs(newUnit - r.unit_cost) > 0.005) {
        changes.push({
          alloc_id: r.alloc_id, so_no: r.so_no, dept_name: r.dept_name,
          item_code: r.item_code, item_name: r.item_name, qty: r.qty,
          old_unit_cost: r.unit_cost, new_unit_cost: Number(newUnit.toFixed(2)),
          old_amount: Math.round(r.line_amount), new_amount: Math.round(newAmt),
          delta: Math.round(newAmt - r.line_amount),
        });
      }
    }
    const summary = {
      year_month: selKey,
      change_count: changes.length,
      old_total: Math.round(oldTotal),
      new_total: Math.round(newTotal),
      delta_total: Math.round(newTotal - oldTotal),
    };

    if (!apply) {
      return res.json({ mode: 'preview', ...summary, changes: changes.slice(0, 500) });
    }

    if (changes.length === 0) {
      return res.json({ mode: 'applied', ...summary, changes: [] });
    }

    await prisma.$transaction(async (tx) => {
      for (const c of changes) {
        await (tx as any).$executeRawUnsafe(
          `UPDATE stock_out_lot_allocations SET unit_cost = ?, line_amount = ? WHERE id = ?`,
          c.new_unit_cost, c.new_amount, c.alloc_id,
        );
      }
    }, { timeout: 30000, maxWait: 10000 });

    await audit({
      actor_user_id: req.user!.id,
      action: 'UPDATE',
      entity_type: 'stock_out_lot_allocations',
      entity_id: selKey,
      reason: `통계 재산정 ${selKey} — ${changes.length}건, 차액 ${summary.delta_total.toLocaleString()}원`,
    });

    res.json({ mode: 'applied', ...summary, changes: changes.slice(0, 500) });
  } catch (e) {
    console.error('[cost-reconcile/recost] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── GET /cost-reconcile/item/:itemId ── 품목별: 단가대(lot)/FIFO출고/단가변동/신뢰도
router.get('/item/:itemId', requirePermission('STATS_VIEW_ALL', 'ACCOUNTING_CLOSE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const itemId = String(req.params.itemId);
    const item = await prisma.item.findUnique({ where: { id: itemId }, select: { item_code: true, name: true, purchase_uom: true, issue_uom: true, pack_size: true } });
    if (!item) return res.status(404).json({ error: '품목을 찾을 수 없습니다.' });

    // 단가대(lot) — FIFO 순(received_at asc). 잔량>0 중 최古 = 소진중, 나머지 잔량>0 = 대기, 잔량0 = 완료
    const lotRows: any[] = await (prisma as any).$queryRawUnsafe(`
      SELECT l.id, l.received_at, l.unit_cost, l.received_qty, l.remaining_qty, v.name AS vendor_name
      FROM inventory_lots l LEFT JOIN vendors v ON v.id = l.vendor_id
      WHERE l.deleted_at IS NULL AND l.item_id = ?
      ORDER BY datetime(l.received_at) ASC, l.id ASC`, itemId);
    let firstActive = true;
    const lots = lotRows.map((l) => {
      const remaining = Number(l.remaining_qty || 0);
      let status: string;
      if (remaining <= 0) status = '소진완료';
      else if (firstActive) { status = '소진중'; firstActive = false; }
      else status = '대기';
      return {
        received_at: l.received_at, vendor_name: l.vendor_name ?? '',
        unit_cost: Number(l.unit_cost || 0), received_qty: Number(l.received_qty || 0),
        remaining_qty: remaining, status,
      };
    });

    // FIFO 출고 흐름 (최근 50)
    const outRows: any[] = await (prisma as any).$queryRawUnsafe(`
      SELECT so.so_no, so.issued_at, d.name AS dept_name, a.issued_qty, a.unit_cost, a.line_amount, a.inventory_lot_id
      FROM stock_out_lot_allocations a
      JOIN stock_out so ON so.id = a.stock_out_id
      JOIN stock_out_items si ON si.id = a.stock_out_item_id
      LEFT JOIN departments d ON d.id = so.department_id
      WHERE si.item_id = ? AND so.deleted_at IS NULL AND so.is_test = 0
        AND so.status IN ('POSTED','RECEIPT_PENDING','RECEIPT_CONFIRMED','RECEIPT_DIFF')
      ORDER BY datetime(so.issued_at) DESC, a.id DESC LIMIT 50`, itemId);
    const outflow = outRows.map((o) => {
      const la = Number(o.line_amount || 0), uc = Number(o.unit_cost || 0);
      return {
        so_no: o.so_no, issued_at: o.issued_at, dept_name: o.dept_name ?? '',
        qty: Number(o.issued_qty || 0), unit_cost: uc, line_amount: la,
        kind: (la === 0 || uc === 0) ? 'unknown' : (o.inventory_lot_id ? 'confirmed' : 'estimated'),
      };
    });

    const ph = await prisma.priceHistory.findMany({ where: { item_id: itemId }, orderBy: { effective_from: 'asc' }, select: { effective_from: true, price: true, source: true } });
    let prev = 0;
    const price_history = ph.map((p) => {
      const price = Number(p.price);
      const delta = prev > 0 ? Math.round(((price - prev) / prev) * 100) : null;
      prev = price;
      return { effective_from: p.effective_from, price, source: p.source, change_pct: delta };
    });

    const trust = outflow.reduce((acc: any, o) => { acc[o.kind] = (acc[o.kind] || 0) + 1; return acc; }, { confirmed: 0, estimated: 0, unknown: 0 });
    const suggested = await resolveFallbackUnitCost(prisma as any, itemId);
    res.json({
      item: { item_id: itemId, ...item, pack_size: Number(item.pack_size ?? 1) },
      lots, outflow, price_history, trust,
      suggested_unit_cost: Number(suggested.toFixed(2)),
    });
  } catch (e) {
    console.error('[cost-reconcile/item] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── GET /cost-reconcile/department/:deptId ── 부서별: 비용금액(불출 실제원가)만
router.get('/department/:deptId', requirePermission('STATS_VIEW_ALL', 'ACCOUNTING_CLOSE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const deptId = String(req.params.deptId);
    const { deptId: scopeDept } = statsScope(req, deptId);
    if (scopeDept && scopeDept !== deptId && scopeDept !== '__none__') {
      return res.status(403).json({ error: '해당 부서 데이터에 접근할 수 없습니다.' });
    }
    const dept = await prisma.department.findUnique({ where: { id: deptId }, select: { name: true } });
    const { selKey, start, end } = monthRange(req);
    const rows = await loadAllocations(req, deptId, start, end);

    const itemMap = new Map<string, any>();
    const bucket = { confirmed: 0, estimated: 0, unknown: 0 };
    let total = 0;
    for (const r of rows) {
      const kind = (r.line_amount === 0 || r.unit_cost === 0) ? 'unknown' : (r.inventory_lot_id ? 'confirmed' : 'estimated');
      bucket[kind] += 1;
      total += r.line_amount;
      const it = itemMap.get(r.item_id) ?? { item_id: r.item_id, item_code: r.item_code, item_name: r.item_name, qty: 0, amount: 0, has_unknown: false };
      it.qty += r.qty; it.amount += r.line_amount;
      if (kind === 'unknown') it.has_unknown = true;
      itemMap.set(r.item_id, it);
    }
    const items = Array.from(itemMap.values())
      .map((x) => ({ ...x, amount: Math.round(x.amount), avg_unit_cost: x.qty > 0 ? Math.round(x.amount / x.qty) : 0 }))
      .sort((a, b) => b.amount - a.amount);
    res.json({
      kind: 'cost', // 비용금액(불출 실제원가) — 구매금액 아님
      year_month: selKey,
      department: { department_id: deptId, department_name: dept?.name ?? '' },
      total_cost: Math.round(total),
      trust: bucket,
      items,
    });
  } catch (e) {
    console.error('[cost-reconcile/department] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── GET /cost-reconcile/vendor/:vendorId ── 거래처별: 구매금액(발주)·재고만 (비용 아님)
router.get('/vendor/:vendorId', requirePermission('STATS_VIEW_ALL', 'ACCOUNTING_CLOSE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const vendorId = String(req.params.vendorId);
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { name: true } });
    if (!vendor) return res.status(404).json({ error: '거래처를 찾을 수 없습니다.' });
    const { selKey, start, end } = monthRange(req);

    const pos = await prisma.purchaseOrder.findMany({
      where: { vendor_id: vendorId, deleted_at: null, status: { not: 'CANCELLED' }, ordered_at: { gte: start, lte: end } },
      select: { id: true, po_no: true, ordered_at: true, status: true, total_amount: true, po_items: { select: { item_id: true, ordered_qty: true, unit_price: true, line_amount: true, item: { select: { item_code: true, name: true } } } } },
      orderBy: { ordered_at: 'desc' },
    });
    const purchase_orders = pos.map((p: any) => ({
      po_no: p.po_no, ordered_at: p.ordered_at, status: p.status,
      total_amount: Math.round(Number(p.total_amount || 0)), item_count: p.po_items.length,
    }));
    const itemAgg = new Map<string, any>();
    for (const p of pos as any[]) for (const it of p.po_items) {
      const a = itemAgg.get(it.item_id) ?? { item_code: it.item?.item_code ?? '', item_name: it.item?.name ?? '', ordered_qty: 0, amount: 0, last_unit_price: Number(it.unit_price || 0) };
      a.ordered_qty += Number(it.ordered_qty || 0);
      a.amount += Number(it.line_amount || 0);
      a.last_unit_price = Number(it.unit_price || 0);
      itemAgg.set(it.item_id, a);
    }
    const purchase_total = pos.reduce((s: number, p: any) => s + Number(p.total_amount || 0), 0);

    // 그 거래처 물품의 현재 FIFO 재고금액 (자산 — 비용 아님)
    const invRow: any[] = await (prisma as any).$queryRawUnsafe(
      `SELECT COALESCE(SUM(remaining_qty * unit_cost),0) AS amt, COUNT(*) AS lots
       FROM inventory_lots WHERE deleted_at IS NULL AND vendor_id = ? AND remaining_qty > 0`, vendorId);
    const inventory_fifo = Math.round(Number(invRow?.[0]?.amt || 0));

    // 단가 변동 (이 거래처 품목)
    const phRows: any[] = await (prisma as any).$queryRawUnsafe(`
      SELECT i.name AS item_name, ph.price, ph.effective_from, ph.source
      FROM price_history ph JOIN items i ON i.id = ph.item_id
      WHERE ph.vendor_id = ? ORDER BY i.name, datetime(ph.effective_from) ASC`, vendorId);

    res.json({
      kind: 'purchase', // 구매금액(발주)·재고자산 — 비용금액 아님
      year_month: selKey,
      vendor: { vendor_id: vendorId, vendor_name: vendor.name },
      purchase_total: Math.round(purchase_total),
      inventory_fifo,
      purchase_orders,
      items: Array.from(itemAgg.values()).map((x) => ({ ...x, amount: Math.round(x.amount) })).sort((a, b) => b.amount - a.amount),
      price_history: phRows.map((r) => ({ item_name: r.item_name, price: Number(r.price), effective_from: r.effective_from, source: r.source })),
    });
  } catch (e) {
    console.error('[cost-reconcile/vendor] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── GET /cost-reconcile/ledger ── 수불부(입출고 내역). mode=item|vendor|dept
router.get('/ledger', requirePermission('STATS_VIEW_ALL', 'ACCOUNTING_CLOSE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const mode = String(req.query.mode || 'item');
    const id = String(req.query.id || '');
    const { selKey, start, end } = monthRange(req);
    const ACT = "('POSTED','RECEIPT_PENDING','RECEIPT_CONFIRMED','RECEIPT_DIFF')";

    // lot 출처 분류: 기초재고(실사 등록 — 구매 아님) vs 구매입고(발주/수기입고)
    //  - GR 없음(빈 goods_receipt_id) = 단순 실사 lot → 기초재고
    //  - GR 있고 발주 연결(purchase_order_id) = 실제 구매
    //  - GR note 가 [기초재고]/[실사 신규 lot] 이고 발주 없음 = 기초재고
    const classifySrc = (grNote: any, grPo: any, grId: any): 'BASE' | 'BUY' => {
      if (!grId) return 'BASE';
      if (grPo) return 'BUY';
      const n = String(grNote || '');
      if (n.startsWith('[기초재고]') || n.startsWith('[실사 신규 lot]')) return 'BASE';
      return 'BUY';
    };

    // 기본(전체): 선택 없으면 이번 달 전체 입출고를 바로 보여줌. 권한 스코프 적용.
    if (!id) {
      const { deptId: scope } = statsScope(req, '');
      const allLots: any[] = await (prisma as any).$queryRawUnsafe(`
        SELECT l.id AS lot_id, l.received_at AS date, l.unit_cost, l.received_qty AS qty,
               i.item_code, i.name AS item_name, v.name AS counter,
               gr.note AS gr_note, gr.purchase_order_id AS gr_po, l.goods_receipt_id AS grid
        FROM inventory_lots l JOIN items i ON i.id = l.item_id
        LEFT JOIN vendors v ON v.id = l.vendor_id
        LEFT JOIN goods_receipts gr ON gr.id = l.goods_receipt_id
        WHERE l.deleted_at IS NULL`);
      const s0 = start.getTime(), e0 = end.getTime();
      const inRows = allLots
        .filter((l) => { const t = new Date(l.date).getTime(); return !isNaN(t) && t >= s0 && t <= e0; })
        .map((l) => {
          const src = classifySrc(l.gr_note, l.gr_po, l.grid);
          return { date: l.date, kind: 'IN', src, item_code: l.item_code, item_name: l.item_name, counter: src === 'BASE' ? '(기초재고)' : (l.counter ?? ''), doc: '', qty: Number(l.qty || 0), unit_cost: Number(l.unit_cost || 0), amount: Number(l.qty || 0) * Number(l.unit_cost || 0), lot_id: l.lot_id };
        });
      const allocs = await loadAllocations(req, scope || '', start, end);
      const oMap = new Map<string, any>();
      for (const r of allocs) {
        const k = `${r.so_no}__${r.item_id}`;
        const e = oMap.get(k) ?? {
          so_no: r.so_no, item_id: r.item_id, item_code: r.item_code, item_name: r.item_name, dept: r.dept_name,
          qty: 0, amount: 0,
          // 미상 추적: lot_id 없는 allocation 의 수량/존재 여부
          unknown_qty: 0, has_any_alloc: false, manual_fill_count: 0,
        };
        e.qty += r.qty;
        e.amount += r.line_amount;
        e.has_any_alloc = true;
        if (r.inventory_lot_id == null) {
          // lot 없는 음수재고 allocation. 단가 0 이면 진짜 미상, 0보다 크면 수동보정 흔적
          if (Number(r.unit_cost ?? 0) === 0) e.unknown_qty += Number(r.qty || 0);
          else e.manual_fill_count += 1;
        }
        oMap.set(k, e);
      }
      const soNos = [...new Set(allocs.map((r) => r.so_no))];
      const soD: any[] = soNos.length ? await (prisma as any).$queryRawUnsafe(
        `SELECT so_no, issued_at FROM stock_out WHERE so_no IN (${soNos.map(() => '?').join(',')})`, ...soNos) : [];
      const dmap = new Map(soD.map((x) => [x.so_no, x.issued_at]));
      const outRows = Array.from(oMap.values()).map((o) => ({
        date: dmap.get(o.so_no), kind: 'OUT',
        item_id: o.item_id, item_code: o.item_code, item_name: o.item_name,
        counter: o.dept ?? '', doc: o.so_no,
        qty: -o.qty,
        unit_cost: o.qty > 0 ? Math.round(o.amount / o.qty) : 0,
        amount: Math.round(o.amount),
        lot_id: null,
        // 미상 행 식별: 합계 금액 0 + 미상 수량 > 0
        is_missing_cost: Math.round(o.amount) === 0 && o.unknown_qty > 0,
        manual_filled: o.manual_fill_count > 0,
      }));
      const rows = [...inRows, ...outRows].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 1000);
      return res.json({
        mode: 'all', year_month: selKey, title: `전체 입출고 (${selKey})`, rows,
        total_in: Math.round(inRows.filter((r) => r.src === 'BUY').reduce((x, r) => x + r.amount, 0)),
        total_base: Math.round(inRows.filter((r) => r.src === 'BASE').reduce((x, r) => x + r.amount, 0)),
        total_out: Math.round(outRows.reduce((x, r) => x + r.amount, 0)),
      });
    }

    if (mode === 'item') {
      const item = await prisma.item.findUnique({ where: { id }, select: { item_code: true, name: true } });
      // 입고(lot) — 전체 이력
      const lots: any[] = await (prisma as any).$queryRawUnsafe(`
        SELECT l.id AS lot_id, l.received_at AS date, l.unit_cost, l.received_qty AS qty, v.name AS counter,
               gr.note AS gr_note, gr.purchase_order_id AS gr_po, l.goods_receipt_id AS grid
        FROM inventory_lots l
        LEFT JOIN vendors v ON v.id = l.vendor_id
        LEFT JOIN goods_receipts gr ON gr.id = l.goods_receipt_id
        WHERE l.deleted_at IS NULL AND l.item_id = ?`, id);
      // 출고 — 불출 1건당 1행 (allocation 합산). 미상/수동보정 표시도 함께 집계.
      const outs: any[] = await (prisma as any).$queryRawUnsafe(`
        SELECT so.so_no, so.issued_at AS date, d.name AS counter,
               SUM(a.issued_qty) AS qty, SUM(a.line_amount) AS amount,
               SUM(CASE WHEN a.inventory_lot_id IS NULL AND IFNULL(a.unit_cost, 0) = 0 THEN a.issued_qty ELSE 0 END) AS unknown_qty,
               SUM(CASE WHEN a.inventory_lot_id IS NULL AND IFNULL(a.unit_cost, 0) > 0 THEN 1 ELSE 0 END) AS manual_fill_count
        FROM stock_out_lot_allocations a
        JOIN stock_out so ON so.id = a.stock_out_id
        JOIN stock_out_items si ON si.id = a.stock_out_item_id
        LEFT JOIN departments d ON d.id = so.department_id
        WHERE si.item_id = ? AND so.deleted_at IS NULL AND so.is_test = 0 AND so.status IN ${ACT}
        GROUP BY a.stock_out_item_id`, id);
      const movs = [
        ...lots.map((l) => { const src = classifySrc(l.gr_note, l.gr_po, l.grid); return { date: l.date, kind: 'IN', src, counter: src === 'BASE' ? '(기초재고)' : (l.counter ?? ''), qty: Number(l.qty || 0), unit_cost: Number(l.unit_cost || 0), amount: Number(l.qty || 0) * Number(l.unit_cost || 0), lot_id: l.lot_id, doc: '' }; }),
        ...outs.map((o) => {
          const q = Number(o.qty || 0), amt = Number(o.amount || 0);
          const unk = Number(o.unknown_qty || 0);
          const mfc = Number(o.manual_fill_count || 0);
          return {
            date: o.date, kind: 'OUT', src: 'OUT', counter: o.counter ?? '',
            qty: -q, unit_cost: q > 0 ? Math.round(amt / q) : 0, amount: amt,
            lot_id: null, doc: o.so_no,
            item_id: id,
            is_missing_cost: Math.round(amt) === 0 && unk > 0,
            manual_filled: mfc > 0,
          };
        }),
      ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      let bal = 0;
      const rows = movs.map((m) => { bal += m.qty; return { ...m, balance: bal }; });
      return res.json({
        mode, year_month: selKey,
        title: `${item?.item_code ?? ''} ${item?.name ?? ''}`,
        rows,
        total_in: Math.round(rows.filter((r) => r.src === 'BUY').reduce((s, r) => s + r.amount, 0)),
        total_base: Math.round(rows.filter((r) => r.src === 'BASE').reduce((s, r) => s + r.amount, 0)),
        total_out: Math.round(rows.filter((r) => r.kind === 'OUT').reduce((s, r) => s + r.amount, 0)),
      });
    }

    if (mode === 'vendor') {
      const v = await prisma.vendor.findUnique({ where: { id }, select: { name: true } });
      const lots0: any[] = await (prisma as any).$queryRawUnsafe(`
        SELECT l.id AS lot_id, l.received_at AS date, l.unit_cost, l.received_qty AS qty,
               i.item_code, i.name AS item_name,
               gr.note AS gr_note, gr.purchase_order_id AS gr_po, l.goods_receipt_id AS grid
        FROM inventory_lots l JOIN items i ON i.id = l.item_id
        LEFT JOIN goods_receipts gr ON gr.id = l.goods_receipt_id
        WHERE l.deleted_at IS NULL AND l.vendor_id = ?`, id);
      // 날짜 필터 + 기초재고 제외(거래처별 = 실제 구매만)
      const s = start.getTime(), e2 = end.getTime();
      const rows = lots0
        .filter((l) => { const t = new Date(l.date).getTime(); return !isNaN(t) && t >= s && t <= e2 && classifySrc(l.gr_note, l.gr_po, l.grid) === 'BUY'; })
        .map((l) => ({
          date: l.date, kind: 'IN', src: 'BUY', item_code: l.item_code, item_name: l.item_name,
          qty: Number(l.qty || 0), unit_cost: Number(l.unit_cost || 0),
          amount: Number(l.qty || 0) * Number(l.unit_cost || 0), lot_id: l.lot_id,
        }))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      return res.json({ mode, year_month: selKey, title: `${v?.name ?? ''} (구매/입고)`, rows, total_in: Math.round(rows.reduce((s, r) => s + r.amount, 0)), total_out: 0 });
    }

    // mode === 'dept'  (출고/비용)
    const { deptId: scope } = statsScope(req, id);
    if (scope && scope !== id && scope !== '__none__') return res.status(403).json({ error: '해당 부서 데이터에 접근할 수 없습니다.' });
    const d = await prisma.department.findUnique({ where: { id }, select: { name: true } });
    const rows0 = await loadAllocations(req, id, start, end);
    const byDoc = new Map<string, any>();
    for (const r of rows0) {
      const k = `${r.so_no}__${r.item_id}`;
      const e = byDoc.get(k) ?? {
        date: null, so_no: r.so_no, item_id: r.item_id, item_code: r.item_code, item_name: r.item_name,
        qty: 0, amount: 0, unknown_qty: 0, manual_fill_count: 0,
      };
      e.qty += r.qty; e.amount += r.line_amount;
      if (r.inventory_lot_id == null) {
        if (Number(r.unit_cost ?? 0) === 0) e.unknown_qty += Number(r.qty || 0);
        else e.manual_fill_count += 1;
      }
      byDoc.set(k, e);
    }
    // 날짜 보강
    const soNos = [...new Set(rows0.map((r) => r.so_no))];
    const soDates: any[] = soNos.length ? await (prisma as any).$queryRawUnsafe(
      `SELECT so_no, issued_at FROM stock_out WHERE so_no IN (${soNos.map(() => '?').join(',')})`, ...soNos) : [];
    const dateMap = new Map(soDates.map((s) => [s.so_no, s.issued_at]));
    const rows = Array.from(byDoc.values()).map((e) => ({
      date: dateMap.get(e.so_no), kind: 'OUT', doc: e.so_no,
      item_id: e.item_id, item_code: e.item_code, item_name: e.item_name,
      qty: -e.qty, unit_cost: e.qty > 0 ? Math.round(e.amount / e.qty) : 0, amount: Math.round(e.amount),
      is_missing_cost: Math.round(e.amount) === 0 && e.unknown_qty > 0,
      manual_filled: e.manual_fill_count > 0,
    })).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return res.json({ mode, year_month: selKey, title: `${d?.name ?? ''} (불출/비용)`, rows, total_in: 0, total_out: Math.round(rows.reduce((s, r) => s + r.amount, 0)) });
  } catch (e) {
    console.error('[cost-reconcile/ledger] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── POST /cost-reconcile/lot-price ── 입고 단가 수정 → 그 품목 출고 자동 재산정
router.post('/lot-price', requirePermission('ACCOUNTING_CLOSE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const lotId = String(req.body?.lot_id || '');
    const newCost = Number(req.body?.new_unit_cost);
    if (!lotId || !Number.isFinite(newCost) || newCost < 0) return res.status(400).json({ error: 'lot_id 와 0 이상 단가 필요' });
    const lot = await prisma.inventoryLot.findUnique({ where: { id: lotId }, select: { item_id: true, vendor_id: true, unit_cost: true } });
    if (!lot) return res.status(404).json({ error: '입고분(lot)을 찾을 수 없습니다.' });

    let changed = 0;
    await prisma.$transaction(async (tx) => {
      await (tx as any).$executeRawUnsafe(`UPDATE inventory_lots SET unit_cost = ? WHERE id = ?`, newCost, lotId);
      // 단가이력 추가 (fallback 추정에도 활용 — vendor 있을 때만)
      if (lot.vendor_id) {
        await (tx as any).$executeRawUnsafe(
          `INSERT OR IGNORE INTO price_history (id, item_id, vendor_id, price, currency, effective_from, source, created_at)
           VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'KRW', ?, 'MANUAL', datetime('now'))`,
          lot.item_id, lot.vendor_id, newCost, new Date().toISOString());
      }
      // 이 품목 전체 allocation 재계산: lot 연결분=그 lot 현재단가, 미할당분=fallback
      const allocs: any[] = await (tx as any).$queryRawUnsafe(`
        SELECT a.id, a.inventory_lot_id, a.issued_qty FROM stock_out_lot_allocations a
        JOIN stock_out_items si ON si.id = a.stock_out_item_id WHERE si.item_id = ?`, lot.item_id);
      const lotCost = new Map<string, number>();
      const fb = await resolveFallbackUnitCost(tx as any, lot.item_id);
      for (const a of allocs) {
        let uc: number;
        if (a.inventory_lot_id) {
          if (!lotCost.has(a.inventory_lot_id)) {
            const r: any[] = await (tx as any).$queryRawUnsafe(`SELECT unit_cost FROM inventory_lots WHERE id = ?`, a.inventory_lot_id);
            lotCost.set(a.inventory_lot_id, Number(r?.[0]?.unit_cost ?? 0));
          }
          uc = lotCost.get(a.inventory_lot_id)!;
        } else uc = fb;
        const q = Number(a.issued_qty || 0);
        const amt = Number((q * uc).toFixed(2));
        await (tx as any).$executeRawUnsafe(`UPDATE stock_out_lot_allocations SET unit_cost = ?, line_amount = ? WHERE id = ?`, uc, amt, a.id);
        changed += 1;
      }
    }, { timeout: 30000, maxWait: 10000 });

    await audit({
      actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'inventory_lots', entity_id: lotId,
      reason: `입고단가 수정 ${Number(lot.unit_cost).toLocaleString()}→${newCost.toLocaleString()}원, 출고 ${changed}건 재산정`,
    });
    res.json({ message: `단가 수정 완료 — 출고 ${changed}건 재산정`, recosted: changed });
  } catch (e) {
    console.error('[cost-reconcile/lot-price] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── POST /cost-reconcile/fill-missing-cost ─────────────────────────────────
// lot 연결 없이 fallback 단가로 산정된 출고 라인(₩0 미상 포함, 기존 추정단가도 포함)에
// 단가를 수동으로 채우거나 고쳐 비용으로 인식시킴.
// - inventory_lot_id IS NULL 인 allocation 만 대상 (lot 연결분은 lot-price 로 처리)
// - lot 신규 생성·재고 변경 없음 (안전장치)
// - fill_all_for_item=true 면 같은 품목의 해당 출고 한꺼번에
// - from_date 지정 시 그 시점(issued_at) 이후 출고만 대상 (fill_all_for_item 모드에서만 의미 있음)
router.post('/fill-missing-cost', requirePermission('ACCOUNTING_CLOSE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const soNo = String(req.body?.so_no || '');
    const itemId = String(req.body?.item_id || '');
    const newCost = Number(req.body?.unit_cost);
    const fillAll = Boolean(req.body?.fill_all_for_item);
    const fromDateRaw = req.body?.from_date ? String(req.body.from_date) : '';
    const fromDate = fromDateRaw && !isNaN(new Date(fromDateRaw).getTime()) ? new Date(fromDateRaw) : null;
    if (!itemId || !Number.isFinite(newCost) || newCost < 0) {
      return res.status(400).json({ error: 'item_id 와 0 이상 단가 필요' });
    }
    if (!fillAll && !soNo) return res.status(400).json({ error: '단건 모드에서는 so_no 필요' });

    const item = await prisma.item.findUnique({ where: { id: itemId }, select: { item_code: true, name: true } });
    if (!item) return res.status(404).json({ error: '품목을 찾을 수 없습니다.' });

    let changed = 0;
    let scannedSoNos: string[] = [];

    await prisma.$transaction(async (tx) => {
      // 대상 allocation — lot 없는 것 전부 (미상 ₩0 + 기존 추정단가 모두 포함, 재계산 대상)
      const where = fillAll
        ? `si.item_id = ? AND a.inventory_lot_id IS NULL
           AND so.deleted_at IS NULL AND so.is_test = 0${fromDate ? ' AND so.issued_at >= ?' : ''}`
        : `si.item_id = ? AND a.inventory_lot_id IS NULL AND so.so_no = ?
           AND so.deleted_at IS NULL AND so.is_test = 0`;
      const params = fillAll
        ? (fromDate ? [itemId, fromDate] : [itemId])
        : [itemId, soNo];
      const allocs: any[] = await (tx as any).$queryRawUnsafe(
        `SELECT a.id, a.issued_qty, so.so_no
         FROM stock_out_lot_allocations a
         JOIN stock_out so ON so.id = a.stock_out_id
         JOIN stock_out_items si ON si.id = a.stock_out_item_id
         WHERE ${where}`,
        ...params,
      );
      if (!allocs.length) return;
      for (const a of allocs) {
        const q = Number(a.issued_qty || 0);
        const amt = Number((q * newCost).toFixed(2));
        await (tx as any).$executeRawUnsafe(
          `UPDATE stock_out_lot_allocations SET unit_cost = ?, line_amount = ? WHERE id = ?`,
          newCost, amt, String(a.id),
        );
        changed += 1;
      }
      scannedSoNos = [...new Set(allocs.map((a) => String(a.so_no)))];
    }, { timeout: 30000, maxWait: 10000 });

    await audit({
      actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'stock_out_lot_allocations', entity_id: itemId,
      reason: `추정단가 수동 보정 — ${item.item_code} ${item.name} @ ${newCost.toLocaleString()}원, ${changed}건${fillAll ? (fromDate ? ` (품목 전체, ${fromDateRaw} 이후)` : ' (품목 전체)') : ` (${soNo})`}`,
    });
    res.json({
      message: changed > 0
        ? `${changed}건 보정 완료 (${item.item_code} ${item.name} @ ${newCost.toLocaleString()}원)`
        : '대상 출고가 없습니다.',
      filled: changed, so_nos: scannedSoNos,
    });
  } catch (e) {
    console.error('[cost-reconcile/fill-missing-cost] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;
