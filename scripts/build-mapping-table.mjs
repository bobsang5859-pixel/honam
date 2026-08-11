// 4월 GR (00007/8/9) 라인을 정답 사전으로 활용해서 거래내역 raw_name → system item 매핑 표 생성
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'node:fs';

const prisma = new PrismaClient();
const transactions = JSON.parse(readFileSync('scripts/transactions.json', 'utf-8'));

// === 1) 거래내역의 4월 출고 데이터 (이미 등록된 4/8, 4/15, 4/16) 가져오기 ===
const aprilTransactions = JSON.parse(readFileSync('scripts/transactions-april.json', 'utf-8').toString() || '[]');
// transactions-april.json 이 없으면 거래내역 엑셀에서 직접 추출 필요 — 4/8/15/16 행만.

// 위 파일 없으면 거래내역에서 4월 분 따로 가져오기 (extract-transactions 가 4월 제외하므로 별도 추출 필요)
// 임시 — DB 의 GR 라인만 활용

const knownGrs = await prisma.goodsReceipt.findMany({
  where: { gr_no: { in: ['GR-202605-00007', 'GR-202605-00008', 'GR-202605-00009'] }, deleted_at: null },
  include: { stock_in_items: { include: { item: true } } },
});

// 4월 GR 라인: 모든 sii.item.name + unit_price + qty
const knownLines = [];
for (const gr of knownGrs) {
  for (const sii of gr.stock_in_items) {
    knownLines.push({
      gr_no: gr.gr_no,
      item_id: sii.item_id,
      item_code: sii.item.item_code,
      item_name: sii.item.name,
      unit_price: Number(sii.unit_price),
      qty: Number(sii.received_qty),
    });
  }
}

// === 2) 모든 시스템 item 가져오기 ===
const allItems = await prisma.item.findMany({
  where: { is_active: true, deleted_at: null },
  select: { id: true, item_code: true, name: true, category: true },
});

// === 3) 거래내역에서 unique raw_name 추출 (가장 흔한 단가도 함께) ===
const uniqueMap = new Map();
for (const tx of transactions) {
  for (const line of tx.items) {
    const key = line.raw_name;
    const e = uniqueMap.get(key) ?? { count: 0, qty_total: 0, prices: [] };
    e.count += 1;
    e.qty_total += line.qty;
    e.prices.push(line.unit_price);
    uniqueMap.set(key, e);
  }
}
// 가장 빈번한 단가 = mode
function mode(arr) {
  const c = {};
  for (const v of arr) c[v] = (c[v] ?? 0) + 1;
  let best = arr[0]; let bestC = 0;
  for (const [v, n] of Object.entries(c)) if (n > bestC) { bestC = n; best = Number(v); }
  return best;
}
const uniques = [...uniqueMap.entries()].map(([k, v]) => ({
  raw_name: k,
  count: v.count,
  qty_total: v.qty_total,
  mode_price: mode(v.prices),
}));

// === 4) 매칭 - 4월 GR 라인의 단가와 일치하면 우선, 이름 점수도 결합 ===
const tokenize = (s) => {
  const out = [];
  const re = /[a-z]+|[가-힣]+|\d+/gi;
  let m;
  while ((m = re.exec(String(s ?? ''))) !== null) out.push(m[0].toLowerCase());
  return out;
};

function nameScore(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  const inter = [...ta].filter(t => tb.has(t)).length;
  return inter / Math.max(ta.size, tb.size);
}

const result = [];
for (const u of uniques) {
  // 4월 GR 라인 중 단가 일치 + 이름 점수 높은 후보
  const priceMatches = knownLines.filter(kl => Math.abs(kl.unit_price - u.mode_price) < 0.5);
  let known = null;
  if (priceMatches.length >= 1) {
    // 단가 일치 + 이름 유사 최고
    known = priceMatches
      .map(kl => ({ ...kl, score: nameScore(u.raw_name, kl.item_name) }))
      .sort((a, b) => b.score - a.score)[0];
  }
  // 전체 시스템 item 중 이름 점수 top
  const all = allItems
    .map(it => ({ it, score: nameScore(u.raw_name, it.name) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  result.push({
    raw_name: u.raw_name,
    count: u.count,
    mode_price: u.mode_price,
    known_match: known ? { item_id: known.item_id, item_code: known.item_code, item_name: known.item_name, gr_no: known.gr_no } : null,
    top_candidates: all.map(s => ({ item_id: s.it.id, item_code: s.it.item_code, name: s.it.name, score: Math.round(s.score * 100) })),
  });
}

writeFileSync('scripts/mapping-table.json', JSON.stringify(result, null, 2), 'utf-8');

// 표 형태로 출력
console.log(`\n# 거래내역 ↔ 시스템 품목 매핑표 (총 ${result.length}건)\n`);
console.log(`| # | 거래내역 품목명 | 단가 | 회수 | 추천 매핑 | 비고 |`);
console.log(`|---|---|---|---|---|---|`);
for (let i = 0; i < result.length; i++) {
  const r = result[i];
  const pick = r.known_match || r.top_candidates[0];
  const note = r.known_match
    ? `4월GR 정답 (${r.known_match.gr_no})`
    : (r.top_candidates[0] ? `자동 추정 score ${r.top_candidates[0].score}` : '⚠ 매칭 없음');
  const pickStr = pick ? `${pick.item_code ?? pick.item_id} | ${pick.item_name ?? pick.name}` : '⚠ 없음';
  console.log(`| ${i + 1} | ${r.raw_name} | ${r.mode_price.toLocaleString()} | ${r.count}회 | ${pickStr} | ${note} |`);
}

console.log(`\n매핑표 JSON: scripts/mapping-table.json`);
await prisma.$disconnect();
