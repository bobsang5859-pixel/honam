const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // 9명의 patient_id 가져오기
  const dirty = await prisma.$queryRawUnsafe(`
    SELECT id, name FROM patients
    WHERE status='ADMITTED' AND deleted_at IS NULL AND diaper_state=''
    ORDER BY created_at
  `);
  console.log(`=== 9명 ===`);
  for (const p of dirty) console.log(`  ${p.name}: ${p.id}`);
  const ids = dirty.map(p => p.id);

  // 1. audit_logs 에서 그들의 생성 기록
  console.log(`\n=== audit_logs (CREATE 액션) ===`);
  const placeholders = ids.map((_, i) => `'${ids[i]}'`).join(',');
  const audits = await prisma.$queryRawUnsafe(`
    SELECT entity_id, action, actor_user_id, occurred_at, before_json, after_json
    FROM audit_logs
    WHERE entity_type='patients' AND entity_id IN (${placeholders})
    ORDER BY occurred_at
    LIMIT 30
  `);
  if (audits.length === 0) {
    console.log('  audit_logs 에 기록 없음 — Prisma 우회 또는 audit 호출 안 한 경로');
  } else {
    for (const a of audits) {
      const t = a.occurred_at ? new Date(a.occurred_at).toISOString().slice(0, 19) : '?';
      const _ignore = 0;
      const after = (a.after_json || '').slice(0, 100);
      console.log(`  ${t} | ${a.action} | ${a.actor_user_id} | after: ${after}...`);
    }
  }

  // 2. 어떤 actor 가 만들었나? created_by 컬럼 확인
  const creators = await prisma.$queryRawUnsafe(`
    SELECT p.created_by, u.display_name, COUNT(*) as cnt
    FROM patients p
    LEFT JOIN users u ON u.id = p.created_by
    WHERE p.id IN (${placeholders})
    GROUP BY p.created_by, u.display_name
  `);
  console.log(`\n=== 9명 created_by ===`);
  for (const r of creators) {
    console.log(`  ${r.display_name || r.created_by || 'NULL'}: ${Number(r.cnt)}명`);
  }

  // 3. 그날 다른 환자 created_by 분포 비교
  const otherDay = await prisma.$queryRawUnsafe(`
    SELECT p.created_by, u.display_name, COUNT(*) as cnt, p.diaper_state
    FROM patients p
    LEFT JOIN users u ON u.id = p.created_by
    WHERE DATE(p.created_at) = '2026-04-22'
    GROUP BY p.created_by, u.display_name, p.diaper_state
    ORDER BY cnt DESC
  `);
  console.log(`\n=== 2026-04-22 전체 환자 생성 ===`);
  for (const r of otherDay) {
    console.log(`  ${r.display_name || r.created_by || 'NULL'} | diaper_state='${r.diaper_state}': ${Number(r.cnt)}명`);
  }

  // 4. 그날 import 관련 audit 로그가 있나
  const importEvents = await prisma.$queryRawUnsafe(`
    SELECT action, entity_type, after_json, occurred_at
    FROM audit_logs
    WHERE DATE(occurred_at) = '2026-04-22'
      AND (action LIKE '%IMPORT%' OR action LIKE '%RESTORE%' OR action LIKE '%BULK%')
    ORDER BY occurred_at
    LIMIT 20
  `);
  console.log(`\n=== 2026-04-22 import/restore/bulk 액션 ===`);
  for (const e of importEvents) {
    const t = e.occurred_at ? new Date(e.occurred_at).toISOString().slice(0, 19) : '?';
    const after = (e.after_json || '').slice(0, 80);
    console.log(`  ${t} | ${e.action} | ${e.entity_type} | ${after}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
