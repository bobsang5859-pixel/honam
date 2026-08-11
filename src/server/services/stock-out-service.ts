import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { audit, generateNo, nextSeq } from '../utils/audit';
import { allocateFifo, ensureFifoTables } from '../utils/fifo';
import { generateEquipmentSerial } from '../utils/serial';
import { getCentralStockOutLocation } from '../routes/stock-out';

/**
 * 승인 직후 재고에서 즉시 불출하는 서비스 함수 (ADHOC 비정기 신청 즉시불출 시 사용)
 * FIFO 방식으로 재고 차감. 재고 부족 시 음수 재고로 처리 (입고 시 자동 상쇄).
 */
export async function performDirectStockOut(params: {
  items: { item_id: string; approved_qty: number }[];
  department_id: string;
  ward_request_id: string;
  issued_by: string;
  note?: string;
  is_test?: boolean;  // 부모 ward_request의 is_test 값 — 호출자가 명시 (없으면 자동 조회)
  /** 외부 트랜잭션에서 호출 시 전달 — 전달하면 자체 $transaction을 생성하지 않음 */
  tx?: any;
}): Promise<{ id: string; so_no: string }> {
  const { items, department_id, ward_request_id, issued_by, note, tx: externalTx } = params;
  let isTest = params.is_test;

  const db = externalTx ?? prisma;
  await ensureFifoTables(db as any);

  // 호출자가 is_test를 명시 안 했으면 ward_request에서 자동 조회
  if (isTest === undefined && ward_request_id) {
    const wr = await db.wardRequest.findUnique({ where: { id: ward_request_id }, select: { is_test: true } });
    isTest = !!wr?.is_test;
  }

  // 정책: 불출은 무조건 "총무구매 창고"에서만 — 위치 고정
  const centralLoc = await getCentralStockOutLocation();
  const itemLocations: { item_id: string; location_id: string; qty: number }[] = [];
  for (const it of items) {
    if (it.approved_qty <= 0) continue;
    itemLocations.push({ item_id: it.item_id, location_id: centralLoc.id, qty: it.approved_qty });
  }

  // 불출 번호 생성
  const seq = await nextSeq('stock_out');
  const so_no = generateNo('SO', seq);

  // 외부 트랜잭션이 있으면 직접 실행, 없으면 자체 트랜잭션 생성
  const executeStockOut = async (tx: any) => {
    await ensureFifoTables(tx as any);

    const stockOut = await tx.stockOut.create({
      data: {
        id: uuidv4(),
        so_no,
        department_id,
        ward_request_id,
        issued_by,
        status: 'RECEIPT_PENDING',
        note: note ?? '[AUTO] 비정기 신청 즉시불출',
        is_test: !!isTest,
      },
    });

    for (const loc of itemLocations) {
      const soi = await tx.stockOutItem.create({
        data: {
          id: uuidv4(),
          stock_out_id: stockOut.id,
          item_id: loc.item_id,
          issued_qty: loc.qty,
          location_id: loc.location_id,
        },
      });

      await allocateFifo(tx as any, {
        stockOutId: stockOut.id,
        stockOutItemId: soi.id,
        itemId: loc.item_id,
        locationId: loc.location_id,
        issueQty: loc.qty,
      });

      // 음수 재고 허용: inventory 레코드가 없으면 음수 잔량으로 신규 생성
      await tx.inventory.upsert({
        where: { item_id_location_id: { item_id: loc.item_id, location_id: loc.location_id } },
        update: { on_hand_qty: { decrement: loc.qty } },
        create: { item_id: loc.item_id, location_id: loc.location_id, on_hand_qty: -loc.qty },
      });
    }

    // 비품 품목 → EquipmentUnit 자동 생성 (트랜잭션 안에서 처리)
    const allItemIds = items.map(i => i.item_id);
    const equipItems = await tx.item.findMany({
      where: { id: { in: allItemIds }, category: { startsWith: 'EQUIP_' } },
      select: { id: true },
    });
    if (equipItems.length > 0) {
      const equipSet = new Set(equipItems.map(i => i.id));
      for (const it of items) {
        if (!equipSet.has(it.item_id) || it.approved_qty <= 0) continue;
        for (let i = 0; i < it.approved_qty; i++) {
          const serial = await generateEquipmentSerial(tx);
          await (tx as any).equipmentUnit.create({
            data: {
              id: uuidv4(),
              serial_no: serial,
              item_id: it.item_id,
              department_id,
              stock_out_id: stockOut.id,
            },
          });
        }
      }
    }

    return stockOut;
  };

  const so = externalTx
    ? await executeStockOut(externalTx)
    : await prisma.$transaction(executeStockOut);

  await audit({
    actor_user_id: issued_by,
    action: 'POST',
    entity_type: 'stock_out',
    entity_id: so.id,
    after: { so_no, department_id, ward_request_id, item_count: itemLocations.length, source: 'AUTO_ADHOC' },
  });

  return { id: so.id, so_no };
}
