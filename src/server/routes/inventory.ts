import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, resolveDeptScope, isCustomMenuUser, AuthRequest } from '../middleware/auth';
import { expandPermissions } from '../../shared/permissions';
import { audit, generateNo, nextSeq } from '../utils/audit';
import { ensureFifoTables } from '../utils/fifo';

// 묶음권한(PURCHASE_MANAGE) 또는 SYSTEM_ADMIN 보유자는 모든 부서 위치 조회 가능.
// raw .includes() 만으로는 5개 하위권한 묶음으로 인정되는 사용자를 놓치므로 expandPermissions 사용.
function canViewAllLocations(req: AuthRequest): boolean {
  const perms = req.user?.permissions ?? [];
  const expanded = expandPermissions(perms);
  return expanded.has('SYSTEM_ADMIN') || expanded.has('PURCHASE_MANAGE');
}

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('inventory', 'PURCHASE_MANAGE', 'REQUEST_USE'));

router.get('/', requirePermission('PURCHASE_MANAGE', 'REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const { location_id, category, search } = req.query;
    const locationIdStr = location_id ? String(location_id) : null;

    // 정책: location_id 가 주어지면 → 모든 활성 items 를 기준으로 그 위치의 inventory 를 left-join.
    //       inventory 가 없는 품목도 qty=0 으로 표시 (사용자 — "모든 품목이 있어야").
    //       location_id 가 없으면 기존 방식 (inventory 행 기준 — 한 품목이 여러 위치에 있으면 여러 행).
    if (locationIdStr) {
      const location = await prisma.inventoryLocation.findUnique({
        where: { id: locationIdStr },
        select: { id: true, code: true, name: true, is_asset_tracked: true } as any,
      });
      if (!location) return res.json([]);

      const items = await prisma.item.findMany({
        where: {
          is_active: true,
          deleted_at: null,
          ...(category && { category: String(category) }),
          ...(search && { name: { contains: String(search) } }),
        },
        include: {
          default_vendor: true,
          price_history: { orderBy: { effective_from: 'desc' }, take: 1 },
        },
        orderBy: [{ category: 'asc' }, { item_code: 'asc' }],
      });

      const itemIds = items.map(i => i.id);
      const invs = await prisma.inventory.findMany({
        where: { item_id: { in: itemIds }, location_id: locationIdStr },
      });
      const invByItem = new Map(invs.map(i => [i.item_id, i]));

      // 외부 거래 최근 단가 (price_history 가 없는 품목용 fallback)
      let extPriceByItem = new Map<string, number>();
      if (itemIds.length > 0) {
        const extPriceRows = await (prisma as any).$queryRawUnsafe(`
          SELECT item_id, unit_price FROM (
            SELECT e.item_id, e.unit_price,
                   ROW_NUMBER() OVER (PARTITION BY e.item_id ORDER BY e.transaction_date DESC, e.id DESC) AS rn
            FROM external_purchase_records e
            WHERE e.item_id IN (${itemIds.map(() => '?').join(',')})
          ) WHERE rn = 1
        `, ...itemIds) as any[];
        extPriceByItem = new Map(extPriceRows.map(r => [r.item_id, Number(r.unit_price)]));
      }

      const result = items.map((item: any) => {
        const inv = invByItem.get(item.id);
        const onHand = inv ? Number(inv.on_hand_qty) : 0;
        const sysAvgCost = inv ? Number(inv.avg_unit_cost) : 0;
        const phPrice = item.price_history?.[0] ? Number(item.price_history[0].price) : 0;
        const extPrice = extPriceByItem.get(item.id) ?? 0;
        // 단가 fallback: 시스템 평균 → PriceHistory 최근 → 외부 거래 최근 → 0
        const avgCost = sysAvgCost > 0 ? sysAvgCost : (phPrice > 0 ? phPrice : extPrice);
        const latestPrice = phPrice > 0 ? phPrice : (extPrice > 0 ? extPrice : avgCost);
        const isLowStock = onHand <= item.reorder_days_threshold;
        const isAssetTracked = !!(location as any).is_asset_tracked;
        return {
          id: inv?.id ?? `placeholder-${item.id}-${locationIdStr}`,
          item_id: item.id,
          item_code: item.item_code,
          item_name: item.name,
          category: item.category,
          uom: item.uom,
          purchase_uom: item.purchase_uom ?? item.uom,
          issue_uom: item.issue_uom ?? item.uom,
          pack_size: item.pack_size ?? 1,
          location_id: location.id,
          location_code: location.code,
          location_name: location.name,
          location_is_asset_tracked: isAssetTracked,
          on_hand_qty: onHand,
          avg_unit_cost: avgCost,
          avg_unit_cost_source: sysAvgCost > 0 ? 'system' : (phPrice > 0 ? 'price_history' : (extPrice > 0 ? 'external' : 'none')),
          latest_price: latestPrice,
          total_value: isAssetTracked ? onHand * sysAvgCost : 0,  // 자산금액은 시스템 단가 기준 (fallback X)
          updated_at: inv?.updated_at ?? null,
          is_low_stock: isLowStock,
          default_vendor_name: item.default_vendor?.name ?? '',
        };
      });
      return res.json(result);
    }

    // 위치 필터 없는 경우 — 기존 방식 (권한 범위 부서 한정)
    const scope = resolveDeptScope(req);
    const isRestricted = !canViewAllLocations(req);
    const deptId = scope.department_id;

    const inv = await prisma.inventory.findMany({
      where: {
        ...(isRestricted && deptId ? { location: { department_id: deptId } } : {}),
        item: {
          is_active: true,
          deleted_at: null,
          ...(category && { category: String(category) }),
          ...(search && { name: { contains: String(search) } }),
        },
      },
      include: {
        item: {
          include: {
            default_vendor: true,
            price_history: { orderBy: { effective_from: 'desc' }, take: 1 },
          },
        },
        location: true,
      },
      orderBy: [{ item: { category: 'asc' } }, { item: { item_code: 'asc' } }],
    });

    const result = inv.map((i: any) => {
      const onHand = Number(i.on_hand_qty);
      const avgCost = Number(i.avg_unit_cost);
      const latestPrice = i.item.price_history?.[0] ? Number(i.item.price_history[0].price) : avgCost;
      const isLowStock = onHand <= i.item.reorder_days_threshold;

      return {
        id: i.id,
        item_id: i.item_id,
        item_code: i.item.item_code,
        item_name: i.item.name,
        category: i.item.category,
        uom: i.item.uom,
        purchase_uom: (i.item as any).purchase_uom ?? i.item.uom,
        issue_uom: (i.item as any).issue_uom ?? i.item.uom,
        pack_size: i.item.pack_size ?? 1,
        location_id: i.location_id,
        location_code: i.location.code,
        location_name: i.location.name,
        location_is_asset_tracked: !!(i.location as any).is_asset_tracked,
        on_hand_qty: onHand,
        avg_unit_cost: avgCost,
        latest_price: latestPrice,
        total_value: (i.location as any).is_asset_tracked ? (onHand * avgCost) : 0,
        updated_at: i.updated_at,
        is_low_stock: isLowStock,
        default_vendor_name: i.item.default_vendor?.name ?? '',
      };
    });

    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 부서 보유 재고 스냅샷 — `{ stocks: { item_id: qty } }` 형태.
// (이전 /usage/stock-snapshot 의 대체 — 사용 등록 폐지 후 동일한 데이터를 inventory 라우트로 옮김)
router.get('/snapshot', requirePermission('PURCHASE_MANAGE', 'REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const scope = resolveDeptScope(req);
    const queryDeptId = String(req.query.department_id ?? '').trim();
    const targetDeptId = queryDeptId || scope.department_id || '';
    if (!targetDeptId) {
      return res.json({ stocks: {} });
    }
    const inv = await prisma.inventory.findMany({
      where: { location: { department_id: targetDeptId, deleted_at: null, is_active: true } },
      select: { item_id: true, on_hand_qty: true },
    });
    const stocks: Record<string, number> = {};
    for (const r of inv) {
      stocks[r.item_id] = (stocks[r.item_id] ?? 0) + Number(r.on_hand_qty);
    }
    res.json({ stocks });
  } catch (e) {
    console.error('[GET /inventory/snapshot] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/low-stock', requirePermission('PURCHASE_MANAGE', 'REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const scope = resolveDeptScope(req);
    const isRestricted = !canViewAllLocations(req);
    const deptId = scope.department_id;

    const inv = await prisma.inventory.findMany({
      where: isRestricted && deptId ? { location: { department_id: deptId } } : undefined,
      include: {
        item: { include: { default_vendor: true } },
        location: true,
      },
    });

    const lowStock = inv.filter((i: any) => Number(i.on_hand_qty) <= i.item.reorder_days_threshold);
    res.json(
      lowStock.map((i: any) => ({
        item_id: i.item_id,
        item_code: i.item.item_code,
        item_name: i.item.name,
        uom: i.item.uom,
        purchase_uom: (i.item as any).purchase_uom ?? i.item.uom,
        issue_uom: (i.item as any).issue_uom ?? i.item.uom,
        pack_size: i.item.pack_size ?? 1,
        location_name: i.location.name,
        on_hand_qty: Number(i.on_hand_qty),
        threshold: i.item.reorder_days_threshold,
        vendor_name: i.item.default_vendor?.name ?? '',
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 특정 (item, location)의 FIFO lot 상세 — 실사 모달에서 lot 별 잔량 참고 표시용
router.get('/lots-detail', requirePermission('PURCHASE_MANAGE', 'REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const itemId = String(req.query.item_id ?? '').trim();
    const locationId = String(req.query.location_id ?? '').trim();
    if (!itemId || !locationId) return res.status(400).json({ error: 'item_id, location_id 필수' });

    const rows = await (prisma as any).$queryRawUnsafe(`
      SELECT l.id, l.received_at, l.unit_cost, l.received_qty, l.remaining_qty, l.sort_order,
             v.name AS vendor_name, gr.gr_no
      FROM inventory_lots l
      LEFT JOIN vendors v ON v.id = l.vendor_id
      LEFT JOIN goods_receipts gr ON gr.id = l.goods_receipt_id
      WHERE l.deleted_at IS NULL
        AND l.item_id = ?
        AND l.location_id = ?
        AND l.remaining_qty > 0
      ORDER BY (CASE WHEN l.sort_order > 0 THEN l.sort_order ELSE 999999 END) ASC,
               datetime(l.received_at) ASC
    `, itemId, locationId);

    const lots = (rows as any[]).map(r => ({
      id: r.id,
      received_at: r.received_at,
      unit_cost: Number(r.unit_cost),
      received_qty: Number(r.received_qty),
      remaining_qty: Number(r.remaining_qty),
      sort_order: Number(r.sort_order ?? 0),
      vendor_name: r.vendor_name ?? '',
      gr_no: r.gr_no ?? '',
    }));

    // 단가 변동 이력 (참고용) — 외부 거래원장 + 시스템 PO 통합
    // 같은 (vendor, unit_price) 묶음으로 기간/거래량 표시. 시스템 PO 도 함께 보여
    // 사용자가 이번에 발주한 단가와 옛 단가 추이를 한 화면에서 비교 가능.
    const histRows = await (prisma as any).$queryRawUnsafe(`
      SELECT first_date, last_date, unit_price, vendor_name, total_qty, occurrences, source FROM (
        -- 외부 거래원장/매출내역
        SELECT date(MIN(e.transaction_date)) AS first_date,
               date(MAX(e.transaction_date)) AS last_date,
               e.unit_price, v.name AS vendor_name,
               SUM(e.qty) AS total_qty, COUNT(*) AS occurrences,
               'external' AS source,
               MIN(e.transaction_date) AS sort_key
        FROM external_purchase_records e
        LEFT JOIN vendors v ON v.id = e.vendor_id
        WHERE e.item_id = ?
        GROUP BY e.unit_price, e.vendor_id, v.name

        UNION ALL

        -- 시스템 PO 입고 (purchase_orders)
        SELECT date(MIN(po.ordered_at)) AS first_date,
               date(MAX(po.ordered_at)) AS last_date,
               poi.unit_price, v.name AS vendor_name,
               SUM(poi.ordered_qty) AS total_qty, COUNT(*) AS occurrences,
               'system_po' AS source,
               MIN(po.ordered_at) AS sort_key
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.purchase_order_id
        LEFT JOIN vendors v ON v.id = po.vendor_id
        WHERE poi.item_id = ? AND po.deleted_at IS NULL
        GROUP BY poi.unit_price, po.vendor_id, v.name
      )
      ORDER BY sort_key ASC
    `, itemId, itemId);

    const historical = (histRows as any[]).map(r => ({
      first_date: r.first_date,
      last_date: r.last_date,
      unit_cost: Number(r.unit_price),
      total_qty: Number(r.total_qty),
      vendor_name: r.vendor_name ?? '',
      occurrences: Number(r.occurrences),
      source: r.source,  // 'external' | 'system_po'
    }));

    const total_qty = lots.reduce((s, l) => s + l.remaining_qty, 0);
    const total_value = lots.reduce((s, l) => s + l.remaining_qty * l.unit_cost, 0);
    const weighted_avg_cost = total_qty > 0 ? total_value / total_qty : 0;
    const distinct_prices = [...new Set(lots.map(l => l.unit_cost))];

    res.json({
      lots,
      historical,  // 외부 거래원장/매출내역의 단가 변동 시점 (참고용)
      summary: {
        lot_count: lots.length,
        total_qty,
        total_value,
        weighted_avg_cost,
        distinct_price_count: distinct_prices.length,
        distinct_prices,
        historical_price_count: new Set(historical.map(h => h.unit_cost)).size,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/locations', async (req: AuthRequest, res) => {
  try {
    const scope = resolveDeptScope(req);
    const isRestricted = !canViewAllLocations(req);
    const deptId = scope.department_id;

    const locs = await prisma.inventoryLocation.findMany({
      where: {
        deleted_at: null,
        is_active: true,
        ...(isRestricted && deptId ? { department_id: deptId } : {}),
      },
      include: { department: true },
      orderBy: { code: 'asc' },
    });

    res.json(
      locs.map((l) => ({
        id: l.id,
        code: l.code,
        name: l.name,
        department_id: l.department_id,
        department_name: (l as any).department?.name ?? null,
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/locations', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { code, name, department_id } = req.body;
  if (!code || !name) return res.status(400).json({ error: '코드와 이름은 필수입니다.' });

  if (isCustomMenuUser(req.user) && !req.user?.permissions.includes('SYSTEM_ADMIN')) {
    return res.status(403).json({ error: '관리자만 재고 위치를 생성할 수 있습니다.' });
  }

  try {
    const loc = await prisma.inventoryLocation.create({
      data: { id: uuidv4(), code, name, department_id: department_id || null },
    });
    res.status(201).json(loc);
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 위치 코드입니다.' });
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /inventory/adjust — 실사(stocktake) 결과로 재고 수량을 보정.
//
// 요청 body:
//   item_id            : string (필수)
//   location_id        : string (필수)
//   actual_qty         : number (필수, 0 이상)
//   reason             : string (필수) — 분실/파손/오기재 등 사유
//   new_lot_unit_cost  : number (옵션) — 실제재고 > 시스템재고 일 때 새로 생성할 lot 의 단가
//                                       미입력 시 현재 inventory.avg_unit_cost 사용
//
// 처리:
//   diff = actual_qty - on_hand_qty
//   diff < 0 (시스템보다 적음 = 분실/파손): 오래된 lot 부터 FIFO 로 remaining_qty 차감
//   diff > 0 (시스템보다 많음 = 누락된 입고): 새 lot 생성 (received_at = now)
//   diff == 0: no-op (사유만 audit 에 기록)
//   inventory.on_hand_qty, avg_unit_cost 재계산.
// ─────────────────────────────────────────────────────────────────────
router.post('/adjust', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { item_id, location_id, actual_qty, reason, new_lot_unit_cost } = req.body || {};
  if (!item_id || !location_id) return res.status(400).json({ error: 'item_id, location_id 필수' });
  const actualQty = Number(actual_qty);
  if (!Number.isFinite(actualQty) || actualQty < 0) return res.status(400).json({ error: '실제 수량은 0 이상의 숫자여야 합니다.' });
  const reasonText = String(reason ?? '').trim();
  if (!reasonText) return res.status(400).json({ error: '실사 사유는 필수입니다.' });

  try {
    await ensureFifoTables(prisma as any);

    const inv = await prisma.inventory.findUnique({
      where: { item_id_location_id: { item_id, location_id } },
    });
    const currentQty = Number(inv?.on_hand_qty ?? 0);
    const currentAvgCost = Number(inv?.avg_unit_cost ?? 0);
    const diff = actualQty - currentQty;

    if (diff === 0) {
      await audit({
        actor_user_id: req.user!.id,
        action: 'ADJUST',
        entity_type: 'inventory',
        entity_id: `${item_id}::${location_id}`,
        before: { on_hand_qty: currentQty },
        after: { on_hand_qty: actualQty },
        reason: `실사 일치: ${reasonText}`,
      });
      return res.json({ ok: true, diff: 0, on_hand_qty: actualQty });
    }

    const result = await prisma.$transaction(async (tx) => {
      await ensureFifoTables(tx as any);

      if (diff < 0) {
        // 시스템 재고가 실제보다 많음 → FIFO 로 부족분 차감
        let need = -diff;
        const lots = await (tx as any).$queryRawUnsafe(
          `SELECT id, remaining_qty, unit_cost FROM inventory_lots
           WHERE deleted_at IS NULL AND item_id = ? AND location_id = ? AND remaining_qty > 0
           ORDER BY datetime(received_at) ASC, id ASC`,
          item_id, location_id,
        ) as any[];
        for (const lot of lots) {
          if (need <= 0) break;
          const take = Math.min(need, Number(lot.remaining_qty));
          await (tx as any).$executeRawUnsafe(
            `UPDATE inventory_lots SET remaining_qty = remaining_qty - ? WHERE id = ?`,
            take, lot.id,
          );
          need -= take;
        }
        // 잔여 lot 합계가 부족분만큼 안 빠지면 (lot 합계 < 시스템재고 인 비정합 상황) 그래도 진행
      } else {
        // 시스템 재고가 실제보다 적음 → 새 lot 생성 (received_at = now)
        const cost = Number(new_lot_unit_cost ?? currentAvgCost) || 0;
        await (tx as any).$executeRawUnsafe(
          `INSERT INTO inventory_lots
             (id, stock_in_item_id, goods_receipt_id, item_id, location_id, vendor_id, received_at, unit_cost, received_qty, remaining_qty, created_at)
           VALUES (?, '', '', ?, ?, NULL, datetime('now'), ?, ?, ?, datetime('now'))`,
          uuidv4(), item_id, location_id, cost, diff, diff,
        );
      }

      // inventory 재계산 — lot 합계로 동기화 (sum, weighted avg)
      const rows = await (tx as any).$queryRawUnsafe(
        `SELECT COALESCE(SUM(remaining_qty), 0) AS qty,
                CASE WHEN SUM(remaining_qty) > 0
                     THEN SUM(remaining_qty * unit_cost) / SUM(remaining_qty)
                     ELSE 0
                END AS avg_cost
         FROM inventory_lots WHERE deleted_at IS NULL AND item_id = ? AND location_id = ?`,
        item_id, location_id,
      ) as any[];
      const newQty = Number(rows[0]?.qty ?? 0);
      const newAvgCost = Number(Number(rows[0]?.avg_cost ?? 0).toFixed(4));

      await tx.inventory.upsert({
        where: { item_id_location_id: { item_id, location_id } },
        update: { on_hand_qty: newQty, avg_unit_cost: newAvgCost },
        create: { id: uuidv4(), item_id, location_id, on_hand_qty: newQty, avg_unit_cost: newAvgCost },
      });

      return { newQty, newAvgCost };
    }, { timeout: 30000, maxWait: 10000 });

    await audit({
      actor_user_id: req.user!.id,
      action: 'ADJUST',
      entity_type: 'inventory',
      entity_id: `${item_id}::${location_id}`,
      before: { on_hand_qty: currentQty, avg_unit_cost: currentAvgCost },
      after: { on_hand_qty: result.newQty, avg_unit_cost: result.newAvgCost, diff },
      reason: `실사 보정: ${reasonText}`,
    });

    res.json({ ok: true, diff, on_hand_qty: result.newQty, avg_unit_cost: result.newAvgCost });
  } catch (e: any) {
    console.error('[POST /inventory/adjust] error:', e);
    res.status(500).json({ error: e?.message ?? '서버 오류' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /inventory/adjust-by-lot — 단가별(lot별) 실재고 등록.
//
// 사용 시나리오:
//   초기 실사 등록 시 사용자가 같은 품목이라도 단가가 다른 묶음을 분리해서 입력.
//   기존 lot 은 잔량/단가 조정, 단가가 새로운 묶음은 신규 lot 생성.
//
// 요청 body:
//   item_id, location_id, reason (필수)
//   lot_adjustments: [
//     { lot_id, actual_qty, unit_cost? }   - 기존 lot 잔량 조정 (옵션 단가 수정)
//     { lot_id: null, actual_qty, unit_cost, vendor_id? }  - 신규 lot 등록
//   ]
//
// 처리:
//   1. 기존 lot: remaining_qty 와 (옵션) unit_cost 갱신
//   2. 신규 lot: 임시 GoodsReceipt/StockInItem 자동 생성 → InventoryLot 등록
//   3. inventory.on_hand_qty / avg_unit_cost 재계산 (lot 가중평균)
//   4. audit_log 각 변경 기록
// ─────────────────────────────────────────────────────────────────────
router.post('/adjust-by-lot', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { item_id, location_id, reason, lot_adjustments } = req.body || {};
  if (!item_id || !location_id) return res.status(400).json({ error: 'item_id, location_id 필수' });
  const reasonText = String(reason ?? '').trim() || '실사 등록';
  // 초기재고 등록 여부 — true: 보유재고 등록(구매 아님, 통계 제외), false: 실제 실사 입고(구매 포함)
  const isBase = req.body?.is_base !== false; // 기본 true
  if (!Array.isArray(lot_adjustments) || lot_adjustments.length === 0) {
    return res.status(400).json({ error: 'lot_adjustments 1개 이상 필요' });
  }

  // 입력 검증
  for (const a of lot_adjustments) {
    const q = Number(a.actual_qty);
    if (!Number.isFinite(q) || q < 0) return res.status(400).json({ error: '수량은 0 이상의 숫자여야 합니다.' });
    if (!a.lot_id) {
      const c = Number(a.unit_cost);
      if (!Number.isFinite(c) || c < 0) return res.status(400).json({ error: '신규 lot 의 단가는 0 이상의 숫자여야 합니다.' });
    }
  }

  try {
    await ensureFifoTables(prisma as any);
    let stocktakeGrId: string | null = null;

    const result = await prisma.$transaction(async (tx) => {
      // === 1. 기존 lot 조정 ===
      for (const adj of lot_adjustments.filter((a: any) => a.lot_id)) {
        const before = await tx.inventoryLot.findUnique({ where: { id: adj.lot_id } });
        if (!before || before.item_id !== item_id || before.location_id !== location_id) continue;
        const beforeQty = Number(before.remaining_qty);
        const beforeCost = Number(before.unit_cost);
        const beforeSort = Number((before as any).sort_order ?? 0);
        const newQty = Number(adj.actual_qty);
        const newCost = (adj.unit_cost !== undefined && adj.unit_cost !== null && Number(adj.unit_cost) > 0)
          ? Number(adj.unit_cost) : beforeCost;
        // sort_order: 명시 값이 들어왔으면 그대로 저장. 0 또는 미입력은 자동(FIFO)으로 둠.
        const newSort = adj.sort_order !== undefined && adj.sort_order !== null
          ? Math.max(0, Math.floor(Number(adj.sort_order) || 0))
          : beforeSort;

        await tx.inventoryLot.update({
          where: { id: adj.lot_id },
          data: { remaining_qty: newQty, unit_cost: newCost, sort_order: newSort } as any,
        });

        await audit({
          actor_user_id: req.user!.id,
          action: 'STOCKTAKE_LOT_ADJUST',
          entity_type: 'inventory_lots',
          entity_id: adj.lot_id,
          before: { remaining_qty: beforeQty, unit_cost: beforeCost, sort_order: beforeSort },
          after: { remaining_qty: newQty, unit_cost: newCost, sort_order: newSort },
          reason: reasonText,
        });
      }

      // === 2. 신규 lot 등록 — 임시 GR/SII 자동 생성 ===
      const newAdjs = lot_adjustments.filter((a: any) => !a.lot_id);
      if (newAdjs.length > 0) {
        const seq = await nextSeq('goods_receipts');
        const gr_no = generateNo('GR', seq);
        const gr = await tx.goodsReceipt.create({
          data: {
            id: uuidv4(),
            gr_no,
            purchase_order_id: null,
            received_by: req.user!.id,
            status: 'CONFIRMED',
            note: isBase ? `[기초재고] 실사등록 ${reasonText}` : `[실사 입고] ${reasonText}`,
          } as any,
        });
        stocktakeGrId = gr.id;

        for (const adj of newAdjs) {
          const sii_id = uuidv4();
          const qty = Number(adj.actual_qty);
          const cost = Number(adj.unit_cost);
          await tx.stockInItem.create({
            data: {
              id: sii_id,
              goods_receipt_id: gr.id,
              item_id,
              expected_qty: qty,
              received_qty: qty,
              confirmed_qty: qty,
              diff_qty: 0,
              unit_price: cost,
              location_id,
              confirmed_at: new Date(),
            } as any,
          });

          const lot_id = uuidv4();
          // 입고일: 입력값(YYYY-MM-DD 등) 있으면 사용, 없으면 현재시각
          const recvParsed = adj.received_at ? new Date(adj.received_at) : null;
          const recvAt = (recvParsed && !Number.isNaN(recvParsed.getTime()))
            ? recvParsed.toISOString() : new Date().toISOString();
          const newSort = adj.sort_order !== undefined && adj.sort_order !== null
            ? Math.max(0, Math.floor(Number(adj.sort_order) || 0)) : 0;
          await (tx as any).$executeRawUnsafe(`
            INSERT INTO inventory_lots
              (id, stock_in_item_id, goods_receipt_id, item_id, location_id, vendor_id, received_at, unit_cost, received_qty, remaining_qty, sort_order, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `, lot_id, sii_id, gr.id, item_id, location_id, adj.vendor_id || null, recvAt, cost, qty, qty, newSort);

          await audit({
            actor_user_id: req.user!.id,
            action: 'STOCKTAKE_NEW_LOT',
            entity_type: 'inventory_lots',
            entity_id: lot_id,
            before: {},
            after: { item_id, location_id, unit_cost: cost, received_qty: qty },
            reason: reasonText,
          });
        }
      }

      // === 3. inventory 재계산 ===
      const sumRows = await (tx as any).$queryRawUnsafe(`
        SELECT COALESCE(SUM(remaining_qty), 0) AS qty,
               CASE WHEN SUM(remaining_qty) > 0
                    THEN SUM(remaining_qty * unit_cost) / SUM(remaining_qty)
                    ELSE 0 END AS avg_cost
        FROM inventory_lots WHERE deleted_at IS NULL AND item_id = ? AND location_id = ?
      `, item_id, location_id) as any[];
      const newQty = Number(sumRows[0]?.qty ?? 0);
      const newAvg = Number(Number(sumRows[0]?.avg_cost ?? 0).toFixed(4));

      await tx.inventory.upsert({
        where: { item_id_location_id: { item_id, location_id } },
        update: { on_hand_qty: newQty, avg_unit_cost: newAvg } as any,
        create: { id: uuidv4(), item_id, location_id, on_hand_qty: newQty, avg_unit_cost: newAvg } as any,
      });

      return { newQty, newAvg };
    }, { timeout: 30000, maxWait: 10000 });

    res.json({ ok: true, on_hand_qty: result.newQty, avg_unit_cost: result.newAvg, stocktake_gr_id: stocktakeGrId });
  } catch (e: any) {
    console.error('[POST /inventory/adjust-by-lot] error:', e);
    res.status(500).json({ error: e?.message ?? '서버 오류' });
  }
});

export default router;



