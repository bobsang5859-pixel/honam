/**
 * 옛 8건 잘못된 출고 위치 정정 (B-3 핀포인트 보정)
 *
 * 대상: SO-202605-00009, SO-202605-00012 中 부서 보관함에서 출고된 8라인.
 *       (위치 자동 추천 로직 버그로 3병동/8병동 보관함에서 출고된 케이스)
 *
 * 변경:
 *   ① stock_out_items.location_id : 부서 보관함 → 총무구매 창고
 *   ② inventory.on_hand_qty 보정 — 부서 보관함 +복원, 총무구매 창고 -차감
 *   ③ audit_logs — JSON metadata 8건 (원본 SO, 변경 전후)
 *   ④ stock_out_lot_allocations 은 lot_id=NULL 유지 (실사가 lot 체계 재구성)
 *
 * Invariant:
 *   - Global: ΣStockIn - ΣStockOut = Σon_hand
 *   - Location: 부서 보관함 + 총무구매 창고 합 보존
 *
 * 실행:
 *   node scripts/fix-wrong-location-stockouts.js          # dry-run
 *   node scripts/fix-wrong-location-stockouts.js --apply  # 실제 적용
 */

const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'prisma', 'hospital-supply.db');
const db = new Database(DB_PATH);

const CENTRAL = db.prepare("SELECT id, name FROM inventory_locations WHERE name='총무구매 창고'").get();
const TONGMUBU = db.prepare("SELECT id, name FROM inventory_locations WHERE name='총무부 보관함'").get();
if (!CENTRAL) { console.error('총무구매 창고 미발견'); process.exit(1); }
if (!TONGMUBU) { console.error('총무부 보관함 미발견'); process.exit(1); }

