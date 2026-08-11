// 76 자동혈압계 (오므론 HEM7141T1) + 80 Nasal Air-way 26FR 신규 품목 등록
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

// 다음 ITEM-XXXX 시퀀스
const lastItem = await prisma.item.findFirst({
  where: { item_code: { startsWith: 'ITEM-' } },
  orderBy: { item_code: 'desc' },
  select: { item_code: true },
});
const lastNum = lastItem ? Number(lastItem.item_code.replace('ITEM-', '')) : 0;
console.log(`마지막 item_code: ${lastItem?.item_code} (${lastNum})`);

const newItems = [
  {
    code: `ITEM-${String(lastNum + 1).padStart(4, '0')}`,
    name: '자동혈압계 (오므론 HEM7141T1)',
    category: 'EQUIP_AID',
    expense_scope: 'EQUIPMENT',
    uom: 'EA', purchase_uom: 'EA', issue_uom: 'EA',
    pack_size: 1,
  },
  {
    code: `ITEM-${String(lastNum + 2).padStart(4, '0')}`,
    name: 'Nasal Air-way (26FR/6.5mm)',
    category: 'MED_AIRWAY',
    expense_scope: 'MEDICAL',
    uom: 'EA', purchase_uom: 'EA', issue_uom: 'EA',
    pack_size: 1,
  },
];

for (const ni of newItems) {
  const exists = await prisma.item.findUnique({ where: { item_code: ni.code } });
  if (exists) {
    console.log(`이미 존재: ${ni.code}`);
    continue;
  }
  const created = await prisma.item.create({
    data: {
      id: uuidv4(),
      item_code: ni.code,
      name: ni.name,
      category: ni.category,
      expense_scope: ni.expense_scope,
      uom: ni.uom,
      purchase_uom: ni.purchase_uom,
      issue_uom: ni.issue_uom,
      pack_size: ni.pack_size,
      min_order_qty: 1,
      is_regular_order: false,
      reorder_days_threshold: 7,
    },
  });
  console.log(`등록: ${created.item_code} | ${created.name} (${created.category})`);
}

await prisma.$disconnect();
