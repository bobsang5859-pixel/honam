/**
 * 일회성 마이그레이션: stock_in_items 의 unit_price 가 ea 단위로 잘못 입력되어
 * 검수 확정 시 한 번 더 환산되어 lot.unit_cost 가 1/pack_size 로 저장된 데이터를 보정.
 *
 * 정정 정책 (가설 A — 단가만 보정, 수량은 그대로):
 *   stock_in_items.unit_price  ×= pack_size
 *   inventory_lots.unit_cost   ×= pack_size
 *   inventory_lots.received_qty / remaining_qty  → 그대로 (실재고 일치 가정)
 *   inventory.on_hand_qty       → 그대로 (실재고 일치 가정)
 *   inventory.avg_unit_cost     → lot 기반 재계산
 *
 * 실행:
 *   npx ts-node --transpile-only -P tsconfig.server.json src/server/scripts/fix-unit-cost-double-conversion.ts          # dry-run
 *   npx ts-node --transpile-only -P tsconfig.server.json src/server/scripts/fix-unit-cost-double-conversion.ts --apply  # 실제 적용
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

type SiiRow = {
  sii_id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  location_id: string;
  loc_name: string;
  pack_size: number;
  unit_price: number;
  received_qty: number;
  po_price: number;
};

async function main() {
  console.log(`[fix-unit-cost] mode = ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // 의심 대상: 두 조건 중 하나 충족
  //   (A) PO source price_history 존재 + 입력 unit_price ≈ po_price / pack_size (±10%)
  //   (B) 같은 품목 안에서 lot.unit_cost 최대/최소 비율이 ≈ pack_size (±20%) — PriceHistory 없는 경우 대비
  // 두 조건 모두 검수 시 한 번 더 환산되어 lot.unit_cost 가 1/pack_size² 로 저장된 패턴을 식별.
  const rows = await prisma.$queryRawUnsafe<SiiRow[]>(`
    WITH po_price AS (
      SELECT ph.item_id, ph.price AS po_price
      FROM price_history ph
      WHERE ph.source='PO'
      GROUP BY ph.item_id
      HAVING MAX(ph.effective_from) = ph.effective_from
    ),
    lot_stats AS (
      SELECT l.item_id,
             MAX(l.unit_cost) AS max_cost,
             MIN(CASE WHEN l.unit_cost > 0 THEN l.unit_cost END) AS min_cost
      FROM inventory_lots l
      WHERE l.deleted_at IS NULL AND l.unit_cost > 0
      GROUP BY l.item_id
    )
    SELECT DISTINCT sii.id AS sii_id, sii.item_id, i.item_code, i.name AS item_name,
           sii.location_id, loc.name AS loc_name,
           i.pack_size, sii.unit_price, sii.received_qty,
           COALESCE(pp.po_price, 0) AS po_price
    FROM stock_in_items sii
    JOIN items i ON i.id = sii.item_id
    JOIN inventory_locations loc ON loc.id = sii.location_id
    JOIN inventory_lots l ON l.stock_in_item_id = sii.id AND l.deleted_at IS NULL
    LEFT JOIN po_price pp ON pp.item_id = i.id
    LEFT JOIN lot_stats ls ON ls.item_id = i.id
    WHERE i.pack_size > 1
      AND (
        -- 조건 A: PO 단가 기반
        (pp.po_price > 0
         AND sii.unit_price * i.pack_size BETWEEN pp.po_price * 0.9 AND pp.po_price * 1.1
         AND sii.unit_price < pp.po_price * 0.5)
        OR
        -- 조건 B: 같은 품목 lot 비율 기반 — 이 sii 의 lot 가 최저단가 쪽
        (ls.min_cost > 0
         AND ls.max_cost / ls.min_cost BETWEEN i.pack_size * 0.8 AND i.pack_size * 1.2
         AND l.unit_cost = ls.min_cost)
      )
    ORDER BY i.item_code, sii.id
  `);

  console.log(`[fix-unit-cost] 대상 stock_in_items: ${rows.length}건`);
  if (rows.length === 0) {
    console.log('[fix-unit-cost] 정정할 행 없음.');
    return;
  }

  const affectedPairs = new Set<string>();
  // dry-run 시뮬레이션용 — pair 별 lot 의 신/구 unit_cost 보관
  const pairLotsSim = new Map<string, { lotId: string; remaining: number; newCost: number }[]>();
  let lotFixCount = 0;

  for (const r of rows) {
    const ps = Number(r.pack_size);
    const oldUnitPrice = Number(r.unit_price);
    const newUnitPrice = oldUnitPrice * ps;
    const pairKey = `${r.item_id}::${r.location_id}`;
    affectedPairs.add(pairKey);

    console.log(`  ${r.item_code} | ${r.item_name} | ${r.loc_name} | sii=${r.sii_id.slice(0, 8)}.. | unit_price ${oldUnitPrice} → ${newUnitPrice} (×${ps})`);

    // lot 시뮬레이션은 dry-run/apply 모두 조회 (apply 시는 UPDATE 까지)
    const lots = await prisma.$queryRawUnsafe<{ id: string; unit_cost: number; remaining_qty: number }[]>(
      `SELECT id, unit_cost, remaining_qty FROM inventory_lots WHERE stock_in_item_id = ? AND deleted_at IS NULL`,
      r.sii_id,
    );
    if (!pairLotsSim.has(pairKey)) pairLotsSim.set(pairKey, []);
    for (const lot of lots) {
      const newLotCost = Number(lot.unit_cost) * ps;
      pairLotsSim.get(pairKey)!.push({ lotId: lot.id, remaining: Number(lot.remaining_qty), newCost: newLotCost });
      lotFixCount += 1;

      if (APPLY) {
        await prisma.$executeRawUnsafe(
          `UPDATE inventory_lots SET unit_cost = ? WHERE id = ?`,
          newLotCost, lot.id,
        );
      }
    }

    if (APPLY) {
      await prisma.$executeRawUnsafe(
        `UPDATE stock_in_items SET unit_price = ? WHERE id = ?`,
        newUnitPrice, r.sii_id,
      );
    }
  }

  console.log(`[fix-unit-cost] 영향받은 (item, location) 조합: ${affectedPairs.size}개`);

  // inventory.avg_unit_cost 재계산 — 영향받은 (item, location) 마다 lot 가중평균
  // dry-run 시: pairLotsSim 의 신 unit_cost 와, 이 sii 와 무관한 다른 lot 의 현 unit_cost 를 섞어 시뮬레이션.
  console.log(`[fix-unit-cost] avg_unit_cost 재계산 대상: ${affectedPairs.size}개`);
  for (const pairKey of affectedPairs) {
    const [itemId, locationId] = pairKey.split('::');
    const allLots = await prisma.$queryRawUnsafe<{ id: string; remaining_qty: number; unit_cost: number }[]>(
      `SELECT id, remaining_qty, unit_cost FROM inventory_lots
       WHERE deleted_at IS NULL AND item_id = ? AND location_id = ?`,
      itemId, locationId,
    );
    // dry-run 신값 매핑
    const newCostByLot = new Map<string, number>();
    for (const sim of pairLotsSim.get(pairKey) ?? []) newCostByLot.set(sim.lotId, sim.newCost);

    let qtySum = 0, valueSum = 0;
    for (const lot of allLots) {
      const q = Number(lot.remaining_qty);
      if (q <= 0) continue;
      const c = APPLY ? Number(lot.unit_cost) : (newCostByLot.get(lot.id) ?? Number(lot.unit_cost));
      qtySum += q;
      valueSum += q * c;
    }
    const newAvg = qtySum > 0 ? valueSum / qtySum : 0;

    const before = await prisma.$queryRawUnsafe<{ avg_unit_cost: number }[]>(
      `SELECT avg_unit_cost FROM inventory WHERE item_id = ? AND location_id = ?`,
      itemId, locationId,
    );
    const oldAvg = Number(before?.[0]?.avg_unit_cost ?? 0);
    console.log(`  pair=${pairKey.slice(0, 16)}..  avg_unit_cost  ${oldAvg} → ${newAvg.toFixed(4)}`);
    if (APPLY) {
      await prisma.$executeRawUnsafe(
        `UPDATE inventory SET avg_unit_cost = ? WHERE item_id = ? AND location_id = ?`,
        newAvg, itemId, locationId,
      );
    }
  }

  console.log(`[fix-unit-cost] done. stock_in_items=${rows.length}, lots=${lotFixCount}, pairs=${affectedPairs.size}`);
  if (!APPLY) console.log(`[fix-unit-cost] DRY-RUN — 실제 변경 없음. 적용하려면 --apply 추가.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
