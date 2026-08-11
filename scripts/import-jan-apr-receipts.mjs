// 호남THE선요양병원 1~4월 거래내역 일괄 입고 등록 + 검수확정
// 1) GR-202605-00008 의 received_at 을 4/13 → 4/15 로 수정
// 2) 9건 입고를 PENDING 으로 등록 (유한메디칼, 총무부)
// 3) 즉시 검수확정 → InventoryLot 생성 (FIFO 정렬키는 거래일자로)
//
// 사용:
//   node scripts/import-jan-apr-receipts.mjs           # DRY RUN
//   node scripts/import-jan-apr-receipts.mjs --apply   # 실제 적용

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';

// fifo.ts createInventoryLot 의 인라인 복사 (.ts 직접 import 불가)
async function createInventoryLot(db, params) {
  const lotId = uuidv4();
  const dt = typeof params.receivedAt === 'string' ? params.receivedAt : params.receivedAt.toISOString();
  const unitCost = Number(params.unitCost) || 0;
  const receivedQty = Number(params.receivedQty) || 0;
  await db.$executeRawUnsafe(
    `INSERT INTO inventory_lots
      (id, stock_in_item_id, goods_receipt_id, item_id, location_id, vendor_id, received_at, unit_cost, received_qty, remaining_qty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    lotId, params.stockInItemId, params.goodsReceiptId, params.itemId, params.locationId,
    params.vendorId ?? null, dt, unitCost, receivedQty, receivedQty,
  );
  return lotId;
}
async function ensureFifoTables(_db) { /* 테이블 이미 존재 */ }

const APPLY = process.argv.includes('--apply');
const prisma = new PrismaClient();

console.log(APPLY ? '\n*** APPLY 모드 ***\n' : '\n*** DRY RUN ***\n');

// ============ 데이터 로드 ============
const transactions = JSON.parse(readFileSync('scripts/transactions.json', 'utf-8'));
const mapping = JSON.parse(readFileSync('scripts/manual-mapping.json', 'utf-8')).mappings;
const mapByRawName = new Map(mapping.map(m => [m.raw_name, m]));

// ============ 거래처 (유한메디칼) / 위치 (총무부) / 사용자 ============
const vendor = await prisma.vendor.findFirst({ where: { name: { contains: '유한메디칼' }, is_active: true } });
if (!vendor) throw new Error('유한메디칼 vendor 없음');
console.log(`거래처: ${vendor.name} (${vendor.code})`);

const location = await prisma.inventoryLocation.findFirst({
  where: { OR: [{ name: { contains: '총무부' } }, { code: { contains: 'CENTRAL' } }] },
});
if (!location) throw new Error('총무부 위치 없음');
console.log(`입고 위치: ${location.name} (${location.code})`);

const user = await prisma.user.findFirst({ where: { username: 'admin' } })
  ?? await prisma.user.findFirst({ where: { is_active: true } });
if (!user) throw new Error('관리자 사용자 없음');
console.log(`등록자: ${user.username} (${user.display_name})`);

// ============ item_code → item 조회 ============
const allCodes = [...new Set(mapping.filter(m => m.item_code).map(m => m.item_code))];
const items = await prisma.item.findMany({ where: { item_code: { in: allCodes } } });
const itemByCode = new Map(items.map(it => [it.item_code, it]));
console.log(`매핑 대상 시스템 품목: ${itemByCode.size}/${allCodes.length}`);
for (const code of allCodes) {
  if (!itemByCode.has(code)) console.warn(`  ⚠ 시스템에 없음: ${code}`);
}

// ============ 1) GR-202605-00008 입고일 수정 ============
const gr8 = await prisma.goodsReceipt.findUnique({ where: { gr_no: 'GR-202605-00008' } });
if (gr8) {
  const current = new Date(gr8.received_at).toLocaleDateString('ko-KR');
  console.log(`\n[1/3] GR-202605-00008 입고일: ${current} → 2026-04-15`);
  if (APPLY) {
    const newDate = new Date('2026-04-15T00:00:00+09:00');
    await prisma.$transaction(async (tx) => {
      await tx.goodsReceipt.update({ where: { id: gr8.id }, data: { received_at: newDate } });
      await tx.inventoryLot.updateMany({
        where: { goods_receipt_id: gr8.id, deleted_at: null },
        data: { received_at: newDate },
      });
    });
    console.log('  ✓ GR-00008 입고일 + 연결된 InventoryLot.received_at 갱신');
  }
}

// ============ 2) 거래일별 GR 생성 + 라인 등록 + 검수확정 ============
async function nextSeq() {
  const result = await prisma.$queryRawUnsafe(
    `SELECT MAX(CAST(SUBSTR("gr_no", LENGTH("gr_no") - 4) AS INTEGER)) as max_seq FROM "goods_receipts" WHERE "gr_no" IS NOT NULL`
  );
  return Number(result[0]?.max_seq ?? 0) + 1;
}

console.log(`\n[2/3] ${transactions.length}건 입고 등록 + 검수확정`);
let totalLines = 0;
let totalAmount = 0;
const summary = [];

for (const tx of transactions) {
  const txDate = new Date(tx.date + 'T00:00:00+09:00');
  const yyyymm = `${txDate.getFullYear()}${String(txDate.getMonth() + 1).padStart(2, '0')}`;
  const lineCount = tx.items.length;
  const lineAmount = tx.items.reduce((s, l) => s + Number(l.amount), 0);
  console.log(`\n  ${tx.date} | ${lineCount} 라인 | ${lineAmount.toLocaleString()}원`);

  // 매핑 적용 — 라인별 item_id / unit_price / qty / custom_name
  const grItems = [];
  let unmatchedCount = 0;
  for (const line of tx.items) {
    const m = mapByRawName.get(line.raw_name);
    const item = m && m.item_code ? itemByCode.get(m.item_code) : null;
    if (item) {
      grItems.push({
        item_id: item.id,
        item: item,
        received_qty: line.qty,
        unit_price: line.unit_price,
        location_id: location.id,
        custom_name: '',
      });
    } else {
      // 자유입력 — D/LARYNGOSCOPE (47), Nasal Air-way 였으나 이제 등록됨. 남은 미매핑은 무시 안 하고 자유입력으로
      grItems.push({
        item_id: null,
        item: null,
        received_qty: line.qty,
        unit_price: line.unit_price,
        location_id: location.id,
        custom_name: line.raw_name,
      });
      unmatchedCount++;
    }
  }
  if (unmatchedCount > 0) console.log(`    자유입력 라인: ${unmatchedCount}`);

  if (!APPLY) {
    summary.push({ date: tx.date, lines: lineCount, amount: lineAmount, unmatched: unmatchedCount });
    totalLines += lineCount;
    totalAmount += lineAmount;
    continue;
  }

  // === 실제 등록 ===
  const seq = await nextSeq();
  const gr_no = `GR-${yyyymm}-${String(seq).padStart(5, '0')}`;

  // GoodsReceipt + StockInItem 생성 (검수 PENDING). 자유입력 라인은 StockInItem 의 item_id 필수라
  // PurchaseOrderItem 처럼 자유입력 라인을 GR 에 못 넣음. 매핑 안 된 라인은 일단 skip.
  // (스키마: StockInItem.item_id String 필수)
  const validLines = grItems.filter(li => li.item_id);
  const skippedLines = grItems.filter(li => !li.item_id);

  if (validLines.length === 0) {
    console.log(`    ⚠ 유효 라인 없음 — 입고 등록 스킵`);
    continue;
  }

  // 같은 item_id 가 한 거래에 두 번 나오면 unique([gr_id, item_id]) 위반 — 합산
  const merged = new Map();
  for (const li of validLines) {
    const key = li.item_id;
    if (merged.has(key)) {
      const e = merged.get(key);
      e.received_qty += Number(li.received_qty);
      // 단가는 첫 라인 기준 유지 (또는 가중평균)
    } else {
      merged.set(key, { ...li });
    }
  }
  const mergedLines = [...merged.values()];

  const gr = await prisma.goodsReceipt.create({
    data: {
      id: uuidv4(),
      gr_no,
      purchase_order_id: null,
      manual_vendor_id: vendor.id,
      received_by: user.id,
      received_at: txDate,
      status: 'PENDING',
      note: `호남THE선요양병원 거래내역 일괄 등록 (${tx.date})`,
      adjustment_amount: 0,
      adjustment_note: '',
      stock_in_items: {
        create: mergedLines.map(li => ({
          id: uuidv4(),
          item_id: li.item_id,
          received_qty: li.received_qty,
          expected_qty: li.received_qty,
          confirmed_qty: li.received_qty,
          diff_qty: 0,
          unit_price: li.unit_price,
          location_id: li.location_id,
        })),
      },
    },
    include: { stock_in_items: { include: { item: true } } },
  });

  // 즉시 검수확정 → InventoryLot 생성
  await prisma.$transaction(async (tx2) => {
    await ensureFifoTables(tx2);
    for (const sii of gr.stock_in_items) {
      const packSize = Number(sii.item?.pack_size ?? 1) || 1;
      const issueQty = Number(sii.confirmed_qty) * packSize;
      const issueCost = Number(sii.unit_price) / packSize;

      await createInventoryLot(tx2, {
        stockInItemId: sii.id,
        goodsReceiptId: gr.id,
        itemId: sii.item_id,
        locationId: sii.location_id,
        vendorId: vendor.id,
        receivedAt: txDate,
        unitCost: issueCost,
        receivedQty: issueQty,
      });

      // inventory 갱신
      const inv = await tx2.inventory.findUnique({
        where: { item_id_location_id: { item_id: sii.item_id, location_id: sii.location_id } },
      });
      const oldQty = Number(inv?.on_hand_qty ?? 0);
      const oldCost = Number(inv?.avg_unit_cost ?? 0);
      const newQty = oldQty + issueQty;
      const newCost = newQty > 0 ? ((oldCost * oldQty) + issueCost * issueQty) / newQty : 0;
      await tx2.inventory.upsert({
        where: { item_id_location_id: { item_id: sii.item_id, location_id: sii.location_id } },
        update: { on_hand_qty: newQty, avg_unit_cost: Number(newCost.toFixed(4)) },
        create: {
          id: uuidv4(),
          item_id: sii.item_id,
          location_id: sii.location_id,
          on_hand_qty: issueQty,
          avg_unit_cost: issueCost,
        },
      });

      await tx2.stockInItem.update({
        where: { id: sii.id },
        data: { confirmed_at: new Date(), confirmed_by: user.id },
      });
    }
    await tx2.goodsReceipt.update({
      where: { id: gr.id },
      data: { status: 'CONFIRMED', confirmed_at: new Date(), confirmed_by: user.id },
    });
  });

  console.log(`    ✓ ${gr_no} 등록·검수확정 (라인 ${mergedLines.length}/${grItems.length}, 자유입력 skip ${skippedLines.length})`);
  summary.push({ date: tx.date, gr_no, lines: mergedLines.length, skipped: skippedLines.length, amount: lineAmount });
  totalLines += mergedLines.length;
  totalAmount += lineAmount;
}

console.log(`\n[3/3] 요약`);
console.table(summary);
console.log(`총 라인: ${totalLines}, 총 금액: ${totalAmount.toLocaleString()}원`);

if (!APPLY) console.log(`\n실제 적용: --apply 옵션`);

await prisma.$disconnect();
