// GR-202601-00010 에 누락된 D/LARYNGOSCOPE (ITEM-0142) 라인 추가
// 거래내역: 2026-01-07 × 1 @ 9,680원
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

const GR_NO = 'GR-202601-00010';
const ITEM_CODE = 'ITEM-0142';
const QTY = 1;
const UNIT_PRICE = 9680;

const gr = await prisma.goodsReceipt.findUnique({
  where: { gr_no: GR_NO },
  include: { stock_in_items: true },
});
if (!gr) throw new Error(`${GR_NO} 없음`);
const item = await prisma.item.findUnique({ where: { item_code: ITEM_CODE } });
if (!item) throw new Error(`${ITEM_CODE} 없음`);

// 이미 라인 있는지 확인
const exists = gr.stock_in_items.find(s => s.item_id === item.id);
if (exists) {
  console.log(`이미 ${ITEM_CODE} 라인 있음. 작업 중단.`);
  await prisma.$disconnect();
  process.exit(0);
}

const location = await prisma.inventoryLocation.findFirst({ where: { code: 'CENTRAL' } });
const user = await prisma.user.findFirst({ where: { username: 'admin' } })
  ?? await prisma.user.findFirst({ where: { is_active: true } });
const vendor = await prisma.vendor.findFirst({ where: { name: { contains: '유한메디칼' } } });

console.log(`\n${APPLY ? '[APPLY]' : '[DRY RUN]'} GR ${GR_NO} (${new Date(gr.received_at).toLocaleDateString('ko-KR')})`);
console.log(`  + ${ITEM_CODE} | ${item.name} | ${QTY} × ${UNIT_PRICE}원 = ${QTY * UNIT_PRICE}원`);
console.log(`  위치: ${location.name} / 거래처: ${vendor.name}`);

if (!APPLY) {
  console.log(`\n실제 적용은 --apply 옵션`);
  await prisma.$disconnect();
  process.exit(0);
}

await prisma.$transaction(async (tx) => {
  // 1) StockInItem 추가
  const sii = await tx.stockInItem.create({
    data: {
      id: uuidv4(),
      goods_receipt_id: gr.id,
      item_id: item.id,
      received_qty: QTY,
      expected_qty: QTY,
      confirmed_qty: QTY,
      diff_qty: 0,
      unit_price: UNIT_PRICE,
      location_id: location.id,
      confirmed_at: new Date(),
      confirmed_by: user.id,
    },
  });

  // 2) InventoryLot 추가 (received_at = GR 입고일)
  const packSize = Number(item.pack_size ?? 1) || 1;
  const issueQty = QTY * packSize;
  const issueCost = UNIT_PRICE / packSize;
  await tx.$executeRawUnsafe(
    `INSERT INTO inventory_lots
       (id, stock_in_item_id, goods_receipt_id, item_id, location_id, vendor_id, received_at, unit_cost, received_qty, remaining_qty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uuidv4(), sii.id, gr.id, item.id, location.id, vendor.id,
    new Date(gr.received_at).toISOString(), issueCost, issueQty, issueQty,
  );

  // 3) Inventory 갱신 (가중평균)
  const inv = await tx.inventory.findUnique({
    where: { item_id_location_id: { item_id: item.id, location_id: location.id } },
  });
  const oldQty = Number(inv?.on_hand_qty ?? 0);
  const oldCost = Number(inv?.avg_unit_cost ?? 0);
  const newQty = oldQty + issueQty;
  const newCost = newQty > 0 ? ((oldCost * oldQty) + issueCost * issueQty) / newQty : 0;
  await tx.inventory.upsert({
    where: { item_id_location_id: { item_id: item.id, location_id: location.id } },
    update: { on_hand_qty: newQty, avg_unit_cost: Number(newCost.toFixed(4)) },
    create: {
      id: uuidv4(),
      item_id: item.id,
      location_id: location.id,
      on_hand_qty: issueQty,
      avg_unit_cost: issueCost,
    },
  });
});

console.log(`\n✓ ${GR_NO} 에 ${item.name} 라인 추가 완료`);
await prisma.$disconnect();
