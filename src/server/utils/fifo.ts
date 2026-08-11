import { v4 as uuidv4 } from 'uuid';

type DbClient = {
  $executeRawUnsafe: (sql: string, ...values: any[]) => Promise<any>;
  $queryRawUnsafe: (sql: string, ...values: any[]) => Promise<any[]>;
};

export async function ensureFifoTables(db: DbClient) {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS inventory_lots (
      id TEXT PRIMARY KEY,
      stock_in_item_id TEXT NOT NULL,
      goods_receipt_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      vendor_id TEXT,
      received_at TEXT NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      received_qty REAL NOT NULL DEFAULT 0,
      remaining_qty REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    )
  `);
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_lots_stock_in_item_id ON inventory_lots(stock_in_item_id)`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_inventory_lots_item_loc_recv ON inventory_lots(item_id, location_id, received_at)`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_inventory_lots_vendor ON inventory_lots(vendor_id)`);

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS stock_out_lot_allocations (
      id TEXT PRIMARY KEY,
      stock_out_item_id TEXT NOT NULL,
      stock_out_id TEXT NOT NULL,
      inventory_lot_id TEXT,
      issued_qty REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      line_amount REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_alloc_stock_out_item ON stock_out_lot_allocations(stock_out_item_id)`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_alloc_stock_out ON stock_out_lot_allocations(stock_out_id)`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_alloc_lot ON stock_out_lot_allocations(inventory_lot_id)`);
}

export async function createInventoryLot(
  db: DbClient,
  params: {
    stockInItemId: string;
    goodsReceiptId: string;
    itemId: string;
    locationId: string;
    vendorId?: string | null;
    receivedAt: Date | string;
    unitCost: number;
    receivedQty: number;
  },
) {
  const lotId = uuidv4();
  const dt = typeof params.receivedAt === 'string' ? params.receivedAt : params.receivedAt.toISOString();
  const unitCost = Number(params.unitCost) || 0;
  const receivedQty = Number(params.receivedQty) || 0;
  await db.$executeRawUnsafe(
    `INSERT INTO inventory_lots
      (id, stock_in_item_id, goods_receipt_id, item_id, location_id, vendor_id, received_at, unit_cost, received_qty, remaining_qty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    lotId, params.stockInItemId, params.goodsReceiptId, params.itemId, params.locationId,
    params.vendorId ?? null, dt, unitCost, receivedQty, receivedQty,
  );
  return lotId;
}

export async function getAvailableLotQty(db: DbClient, itemId: string, locationId: string) {
  const rows = await db.$queryRawUnsafe(
    `SELECT COALESCE(SUM(remaining_qty), 0) AS qty
    FROM inventory_lots
    WHERE deleted_at IS NULL AND item_id = ? AND location_id = ? AND remaining_qty > 0`,
    itemId, locationId,
  );
  return Number((rows?.[0] as any)?.qty ?? 0);
}

