/**
 * datetime 컬럼의 epoch ms 형식 → ISO 문자열 일괄 정규화.
 *
 * 대상 (옛 import/마이그레이션 데이터):
 *   inventory_lots.received_at
 *   goods_receipts.received_at
 *   stock_out.issued_at / receipt_confirmed_at
 *   stock_in_items.confirmed_at
 *   price_history.effective_from / effective_to / created_at
 *
 * 변환:
 *   "1776178800000"  →  "2026-04-12T03:00:00.000Z"
 *
 * 실행:
 *   node scripts/normalize-datetime-formats.js          # dry-run
 *   node scripts/normalize-datetime-formats.js --apply  # 실제 적용
 */

const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'prisma', 'hospital-supply.db');
const db = new Database(DB_PATH);

console.log(`[normalize-datetime] mode = ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log('');

// 대상 (table, column) 쌍
const TARGETS = [
  ['inventory_lots', 'received_at'],
  ['goods_receipts', 'received_at'],
  ['stock_out', 'issued_at'],
  ['stock_out', 'receipt_confirmed_at'],
  ['stock_in_items', 'confirmed_at'],
  ['price_history', 'effective_from'],
  ['price_history', 'effective_to'],
  ['price_history', 'created_at'],
];

// 변환 조건: 컬럼 값이 ISO 형식이 아니고 12자리 이상 숫자 (epoch ms)
const COND = `\${col} NOT LIKE '____-__-__%' AND CAST(\${col} AS INTEGER) > 1000000000000`;

let totalChanged = 0;
for (const [table, col] of TARGETS) {
  const condRendered = COND.replace(/\$\{col\}/g, col);
  const countQ = `SELECT COUNT(*) AS n FROM ${table} WHERE ${condRendered}`;
  let n;
  try {
    n = db.prepare(countQ).get().n;
  } catch (e) {
    console.log(`  ⚠ ${table}.${col} 조회 실패 — 컬럼 없음? (${e.message})`);
    continue;
  }
  if (n === 0) {
    console.log(`  ${table}.${col}: 변환 대상 없음`);
    continue;
  }

  // 변환 샘플 3개
  const sample = db.prepare(`
    SELECT ${col} AS raw,
           strftime('%Y-%m-%dT%H:%M:%fZ', ${col}/1000, 'unixepoch') AS converted
    FROM ${table} WHERE ${condRendered}
    LIMIT 3
  `).all();

  console.log(`  ${table}.${col}: ${n}건 변환 예정`);
  for (const s of sample) {
    console.log(`    ${s.raw}  →  ${s.converted}`);
  }

  if (APPLY) {
    const info = db.prepare(`
      UPDATE ${table}
      SET ${col} = strftime('%Y-%m-%dT%H:%M:%fZ', ${col}/1000, 'unixepoch')
      WHERE ${condRendered}
    `).run();
    console.log(`    ✓ 변환됨: ${info.changes}`);
    totalChanged += info.changes;
  }
  console.log('');
}

if (APPLY) {
  console.log(`완료. 총 ${totalChanged}건 변환됨.`);
} else {
  console.log('DRY-RUN — 실제 적용은 --apply 추가');
}
db.close();
