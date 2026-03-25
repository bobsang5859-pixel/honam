import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { audit, generateNo, nextSeq } from '../utils/audit';
import { allocateFifo, ensureFifoTables, getAvailableLotQty } from '../utils/fifo';
import { generateEquipmentSerial } from '../utils/serial';

/**
 * 승인 직후 재고에서 즉시 불출하는 서비스 함수 (ADHOC 비정기 신청 즉시불출 시 사용)
 * FIFO 방식으로 재고 차감. 재고 부족 시 에러를 throw.
 */
export async function performDirectStockOut(params: {
  items: { item_id: string; approved_qty: number }[];
  department_id: string;
  ward_request_id: string;
  issued_by: string;
  note?: string;
  /** 외부 트랜잭션에서 호출 시 전달 — 전달하면 자체 $transaction을 생성하지 않음 */
  tx?: any;
}): Promise<{ id: string; so_no: string }> {
  const { items, department_id, ward_request_id, issued_by, note, tx: externalTx } = params;

  const db = externalTx ?? prisma;
  await ensureFifoTables(db as any);

  // 각 품목별로 재고가 있는 위치 찾기 (location_id 결정)
  const itemLocations: { item_id: string; location_id: string; qty: number }[] = [];

  for (const it of items) {
    if (it.approved_qty <= 0) continue;

    // 재고가 있는 모든 위치 조회 (on_hand_qty 내림차순)
    const invRows = await db.inventory.findMany({
      where: { item_id: it.item_id, on_hand_qty: { gt: 0 } },
      include: { location: true },
      orderBy: { on_hand_qty: 'desc' },
    });

    let remaining = it.approved_qty;
    for (const inv of invRows) {
      if (remaining <= 0) break;
      const available = Number(inv.on_hand_qty);
      const lotQty = await getAvailableLotQty(db as any, it.item_id, inv.location_id);
      const canTake = Math.min(available, lotQty, remaining);
      if (canTake <= 0) continue;
      itemLocations.push({ item_id: it.item_id, location_id: inv.location_id, qty: canTake });
      remaining -= canTake;
    }

    if (remaining > 0) {
      const item = await db.item.findUnique({ where: { id: it.item_id }, select: { name: true } });
      throw new Error(`재고 부족: ${item?.name ?? it.item_id} (부족량: ${remaining})`);
    }
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

      await tx.inventory.update({
        where: { item_id_location_id: { item_id: loc.item_id, location_id: loc.location_id } },
        data: { on_hand_qty: { decrement: loc.qty } },
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
