import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

const TARGET_REQUEST_NO = 'WR-202605-00064';

const wr = await prisma.wardRequest.findFirst({
  where: { request_no: TARGET_REQUEST_NO, deleted_at: null },
  include: { items: true, department: true, requester: true },
});

if (!wr) {
  console.error(`Not found: ${TARGET_REQUEST_NO}`);
  process.exit(1);
}

if (wr.status !== 'DRAFT') {
  console.error(`Status is ${wr.status}, not DRAFT. Aborting.`);
  process.exit(1);
}
if (wr.items.length === 0) {
  console.error('No items. Aborting.');
  process.exit(1);
}

const requestType = wr.request_type ?? 'CONSUMABLE_REGULAR';

// 중복 체크
if (requestType !== 'EQUIPMENT' && requestType !== 'ADHOC') {
  const dup = await prisma.wardRequest.findFirst({
    where: {
      id: { not: wr.id },
      department_id: wr.department_id,
      request_type: requestType,
      period_start: wr.period_start,
      status: { in: ['SUBMITTED', 'APPROVED', 'PARTIAL_APPROVED'] },
      deleted_at: null,
    },
  });
  if (dup) {
    console.error(`중복 신청 존재: ${dup.request_no} (${dup.status}). Aborting.`);
    process.exit(1);
  }
}

// 트랜잭션: baseline 계산 + 상태 업데이트
const updated = await prisma.$transaction(async (tx) => {
  if (requestType !== 'EQUIPMENT') {
    const patientStat = await tx.patientStat.findFirst({
      where: {
        department_id: wr.department_id,
        period_type: 'MONTH',
        period_start: { lte: new Date(wr.period_start) },
        period_end: { gte: new Date(wr.period_end) },
        deleted_at: null,
      },
    });
    const patientCount = patientStat?.patient_count ?? 0;
    console.log(`[baseline] patient_count=${patientCount}`);

    const overPct = 0.15;
    for (const item of wr.items) {
      const baseline = item.item_id
        ? await tx.usageBaseline.findFirst({
            where: {
              item_id: item.item_id,
              deleted_at: null,
              effective_from: { lte: new Date() },
              OR: [{ effective_to: null }, { effective_to: { gte: new Date() } }],
            },
            orderBy: { version: 'desc' },
          })
        : null;

      let baselineQty = 0;
      const flags = [];
      if (!baseline || patientCount === 0) {
        flags.push('BASELINE_MISSING');
      } else {
        baselineQty = Number(baseline.qty_per_patient) * patientCount;
        const diff = Math.abs(Number(item.requested_qty) - baselineQty);
        if (baselineQty > 0 && diff / baselineQty > overPct) flags.push('OVER_15PCT');
      }
      const diffPct = baselineQty > 0
        ? ((Number(item.requested_qty) - baselineQty) / baselineQty) * 100
        : 0;

      await tx.wardRequestItem.update({
        where: { id: item.id },
        data: {
          baseline_qty: baselineQty,
          diff_pct: diffPct,
          policy_flags: JSON.stringify(flags),
        },
      });
    }
  }

  return await tx.wardRequest.update({
    where: { id: wr.id },
    data: { status: 'SUBMITTED', submitted_at: new Date() },
  });
});

// audit log
await prisma.auditLog.create({
  data: {
    id: randomUUID(),
    actor_user_id: wr.requester_id,
    actor_role_snapshot: '',
    action: 'UPDATE',
    entity_type: 'ward_requests',
    entity_id: wr.id,
    before_json: JSON.stringify({ status: 'DRAFT' }),
    after_json: JSON.stringify({ status: 'SUBMITTED' }),
    reason: '관리자 콘솔에서 임시저장 강제 제출 (오류 복구)',
    ip: '',
  },
});

console.log(`\n✓ ${updated.request_no} → SUBMITTED (submitted_at=${updated.submitted_at?.toISOString()})`);
await prisma.$disconnect();