console.log(`[fix-wrong-location] mode = ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`  CENTRAL = ${CENTRAL.id}`);

// 대상 라인 식별 — 8건의 SO 중 총무구매 창고가 아닌 위치에서 출고된 라인
const targets = db.prepare(`
  SELECT
    soi.id AS soi_id, soi.stock_out_id, so.so_no,
    soi.item_id, i.item_code, i.name AS item_name,
    soi.location_id AS old_location_id, loc.name AS old_location_name,
    soi.issued_qty,
    so.department_id, d.name AS dept_name
  FROM stock_out_items soi
  JOIN stock_out so ON so.id = soi.stock_out_id
  JOIN items i ON i.id = soi.item_id
  JOIN inventory_locations loc ON loc.id = soi.location_id
  JOIN departments d ON d.id = so.department_id
  WHERE so.deleted_at IS NULL
    AND so.status != 'REVERSED'
    AND soi.location_id != ?
  ORDER BY so.so_no, i.name
`).all(CENTRAL.id);

console.log(`정정 대상: ${targets.length}건`);
console.log('');

if (targets.length === 0) {
  console.log('정정할 라인 없음.');
  db.close();
  process.exit(0);
}

// --- Invariant Before ---
function locQty(locId) {
  const row = db.prepare("SELECT COALESCE(SUM(on_hand_qty),0) AS qty FROM inventory WHERE location_id = ?").get(locId);
  return Number(row.qty);
}
const affectedLocs = new Set([CENTRAL.id]);
for (const t of targets) affectedLocs.add(t.old_location_id);
const beforeMap = {};
for (const lid of affectedLocs) beforeMap[lid] = locQty(lid);
const beforeSum = Object.values(beforeMap).reduce((s, q) => s + q, 0);
console.log('[before] 영향 위치별 on_hand_qty 합:', beforeMap, ' 합:', beforeSum);
console.log('');

console.log('=== 정정 대상 라인 ===');
console.log('SO              | 품목                          | 부서  | 옛 위치           | 새 위치        | qty');
for (const t of targets) {
  console.log(`  ${t.so_no} | ${(t.item_name||'').padEnd(28)} | ${(t.dept_name||'').padEnd(4)} | ${(t.old_location_name||'').padEnd(15)} | ${CENTRAL.name} | ${t.issued_qty}`);
}
console.log('');

// 분기: 옛 총무부 보관함 출고 (inventory 보정 X, location_id만) vs 부서 보관함 출고 (inventory 보정 O)
const tongmuTargets = targets.filter(t => t.old_location_id === TONGMUBU.id);
const deptTargets   = targets.filter(t => t.old_location_id !== TONGMUBU.id);
console.log(`  ⤷ 옛 총무부 보관함: ${tongmuTargets.length}건 (location_id 만)`);
console.log(`  ⤷ 부서 보관함:     ${deptTargets.length}건 (location_id + inventory 보정)`);
console.log('');

if (APPLY) {
  const tx = db.transaction(() => {
    // === 그룹 1: 옛 총무부 보관함 출고 — location_id 만 변경 (inventory 이미 일괄 이전됨) ===
    for (const t of tongmuTargets) {
      db.prepare('UPDATE stock_out_items SET location_id = ? WHERE id = ?').run(CENTRAL.id, t.soi_id);

      const meta = {
        reason: '잘못된 출고 위치 정정 — 옛 총무부 보관함 기록을 정책 위치(총무구매 창고)로 통합',
        original_so_no: t.so_no,
        original_stock_out_id: t.stock_out_id,
        item_code: t.item_code,
        item_name: t.item_name,
        target_department: t.dept_name,
        before: { location_id: t.old_location_id, location_name: t.old_location_name },
        after:  { location_id: CENTRAL.id, location_name: CENTRAL.name },
        issued_qty: Number(t.issued_qty),
        inventory_adjusted: false,
        policy: '일관성 유지 — 옛 총무부 보관함 inventory/lot 일괄 이전 후 stock_out 기록도 함께 정정',
      };
      db.prepare(`
        INSERT INTO audit_logs (id, occurred_at, actor_user_id, actor_role_snapshot, action, entity_type, entity_id, before_json, after_json, reason, ip)
        VALUES (?, CURRENT_TIMESTAMP, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), '{"system":"migration"}', 'STOCK_OUT_LOCATION_FIX', 'stock_out_items', t.soi_id,
             JSON.stringify(meta.before), JSON.stringify(meta.after), meta.reason, 'localhost');
    }

    // === 그룹 2: 부서 보관함 출고 — location_id 변경 + inventory 보정 ===
    for (const t of deptTargets) {
      db.prepare('UPDATE stock_out_items SET location_id = ? WHERE id = ?').run(CENTRAL.id, t.soi_id);

      // (a) 옛 부서 보관함 +복원
      const oldInv = db.prepare('SELECT id, on_hand_qty FROM inventory WHERE item_id=? AND location_id=?').get(t.item_id, t.old_location_id);
      if (oldInv) {
        db.prepare('UPDATE inventory SET on_hand_qty = on_hand_qty + ? WHERE id = ?').run(Number(t.issued_qty), oldInv.id);
      } else {
        db.prepare('INSERT INTO inventory (id, item_id, location_id, on_hand_qty, avg_unit_cost, updated_at) VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)').run(uuidv4(), t.item_id, t.old_location_id, Number(t.issued_qty));
      }

      // (b) 총무구매 창고 -차감
      const newInv = db.prepare('SELECT id, on_hand_qty FROM inventory WHERE item_id=? AND location_id=?').get(t.item_id, CENTRAL.id);
      if (newInv) {
        db.prepare('UPDATE inventory SET on_hand_qty = on_hand_qty - ? WHERE id = ?').run(Number(t.issued_qty), newInv.id);
      } else {
        db.prepare('INSERT INTO inventory (id, item_id, location_id, on_hand_qty, avg_unit_cost, updated_at) VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)').run(uuidv4(), t.item_id, CENTRAL.id, -Number(t.issued_qty));
      }

      const meta = {
        reason: '잘못된 출고 위치 정정 — 부서 보관함에서 출고된 라인을 정책 위치(총무구매 창고)로 변경',
        original_so_no: t.so_no,
        original_stock_out_id: t.stock_out_id,
        item_code: t.item_code,
        item_name: t.item_name,
        target_department: t.dept_name,
        before: { location_id: t.old_location_id, location_name: t.old_location_name },
        after:  { location_id: CENTRAL.id, location_name: CENTRAL.name },
        issued_qty: Number(t.issued_qty),
        inventory_adjusted: true,
        policy: 'B-3 pinpoint fix (50 lines re-inspection 회피)',
        note: 'lot_id=NULL allocation 은 실사가 lot 체계 재구성 시 정리',
      };
      db.prepare(`
        INSERT INTO audit_logs (id, occurred_at, actor_user_id, actor_role_snapshot, action, entity_type, entity_id, before_json, after_json, reason, ip)
        VALUES (?, CURRENT_TIMESTAMP, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), '{"system":"migration"}', 'STOCK_OUT_LOCATION_FIX', 'stock_out_items', t.soi_id,
             JSON.stringify(meta.before), JSON.stringify(meta.after), meta.reason, 'localhost');
    }
  });
  tx();
  console.log('✓ APPLY 완료');
} else {
  console.log(`(dry-run) — 총 ${targets.length}건 정정 예정 (총무부 ${tongmuTargets.length} + 부서 ${deptTargets.length})`);
}

// --- Invariant After ---
const afterMap = {};
for (const lid of affectedLocs) afterMap[lid] = locQty(lid);
const afterSum = Object.values(afterMap).reduce((s, q) => s + q, 0);
console.log('');
console.log('[after] 영향 위치별 on_hand_qty 합:', afterMap, ' 합:', afterSum);
console.log(`[invariant] Location 합 보존? ${beforeSum === afterSum ? '✓' : '❌'} (before=${beforeSum}, after=${afterSum})`);

db.close();
console.log('');
console.log(APPLY ? '완료' : 'DRY-RUN — 실제 적용은 --apply 추가');