export async function allocateFifo(
  db: DbClient,
  params: {
    stockOutId: string;
    stockOutItemId: string;
    itemId: string;
    locationId: string;
    issueQty: number;
  },
) {
  let remain = Number(params.issueQty) || 0;
  // 사용자 지정 우선순위(sort_order > 0) 먼저 적용, 그 외는 received_at 오름차순(기본 FIFO).
  // sort_order = 0 (기본) 인 lot 들은 큰 값으로 fallback 시켜 명시 우선순위 lot 들 뒤에 가게 함.
  const lots = await db.$queryRawUnsafe(
    `SELECT id, remaining_qty, unit_cost
    FROM inventory_lots
    WHERE deleted_at IS NULL AND item_id = ? AND location_id = ? AND remaining_qty > 0
    ORDER BY (CASE WHEN sort_order > 0 THEN sort_order ELSE 999999 END) ASC,
             datetime(received_at) ASC, id ASC`,
    params.itemId, params.locationId,
  );
  for (const lot of lots) {
    if (remain <= 0) break;
    const available = Number((lot as any).remaining_qty || 0);
    if (available <= 0) continue;
    const take = Math.min(available, remain);
    const unitCost = Number((lot as any).unit_cost || 0);
    const lineAmount = Number((take * unitCost).toFixed(2));
    const newRemaining = Number((available - take).toFixed(6));
    const lotId = String((lot as any).id);

    await db.$executeRawUnsafe(
      `UPDATE inventory_lots SET remaining_qty = ? WHERE id = ?`,
      newRemaining, lotId,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO stock_out_lot_allocations
        (id, stock_out_item_id, stock_out_id, inventory_lot_id, issued_qty, unit_cost, line_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      uuidv4(), params.stockOutItemId, params.stockOutId, lotId, take, unitCost, lineAmount,
    );
    remain = Number((remain - take).toFixed(6));
  }
  if (remain > 0) {
    // 음수 재고 허용: 가용 LOT 부족분은 inventory_lot_id=NULL 로 기록.
    // 단가는 fallback (lot 평균 → inventory.avg_unit_cost → PriceHistory PO ÷ pack_size) 적용.
    // 0원으로 두면 부서별 비용 통계가 왜곡되므로 합리적 단가를 추정해 line_amount 채움.
    const fallbackCost = await resolveFallbackUnitCost(db, params.itemId);
    const lineAmount = Number((remain * fallbackCost).toFixed(2));
    await db.$executeRawUnsafe(
      `INSERT INTO stock_out_lot_allocations
        (id, stock_out_item_id, stock_out_id, inventory_lot_id, issued_qty, unit_cost, line_amount)
      VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      uuidv4(), params.stockOutItemId, params.stockOutId, remain, fallbackCost, lineAmount,
    );
  }
}

// Unallocated 라인의 ea 단위 fallback 단가 결정.
// 우선순위: 1) 같은 품목의 모든 lot 가중평균 unit_cost (deleted 제외, remaining > 0)
//          2) 같은 품목의 inventory.avg_unit_cost 최댓값 (위치 무관)
//          3) PriceHistory PO source 최근 단가 ÷ items.pack_size
//          4) 0
export async function resolveFallbackUnitCost(db: DbClient, itemId: string): Promise<number> {
  // 1) lot 가중평균
  const lotRows = await db.$queryRawUnsafe(
    `SELECT CASE WHEN SUM(remaining_qty) > 0
                 THEN SUM(remaining_qty * unit_cost) / SUM(remaining_qty)
                 ELSE NULL END AS cost
     FROM inventory_lots
     WHERE deleted_at IS NULL AND item_id = ? AND remaining_qty > 0 AND unit_cost > 0`,
    itemId,
  ) as Array<{ cost: number | null }>;
  const lotCost = Number(lotRows?.[0]?.cost ?? 0);
  if (lotCost > 0) return lotCost;

  // 2) inventory.avg_unit_cost 최댓값
  const invRows = await db.$queryRawUnsafe(
    `SELECT MAX(avg_unit_cost) AS cost
     FROM inventory WHERE item_id = ? AND avg_unit_cost > 0`,
    itemId,
  ) as Array<{ cost: number | null }>;
  const invCost = Number(invRows?.[0]?.cost ?? 0);
  if (invCost > 0) return invCost;

  // 3) PriceHistory PO ÷ pack_size
  const phRows = await db.$queryRawUnsafe(
    `SELECT ph.price AS price, i.pack_size AS pack_size
     FROM price_history ph
     JOIN items i ON i.id = ph.item_id
     WHERE ph.item_id = ? AND ph.source = 'PO'
     ORDER BY ph.effective_from DESC LIMIT 1`,
    itemId,
  ) as Array<{ price: number | null; pack_size: number | null }>;
  const phPrice = Number(phRows?.[0]?.price ?? 0);
  const ps = Math.max(1, Number(phRows?.[0]?.pack_size ?? 1));
  if (phPrice > 0) return phPrice / ps;

  return 0;
}

export async function reverseAllocationsByStockOut(db: DbClient, stockOutId: string) {
  const rows = await db.$queryRawUnsafe(
    `SELECT inventory_lot_id, issued_qty
    FROM stock_out_lot_allocations
    WHERE stock_out_id = ?
    ORDER BY created_at DESC`,
    stockOutId,
  );
  for (const r of rows) {
    const lotId = (r as any).inventory_lot_id;
    if (!lotId) continue;
    const issuedQty = Number((r as any).issued_qty || 0);
    await db.$executeRawUnsafe(
      `UPDATE inventory_lots SET remaining_qty = remaining_qty + ? WHERE id = ?`,
      issuedQty, String(lotId),
    );
  }
}

export async function checkReceiptLotsReversible(db: DbClient, stockInItemIds: string[]) {
  if (!stockInItemIds.length) return { ok: true, blocked: [] as any[] };
  const placeholders = stockInItemIds.map(() => '?').join(',');
  const rows = await db.$queryRawUnsafe(
    `SELECT stock_in_item_id, received_qty, remaining_qty
    FROM inventory_lots
    WHERE stock_in_item_id IN (${placeholders})
      AND deleted_at IS NULL`,
    ...stockInItemIds,
  );
  const blocked = rows.filter((r: any) => Number(r.remaining_qty) < Number(r.received_qty));
  return { ok: blocked.length === 0, blocked };
}
