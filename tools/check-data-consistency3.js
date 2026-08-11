const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // ward_room_boards 실제 데이터 샘플
  const sample = await prisma.$queryRawUnsafe(`SELECT * FROM ward_room_boards WHERE patient_id IS NOT NULL LIMIT 3`);
  console.log('=== ward_room_boards 샘플 row ===');
  for (const r of sample) {
    console.log(JSON.stringify(r, (k, v) => typeof v === 'bigint' ? Number(v) : (v instanceof Date ? v.toISOString() : v), 2));
  }

  // 컬럼 정보
  const cols = await prisma.$queryRawUnsafe(`PRAGMA table_info(ward_room_boards)`);
  console.log('\n=== ward_room_boards 컬럼 ===');
  for (const c of cols) console.log(`  ${c.name} (${c.type})`);

  // patient_id 채워진 row 수 vs 전체
  const counts = await prisma.$queryRawUnsafe(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN patient_id IS NOT NULL THEN 1 ELSE 0 END) as with_patient,
      SUM(CASE WHEN board_date IS NOT NULL THEN 1 ELSE 0 END) as with_date,
      COUNT(DISTINCT patient_id) as distinct_patients
    FROM ward_room_boards
  `);
  console.log('\n=== ward_room_boards 전체 통계 ===');
  console.log(JSON.stringify(counts[0], (k, v) => typeof v === 'bigint' ? Number(v) : v, 2));

  // patient 테이블 ADMITTED 410 명 중 ward_room_boards 에 있는 수
  const linked = await prisma.$queryRawUnsafe(`
    SELECT COUNT(DISTINCT p.id) as linked
    FROM patients p
    INNER JOIN ward_room_boards w ON w.patient_id = p.id
    WHERE p.status = 'ADMITTED' AND p.deleted_at IS NULL
  `);
  console.log(`\nADMITTED 환자 중 ward_room_boards 에 있는 수: ${Number(linked[0].linked)} / 410`);

  // diaper_state 다시 — IS NULL 표기와 빈 문자열 구분
  const diaperRaw = await prisma.$queryRawUnsafe(`
    SELECT diaper_state, COUNT(*) as cnt
    FROM patients
    WHERE status = 'ADMITTED' AND deleted_at IS NULL
    GROUP BY diaper_state
  `);
  console.log('\n=== diaper_state raw 분포 ===');
  for (const r of diaperRaw) {
    const v = r.diaper_state;
    console.log(`  '${v === null ? 'NULL' : v}' (length=${v === null ? 'null' : v.length}): ${Number(r.cnt)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
