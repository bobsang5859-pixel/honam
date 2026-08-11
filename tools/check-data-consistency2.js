const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // ward_room_boards 의 board_date 분포
  const dateDist = await prisma.$queryRawUnsafe(`
    SELECT DATE(board_date) as d, COUNT(*) as cnt, COUNT(DISTINCT patient_id) as patients
    FROM ward_room_boards
    GROUP BY DATE(board_date)
    ORDER BY d DESC
    LIMIT 20
  `);
  console.log('=== ward_room_boards board_date 분포 (최근 20개) ===');
  for (const r of dateDist) {
    console.log(`  ${r.d}: cells ${Number(r.cnt)}, distinct patients ${Number(r.patients)}`);
  }
  console.log();

  // 가장 최근 board_date 찾기
  const latest = await prisma.$queryRawUnsafe(`SELECT MAX(DATE(board_date)) as latest FROM ward_room_boards`);
  const latestDate = latest[0].latest;
  console.log(`가장 최근 board_date: ${latestDate}`);

  if (latestDate) {
    // 그 날짜 기준으로 비교
    const onLatest = await prisma.$queryRawUnsafe(`
      SELECT w.department_id, d.name as dept_name, COUNT(DISTINCT w.patient_id) as count
      FROM ward_room_boards w
      LEFT JOIN departments d ON d.id = w.department_id
      WHERE DATE(w.board_date) = '${latestDate}' AND w.patient_id IS NOT NULL
      GROUP BY w.department_id, d.name
      ORDER BY count DESC
    `);
    console.log(`\n=== ${latestDate} 의 ward_room_boards 부서별 환자수 ===`);
    let total = 0;
    for (const r of onLatest) {
      console.log(`  ${r.dept_name || r.department_id}: ${Number(r.count)}명`);
      total += Number(r.count);
    }
    console.log(`  합계: ${total}명`);

    // 그 날짜 기준 patient.ADMITTED 와 비교
    const inPatientNotInBoard = await prisma.$queryRawUnsafe(`
      SELECT p.id, p.name, p.department_id, d.name as dept_name
      FROM patients p
      LEFT JOIN departments d ON d.id = p.department_id
      LEFT JOIN ward_room_boards w ON w.patient_id = p.id AND DATE(w.board_date) = '${latestDate}'
      WHERE p.status = 'ADMITTED' AND p.deleted_at IS NULL AND w.id IS NULL
      LIMIT 10
    `);
    console.log(`\n=== patient.ADMITTED 인데 ${latestDate} 보드에 없는 환자 ===`);
    if (inPatientNotInBoard.length === 0) console.log('  없음');
    else {
      console.log(`  ${inPatientNotInBoard.length}명 발견 (샘플 최대 10명):`);
      for (const p of inPatientNotInBoard) console.log(`    - ${p.name} (${p.dept_name})`);
    }
  }

  // diaper_state NULL 환자 — 어느 부서?
  const diaperNull = await prisma.$queryRawUnsafe(`
    SELECT p.name, d.name as dept_name
    FROM patients p
    LEFT JOIN departments d ON d.id = p.department_id
    WHERE p.status = 'ADMITTED' AND p.deleted_at IS NULL AND p.diaper_state IS NULL
    LIMIT 15
  `);
  console.log(`\n=== diaper_state NULL 인 입원 환자 ===`);
  for (const p of diaperNull) console.log(`  - ${p.name} (${p.dept_name})`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
