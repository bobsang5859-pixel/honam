// 부서별 보관함 / 재고 / 최근 불출 비교 검증
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

console.log('\n=== 1. 부서별 InventoryLocation 상태 ===\n');
const depts = await prisma.department.findMany({
  where: { is_active: true, deleted_at: null },
  orderBy: { name: 'asc' },
});
let locCount = 0;
for (const d of depts) {
  const loc = await prisma.inventoryLocation.findFirst({
    where: { department_id: d.id, deleted_at: null, is_active: true },
  });
  const status = loc ? `✓ ${loc.code} (${loc.name})` : '⚠ 없음 (불출 시 자동 생성됨)';
  if (loc) locCount++;
  console.log(`  ${d.name.padEnd(10)} ${status}`);
}
console.log(`\n  → 부서 ${depts.length}개 중 ${locCount}개 보관함 등록됨`);

console.log('\n=== 2. 부서별 보관함 재고 합계 ===\n');
const deptLocs = await prisma.inventoryLocation.findMany({
  where: { department_id: { not: null }, deleted_at: null },
  include: {
    department: { select: { name: true } },
    inventory: { select: { item_id: true, on_hand_qty: true } },
  },
});
for (const loc of deptLocs) {
  const total = loc.inventory.reduce((s, i) => s + Number(i.on_hand_qty), 0);
  const itemCount = loc.inventory.filter(i => Number(i.on_hand_qty) > 0).length;
  if (itemCount === 0 && total === 0) continue;
  console.log(`  ${(loc.department?.name ?? '?').padEnd(10)} | ${itemCount} 품목 보유 | 총 ${total} 개`);
}

console.log('\n=== 3. 최근 불출 5건 — 부서 재고 반영 확인 ===\n');
const recent = await prisma.stockOut.findMany({
  where: { deleted_at: null, status: { not: 'REVERSED' } },
  include: {
    department: { select: { id: true, name: true } },
    items: { include: { item: { select: { name: true, category: true } } } },
  },
  orderBy: { issued_at: 'desc' },
  take: 5,
});

for (const so of recent) {
  console.log(`▶ ${so.so_no} | ${so.department?.name} | ${new Date(so.issued_at).toLocaleString('ko-KR')}`);
  const deptLoc = await prisma.inventoryLocation.findFirst({
    where: { department_id: so.department.id, deleted_at: null, is_active: true },
  });
  if (!deptLoc) {
    console.log(`  ⚠ 부서 보관함 없음`);
    continue;
  }
  // 비품 제외 라인만 — 부서 보관함에 들어갔어야 할 라인
  const nonEquip = so.items.filter(it => !String(it.item?.category ?? '').startsWith('EQUIP_'));
  console.log(`  부서 보관함: ${deptLoc.code} (${deptLoc.name})`);
  console.log(`  소모품 라인 ${nonEquip.length} 개 — 각 라인의 부서 재고 현황:`);
  for (const it of nonEquip.slice(0, 5)) {
    const inv = await prisma.inventory.findUnique({
      where: { item_id_location_id: { item_id: it.item_id, location_id: deptLoc.id } },
    });
    const onHand = inv ? Number(inv.on_hand_qty) : 0;
    console.log(`    · ${it.item?.name ?? it.item_id} | 불출 ${Number(it.issued_qty)} | 부서 현 재고 ${onHand}`);
  }
  if (nonEquip.length > 5) console.log(`    ... 외 ${nonEquip.length - 5}개 생략`);
}

console.log('\n=== 4. 합산 검증 — 한 품목 기준 (CENTRAL 차감 vs 부서 합산) ===\n');
// CENTRAL에서 차감된 총량 vs 부서별 합산이 일치하는지 (옛 불출은 부서에 자동 반영 안됨)
const sample = await prisma.stockOutItem.groupBy({
  by: ['item_id'],
  where: { stock_out: { status: { not: 'REVERSED' }, deleted_at: null } },
  _sum: { issued_qty: true },
  orderBy: { _sum: { issued_qty: 'desc' } },
  take: 5,
});
for (const s of sample) {
  const item = await prisma.item.findUnique({ where: { id: s.item_id }, select: { name: true, category: true } });
  if (String(item?.category ?? '').startsWith('EQUIP_')) continue;
  const totalIssued = Number(s._sum.issued_qty ?? 0);
  const deptSum = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM(inv.on_hand_qty), 0) AS qty
     FROM inventory inv
     JOIN inventory_locations loc ON loc.id = inv.location_id
     WHERE inv.item_id = ? AND loc.department_id IS NOT NULL AND loc.deleted_at IS NULL`,
    s.item_id,
  );
  const deptTotal = Number(deptSum[0]?.qty ?? 0);
  const central = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(SUM(inv.on_hand_qty), 0) AS qty
     FROM inventory inv
     JOIN inventory_locations loc ON loc.id = inv.location_id
     WHERE inv.item_id = ? AND loc.department_id IS NULL`,
    s.item_id,
  );
  const centralQty = Number(central[0]?.qty ?? 0);
  console.log(`  ${item?.name ?? s.item_id}`);
  console.log(`    누적 불출: ${totalIssued}  |  창고 현재: ${centralQty}  |  부서 합산: ${deptTotal}`);
}

await prisma.$disconnect();
