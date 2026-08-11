// 음수재고(allocation.inventory_lot_id = NULL) 불출 라인을 잔여 lot 으로 재할당.
// 한 음수 allocation 이 여러 lot 에 걸치면 split (새 allocation row 추가).
//
// 사용:
//   node scripts/backfill-negative-allocations.mjs          # DRY RUN — 변경 미리보기만
//   node scripts/backfill-negative-allocations.mjs --apply  # 실제 적용
//
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

console.log(APPLY ? '\n*** APPLY 모드 — DB 에 실제 반영 ***\n' : '\n*** DRY RUN — 변경 미리보기 (DB 안 건드림) ***\n');

// 1) 음수재고 allocation 전부 — issued_at 오래된 순서로
const rawNeg = await prisma.$queryRawUnsafe(`
  SELECT a.id as alloc_id, a.issued_qty, a.stock_out_item_id,
         soi.item_id, soi.location_id,
         so.so_no, so.issued_at, so.id as stock_out_id,
         d.name as dept_name, i.name as item_name
  FROM stock_out_lot_allocations a
  JOIN stock_out_items soi ON soi.id = a.stock_out_item_id
  JOIN stock_out so ON so.id = soi.stock_out_id
  LEFT JOIN departments d ON d.id = so.department_id
  LEFT JOIN items i ON i.id = soi.item_id
  WHERE a.inventory_lot_id IS NULL
    AND so.deleted_at IS NULL
    AND so.status != 'REVERSED'
  ORDER BY so.issued_at ASC, a.id ASC
`);

console.log(`음수재고 allocation: ${rawNeg.length}건\n`);

if (rawNeg.length === 0) {
  console.log('보정할 음수재고 라인이 없습니다.');
  await prisma.$disconnect();
  process.exit(0);
}

// 2) (item_id, location_id) 별 잔여 lot 인메모리 캐시
const lotCacheKey = (itemId, locationId) => `${itemId}::${locationId}`;
const lotCache = new Map(); // key -> [{ id, received_at, unit_cost, remaining_qty }, ...] sorted by received_at ASC

async function getLots(itemId, locationId) {
  const key = lotCacheKey(itemId, locationId);
  if (lotCache.has(key)) return lotCache.get(key);
  const lots = await prisma.$queryRawUnsafe(`
    SELECT id, received_at, unit_cost, remaining_qty
    FROM inventory_lots
    WHERE deleted_at IS NULL AND item_id = ? AND location_id = ? AND remaining_qty > 0
    ORDER BY datetime(received_at) ASC, id ASC
  `, itemId, locationId);
  // remaining_qty 는 Number 로 정규화
  const norm = lots.map(l => ({ id: l.id, received_at: l.received_at, unit_cost: Number(l.unit_cost), remaining_qty: Number(l.remaining_qty) }));
  lotCache.set(key, norm);
  return norm;
}

// 3) 보정 시뮬레이션
const plan = []; // { allocId, item_name, so_no, originalQty, splits: [{ lotId, qty, unit_cost }] , unresolvedQty }
let totalRecoveredAmount = 0;
let totalUnresolvedQty = 0;

for (const neg of rawNeg) {
  const lots = await getLots(neg.item_id, neg.location_id);
  let remain = Number(neg.issued_qty);
  const splits = [];
  for (const lot of lots) {
    if (remain <= 0) break;
    if (lot.remaining_qty <= 0) continue;
    const take = Math.min(remain, lot.remaining_qty);
    splits.push({ lotId: lot.id, qty: take, unit_cost: lot.unit_cost, received_at: lot.received_at });
    lot.remaining_qty -= take;
    remain -= take;
  }
  const recovered = splits.reduce((s, sp) => s + sp.qty * sp.unit_cost, 0);
  totalRecoveredAmount += recovered;
  if (remain > 0) totalUnresolvedQty += remain;
  plan.push({
    allocId: neg.alloc_id,
    stockOutItemId: neg.stock_out_item_id,
    itemName: neg.item_name,
    soNo: neg.so_no,
    deptName: neg.dept_name,
    issuedAt: neg.issued_at,
    originalQty: Number(neg.issued_qty),
    splits,
    unresolvedQty: remain,
  });
}

