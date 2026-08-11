import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
(async () => {
  const item = await prisma.item.findFirst({
    where: { name: { contains: '밴드에스' }, deleted_at: null },
  });
  if (!item) { console.log('밴드에스 못 찾음'); return; }
  console.log('=== 밴드에스 마스터 ===');
  console.log(`코드: ${item.item_code}, 이름: ${item.name}`);
  console.log(`pack_size: ${item.pack_size}  ← 1박스에 ${item.pack_size}개 들어있다고 시스템이 인식`);
  console.log(`uom (issue): ${item.uom}, purchase_uom: ${item.purchase_uom}, issue_uom: ${item.issue_uom}`);

  // 4병동의 모든 PO 에서 밴드에스 찾기
  const poItems = await prisma.purchaseOrderItem.findMany({
    where: { item_id: item.id, purchase_order: { deleted_at: null } as any },
    include: { purchase_order: { select: { po_no: true, status: true, sources: { include: { ward_request: { include: { department: { select: { name: true } } } } } } } } } as any,
  });
  console.log(`\n=== 발주 이력 (밴드에스 전체) ===`);
  for (const po of poItems as any[]) {
    const sources = po.purchase_order.sources;
    const depts = new Set(sources.map((s: any) => s.ward_request?.department?.name));
    console.log(`  ${po.purchase_order.po_no} ${po.purchase_order.status} 발주수량 ${po.ordered_qty} (단가 ${po.unit_price})  부서:${[...depts].join(',') || '-'}`);
  }

  // 4병동 ward_request → 밴드에스 신청·승인
  const dept = await prisma.department.findFirst({ where: { name: '4병동', deleted_at: null } });
  if (dept) {
    const wrs = await prisma.wardRequest.findMany({
      where: {
        department_id: dept.id,
        deleted_at: null,
        items: { some: { item_id: item.id } },
      },
      include: {
        items: { where: { item_id: item.id } },
        approval_actions: { orderBy: { created_at: 'desc' }, take: 1, include: { items: { where: { item_id: item.id } } } },
      },
    });
    console.log(`\n=== 4병동 신청 이력 ===`);
    for (const wr of wrs as any[]) {
      const reqQty = wr.items[0]?.requested_qty;
      const apprQty = wr.approval_actions[0]?.items[0]?.approved_qty;
      console.log(`  ${wr.request_no} ${wr.status} 요청${reqQty} 승인${apprQty ?? '-'}`);
    }
  }
})()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
