// 자동 이월 수동 트리거 — index.ts 우회 (migrate 트리거 방지).
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');

const prisma = new PrismaClient();
const AUTO_CARRYOVER_ITEMS = ['기저귀', '간병', '간병비'];

async function main() {
  const targetMonth = '2026-05';
  const fromMonth = '2026-04';

  const flagKey = `patient_charges:auto_carryover:${targetMonth}`;
  const flag = await prisma.appSetting.findUnique({ where: { key: flagKey } });
  if (flag) {
    console.log('이미 처리됨, 종료');
    return;
  }

  // 입원 환자
  const admittedIds = (await prisma.patient.findMany({
    where: { status: 'ADMITTED', deleted_at: null },
    select: { id: true },
  })).map(p => p.id);
  console.log('입원 환자수:', admittedIds.length);

  // 전월 청구 (기저귀·간병만)
  const sources = await prisma.patientCharge.findMany({
    where: {
      patient_id: { in: admittedIds },
      charge_month: fromMonth,
      deleted_at: null,
      item_name: { in: AUTO_CARRYOVER_ITEMS },
    },
    select: { patient_id: true, category: true, item_name: true, amount: true, note: true },
  });
  console.log(`${fromMonth} 청구 (기저귀·간병):`, sources.length, '건');

  // 당월 기존
  const existing = await prisma.patientCharge.findMany({
    where: { patient_id: { in: admittedIds }, charge_month: targetMonth, deleted_at: null },
    select: { patient_id: true, category: true, item_name: true },
  });
  const existingKeys = new Set(existing.map(e => `${e.patient_id}::${e.category}::${e.item_name}`));
  console.log(`${targetMonth} 기존:`, existing.length, '건');

  let copied = 0;
  let skipped = 0;
  const patientSet = new Set();
  for (const s of sources) {
    const k = `${s.patient_id}::${s.category}::${s.item_name}`;
    if (existingKeys.has(k)) { skipped += 1; continue; }
    await prisma.patientCharge.create({
      data: {
        id: uuidv4(),
        patient_id: s.patient_id,
        category: s.category,
        item_name: s.item_name,
        amount: s.amount,
        charge_month: targetMonth,
        note: s.note || `${fromMonth} 이월`,
      },
    });
    copied += 1;
    patientSet.add(s.patient_id);
  }
  console.log(`복사: ${copied}건, skip: ${skipped}건, 환자: ${patientSet.size}명`);

  // flag 기록
  await prisma.appSetting.upsert({
    where: { key: flagKey },
    update: {
      value: JSON.stringify({ from: fromMonth, to: targetMonth, copied, skipped, by_patient: patientSet.size, at: new Date().toISOString() }),
      description: '자동 이월 처리 기록 — 멱등성 보장',
    },
    create: {
      id: uuidv4(),
      key: flagKey,
      value: JSON.stringify({ from: fromMonth, to: targetMonth, copied, skipped, by_patient: patientSet.size, at: new Date().toISOString() }),
      description: '자동 이월 처리 기록 — 멱등성 보장',
    },
  });
  console.log('flag 기록 완료:', flagKey);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
