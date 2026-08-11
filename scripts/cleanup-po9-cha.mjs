// PO-202605-00009 절사 라인 정리:
//  1) 절사 라인(ITEM-0151) PO 에서 삭제
//  2) PO.total_amount 재계산
//  3) 연결 GR(GR-202605-00005).adjustment_amount += 245, note 에 이관 표시
//  4) PO.status = CLOSED
// 모든 작업 한 트랜잭션. 감사 로그 기록.
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

const PO_NO = 'PO-202605-00009';
const ITEM_CODE = 'ITEM-0151';

const po = await prisma.purchaseOrder.findUnique({
  where: { po_no: PO_NO },
  include: { po_items: { include: { item: true } }, receipts: true },
});
if (!po) throw new Error(`${PO_NO} 없음`);

const cutLine = po.po_items.find(l => l.item.item_code === ITEM_CODE);
if (!cutLine) throw new Error(`${ITEM_CODE} 라인 없음`);

const cutAmount = Math.abs(Number(cutLine.line_amount));
const oldPoTotal = Number(po.total_amount);
const newPoTotal = po.po_items
  .filter(l => l.id !== cutLine.id)
  .reduce((s, l) => s + Number(l.line_amount), 0);

console.log(`\n=== PO-202605-00009 절사 라인 정리 ===`);
console.log(`  현재 PO total_amount: ${oldPoTotal.toLocaleString()}원`);
console.log(`  절사 라인 line_amount: ${Number(cutLine.line_amount).toLocaleString()}원 (절사 금액 = ${cutAmount.toLocaleString()}원)`);
console.log(`  절사 라인 제외 합계: ${newPoTotal.toLocaleString()}원`);
console.log(`  연결 GR 수: ${po.receipts.length}`);

if (po.receipts.length !== 1) {
  console.log(`  ⚠ 연결 GR이 1건이 아님 (${po.receipts.length}건). 첫 번째 GR 에 adjustment 추가합니다.`);
}
const gr = po.receipts[0];
if (!gr) throw new Error('연결된 GR 없음 — 절사를 옮길 대상이 없습니다.');
console.log(`  대상 GR: ${gr.gr_no}, 현재 adjustment_amount=${Number(gr.adjustment_amount)}, note="${gr.adjustment_note}"`);

await prisma.$transaction(async (tx) => {
  // 1) PurchaseOrderItem 삭제
  await tx.purchaseOrderItem.delete({ where: { id: cutLine.id } });

  // 2) PO total_amount 재계산 + status CLOSED
  await tx.purchaseOrder.update({
    where: { id: po.id },
    data: { total_amount: newPoTotal, status: 'CLOSED' },
  });

  // 3) GR.adjustment_amount += cutAmount, note 이관 표시
  const oldAdj = Number(gr.adjustment_amount ?? 0);
  const newAdj = oldAdj + cutAmount;
  const oldNote = String(gr.adjustment_note ?? '').trim();
  const addNote = `구 절사 라인(${ITEM_CODE}) 이관 +${cutAmount}원`;
  const newNote = oldNote ? `${oldNote}; ${addNote}` : addNote;
  await tx.goodsReceipt.update({
    where: { id: gr.id },
    data: { adjustment_amount: newAdj, adjustment_note: newNote },
  });

  // 4) audit logs
  await tx.auditLog.create({
    data: {
      id: randomUUID(),
      actor_user_id: null,
      actor_role_snapshot: '',
      action: 'CLEANUP',
      entity_type: 'purchase_order_items',
      entity_id: cutLine.id,
      before_json: JSON.stringify({ item_code: ITEM_CODE, qty: Number(cutLine.ordered_qty), unit_price: Number(cutLine.unit_price), line_amount: Number(cutLine.line_amount) }),
      after_json: JSON.stringify({ deleted: true }),
      reason: '구 절사 라인 → GR.adjustment_amount 로 이관',
      ip: '',
    },
  });
  await tx.auditLog.create({
    data: {
      id: randomUUID(),
      actor_user_id: null,
      actor_role_snapshot: '',
      action: 'UPDATE',
      entity_type: 'purchase_orders',
      entity_id: po.id,
      before_json: JSON.stringify({ total_amount: oldPoTotal, status: po.status }),
      after_json: JSON.stringify({ total_amount: newPoTotal, status: 'CLOSED' }),
      reason: '절사 라인 제거 + 발주 마감',
      ip: '',
    },
  });
  await tx.auditLog.create({
    data: {
      id: randomUUID(),
      actor_user_id: null,
      actor_role_snapshot: '',
      action: 'UPDATE',
      entity_type: 'goods_receipts',
      entity_id: gr.id,
      before_json: JSON.stringify({ adjustment_amount: oldAdj, adjustment_note: oldNote }),
      after_json: JSON.stringify({ adjustment_amount: newAdj, adjustment_note: newNote }),
      reason: '구 절사 라인 이관',
      ip: '',
    },
  });
});

// 검증
const after = await prisma.purchaseOrder.findUnique({
  where: { po_no: PO_NO },
  include: { po_items: true, receipts: true },
});
const afterGr = await prisma.goodsReceipt.findUnique({ where: { id: gr.id } });
console.log(`\n=== 결과 ===`);
console.log(`  PO total_amount: ${oldPoTotal.toLocaleString()} → ${Number(after.total_amount).toLocaleString()}원`);
console.log(`  PO status: PARTIAL_RECEIVED → ${after.status}`);
console.log(`  PO 라인 수: ${po.po_items.length} → ${after.po_items.length}`);
console.log(`  GR adjustment_amount: ${Number(gr.adjustment_amount)} → ${Number(afterGr.adjustment_amount)}원`);
console.log(`  GR adjustment_note: "${afterGr.adjustment_note}"`);
console.log(`\n  PO 발주 라인합 = ${Number(after.total_amount).toLocaleString()}`);
console.log(`  GR 라인합 - adjustment = ${Number(after.total_amount).toLocaleString()} - ${Number(afterGr.adjustment_amount)} = ${(Number(after.total_amount) - Number(afterGr.adjustment_amount)).toLocaleString()}원 (실 결제액)`);

await prisma.$disconnect();
