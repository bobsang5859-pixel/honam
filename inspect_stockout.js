/**
 * Ward Stock-Out FIFO Inspection Script
 * Run with: node inspect_stockout.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    // Get latest 5-10 ward stock-outs
    const stockOuts = await prisma.stockOut.findMany({
      where: {
        deleted_at: null,
        ward_request_id: { not: null },
      },
      include: {
        items: {
          include: {
            allocations: {
              include: {
                inventory_lot: {
                  select: {
                    unit_cost: true,
                    received_at: true,
                  }
                }
              }
            }
          }
        }
      },
      orderBy: { issued_at: 'desc' },
      take: 10
    });

    console.log(`\n=== Latest ${stockOuts.length} Ward Stock-Outs ===\n`);

    for (const so of stockOuts) {
      console.log(`StockOut: ${so.so_no}`);
      console.log(`  ward_request_id: ${so.ward_request_id}`);
      console.log(`  issued_at: ${so.issued_at}`);
      
      // Calculate total from allocations
      let totalAmount = 0;
      for (const item of so.items) {
        for (const alloc of item.allocations) {
          totalAmount += Number(alloc.line_amount);
        }
      }
      console.log(`  total_amount (sum of allocations): ${totalAmount}`);
      
      // Items and allocations
      for (const item of so.items) {
        console.log(`  Item: ${item.item_id}`);
        console.log(`    issue_qty: ${item.issued_qty}`);
        console.log(`    Lot Allocations:`);
        
        let itemTotal = 0;
        for (const alloc of item.allocations) {
          if (alloc.inventory_lot_id) {
            console.log(`      lot_id: ${alloc.inventory_lot_id}`);
            console.log(`        qty: ${alloc.issued_qty}, unit_cost: ${alloc.unit_cost}, line_amount: ${alloc.line_amount}`);
            console.log(`        received_at: ${alloc.inventory_lot?.received_at}`);
          } else {
            console.log(`      [NEGATIVE STOCK - no lot]`);
            console.log(`        qty: ${alloc.issued_qty}, unit_cost: 0, line_amount: 0`);
          }
          itemTotal += Number(alloc.line_amount);
        }
        console.log(`    item_total: ${itemTotal}`);
      }
      console.log('');
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
