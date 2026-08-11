/**
 * 기존 PurchaseDecision → OrderRouting(DECISION, ACTIVE) 정밀 재구성.
 *
 * 멱등 + 교정: 이전 백필행(routed_by='BACKFILL') 을 먼저 비우고,
 * 결의서가 묶은 (wr,item) 중 "그 wr 의 실제 승인내역에 그 item 이 있는" 페어만 마킹.
 * (구 cartesian 곱이 만든 유령쌍 제거 — 진짜 대기 품목이 풀에서 안 가려지게)
 * 정상 라우팅(/route, routed_by=실유저)은 건드리지 않음.
 *
 * 실행: npx ts-node --transpile-only -P tsconfig.server.json scripts/backfill-order-routing.ts
 */
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { loadSchedulesByType, resolveScheduleLabel, monthLabel } from '../src/server/utils/period-label';

const prisma = new PrismaClient();

async function main() {
  const purged = await (prisma as any).orderRouting.deleteMany({ where: { routed_by: 'BACKFILL' } });

  const decisions: any[] = await (prisma as any).purchaseDecision.findMany({
    where: { deleted_at: null },
    select: { id: true, vendor_id: true, source_ward_request_ids: true, items_json: true },
  });

  const allWrIds = new Set<string>();
  const decParsed = decisions.map((d: any) => {
    let wrIds: string[] = []; let items: any[] = [];
    try { wrIds = JSON.parse(d.source_ward_request_ids ?? '[]'); } catch {}
    try { items = JSON.parse(d.items_json ?? '[]'); } catch {}
    for (const w of wrIds) allWrIds.add(w);
    return { d, wrIds, itemIds: new Set(items.map((i: any) => i.item_id).filter(Boolean)) };
  });

  const wrs = await prisma.wardRequest.findMany({
    where: { id: { in: Array.from(allWrIds) } },
    include: { approval_actions: { orderBy: { created_at: 'desc' as const }, take: 1, include: { items: true } } },
  });
  const approvedByWr = new Map<string, Map<string, number>>();
  const schedulesByType = await loadSchedulesByType(prisma as any);
  const periodByWr = new Map<string, string>();
  for (const wr of wrs as any[]) {
    const act = wr.approval_actions[0];
    const m = new Map<string, number>();
    if (act) for (const ai of act.items) {
      if (!ai.item_id || Number(ai.approved_qty) <= 0) continue;
      m.set(ai.item_id, (m.get(ai.item_id) ?? 0) + Number(ai.approved_qty));
    }
    approvedByWr.set(wr.id, m);
    const ps = wr.period_start ? new Date(wr.period_start) : null;
    const { period_label } = resolveScheduleLabel(String(wr.request_type ?? ''), ps, schedulesByType);
    periodByWr.set(wr.id, (period_label && period_label.trim()) ? period_label : (ps ? monthLabel(ps) : '주기 미지정'));
  }

  let inserted = 0;
  let skippedPhantom = 0;
  const seen = new Set<string>();
  for (const { d, wrIds, itemIds } of decParsed) {
    for (const wrId of wrIds) {
      const approved = approvedByWr.get(wrId);
      if (!approved) continue;
      for (const itemId of itemIds as Set<string>) {
        if (!approved.has(itemId)) { skippedPhantom++; continue; }
        const key = `${wrId}::${itemId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await (prisma as any).orderRouting.create({
          data: {
            id: uuidv4(),
            ward_request_id: wrId,
            item_id: itemId,
            custom_key: '',
            route: 'DECISION',
            status: 'ACTIVE',
            approved_qty: approved.get(itemId) ?? 0,
            vendor_id: d.vendor_id ?? null,
            period_label: periodByWr.get(wrId) ?? '',
            decision_id: d.id,
            routed_by: 'BACKFILL',
            routed_at: new Date(),
          },
        });
        inserted++;
      }
    }
  }
  console.log(`[backfill-order-routing] decisions=${decisions.length} purged=${purged.count} inserted=${inserted} skipped_phantom=${skippedPhantom}`);
}

main()
  .catch((e) => { console.error('[backfill-order-routing] error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
