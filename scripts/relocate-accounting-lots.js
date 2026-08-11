#!/usr/bin/env node
// 「경리부 보관함」 lot 들을 「총무구매 창고」 로 일괄 이동.
// 이유: 입고 등록 기본값이 잘못되어 경리부로 들어간 lot 들. (148개 / 잔량 14,584)
// 분석 결과 「불출 출처」 lot 는 0개. 모두 「입고 출처」 라 안전하게 이동 가능.
//
// 처리 순서:
//   1) 이동 전 sanity check (lot 출처 확인, inventory 합산 사전 검사)
//   2) lot.location_id 변경 (ACCOUNTING_DEPT → CENTRAL)
//   3) inventory 행 정리:
//      - 같은 item 이 두 위치(ACCOUNTING_DEPT + CENTRAL)에 있으면 → CENTRAL 행에 합산, ACCOUNTING_DEPT 행 0 으로
//      - ACCOUNTING_DEPT 에만 있으면 → CENTRAL 행으로 이동 (또는 신규 생성)
//   4) 검증 출력
//
// --dry-run 옵션: 변경 안 하고 미리보기만.

const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient();
  const dryRun = process.argv.includes('--dry-run');

  try {
    // 위치 확인
    const acctLoc = await prisma.inventoryLocation.findFirst({ where: { code: 'ACCOUNTING_DEPT' } });
    const centralLoc = await prisma.inventoryLocation.findFirst({ where: { code: 'CENTRAL' } });
    if (!acctLoc) throw new Error('「경리부 보관함 (ACCOUNTING_DEPT)」 위치를 찾을 수 없음.');
    if (!centralLoc) throw new Error('「총무구매 창고 (CENTRAL)」 위치를 찾을 수 없음.');

    console.log(`경리부: ${acctLoc.id}`);
    console.log(`총무구매: ${centralLoc.id}`);
    if (dryRun) console.log('\n--- DRY RUN (변경 안 함) ---');

    // 1) lot 출처 sanity check — 「입고 출처」 만 있는지 다시 확인
    const lots = await prisma.inventoryLot.findMany({
      where: { location_id: acctLoc.id, deleted_at: null },
      select: { id: true, item_id: true, goods_receipt_id: true, remaining_qty: true },
    });
    console.log(`\n경리부 lot: ${lots.length} 개 / 총 잔량: ${lots.reduce((s, l) => s + Number(l.remaining_qty), 0)}`);
    const noGr = lots.filter((l) => !l.goods_receipt_id).length;
    if (noGr > 0) console.warn(`  ⚠ GR 연결 없는 lot ${noGr} 개 — 입고 출처 아닌 lot 일 수 있음. 점검 필요.`);

    // 2) inventory 사전 상태
    const acctInvs = await prisma.inventory.findMany({
      where: { location_id: acctLoc.id },
      select: { id: true, item_id: true, on_hand_qty: true, avg_unit_cost: true },
    });
    const centralInvs = await prisma.inventory.findMany({
      where: { location_id: centralLoc.id },
      select: { id: true, item_id: true, on_hand_qty: true, avg_unit_cost: true },
    });
    const centralByItem = new Map(centralInvs.map((i) => [i.item_id, i]));
    console.log(`경리부 inventory 행: ${acctInvs.length} / 총무구매 inventory 행: ${centralInvs.length}`);

    let mergedRows = 0;
    let movedRows = 0;
    let totalQtyBefore = 0, totalQtyAfter = 0;
    acctInvs.forEach((i) => totalQtyBefore += Number(i.on_hand_qty));
    centralInvs.forEach((i) => totalQtyBefore += Number(i.on_hand_qty));

    if (dryRun) {
      // 변경 후 예상 상태 계산
      for (const acctInv of acctInvs) {
        const onCentral = centralByItem.get(acctInv.item_id);
        if (onCentral) {
          mergedRows++;
        } else {
          movedRows++;
        }
      }
      console.log(`\n[dry-run] 예상:`);
      console.log(`  lot 이동: ${lots.length} 건`);
      console.log(`  inventory 병합 (CENTRAL 에도 있는 품목): ${mergedRows} 건`);
      console.log(`  inventory 이동 (CENTRAL 에 없는 품목): ${movedRows} 건`);
      console.log(`  변경 전 총 잔량 (경리부+총무구매): ${totalQtyBefore}`);
      return;
    }

    // 3) 실제 작업 — 트랜잭션
    await prisma.$transaction(async (tx) => {
      // 3-1) lot location_id 일괄 변경
      const upd = await tx.inventoryLot.updateMany({
        where: { location_id: acctLoc.id, deleted_at: null },
        data: { location_id: centralLoc.id },
      });
      console.log(`\nlot location_id 변경: ${upd.count} 건`);

      // 3-2) inventory 행 정리
      for (const acctInv of acctInvs) {
        const qty = Number(acctInv.on_hand_qty);
        const avg = Number(acctInv.avg_unit_cost);
        const onCentral = centralByItem.get(acctInv.item_id);
        if (onCentral) {
          // 병합: CENTRAL 행에 합산, 경리부 행은 0 으로
          const newQty = Number(onCentral.on_hand_qty) + qty;
          // 가중평균 단가 = (기존qty × 기존avg + 추가qty × 추가avg) / newQty
          const newAvg = newQty > 0
            ? Number(((Number(onCentral.on_hand_qty) * Number(onCentral.avg_unit_cost)) + (qty * avg)) / newQty).toFixed(2)
            : 0;
          await tx.inventory.update({
            where: { id: onCentral.id },
            data: { on_hand_qty: newQty, avg_unit_cost: Number(newAvg) },
          });
          await tx.inventory.update({
            where: { id: acctInv.id },
            data: { on_hand_qty: 0 },
          });
          mergedRows++;
        } else {
          // 신규 생성: CENTRAL 위치로 행 이동
          await tx.inventory.create({
            data: {
              item_id: acctInv.item_id,
              location_id: centralLoc.id,
              on_hand_qty: qty,
              avg_unit_cost: avg,
            },
          });
          await tx.inventory.update({
            where: { id: acctInv.id },
            data: { on_hand_qty: 0 },
          });
          movedRows++;
        }
      }

      // 3-3) audit 기록
      await tx.auditLog.create({
        data: {
          actor_user_id: null,
          action: 'BULK_RELOCATE',
          entity_type: 'inventory_location',
          entity_id: acctLoc.id,
          reason: `경리부 보관함 → 총무구매 창고 일괄 이동 (잘못 입고된 lot 정리). lot ${upd.count} 건, inventory 병합 ${mergedRows} / 이동 ${movedRows} 건.`,
        },
      });
    }, { timeout: 120000, maxWait: 30000 });

    // 4) 검증
    const afterAcctLots = await prisma.inventoryLot.count({ where: { location_id: acctLoc.id, deleted_at: null } });
    const afterCentralLots = await prisma.inventoryLot.count({ where: { location_id: centralLoc.id, deleted_at: null } });
    const afterAcctSum = await prisma.inventory.aggregate({
      where: { location_id: acctLoc.id }, _sum: { on_hand_qty: true },
    });
    const afterCentralSum = await prisma.inventory.aggregate({
      where: { location_id: centralLoc.id }, _sum: { on_hand_qty: true },
    });
    totalQtyAfter = Number(afterAcctSum._sum.on_hand_qty ?? 0) + Number(afterCentralSum._sum.on_hand_qty ?? 0);

    console.log('\n=== 검증 ===');
    console.log(`  경리부 lot 잔여: ${afterAcctLots} (기대값: 0)`);
    console.log(`  총무구매 lot 잔여: ${afterCentralLots}`);
    console.log(`  경리부 inventory 합: ${Number(afterAcctSum._sum.on_hand_qty ?? 0)} (기대값: 0)`);
    console.log(`  총무구매 inventory 합: ${Number(afterCentralSum._sum.on_hand_qty ?? 0)}`);
    console.log(`  변경 전 두 위치 총 잔량: ${totalQtyBefore}`);
    console.log(`  변경 후 두 위치 총 잔량: ${totalQtyAfter}`);
    if (Math.abs(totalQtyBefore - totalQtyAfter) > 0.01) {
      console.warn(`  ⚠ 총 수량 일치 안 함! 차이: ${(totalQtyBefore - totalQtyAfter).toFixed(2)}`);
    } else {
      console.log(`  ✅ 총 수량 일치`);
    }
    console.log(`\n작업 완료. inventory 병합 ${mergedRows} / 이동 ${movedRows}`);
  } catch (e) {
    console.error('오류:', e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
