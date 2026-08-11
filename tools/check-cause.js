const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // 1. diaper_state '' 환자 9명의 상세 — 누가 언제 만들었나?
  const dirtyPatients = await prisma.$queryRawUnsafe(`
    SELECT p.id, p.name, p.chart_no, p.created_at, d.name as dept_name, p.diaper_state, p.note
    FROM patients p
    LEFT JOIN departments d ON d.id = p.department_id
    WHERE p.status = 'ADMITTED' AND p.deleted_at IS NULL AND p.diaper_state = ''
    ORDER BY p.created_at
  `);
  console.log('=== diaper_state="" 환자 9명 ===');
  for (const p of dirtyPatients) {
    const created = p.created_at ? new Date(p.created_at).toISOString().slice(0, 10) : '?';
    console.log(`  ${p.name} | ${p.dept_name} | created: ${created} | note: "${(p.note || '').slice(0, 30)}"`);
  }

  // 2. 같은 시점에 만들어진 다른 환자들의 diaper_state 분포
  console.log('\n=== 비교: 같은 created_at 의 다른 환자들 ===');
  if (dirtyPatients.length > 0) {
    const createdAt = dirtyPatients[0].created_at;
    const date = new Date(createdAt).toISOString().slice(0, 10);
    const sameTime = await prisma.$queryRawUnsafe(`
      SELECT diaper_state, COUNT(*) as cnt
      FROM patients
      WHERE DATE(created_at) = '${date}' AND status = 'ADMITTED'
      GROUP BY diaper_state
    `);
    console.log(`  ${date} 에 생성된 환자들의 diaper_state 분포:`);
    for (const r of sameTime) {
      console.log(`    '${r.diaper_state}': ${Number(r.cnt)}`);
    }
  }

  // 3. ward_room_boards 의 실제 board_date 분포 — 정확히 어디까지 있나?
  const boardDateRaw = await prisma.$queryRawUnsafe(`
    SELECT board_date, COUNT(*) as cnt
    FROM ward_room_boards
    GROUP BY board_date
    ORDER BY board_date DESC
    LIMIT 10
  `);
  console.log('\n=== ward_room_boards board_date 상위 10개 (최근순) ===');
  for (const r of boardDateRaw) {
    const d = r.board_date ? new Date(r.board_date).toISOString().slice(0, 10) : 'NULL';
    console.log(`  ${d}: ${Number(r.cnt)} cells`);
  }

  // 4. ward_room_boards 마지막 cell 의 created_at — 누가 마지막으로 보드 만들었나?
  const lastBoard = await prisma.$queryRawUnsafe(`
    SELECT board_date, created_at, COUNT(*) as cnt
    FROM ward_room_boards
    GROUP BY DATE(created_at)
    ORDER BY MAX(created_at) DESC
    LIMIT 5
  `);
  console.log('\n=== ward_room_boards created_at 일별 ===');
  for (const r of lastBoard) {
    const created = r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '?';
    const board = r.board_date ? new Date(r.board_date).toISOString().slice(0, 10) : '?';
    console.log(`  생성일 ${created} → board_date ${board}: ${Number(r.cnt)} cells`);
  }

  // 5. ensureBoardForDate 가 호출되면 board_date 가 동적으로 늘어나야 함. 확인.
  // 가장 최근 입원/이동/퇴원 이벤트
  const lastEvents = await prisma.$queryRawUnsafe(`
    SELECT event_type, event_date, created_at, COUNT(*) as cnt
    FROM patient_events
    WHERE deleted_at IS NULL
    GROUP BY DATE(created_at), event_type
    ORDER BY MAX(created_at) DESC
    LIMIT 10
  `);
  console.log('\n=== patient_events 최근 ===');
  for (const r of lastEvents) {
    const created = r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '?';
    console.log(`  ${created}: ${r.event_type} ${Number(r.cnt)}건`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
