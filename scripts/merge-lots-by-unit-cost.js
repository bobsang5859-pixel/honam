/**
 * 같은 (item, location, vendor, unit_cost) inventory_lots 일괄 병합.
 *
 * 동작:
 *   - 그룹 키: (item_id, location_id, vendor_id, unit_cost)
 *   - 그룹 내 가장 오래된 received_at 의 lot 을 대표(primary)로 선정
 *   - 나머지 lot 의 received_qty / remaining_qty 를 primary 에 합산
 *   - 나머지 lot 은 deleted_at set
 *   - stock_out_lot_allocations.inventory_lot_id 를 primary id 로 재매핑 (FK 정합성)
 *
 * Invariant:
 *   - SUM(active_lots.remaining_qty) 보존
 *   - SUM(active_lots.received_qty)  보존
 *   - Allocation FK 깨짐 없음
 *
 * 실행:
 *   node scripts/merge-lots-by-unit-cost.js          # dry-run
 *   node scripts/merge-lots-by-unit-cost.js --apply  # 실제 적용
 */

const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'prisma', 'hospital-supply.db');
const db = new Database(DB_PATH);

console.log(`[merge-lots] mode = ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log('');

// === 1. Invariant Before ===
const totalBefore = db.prepare(`
  SELECT
    COUNT(*) AS lot_count,
    COALESCE(SUM(received_qty), 0) AS total_received,
    COALESCE(SUM(remaining_qty), 0) AS total_remaining
  FROM inventory_lots WHERE deleted_at IS NULL
`).get();
console.log('[before] lot수=' + totalBefore.lot_count
  + ' / 총 received=' + totalBefore.total_received
  + ' / 총 remaining=' + totalBefore.total_remaining);
console.log('');

// === 2. 병합 대상 그룹 식별 ===
// 같은 (item, location, vendor_id IS NULL 처리), unit_cost 묶어서 2개 이상인 그룹
const groups = db.prepare(`
  SELECT
    item_id,
    location_id,
    COALESCE(vendor_id, '__NO_VENDOR__') AS vendor_key,
    unit_cost,
    COUNT(*) AS lot_count,
    SUM(received_qty) AS sum_received,
    SUM(remaining_qty) AS sum_remaining
  FROM inventory_lots
  WHERE deleted_at IS NULL
  GROUP BY item_id, location_id, COALESCE(vendor_id, '__NO_VENDOR__'), unit_cost
  HAVING COUNT(*) > 1
`).all();

console.log('병합 대상 그룹: ' + groups.length + '개');
let totalMerged = 0;
let totalAllocRemapped = 0;

if (APPLY) {
  const tx = db.transaction(() => {
    for (const g of groups) {
      // 그룹 lot 목록 — 가장 오래된 received_at 순
      const lots = db.prepare(`
        SELECT id, received_at, received_qty, remaining_qty
        FROM inventory_lots
        WHERE deleted_at IS NULL
          AND item_id = ?
          AND location_id = ?
          AND COALESCE(vendor_id, '__NO_VENDOR__') = ?
          AND unit_cost = ?
        ORDER BY datetime(received_at) ASC, id ASC
      `).all(g.item_id, g.location_id, g.vendor_key, g.unit_cost);

      if (lots.length < 2) continue;

      const primary = lots[0];
      const rest = lots.slice(1);

      // 합산 양 계산
      let addReceived = 0;
      let addRemaining = 0;
      for (const r of rest) {
        addReceived += Number(r.received_qty);
        addRemaining += Number(r.remaining_qty);
      }

      // primary 갱신
      db.prepare(`
        UPDATE inventory_lots
        SET received_qty = received_qty + ?,
            remaining_qty = remaining_qty + ?
        WHERE id = ?
      `).run(addReceived, addRemaining, primary.id);

      // allocation FK 재매핑
      const restIds = rest.map(r => r.id);
      const placeholders = restIds.map(() => '?').join(',');
      const allocInfo = db.prepare(`
        UPDATE stock_out_lot_allocations
        SET inventory_lot_id = ?
        WHERE inventory_lot_id IN (${placeholders})
      `).run(primary.id, ...restIds);
      totalAllocRemapped += allocInfo.changes;

      // 나머지 lot 삭제 (soft)
      const delInfo = db.prepare(`
        UPDATE inventory_lots
        SET deleted_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
      `).run(...restIds);
      totalMerged += delInfo.changes;
    }
  });
  tx();
} else {
  for (const g of groups) {
    totalMerged += (g.lot_count - 1);
  }
}

console.log('병합 예정/완료 lot: ' + totalMerged + '건');
console.log('allocation FK 재매핑: ' + totalAllocRemapped + '건');
console.log('');

// === 3. Invariant After ===
const totalAfter = db.prepare(`
  SELECT
    COUNT(*) AS lot_count,
    COALESCE(SUM(received_qty), 0) AS total_received,
    COALESCE(SUM(remaining_qty), 0) AS total_remaining
  FROM inventory_lots WHERE deleted_at IS NULL
`).get();
console.log('[after]  lot수=' + totalAfter.lot_count
  + ' / 총 received=' + totalAfter.total_received
  + ' / 총 remaining=' + totalAfter.total_remaining);
console.log('');

const recPreserved = Number(totalBefore.total_received) === Number(totalAfter.total_received);
const remPreserved = Number(totalBefore.total_remaining) === Number(totalAfter.total_remaining);
console.log(`[invariant] received 보존: ${recPreserved ? '✓' : '❌'}`);
console.log(`[invariant] remaining 보존: ${remPreserved ? '✓' : '❌'}`);

// === 4. 샘플 ===
if (groups.length > 0) {
  console.log('');
  console.log('=== 병합 효과 큰 그룹 상위 10 ===');
  const sorted = groups.sort((a, b) => b.lot_count - a.lot_count).slice(0, 10);
  for (const g of sorted) {
    const item = db.prepare("SELECT item_code, name FROM items WHERE id = ?").get(g.item_id);
    console.log(`  ${item?.item_code || '?'} ${(item?.name || '?').padEnd(28)} | 단가 ${g.unit_cost}원 | ${g.lot_count} → 1 lot`);
  }
}

db.close();
console.log('');
console.log(APPLY ? '완료' : 'DRY-RUN — 실제 적용은 --apply 추가');
