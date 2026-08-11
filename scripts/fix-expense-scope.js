#!/usr/bin/env node
// 품목 expense_scope 일괄 보정.
// 카테고리 prefix 로 환자직접비 / 운영간접비 자동 결정.
//   MED_*, INFECT_*, PAT_*, DIAPER_* → PATIENT_DIRECT
//   FAC_*, OFF_*, FOOD_*, EQUIP_*    → OPS_INDIRECT
// legacy 값('MEDICAL', 'EQUIPMENT') 도 같은 규칙으로 변환.

const { PrismaClient } = require('@prisma/client');

const SCOPE_FOR_PREFIX = {
  MED: 'PATIENT_DIRECT',
  INFECT: 'PATIENT_DIRECT',
  PAT: 'PATIENT_DIRECT',
  DIAPER: 'PATIENT_DIRECT',
  FAC: 'OPS_INDIRECT',
  OFF: 'OPS_INDIRECT',
  FOOD: 'OPS_INDIRECT',
  EQUIP: 'OPS_INDIRECT',
};

function targetScope(category) {
  if (!category) return null;
  const prefix = String(category).split('_')[0];
  return SCOPE_FOR_PREFIX[prefix] ?? null;
}

(async () => {
  const prisma = new PrismaClient();
  try {
    const items = await prisma.item.findMany({
      where: { deleted_at: null },
      select: { id: true, item_code: true, name: true, category: true, expense_scope: true },
    });
    console.log(`전체 활성 품목: ${items.length}개`);

    const changes = [];
    const byTransition = new Map();
    for (const it of items) {
      const target = targetScope(it.category);
      if (!target) continue;
      if (it.expense_scope === target) continue;
      changes.push({ id: it.id, item_code: it.item_code, name: it.name, category: it.category, from: it.expense_scope, to: target });
      const key = `${it.expense_scope || '(빈값)'} → ${target}`;
      byTransition.set(key, (byTransition.get(key) ?? 0) + 1);
    }

    console.log(`\n변경 예정: ${changes.length}건`);
    console.log('전환 패턴:');
    for (const [k, v] of byTransition.entries()) console.log(`  ${k}: ${v}건`);

    if (process.argv.includes('--dry-run')) {
      console.log('\n[dry-run] 변경 안 함. 샘플 10건:');
      for (const c of changes.slice(0, 10)) {
        console.log(`  ${c.item_code} ${c.name} [${c.category}] ${c.from} → ${c.to}`);
      }
      return;
    }

    let updated = 0;
    for (const c of changes) {
      await prisma.item.update({ where: { id: c.id }, data: { expense_scope: c.to } });
      updated++;
    }
    console.log(`\n완료: ${updated}건 보정.`);

    // 검증
    const after = await prisma.$queryRawUnsafe(`
      SELECT
        CASE WHEN category LIKE 'MED%' THEN '의료소모품'
             WHEN category LIKE 'INFECT%' THEN '감염보호구'
             WHEN category LIKE 'PAT%' THEN '위생·생활케어'
             WHEN category LIKE 'DIAPER%' THEN '기저귀'
             WHEN category LIKE 'FAC%' THEN '청소·주방'
             WHEN category LIKE 'OFF%' THEN '사무용품'
             WHEN category LIKE 'FOOD%' THEN '식음료'
             ELSE '기타' END as 대분류,
        expense_scope, COUNT(*) as cnt
      FROM items WHERE deleted_at IS NULL
      GROUP BY 대분류, expense_scope ORDER BY 대분류, expense_scope
    `);
    console.log('\n보정 후 분포:');
    for (const r of after) console.log(`  ${r.대분류} | ${r.expense_scope} | ${Number(r.cnt)}개`);
  } catch (e) {
    console.error('오류:', e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
