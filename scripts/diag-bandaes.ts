import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
(async () => {
  // 4병동 + 밴드에스 검색
  const dept = await prisma.department.findFirst({ where: { name: '4병동', deleted_at: null } });
  if (!dept) { console.log('4병동 없음'); return; }
  const items = await prisma.item.findMany({
    where: { name: { contains: '밴드에스' }, deleted_at: null },
    select: { id: true, item_code: true, name: true, sub_category: true, pack_size: true, uom: true, purchase_uom: true, issue_uom: true },
  });
  console.log(`밴드에스 후보: ${items.length}건`);
  for (const it of items) {
    console.log(`  ${it.item_code} ${it.name} (${it.sub_category}) pack_size=${it.pack_size} uom=${it.uom}/${it.purchase_uom}/${it.issue_uom}`);
  }
  if (items.length === 0) return;

  for (const item of items) {
    console.log(`\n=== ${item.name} (${item.item_code}) ===`);
    // 4병동의 ward_request 중 이 품목 포함된 것
    const wrs = await prisma.wardRequest.findMany({
      where: {
        department_id: dept.id,
        deleted_at: null,
        items: { some: { item_id: item.id } },
      },
      include: {
        items: { where: { item_id: item.id } },
        approval_actions: {
          orderBy: { created_at: 'desc' },
          take: 1,
          include: { items: { where: { item_id: item.id } } },
        },
      },
    });
    for (const wr of wrs as any[]) {
      const reqQty = wr.items[0]?.requested_qty;
      const action = wr.approval_actions[0];
      const apprQty = action?.items[0]?.approved_qty;
      console.log(`  ${wr.request_no} ${wr.status} 요청${reqQty} 승인${apprQty ?? '-'}`);

      // 불출 이력
      const sois = await prisma.stockOutItem.findMany({
        where: {
          item_id: item.id,
          stock_out: { ward_request_id: wr.id, deleted_at: null, status: { not: 'REVERSED' } },
        } as any,
        include: { stock_out: { select: { so_no: true, status: true } } },
      });
      let issued = 0;
      for (const soi of sois as any[]) {
        issued += Number(soi.issued_qty);
        console.log(`    ↳ ${soi.stock_out.so_no} ${soi.stock_out.status} 불출 ${soi.issued_qty}`);
      }
      console.log(`    잔여: 승인${apprQty ?? 0} - 불출${issued} = ${Number(apprQty ?? 0) - issued}`);
    }
  }
})()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
