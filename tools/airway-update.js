const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const db = new Database('prisma/hospital-supply.db');

// 1) 기존 Air Way 3개 삭제 (soft)
const del = db.prepare("UPDATE items SET deleted_at=CURRENT_TIMESTAMP, is_active=0 WHERE name LIKE 'Air Way%' AND deleted_at IS NULL").run();
console.log('Air Way 삭제:', del.changes, '건');

// 2) Air Way #0 ~ #5 신규 등록
const ins = db.prepare(`INSERT INTO items
  (id, item_code, name, category, sub_category, expense_scope, uom, pack_size, default_vendor_id, min_order_qty, is_regular_order, reorder_days_threshold, is_active)
  VALUES (?, ?, ?, 'MED_AIRWAY', '', 'PATIENT_DIRECT', 'EA', 1, NULL, 1, 1, 7, 1)`);

let code = 506;
for (let i = 0; i <= 5; i++) {
  const itemCode = 'ITEM-' + String(code++).padStart(4, '0');
  const id = uuidv4();
  ins.run(id, itemCode, 'Air Way #' + i);
  console.log('등록:', itemCode, 'Air Way #' + i);
}

// 3) 손톱깍기 → 손톱깍이
const r = db.prepare("UPDATE items SET name='손톱깍이 (대형)' WHERE name='손톱깍기 (대형)' AND deleted_at IS NULL").run();
console.log('\n손톱깍기 → 손톱깍이:', r.changes, '건');

console.log('\n=== Air Way 최종 ===');
db.prepare("SELECT item_code, name FROM items WHERE name LIKE 'Air Way%' AND deleted_at IS NULL ORDER BY item_code").all().forEach(r => console.log(' ', r.item_code, r.name));