// 4) 미리보기 출력
console.log('=== 보정 계획 ===\n');
for (const p of plan) {
  const flag = p.unresolvedQty > 0 ? ` ⚠ ${p.unresolvedQty}개 잔여재고 부족` : '';
  console.log(`${p.soNo} | ${p.deptName} | ${new Date(p.issuedAt).toLocaleString('ko-KR')}`);
  console.log(`  ${p.itemName} × ${p.originalQty} ${flag}`);
  for (const sp of p.splits) {
    const lotDate = new Date(sp.received_at).toLocaleDateString('ko-KR');
    console.log(`    → lot ${lotDate} | ${sp.qty} × ${sp.unit_cost.toLocaleString('ko-KR')}원 = ${(sp.qty * sp.unit_cost).toLocaleString('ko-KR')}원`);
  }
  console.log('');
}

console.log(`---`);
console.log(`보정 가능 allocation: ${plan.filter(p => p.splits.length > 0).length}건 / ${plan.length}건`);
console.log(`총 회수 금액: ${totalRecoveredAmount.toLocaleString('ko-KR')}원`);
console.log(`잔여재고 부족으로 0원 유지: ${totalUnresolvedQty}개\n`);

if (!APPLY) {
  console.log('미리보기 완료. 실제 적용하려면 --apply 옵션으로 다시 실행하세요.');
  await prisma.$disconnect();
  process.exit(0);
}

// 5) 실제 적용 (트랜잭션)
console.log('=== 실제 적용 중 ===\n');
await prisma.$transaction(async (tx) => {
  for (const p of plan) {
    if (p.splits.length === 0) continue;
    const [first, ...rest] = p.splits;
    // 첫 split 은 기존 allocation 갱신
    await tx.$executeRawUnsafe(
      `UPDATE stock_out_lot_allocations
       SET inventory_lot_id = ?, issued_qty = ?, unit_cost = ?, line_amount = ?
       WHERE id = ?`,
      first.lotId, first.qty, first.unit_cost, Number((first.qty * first.unit_cost).toFixed(2)), p.allocId
    );
    // 나머지 split 은 새 allocation row
    for (const sp of rest) {
      await tx.$executeRawUnsafe(
        `INSERT INTO stock_out_lot_allocations (id, stock_out_item_id, inventory_lot_id, issued_qty, unit_cost, line_amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        randomUUID(), p.stockOutItemId, sp.lotId, sp.qty, sp.unit_cost, Number((sp.qty * sp.unit_cost).toFixed(2))
      );
    }
    // 잔여재고 부족분(unresolvedQty)이 있으면 0원짜리 음수 allocation 으로 별도 row — 첫 allocation 의 qty 가 줄어서 나머지가 떨어져 나옴
    if (p.unresolvedQty > 0) {
      await tx.$executeRawUnsafe(
        `INSERT INTO stock_out_lot_allocations (id, stock_out_item_id, inventory_lot_id, issued_qty, unit_cost, line_amount, created_at)
         VALUES (?, ?, NULL, ?, 0, 0, datetime('now'))`,
        randomUUID(), p.stockOutItemId, p.unresolvedQty
      );
    }
    // lot 잔여 차감
    for (const sp of p.splits) {
      await tx.$executeRawUnsafe(
        `UPDATE inventory_lots SET remaining_qty = remaining_qty - ? WHERE id = ?`,
        sp.qty, sp.lotId
      );
    }
  }
}, { timeout: 60000 });

console.log(`완료. 회수 금액 ${totalRecoveredAmount.toLocaleString('ko-KR')}원 반영.`);
await prisma.$disconnect();
