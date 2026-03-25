import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { ensureFifoTables } from '../utils/fifo';

const prisma = new PrismaClient();

async function main() {
  await ensureFifoTables(prisma as any);
  console.log('[FIFO] start backfill');

  await (prisma as any).$executeRawUnsafe(`DELETE FROM stock_out_lot_allocations`);
  await (prisma as any).$executeRawUnsafe(`DELETE FROM inventory_lots`);

  const stockInRows = await (prisma as any).$queryRawUnsafe(`
    SELECT sii.id AS stock_in_item_id, sii.goods_receipt_id, sii.item_id, sii.location_id,
           sii.received_qty, sii.unit_price, gr.received_at,
           COALESCE(po.vendor_id, i.default_vendor_id) AS vendor_id
    FROM stock_in_items sii
    JOIN goods_receipts gr ON gr.id = sii.goods_receipt_id
    LEFT JOIN purchase_orders po ON po.id = gr.purchase_order_id
    LEFT JOIN items i ON i.id = sii.item_id
    WHERE gr.deleted_at IS NULL
    ORDER BY datetime(gr.received_at) ASC, sii.id ASC
  `);

  for (const r of stockInRows) {
    await (prisma as any).$executeRawUnsafe(`
      INSERT INTO inventory_lots
        (id, stock_in_item_id, goods_receipt_id, item_id, location_id, vendor_id, received_at, unit_cost, received_qty, remaining_qty)
      VALUES
        ('${uuidv4()}', '${r.stock_in_item_id}', '${r.goods_receipt_id}', '${r.item_id}', '${r.location_id}',
         ${r.vendor_id ? `'${String(r.vendor_id).replace(/'/g, "''")}'` : 'NULL'},
         '${String(r.received_at)}', ${Number(r.unit_price || 0)}, ${Number(r.received_qty || 0)}, ${Number(r.received_qty || 0)})
    `);
  }

  const stockOutRows = await (prisma as any).$queryRawUnsafe(`
    SELECT soi.id AS stock_out_item_id, soi.stock_out_id, soi.item_id, soi.location_id, soi.issued_qty, so.issued_at
    FROM stock_out_items soi
    JOIN stock_out so ON so.id = soi.stock_out_id
    WHERE so.deleted_at IS NULL AND so.status = 'POSTED'
    ORDER BY datetime(so.issued_at) ASC, soi.id ASC
  `);

  let full = 0;
  let partial = 0;
  let unmatched = 0;
  for (const r of stockOutRows) {
    let remain = Number(r.issued_qty || 0);
    const lots = await (prisma as any).$queryRawUnsafe(`
      SELECT id, remaining_qty, unit_cost
      FROM inventory_lots
      WHERE deleted_at IS NULL
        AND item_id='${String(r.item_id).replace(/'/g, "''")}'
        AND location_id='${String(r.location_id).replace(/'/g, "''")}'
        AND remaining_qty > 0
      ORDER BY datetime(received_at) ASC, id ASC
    `);
    const start = remain;
    for (const lot of lots) {
      if (remain <= 0) break;
      const av = Number(lot.remaining_qty || 0);
      if (av <= 0) continue;
      const take = Math.min(remain, av);
      const unit = Number(lot.unit_cost || 0);
      await (prisma as any).$executeRawUnsafe(`
        UPDATE inventory_lots SET remaining_qty = ${Number((av - take).toFixed(6))}
        WHERE id='${String(lot.id).replace(/'/g, "''")}'
      `);
      await (prisma as any).$executeRawUnsafe(`
        INSERT INTO stock_out_lot_allocations
          (id, stock_out_id, stock_out_item_id, inventory_lot_id, issued_qty, unit_cost, line_amount)
        VALUES
          ('${uuidv4()}', '${r.stock_out_id}', '${r.stock_out_item_id}', '${String(lot.id).replace(/'/g, "''")}',
           ${take}, ${unit}, ${Number((take * unit).toFixed(2))})
      `);
      remain = Number((remain - take).toFixed(6));
    }
    if (remain <= 0) full += 1;
    else if (remain < start) partial += 1;
    else unmatched += 1;

    if (remain > 0) {
      await (prisma as any).$executeRawUnsafe(`
        INSERT INTO stock_out_lot_allocations
          (id, stock_out_id, stock_out_item_id, inventory_lot_id, issued_qty, unit_cost, line_amount)
        VALUES
          ('${uuidv4()}', '${r.stock_out_id}', '${r.stock_out_item_id}', NULL, ${remain}, 0, 0)
      `);
    }
  }

  console.log(`[FIFO] lots created: ${stockInRows.length}`);
  console.log(`[FIFO] allocation full: ${full}, partial: ${partial}, unmatched: ${unmatched}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

