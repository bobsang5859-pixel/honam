import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const drafts = await prisma.wardRequest.findMany({
  where: {
    status: 'DRAFT',
    request_type: 'CONSUMABLE_REGULAR',
    deleted_at: null,
    department: { code: 'NUTRITION' },
  },
  select: {
    id: true,
    request_no: true,
    status: true,
    request_type: true,
    period_type: true,
    period_start: true,
    period_end: true,
    department: { select: { name: true, code: true } },
    requester: { select: { username: true, display_name: true } },
    _count: { select: { items: true, po_sources: true, stock_outs: true } },
  },
});

console.log(JSON.stringify(drafts, null, 2));
console.log(`\nTotal: ${drafts.length} draft(s) found`);
await prisma.$disconnect();
