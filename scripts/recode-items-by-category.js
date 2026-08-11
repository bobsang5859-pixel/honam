/**
 * 품목코드 카테고리별 재채번.
 *   의료소모품(MED_/INFECT_)  → MED-####
 *   사무용품(OFF_)            → OFF-####
 *   비품(EQUIP_)              → EQP-####
 *   그 외(PAT_/DIAPER/FAC_/FOOD_ 등) → GEN-####   (일반소모품)
 *
 * - item_code 는 Item 테이블에만 존재(다른 연결은 item_id=uuid) → 재코딩해도 이력 안 깨짐.
 * - 결의서 items_json 스냅샷은 시점기록이라 손대지 않음(통계는 uuid 기준이라 무관).
 * - 활성 품목(deleted_at NULL)만 대상. 삭제품목은 ITEM- 유지(접두어 달라 충돌 없음).
 * - 정렬: 기존 item_code asc (결정적 부여). @@unique 충돌 회피 위해 2단계(TMP→최종).
 * - 매핑 로그를 scripts/recode-map-<ts>.csv 로 저장(롤백 근거).
 *
 *   node scripts/recode-items-by-category.js           # DRY-RUN (검수용 CSV만)
 *   node scripts/recode-items-by-category.js --apply   # 실제 적용(트랜잭션)
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB = path.join(__dirname, '..', 'prisma', 'hospital-supply.db');
const db = new Database(DB);

function bucket(category) {
  const c = String(category || '').toUpperCase();
  if (c.startsWith('EQUIP_')) return 'EQP';
  if (c.startsWith('OFF_')) return 'OFF';
  if (c.startsWith('MED_') || c.startsWith('INFECT_')) return 'MED';
  return 'GEN'; // PAT_/DIAPER/FAC_/FOOD_/미분류 = 일반소모품
}

const rows = db.prepare(
  `SELECT id, item_code, name, category FROM items WHERE deleted_at IS NULL ORDER BY item_code ASC`,
).all();

const seq = { MED: 0, GEN: 0, OFF: 0, EQP: 0 };
const map = []; // { id, old, neu, name, category, prefix }
for (const r of rows) {
  const p = bucket(r.category);
  seq[p] += 1;
  const neu = `${p}-${String(seq[p]).padStart(4, '0')}`;
  map.push({ id: r.id, old: r.item_code, neu, name: r.name, category: r.category || '(미분류)', prefix: p });
}

// 요약
console.log(`[recode] mode = ${APPLY ? 'APPLY' : 'DRY-RUN'} | 대상 활성품목 ${rows.length}개`);
console.log('버킷별 개수:', JSON.stringify(seq));
const noCat = map.filter((m) => m.category === '(미분류)');
if (noCat.length) console.log(`⚠ 미분류 ${noCat.length}개 → GEN 으로 채번:`, noCat.slice(0, 10).map((m) => m.old).join(', '));
// 유니크 검증
const newSet = new Set(map.map((m) => m.neu));
if (newSet.size !== map.length) { console.error('✗ 신코드 중복 발생 — 중단'); process.exit(1); }
console.log('신코드 유니크 OK:', newSet.size, '개');
console.log('샘플:');
for (const m of map.slice(0, 8)) console.log(`  ${m.old} → ${m.neu}  ${m.name} [${m.category}]`);

// 매핑 CSV 저장 (검수/롤백)
const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const csvPath = path.join(__dirname, `recode-map-${ts}.csv`);
fs.writeFileSync(csvPath,
  'id,old_code,new_code,prefix,category,name\n' +
  map.map((m) => `${m.id},${m.old},${m.neu},${m.prefix},${m.category},"${String(m.name).replace(/"/g, '""')}"`).join('\n'),
  'utf8');
console.log('매핑표 저장:', csvPath, '(검수 후 --apply)');

if (!APPLY) { console.log('\nDRY-RUN — 실제 적용 안 함. 위 CSV 검수 후 --apply'); db.close(); return; }

// 적용: 2단계(TMP → 최종) 단일 트랜잭션
const toTmp = db.prepare(`UPDATE items SET item_code = ? WHERE id = ?`);
const tx = db.transaction(() => {
  for (const m of map) toTmp.run(`TMP-${m.id}`, m.id);     // 1단계: 임시
  for (const m of map) toTmp.run(m.neu, m.id);             // 2단계: 최종
});
tx();
const after = db.prepare(
  `SELECT substr(item_code,1,4) p, COUNT(*) c FROM items WHERE deleted_at IS NULL GROUP BY p ORDER BY p`,
).all();
console.log('✓ APPLY 완료. 적용 후 접두어 분포:', JSON.stringify(after));
console.log('롤백 근거:', csvPath, '+ DB 백업');
db.close();
