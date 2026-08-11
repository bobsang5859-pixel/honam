// 환자 쓰기 가드 테스트 — 빈값으로 patient.create 시도 → 자동 NONE 변환 확인.
import { PrismaClient } from '@prisma/client';
import { patientWriteGuard } from '../src/server/db/patient-write-guard';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient().$extends(patientWriteGuard);

async function main() {
  // 테스트용 부서 1개 가져오기
  const dept = await (prisma as any).department.findFirst({ select: { id: true } });
  if (!dept) {
    console.error('테스트할 부서 없음');
    return;
  }
  const user = await (prisma as any).user.findFirst({ select: { id: true } });
  if (!user) {
    console.error('테스트할 사용자 없음');
    return;
  }

  const testId = uuidv4();
  console.log(`\n[테스트] 빈값으로 patient.create 시도 (id=${testId})`);

  // 의도적으로 빈값으로 생성 시도
  const created = await (prisma as any).patient.create({
    data: {
      id: testId,
      patient_no: 'TEST-' + Date.now(),
      chart_no: 'TEST-' + Date.now(),
      name: '__GUARD_TEST__',
      department_id: dept.id,
      diaper_state: '',         // 빈문자열 — guard 가 NONE 으로 강제해야
      specializations: '',      // 빈문자열 — guard 가 [] 로 강제
      gender: '',               // 빈문자열 — guard 가 UNKNOWN 으로 강제
      mobility_type: '',        // 빈문자열 — guard 가 AMBULATORY 로 강제
      patient_group: '',        // 빈문자열 — guard 가 UNRATED 로 강제
      admitted_at: new Date(),
      created_by: user.id,
    },
  });

  console.log('\n[결과] DB 에 저장된 값:');
  console.log(`  diaper_state: '${created.diaper_state}'  (예상: NONE)`);
  console.log(`  specializations: '${created.specializations}'  (예상: [])`);
  console.log(`  gender: '${created.gender}'  (예상: UNKNOWN)`);
  console.log(`  mobility_type: '${created.mobility_type}'  (예상: AMBULATORY)`);
  console.log(`  patient_group: '${created.patient_group}'  (예상: UNRATED)`);

  const allCorrect =
    created.diaper_state === 'NONE' &&
    created.specializations === '[]' &&
    created.gender === 'UNKNOWN' &&
    created.mobility_type === 'AMBULATORY' &&
    created.patient_group === 'UNRATED';

  if (allCorrect) {
    console.log('\n✅ 통과 — 모든 빈값이 안전한 default 로 강제됨');
  } else {
    console.log('\n❌ 실패 — 일부 빈값이 그대로 저장됨');
    process.exitCode = 1;
  }

  // 정리 — 테스트 환자 삭제
  await (prisma as any).patient.delete({ where: { id: testId } });
  console.log('테스트 환자 삭제 완료');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
