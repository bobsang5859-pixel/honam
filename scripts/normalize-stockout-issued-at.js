/**
 * stock_out.issued_at 저장 포맷 정규화.
 *
 * 문제: issued_at 가 일부는 INTEGER(epoch ms, Prisma 기록), 일부는 TEXT(ISO, raw/seed 기록)
 *       으로 혼재. Prisma 의 DateTime 은 SQLite 에 INTEGER(ms)로 저장/비교하므로,
 *       TEXT 로 저장된 행은 `issued_at: { gte, lte }` 필터에서 통째로 누락된다.
 *       → 물품통계/비용분석 금액이 절반만 잡힘.
 *
 * 해결: TEXT 로 저장된 issued_at 을 epoch ms(INTEGER)로 변환.
 *
 *   node scripts/normalize-stockout-issued-at.js          # dry-run
 *   node scripts/normalize-stockout-issued-at.js --apply  # 실제 적용
 */
const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB = path.join(__dirname, '..', 'prisma', 'hospital-supply.db');
const db = new Database(DB);

console.log(`[normalize-issued-at] mode = ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

const rows = db.prepare(
  `SELECT id, so_no, issued_at FROM stock_out WHERE typeof(issued_at) = 'text'`,
).all();

console.log(`TEXT 포맷 issued_at 행: ${rows.length}건`);

const updates = [];
const bad = [];
for (const r of rows) {
  const ms = Date.parse(String(r.issued_at));
  if (!Number.isFinite(ms)) { bad.push(r); continue; }
  updates.push({ id: r.id, so_no: r.so_no, from: r.issued_at, to: ms });
}

for (const u of updates.slice(0, 5)) {
  console.log(`  ${u.so_no}: "${u.from}" -> ${u.to} (${new Date(u.to).toISOString()})`);
}
if (updates.length > 5) console.log(`  ... 외 ${updates.length - 5}건`);
if (bad.length) console.log(`  ⚠ 파싱 불가 ${bad.length}건 (변환 제외):`, bad.map(b => b.so_no));

if (!APPLY) {
  console.log(`\nDRY-RUN — 변환 대상 ${updates.length}건. 실제 적용은 --apply`);
  // 적용 후 예상: 전 활성 stock_out 이 INTEGER 로 통일되어 Prisma 날짜필터가 전부 포착
  db.close();
  return;
}

const stmt = db.prepare(`UPDATE stock_out SET issued_at = ? WHERE id = ?`);
const tx = db.transaction(() => {
  for (const u of updates) stmt.run(u.to, u.id);
});
tx();

const after = db.prepare(
  `SELECT typeof(issued_at) t, COUNT(*) c FROM stock_out
   WHERE deleted_at IS NULL AND is_test = 0
     AND status IN ('POSTED','RECEIPT_PENDING','RECEIPT_CONFIRMED','RECEIPT_DIFF')
   GROUP BY typeof(issued_at)`,
).all();
console.log(`✓ APPLY 완료: ${updates.length}건 변환`);
console.log('적용 후 활성 stock_out issued_at 타입 분포:', JSON.stringify(after));
db.close();
