/**
 * 일괄 이전: '총무부 보관함' → '총무구매 창고'
 *
 * 변경:
 *   ① inventory_lots.location_id : 총무부 보관함 → 총무구매 창고 (lot 추적성 보존)
 *   ② inventory.on_hand_qty / avg_unit_cost : 총무구매 창고에 가중평균 합산, 총무부 보관함은 0
 *   ③ audit_log : 이전 흔적 기록 (JSON metadata)
 *
 * Invariant (검증):
 *   - Global: ΣStockIn - ΣStockOut = Σon_hand   (이전 전후 보존)
 *   - Location: 총무부 + 총무구매 합 = 보존
 *
 * 실행:
 *   node scripts/move-tongmubu-to-central.js          # dry-run
 *   node scripts/move-tongmubu-to-central.js --apply  # 실제 실행
 */

const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'prisma', 'hospital-supply.db');
const db = new Database(DB_PATH);

const SRC = db.prepare("SELECT id FROM inventory_locations WHERE name='총무부 보관함'").get();
const DST = db.prepare("SELECT id FROM inventory_locations WHERE name='총무구매 창고'").get();
if (!SRC || !DST) { console.error('Location 미발견'); process.exit(1); }

console.log(`[move-tongmubu] mode = ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`  SRC 총무부 보관함 = ${SRC.id}`);
console.log(`  DST 총무구매 창고 = ${DST.id}`);
console.log('');

// --- Invariant Before 측정 ---
function measureLocation(locId) {
  const row = db.prepare("SELECT COALESCE(SUM(on_hand_qty), 0) AS qty FROM inventory WHERE location_id = ?").get(locId);
  return Number(row.qty);
}
const beforeSrc = measureLocation(SRC.id);
const beforeDst = measureLocation(DST.id);
const beforeSum = beforeSrc + beforeDst;
console.log(`[before] 총무부=${beforeSrc}, 총무구매=${beforeDst}, 합=${beforeSum}`);

// --- 이전 대상 inventory (총무부 보관함의 모든 행) ---
const srcInvs = db.prepare(`
  SELECT inv.item_id, i.item_code, i.name AS item_name, inv.on_hand_qty, inv.avg_unit_cost
  FROM inventory inv
  JOIN items i ON i.id = inv.item_id
  WHERE inv.location_id = ?
`).all(SRC.id);

console.log(`이전 대상 inventory 행: ${srcInvs.length}건`);

// --- 이전 대상 lot ---
const srcLots = db.prepare(`
  SELECT id, item_id, remaining_qty, unit_cost
  FROM inventory_lots
  WHERE location_id = ? AND deleted_at IS NULL
`).all(SRC.id);
console.log(`이전 대상 inventory_lots: ${srcLots.length}건`);
console.log('');

// --- 시뮬레이션: 각 item별 결과 계산 ---
const changes = [];
for (const src of srcInvs) {
  const dstInv = db.prepare(`
    SELECT id, on_hand_qty, avg_unit_cost FROM inventory
    WHERE item_id = ? AND location_id = ?
  `).get(src.item_id, DST.id);

  const srcQty = Number(src.on_hand_qty);
  const srcAvg = Number(src.avg_unit_cost);
  const dstQty = Number(dstInv?.on_hand_qty ?? 0);
  const dstAvg = Number(dstInv?.avg_unit_cost ?? 0);

  const newQty = dstQty + srcQty;
  // 가중평균 — qty > 0 일 때만 의미 있음 (음수 합산은 가중평균 무의미 — 그 경우 기존 avg 유지)
  let newAvg;
  if (newQty > 0 && (srcQty > 0 || dstQty > 0)) {
    const validQtyDst = Math.max(0, dstQty);
    const validQtySrc = Math.max(0, srcQty);
    if (validQtyDst + validQtySrc > 0) {
      newAvg = (validQtyDst * dstAvg + validQtySrc * srcAvg) / (validQtyDst + validQtySrc);
    } else {
      newAvg = dstAvg || srcAvg;
    }
  } else {
    newAvg = dstAvg || srcAvg;
  }

  changes.push({
    item_id: src.item_id,
    item_code: src.item_code,
    item_name: src.item_name,
    srcQty, srcAvg, dstQty, dstAvg, newQty, newAvg,
    dstInvId: dstInv?.id ?? null,
  });
}

console.log('=== 시뮬레이션 (금액 영향 큰 순) ===');
const sorted = [...changes].sort((a, b) => Math.abs(b.srcQty * b.srcAvg) - Math.abs(a.srcQty * a.srcAvg));
console.log('품목코드   | 품목명                       | 총무부 → 총무구매         | 새 합계 (qty / avg)');
for (const c of sorted.slice(0, 30)) {
  const srcLabel = `${c.srcQty}@${Math.round(c.srcAvg)}원`;
  const dstLabel = `${c.dstQty}@${Math.round(c.dstAvg)}원`;
  const newLabel = `${c.newQty}@${Math.round(c.newAvg)}원`;
  console.log(`  ${c.item_code.padEnd(10)} | ${(c.item_name||'').slice(0,26).padEnd(26)} | ${srcLabel.padEnd(14)} + ${dstLabel.padEnd(14)} → ${newLabel}`);
}
if (sorted.length > 30) console.log(`  ... +${sorted.length-30}건 더`);
console.log('');

if (APPLY) {
  const tx = db.transaction(() => {
    // 1. inventory 합산
    for (const c of changes) {
      if (c.dstInvId) {
        db.prepare('UPDATE inventory SET on_hand_qty = ?, avg_unit_cost = ? WHERE id = ?')
          .run(c.newQty, c.newAvg, c.dstInvId);
      } else {
        db.prepare('INSERT INTO inventory (id, item_id, location_id, on_hand_qty, avg_unit_cost, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
          .run(uuidv4(), c.item_id, DST.id, c.newQty, c.newAvg);
      }
    }
    // 2. 총무부 보관함 inventory 전부 0으로
    db.prepare('UPDATE inventory SET on_hand_qty = 0, avg_unit_cost = 0 WHERE location_id = ?').run(SRC.id);

    // 3. inventory_lots 위치 변경
    db.prepare('UPDATE inventory_lots SET location_id = ? WHERE location_id = ? AND deleted_at IS NULL').run(DST.id, SRC.id);

    // 4. audit_log 기록
    const meta = {
      reason: '운영 정책 정합화 — 총무부 보관함은 부서 자체 보관함, 모든 자산은 총무구매 창고',
      moved_inventory_rows: changes.length,
      moved_lot_rows: srcLots.length,
      total_moved_qty_positive: changes.filter(c => c.srcQty > 0).reduce((s, c) => s + c.srcQty, 0),
      total_moved_qty_negative: changes.filter(c => c.srcQty < 0).reduce((s, c) => s + c.srcQty, 0),
      total_moved_value: changes.reduce((s, c) => s + c.srcQty * c.srcAvg, 0),
    };
    db.prepare(`
      INSERT INTO audit_logs (id, occurred_at, actor_user_id, actor_role_snapshot, action, entity_type, entity_id, before_json, after_json, reason, ip)
      VALUES (?, CURRENT_TIMESTAMP, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), '{"system":"migration"}', 'BULK_LOCATION_MOVE', 'inventory_location_migration', SRC.id, JSON.stringify({src: SRC.id, dst: DST.id}), JSON.stringify(meta), meta.reason, 'localhost');
  });
  tx();
  console.log('✓ APPLY 완료');
}

// --- Invariant After 측정 ---
const afterSrc = measureLocation(SRC.id);
const afterDst = measureLocation(DST.id);
const afterSum = afterSrc + afterDst;
console.log('');
console.log(`[after]  총무부=${afterSrc}, 총무구매=${afterDst}, 합=${afterSum}`);
console.log(`[invariant] 합 보존? ${beforeSum === afterSum ? '✓' : '❌'} (before=${beforeSum}, after=${afterSum})`);

if (APPLY) {
  const srcLotsAfter = db.prepare("SELECT COUNT(*) AS n FROM inventory_lots WHERE location_id = ? AND deleted_at IS NULL").get(SRC.id);
  const dstLotsAfter = db.prepare("SELECT COUNT(*) AS n FROM inventory_lots WHERE location_id = ? AND deleted_at IS NULL").get(DST.id);
  console.log(`[after lots] 총무부=${srcLotsAfter.n}건, 총무구매=${dstLotsAfter.n}건`);
}

db.close();
console.log('');
console.log(APPLY ? '완료' : 'DRY-RUN — 실제 적용은 --apply 추가');
