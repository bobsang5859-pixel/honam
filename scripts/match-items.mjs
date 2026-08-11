// 거래내역 품목명 → 시스템 item 매칭 dry-run (v2)
// 1) unique raw_name 추출 (반복 라인은 1번만 매핑)
// 2) 시스템 item.name 토큰 매칭 + 단가 보조
// 3) 이미 등록된 GR-202605-00007/8/9 라인을 정답 사전으로 활용

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const prisma = new PrismaClient();
const transactions = JSON.parse(readFileSync('scripts/transactions.json', 'utf-8'));

const items = await prisma.item.findMany({
  where: { is_active: true, deleted_at: null },
  select: { id: true, item_code: true, name: true, category: true },
});

// 정규화
const norm = (s) => String(s ?? '')
  .replace(/[\s()<>\[\]{}\-_.,!?:;'"`~@#$%^&*+=\\/|]/g, '')
  .replace(/\*/g, '')
  .toLowerCase();

// 토큰화 (영문 단어, 한글 단어, 숫자)
const tokenize = (s) => {
  const out = [];
  const re = /[a-z]+|[가-힣]+|\d+/gi;
  let m;
  while ((m = re.exec(String(s ?? ''))) !== null) out.push(m[0].toLowerCase());
  return out;
};

function scoreMatch(rawName, itemName) {
  const a = norm(rawName);
  const b = norm(itemName);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b)) return 85;
  if (b.includes(a)) return 80;
  // 토큰 교집합
  const ta = new Set(tokenize(rawName));
  const tb = new Set(tokenize(itemName));
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = [...ta].filter(t => tb.has(t)).length;
  const denom = Math.max(ta.size, tb.size);
  return Math.round((inter / denom) * 70);
}

// unique raw_name → 최대 단가 + 빈도
const uniqueMap = new Map();
for (const tx of transactions) {
  for (const line of tx.items) {
    const key = line.raw_name;
    const e = uniqueMap.get(key) ?? { count: 0, totalQty: 0, prices: new Set() };
    e.count += 1;
    e.totalQty += line.qty;
    e.prices.add(line.unit_price);
    uniqueMap.set(key, e);
  }
}
const uniques = [...uniqueMap.entries()].map(([k, v]) => ({
  raw_name: k,
  count: v.count,
  qty_total: v.totalQty,
  price_samples: [...v.prices].slice(0, 3),
}));

// 이미 등록된 GR의 line 단가 dictionary — 거래내역 4/8/15/16 의 raw_name 과 동일 단가 → 같은 item 추정
const knownGrs = await prisma.goodsReceipt.findMany({
  where: { gr_no: { in: ['GR-202605-00007', 'GR-202605-00008', 'GR-202605-00009'] }, deleted_at: null },
  include: { stock_in_items: { include: { item: true } } },
});
const knownLines = []; // { unit_price, item, item_name_norm }
for (const gr of knownGrs) {
  for (const sii of gr.stock_in_items) {
    knownLines.push({
      unit_price: Number(sii.unit_price),
      qty: Number(sii.received_qty),
      item: sii.item,
    });
  }
}

console.log(`고유 품목명: ${uniques.length} 종 (전체 라인 ${[...uniqueMap.values()].reduce((s, v) => s + v.count, 0)})`);
console.log(`기존 등록 GR 라인 (정답 후보): ${knownLines.length}`);

const result = [];
for (const u of uniques) {
  // 1) 시스템 item 점수
  const scored = items.map(it => ({ it, score: scoreMatch(u.raw_name, it.name) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // 2) 기존 등록 GR 의 단가가 일치하는 라인 — 단가 일치 보너스
  const priceMatched = new Set();
  for (const pr of u.price_samples) {
    for (const kl of knownLines) {
      if (Math.abs(kl.unit_price - pr) < 0.5) priceMatched.add(kl.item.id);
    }
  }
  // 단가 일치한 후보를 위로 끌어올림
  for (const s of scored) {
    if (priceMatched.has(s.it.id)) s.score += 15;
  }
  scored.sort((a, b) => b.score - a.score);

  result.push({ ...u, candidates: scored });
}

// 결과 분류
const auto = result.filter(r => r.candidates[0]?.score >= 80 && (r.candidates.length === 1 || r.candidates[0].score - (r.candidates[1]?.score ?? 0) >= 15));
const review = result.filter(r => !(r.candidates[0]?.score >= 80 && (r.candidates.length === 1 || r.candidates[0].score - (r.candidates[1]?.score ?? 0) >= 15)));

console.log(`\n=== 분류 ===`);
console.log(`  자동 확정: ${auto.length} 종`);
console.log(`  사용자 검토 필요: ${review.length} 종`);

console.log(`\n=== 자동 확정 (앞 30) ===`);
for (const a of auto.slice(0, 30)) {
  console.log(`  "${a.raw_name}" → ${a.candidates[0].it.item_code} ${a.candidates[0].it.name} (${a.candidates[0].score})`);
}
if (auto.length > 30) console.log(`  ... 외 ${auto.length - 30}종`);

console.log(`\n=== 사용자 검토 필요 ===`);
for (const r of review) {
  const priceStr = r.price_samples.map(p => `${p}원`).join('/');
  console.log(`\n"${r.raw_name}" (총${r.count}회, 단가${priceStr})`);
  for (const c of r.candidates.slice(0, 4)) {
    console.log(`   (${c.score}) ${c.it.item_code} | ${c.it.name}`);
  }
}

// 결과를 JSON 으로 저장 — 다음 단계(매핑 확정)에서 사용
const mappingDraft = result.map(r => ({
  raw_name: r.raw_name,
  count: r.count,
  qty_total: r.qty_total,
  best_item_id: r.candidates[0]?.it?.id ?? null,
  best_item_code: r.candidates[0]?.it?.item_code ?? null,
  best_item_name: r.candidates[0]?.it?.name ?? null,
  best_score: r.candidates[0]?.score ?? 0,
  needs_review: !(r.candidates[0]?.score >= 80 && (r.candidates.length === 1 || r.candidates[0].score - (r.candidates[1]?.score ?? 0) >= 15)),
  candidates: r.candidates.map(c => ({ item_id: c.it.id, item_code: c.it.item_code, name: c.it.name, score: c.score })),
}));
const { writeFileSync } = await import('node:fs');
writeFileSync('scripts/item-mapping.json', JSON.stringify(mappingDraft, null, 2), 'utf-8');
console.log(`\n매핑 초안 저장: scripts/item-mapping.json`);

await prisma.$disconnect();
