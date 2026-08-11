// 헬스체크 5종 직접 호출해서 어떤 알림이 몇 건씩 나오는지 확인 (info만)
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const STALE_DAYS = 14;

// 1. 14일 이상 SUBMITTED 상태 신청
const staleCutoff = new Date(Date.now() - STALE_DAYS * 86400000);
const stale = await prisma.wardRequest.count({
  where: { deleted_at: null, status: 'SUBMITTED', submitted_at: { lt: staleCutoff } },
});
console.log(`주의: 오래된 미처리 신청 (>${STALE_DAYS}일): ${stale}건`);

// 2. SLA 초과 GR (PENDING 24시간 이상)
const slaCutoff = new Date(Date.now() - 24 * 3600 * 1000);
const sla = await prisma.stockOut.count({
  where: { deleted_at: null, status: 'RECEIPT_PENDING', issued_at: { lt: slaCutoff } },
});
console.log(`주의: SLA 초과 수령검수 대기 (>24h): ${sla}건`);

// 3. OPEN 후속작업
const followups = await prisma.stockOutFollowUp.count({
  where: { status: 'OPEN' },
});
const grFollowups = await prisma.pendingReceiptFollowUp.count({
  where: { status: 'OPEN' },
});
console.log(`주의: OPEN 불출 후속작업: ${followups}건`);
console.log(`주의: OPEN 입고 후속작업: ${grFollowups}건`);

// 4. 중복 신청
const dups = await prisma.$queryRawUnsafe(`
  SELECT department_id, request_type, period_start, COUNT(*) as cnt
  FROM ward_requests
  WHERE deleted_at IS NULL AND status IN ('SUBMITTED', 'APPROVED', 'PARTIAL_APPROVED')
  GROUP BY department_id, request_type, period_start
  HAVING cnt > 1
`);
console.log(`주의: 중복 신청 그룹: ${dups.length}건`);

// 5. 부서 미배정 환자
const unassigned = await prisma.patient.count({
  where: { status: 'ADMITTED', deleted_at: null, department_id: '' },
});
console.log(`주의: 부서 미배정 입원환자: ${unassigned}건`);

// 음수 lot
const negLots = await prisma.$queryRawUnsafe(`SELECT COUNT(*) as cnt FROM inventory_lots WHERE deleted_at IS NULL AND remaining_qty < 0`);
console.log(`긴급: 음수 lot: ${negLots[0].cnt}건`);

// PO 상태 불일치
const poInconsist = await prisma.purchaseOrder.count({
  where: { deleted_at: null, status: 'PARTIAL_RECEIVED' },
});
console.log(`경고: PARTIAL_RECEIVED 발주 수: ${poInconsist}건 (단순 카운트, 실제 불일치 아닐 수 있음)`);

await prisma.$disconnect();
