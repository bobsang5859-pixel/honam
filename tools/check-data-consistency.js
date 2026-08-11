// 데이터 일관성 점검 — patient vs ward_room_boards vs diaper_state.
// 운영 후 1회성 실행 (검증용).
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  // 1. 부서별 입원 환자수 (patient 테이블 기준)
  const deptCounts = await prisma.$queryRawUnsafe(`
    SELECT p.department_id, d.name as dept_name, COUNT(*) as count
    FROM patients p
    LEFT JOIN departments d ON d.id = p.department_id
    WHERE p.status = 'ADMITTED' AND p.deleted_at IS NULL
    GROUP BY p.department_id, d.name
    ORDER BY count DESC
  `);
  console.log('=== 1. Admitted patient count by dept (patient 테이블 기준) ===');
  for (const r of deptCounts) {
    console.log(`  ${r.dept_name || r.department_id}: ${Number(r.count)}명`);
  }
  const totalAdmitted = deptCounts.reduce((s, r) => s + Number(r.count), 0);
  console.log(`  합계: ${totalAdmitted}명\n`);

  // 2. diaper_state 분포
  const diaperStats = await prisma.$queryRawUnsafe(`
    SELECT diaper_state, COUNT(*) as count FROM patients
    WHERE status='ADMITTED' AND deleted_at IS NULL
    GROUP BY diaper_state
    ORDER BY count DESC
  `);
  console.log('=== 2. diaper_state 분포 (입원 환자 중) ===');
  for (const r of diaperStats) {
    console.log(`  ${r.diaper_state || '(NULL)'}: ${Number(r.count)}명`);
  }
  console.log();

  // 3. ward_room_boards 와 어긋남 — 입원 상태인데 오늘 cell 없음
  const ghostPatients = await prisma.$queryRawUnsafe(`
    SELECT p.id, p.name, p.department_id, d.name as dept_name, p.status
    FROM patients p
    LEFT JOIN departments d ON d.id = p.department_id
    LEFT JOIN ward_room_boards w ON w.patient_id = p.id AND DATE(w.board_date) = '${today}'
    WHERE p.status = 'ADMITTED' AND p.deleted_at IS NULL AND w.id IS NULL
    LIMIT 20
  `);
  console.log(`=== 3. patient.status='ADMITTED' 인데 오늘(${today}) ward_room_boards 에 없는 환자 ===`);
  if (ghostPatients.length === 0) {
    console.log('  없음 (일관성 OK)\n');
  } else {
    console.log(`  발견: ${ghostPatients.length}명 (불일치)`);
    for (const p of ghostPatients) {
      console.log(`    - ${p.name} (${p.dept_name})`);
    }
    console.log();
  }

  // 4. 반대 — ward_room_boards 에 오늘 cell 있는데 patient.status != 'ADMITTED'
  const orphanCells = await prisma.$queryRawUnsafe(`
    SELECT w.id, w.patient_id, p.name, p.status, d.name as dept_name
    FROM ward_room_boards w
    LEFT JOIN patients p ON p.id = w.patient_id
    LEFT JOIN departments d ON d.id = w.department_id
    WHERE DATE(w.board_date) = '${today}'
      AND w.patient_id IS NOT NULL
      AND (p.status != 'ADMITTED' OR p.deleted_at IS NOT NULL OR p.id IS NULL)
    LIMIT 20
  `);
  console.log(`=== 4. ward_room_boards 에 오늘 cell 있는데 patient 가 ADMITTED 가 아닌 경우 ===`);
  if (orphanCells.length === 0) {
    console.log('  없음 (일관성 OK)\n');
  } else {
    console.log(`  발견: ${orphanCells.length}건 (불일치)`);
    for (const c of orphanCells) {
      console.log(`    - ${c.name || '(deleted)'} status=${c.status || 'NULL'} (${c.dept_name})`);
    }
    console.log();
  }

  // 5. ward_room_boards 환자수 vs patient 환자수
  const wardCells = await prisma.$queryRawUnsafe(`
    SELECT w.department_id, d.name as dept_name, COUNT(DISTINCT w.patient_id) as count
    FROM ward_room_boards w
    LEFT JOIN departments d ON d.id = w.department_id
    WHERE DATE(w.board_date) = '${today}' AND w.patient_id IS NOT NULL
    GROUP BY w.department_id, d.name
    ORDER BY count DESC
  `);
  console.log(`=== 5. ward_room_boards 의 부서별 환자수 (오늘 ${today} 기준) ===`);
  for (const r of wardCells) {
    console.log(`  ${r.dept_name || r.department_id}: ${Number(r.count)}명`);
  }
  const totalWard = wardCells.reduce((s, r) => s + Number(r.count), 0);
  console.log(`  합계: ${totalWard}명\n`);

  // 비교
  console.log('=== 일관성 비교 ===');
  console.log(`  patient.ADMITTED 합계: ${totalAdmitted}명`);
  console.log(`  ward_room_boards (오늘) 합계: ${totalWard}명`);
  console.log(`  차이: ${totalAdmitted - totalWard}명`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
