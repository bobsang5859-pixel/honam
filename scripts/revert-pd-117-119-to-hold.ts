/**
 * PD-202605-00117 · 00118 · 00119 (5월 1주차, 임시저장) 를 재고보유로 되돌림.
 *  - 각 결의서로 묶인 OrderRouting(DECISION,ACTIVE) → route=HOLD, decision_id=null, hold_reason='재고 있음'.
 *  - 결의서 자체는 소프트 삭제(deleted_at=now).
 * LOCKED 결의서는 안전상 건너뜀.
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const TARGETS = ['PD-202605-00117', 'PD-202605-00118', 'PD-202605-00119'];
const REASON = '재고 있음';

(async () => {
  const decs: any[] = await (prisma as any).purchaseDecision.findMany({
    where: { decision_no: { in: TARGETS }, deleted_at: null },
    select: { id: true, decision_no: true, status: true, vendor_id: true },
  });
  console.log('대상 결의서:');
  for (const d of decs) console.log(`  ${d.decision_no} ${d.status} id=${d.id}`);

  const now = new Date();
  for (const d of decs) {
    if (d.status === 'LOCKED') { console.log(`  ⏭  ${d.decision_no} LOCKED — 건너뜀`); continue; }

    const flipped = await (prisma as any).orderRouting.updateMany({
      where: { decision_id: d.id, route: 'DECISION', status: 'ACTIVE' },
      data: { route: 'HOLD', hold_reason: REASON, decision_id: null },
    });
    const del = await (prisma as any).purchaseDecision.update({
      where: { id: d.id },
      data: { deleted_at: now },
    });
    console.log(`  ✅ ${d.decision_no} → 라우팅 ${flipped.count}건 HOLD 전환 + 결의서 소프트삭제 (deleted_at=${del.deleted_at?.toISOString()})`);
  }

  // 결과 요약
  const remainingActive = await (prisma as any).orderRouting.count({
    where: { decision_id: { in: decs.map((d: any) => d.id) }, status: 'ACTIVE' },
  });
  const newHold = await (prisma as any).orderRouting.count({
    where: { route: 'HOLD', status: 'ACTIVE', hold_reason: REASON },
  });
  console.log(`\n검증: 해당 결의서 ACTIVE 라우팅 남은수=${remainingActive} (0 이어야 정상)`);
  console.log(`검증: 전체 HOLD/ACTIVE/'재고 있음' = ${newHold}건`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
