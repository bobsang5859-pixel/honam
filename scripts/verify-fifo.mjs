import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// 최근 병동 불출 5건의 lot 할당 내역과 FIFO 정합성 확인
const recent = await prisma.stockOut.findMany({
  where: {
    ward_request_id: { not: null },
    deleted_at: null,
    status: { not: 'REVERSED' },
  },
  include: {
    department: { select: { name: true } },
    items: {
      include: {
        item: { select: { name: true, item_code: true } },
        allocations: {
          include: {
            inventory_lot: { select: { received_at: true, unit_cost: true, goods_receipt_id: true } },
          },
        },
      },
    },
  },
  orderBy: { issued_at: 'desc' },
  take: 5,
});

console.log(`\n=== 최근 병동 불출 ${recent.length}건 FIFO 검증 ===\n`);

for (const so of recent) {
  console.log(`▶ ${so.so_no} | ${so.department?.name ?? '-'} | ${new Date(so.issued_at).toLocaleString('ko-KR')}`);
  let soTotal = 0;
  let multiLotCount = 0;
  for (const it of so.items) {
    const allocs = it.allocations ?? [];
    const allocTotal = allocs.reduce((s, a) => s + Number(a.line_amount), 0);
    soTotal += allocTotal;

    // 정렬 검증: lot.received_at 이 오름차순(=FIFO)인지
    const sortedAsc = [...allocs].sort((a, b) =>
      new Date(a.inventory_lot?.received_at ?? 0).getTime()
      - new Date(b.inventory_lot?.received_at ?? 0).getTime()
    );
    const isFifo = allocs.every((a, i) => a.id === sortedAsc[i].id);

    // lot별 단가 다름 여부
    const distinctCosts = new Set(allocs.map(a => Number(a.unit_cost).toFixed(2)));
    const multiLot = allocs.length > 1;
    if (multiLot) multiLotCount++;

    const flag = !isFifo ? '⚠ FIFO 어긋남' : multiLot && distinctCosts.size > 1 ? '◎ 다단가 혼합' : '';
    console.log(`   · ${it.item?.name ?? it.item_id} (${it.item?.item_code ?? ''}) ${Number(it.issued_qty)}${' '.repeat(2)}→ ${allocTotal.toLocaleString('ko-KR')}원  ${flag}`);

    for (const a of allocs) {
      const lot = a.inventory_lot;
      const lotDate = lot?.received_at ? new Date(lot.received_at).toLocaleDateString('ko-KR') : '재고없음(음수)';
      console.log(`       lot ${lotDate} | 단가 ${Number(a.unit_cost).toLocaleString('ko-KR')}원 × ${Number(a.issued_qty)} = ${Number(a.line_amount).toLocaleString('ko-KR')}원`);
    }
  }
  console.log(`   합계: ${soTotal.toLocaleString('ko-KR')}원 (lot 분할 라인 ${multiLotCount}건)\n`);
}

await prisma.$disconnect();
