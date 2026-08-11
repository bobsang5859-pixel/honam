import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// 4월자 소급 등록 GR 들의 lot 들과 같은 품목의 모든 lot 비교
const aprilGrIds = (await prisma.goodsReceipt.findMany({
  where: {
    deleted_at: null,
    received_at: { lt: new Date('2026-05-01T15:00:00.000Z') }, // KST 5/1 자정 ≈ UTC 4/30 15:00
  },
  select: { id: true, gr_no: true, received_at: true, confirmed_at: true, status: true },
})).filter(gr => new Date(gr.received_at).getTime() < new Date('2026-05-01T00:00:00+09:00').getTime());

console.log(`\n=== 4월 입고 GR ${aprilGrIds.length}건 ===`);
for (const gr of aprilGrIds) {
  console.log(`  ${gr.gr_no} | 입고일 ${new Date(gr.received_at).toLocaleDateString('ko-KR')} | 검수확정 ${gr.confirmed_at ? new Date(gr.confirmed_at).toLocaleString('ko-KR') : '미확정'} | ${gr.status}`);
}

// 4월자 GR 에서 생성된 lot 들
const aprilLots = await prisma.inventoryLot.findMany({
  where: { deleted_at: null, goods_receipt_id: { in: aprilGrIds.map(g => g.id) } },
  include: {
    item: { select: { name: true, item_code: true } },
    goods_receipt: { select: { gr_no: true } },
  },
});

console.log(`\n=== 4월 GR 에서 생성된 lot ${aprilLots.length}건 ===\n`);

// 동일 품목의 모든 lot 모아서 FIFO 정렬해서 보여주기
const itemIds = [...new Set(aprilLots.map(l => l.item_id))];
for (const itemId of itemIds) {
  const allLots = await prisma.inventoryLot.findMany({
    where: { deleted_at: null, item_id: itemId },
    include: {
      goods_receipt: { select: { gr_no: true } },
      allocations: {
        include: {
          stock_out_item: {
            include: {
              stock_out: { select: { so_no: true, issued_at: true, department: { select: { name: true } } } },
            },
          },
        },
        orderBy: { created_at: 'asc' },
      },
    },
    orderBy: { received_at: 'asc' },
  });
  const itemName = aprilLots.find(l => l.item_id === itemId)?.item?.name ?? itemId;
  const itemCode = aprilLots.find(l => l.item_id === itemId)?.item?.item_code ?? '';
  console.log(`▶ ${itemName} (${itemCode}) — lot ${allLots.length}개`);
  for (const lt of allLots) {
    const recvDate = new Date(lt.received_at).toLocaleDateString('ko-KR');
    const isApril = aprilGrIds.some(g => g.id === lt.goods_receipt_id);
    const marker = isApril ? '◆' : ' ';
    const consumedQty = lt.allocations.reduce((s, a) => s + Number(a.issued_qty), 0);
    console.log(`   ${marker} ${recvDate} (${lt.goods_receipt?.gr_no}) 단가 ${Number(lt.unit_cost).toLocaleString('ko-KR')}원 / 입고 ${Number(lt.received_qty)} 잔여 ${Number(lt.remaining_qty)} 소비 ${consumedQty}`);
    for (const a of lt.allocations) {
      const so = a.stock_out_item?.stock_out;
      const when = so?.issued_at ? new Date(so.issued_at).toLocaleString('ko-KR') : '?';
      console.log(`         · ${so?.so_no ?? '?'} | ${so?.department?.name ?? '-'} | ${when} | ${Number(a.issued_qty)} × ${Number(a.unit_cost).toLocaleString('ko-KR')}원`);
    }
  }
  // 이 품목으로 최근 불출이 있었는지 (lot 없이 음수 처리된 것 포함)
  const recentSos = await prisma.stockOutItem.findMany({
    where: { item_id: itemId, stock_out: { deleted_at: null } },
    include: {
      stock_out: { select: { so_no: true, issued_at: true, status: true, department: { select: { name: true } } } },
      allocations: { select: { inventory_lot_id: true, issued_qty: true, unit_cost: true } },
    },
    orderBy: { stock_out: { issued_at: 'desc' } },
    take: 3,
  });
  if (recentSos.length > 0) {
    console.log(`     최근 불출 ${recentSos.length}건:`);
    for (const soi of recentSos) {
      const so = soi.stock_out;
      const when = so?.issued_at ? new Date(so.issued_at).toLocaleString('ko-KR') : '?';
      const nullAllocs = soi.allocations.filter(a => !a.inventory_lot_id);
      const flag = nullAllocs.length > 0 ? `  ⚠ 음수재고 ${nullAllocs.reduce((s, a) => s + Number(a.issued_qty), 0)}개 (단가0)` : '';
      console.log(`         ${so?.so_no} | ${so?.department?.name} | ${when} | 불출 ${Number(soi.issued_qty)}${flag}`);
    }
  }
  console.log('');
}

await prisma.$disconnect();
