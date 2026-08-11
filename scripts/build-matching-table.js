// 외부 거래내역의 품목 ↔ 시스템 items 매칭 후보 생성
// 출력: dist/매칭_후보.csv — 사용자가 확인/수정용

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PDFParse } = require('pdf-parse');

const OUT_DIR = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const db = new Database(path.join(__dirname, '..', 'prisma', 'hospital-supply.db'), { readonly: true });

function csvEscape(s) {
  const str = String(s ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// 시스템의 일반소모품/감염/기저귀/위생 카테고리 items 미리 로드
const candidateCategories = [
  'FAC_KIT_TOOL', 'FAC_TOOL', 'FAC_DISH', 'FAC_DETERGENT', 'FAC_SPONGE', 'FAC_PEST',
  'PAT_HYGIENE', 'PAT_BAG', 'PAT_PAPER', 'PAT_HANDWASH',
  'INFECT_GLOVE', 'INFECT_GOWN', 'INFECT_MASK',
  'DIAPER_MAIN',
];
const sysItems = db.prepare(
  `SELECT id, item_code, name, category, purchase_uom, pack_size
   FROM items
   WHERE deleted_at IS NULL AND category IN (${candidateCategories.map(() => '?').join(',')})`
).all(...candidateCategories);

console.log('시스템 매칭 후보 풀:', sysItems.length, '개 items');

// 한글 처리용 — 공백/특수문자 제거 후 토큰 추출
function tokens(s) {
  return String(s || '')
    .replace(/[\s\(\)\[\],.\-_\/\\*'\"]+/g, ' ')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 0);
}

function similarityScore(extName, sysName) {
  const a = tokens(extName);
  const b = tokens(sysName);
  if (a.length === 0 || b.length === 0) return 0;
  let hits = 0;
  for (const t of a) {
    if (b.includes(t)) hits += 1;
    else if (b.some(x => x.includes(t) || t.includes(x))) hits += 0.5;
  }
  return hits / Math.max(a.length, b.length);
}

function topMatches(extName, n = 3) {
  const scored = sysItems
    .map(it => ({ ...it, score: similarityScore(extName, it.name) }))
    .filter(it => it.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
  return scored;
}

// === 1. 예스상사 매출내역 unique 품목 추출 ===
const wb = XLSX.readFile('C:/Users/총무구매/Downloads/호남요양1월--4월매출내역.xlsx');
const sheet = wb.Sheets['Sheet1'];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
const yesItems = new Map(); // key: category::name::spec → first record
for (const row of rows) {
  const content = String(row[1] || '');
  if (!content.startsWith('>>')) continue;
  const body = content.replace(/^>>\s*/, '').trim();
  if (body.startsWith('부가세') || body.startsWith('(')) continue;
  const priceMatch = body.match(/@\s*([\d,]+)\s*$/);
  if (!priceMatch) continue;
  const unitPrice = Number(priceMatch[1].replace(/,/g, ''));
  const beforePrice = body.slice(0, priceMatch.index).replace(/[\s,]+$/, '').trim();
  const lastSpace = beforePrice.lastIndexOf(' ');
  if (lastSpace < 0) continue;
  const qtyToken = beforePrice.slice(lastSpace + 1).trim();
  const rest = beforePrice.slice(0, lastSpace).trim();
  const parts = rest.split(',').map(s => s.trim()).filter(Boolean);
  const category = parts[0] || '';
  const itemName = parts[1] || '';
  const spec = parts.slice(2).join(', ') || '';
  const key = `${category}::${itemName}::${spec}`;
  if (!yesItems.has(key)) {
    yesItems.set(key, { source: '예스상사', category, itemName, spec, unitPrice });
  }
}

// === 2. 기저귀 거래원장 unique 품목 추출 ===
async function loadDiaperItems() {
  const buffer = fs.readFileSync('C:/Users/총무구매/Downloads/호남THE선요양병원 거래원장.pdf');
  const parser = new PDFParse({ data: buffer });
  const data = await parser.getText();
  const lines = data.text.split(/\r?\n/);
  const diaperItems = new Map();
  const lineRe = /^(\d{4}-\d{2}-\d{2})\s+매출\s+(.+)$/;
  for (const line of lines) {
    const m = line.trim().match(lineRe);
    if (!m) continue;
    const [, date, rest] = m;
    const tail = rest.match(/^(.*?)\s+(\S+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)$/);
    if (!tail) continue;
    const [, nameSpec, unit, qtyStr, priceStr] = tail;
    const lastSp = nameSpec.lastIndexOf(' ');
    const name = lastSp > 0 ? nameSpec.slice(0, lastSp).trim() : nameSpec.trim();
    const spec = lastSp > 0 ? nameSpec.slice(lastSp + 1).trim() : '';
    const key = `${name}::${spec}`;
    if (!diaperItems.has(key)) {
      diaperItems.set(key, { source: '기저귀 거래원장', category: '기저귀', itemName: name, spec, unitPrice: Number(priceStr.replace(/,/g, '')) });
    }
  }
  return diaperItems;
}

async function main() {
  const diaperItems = await loadDiaperItems();

  // === 3. 매칭 후보 CSV 생성 ===
  const all = [...yesItems.values(), ...diaperItems.values()];
  console.log('외부 unique 품목:', all.length, '개');

  const header = ['소스', '외부 분류', '외부 품목명', '외부 규격', '외부 단가(원)', '시스템 매칭 후보 1', '후보1 코드', '시스템 매칭 후보 2', '후보2 코드', '시스템 매칭 후보 3', '후보3 코드', '확정 시스템 코드 (사용자 입력)'];
  const lines = [header.join(',')];
  for (const ext of all) {
    const matches = topMatches(`${ext.itemName} ${ext.spec}`, 3);
    const cells = [
      csvEscape(ext.source),
      csvEscape(ext.category),
      csvEscape(ext.itemName),
      csvEscape(ext.spec),
      ext.unitPrice,
    ];
    for (let i = 0; i < 3; i++) {
      if (matches[i]) {
        cells.push(csvEscape(matches[i].name + (matches[i].pack_size > 1 ? ` (${matches[i].purchase_uom}1=${matches[i].pack_size}ea)` : '')));
        cells.push(csvEscape(matches[i].item_code));
      } else {
        cells.push('');
        cells.push('');
      }
    }
    cells.push(''); // 확정 시스템 코드 (사용자 입력 컬럼)
    lines.push(cells.join(','));
  }
  const outPath = path.join(OUT_DIR, '매칭_후보.csv');
  fs.writeFileSync(outPath, '﻿' + lines.join('\n'), 'utf8');
  console.log('매칭 후보 CSV:', outPath);
  console.log('');
  console.log('총 외부 품목:', all.length);
  console.log('   - 예스상사:', yesItems.size);
  console.log('   - 기저귀:', diaperItems.size);

  db.close();
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
