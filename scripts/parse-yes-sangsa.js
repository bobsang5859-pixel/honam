// 예스상사 매출내역 파싱 + 단가 변동 추출
// 입력: C:/Users/총무구매/Downloads/호남요양1월--4월매출내역.xlsx
// 출력:
//   - dist/예스상사_거래이력.csv (전체 이력)
//   - dist/예스상사_단가변동.csv (인상된 품목만)

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const SRC = 'C:/Users/총무구매/Downloads/호남요양1월--4월매출내역.xlsx';
const OUT_DIR = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function excelSerialToDate(serial) {
  // Excel 1900 base, 1 = 1900-01-01 (실제 1900-01-01 = serial 1)
  // 단, Excel은 1900년을 윤년으로 잘못 처리하므로 -2 보정
  const ms = (Number(serial) - 25569) * 86400 * 1000;
  return new Date(ms);
}

function fmt(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return Math.round(Number(n)).toLocaleString('ko-KR');
}

function csvEscape(s) {
  const str = String(s ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// 명세 라인 파싱 — ">> 분류, 품목명/규격, 수량단위 @단가"
// 다양한 변형 케이스 처리
function parseLine(content) {
  if (!content || !content.startsWith('>>')) return null;
  const body = content.replace(/^>>\s*/, '').trim();
  // 부가세 / 일계 / 월계 등 제외
  if (body.startsWith('부가세') || body.startsWith('(일계') || body.startsWith('(월계')) return null;

  // 단가 추출 — " @숫자" 또는 " @숫자,숫자"
  const priceMatch = body.match(/@\s*([\d,]+)\s*$/);
  if (!priceMatch) return null;
  const unitPrice = Number(priceMatch[1].replace(/,/g, ''));
  const beforePrice = body.slice(0, priceMatch.index).replace(/[\s,]+$/, '').trim();

  // 마지막 공백 split으로 수량+단위 추출
  const lastSpace = beforePrice.lastIndexOf(' ');
  if (lastSpace < 0) return null;
  const qtyToken = beforePrice.slice(lastSpace + 1).trim();
  const rest = beforePrice.slice(0, lastSpace).trim();

  // 수량 + 단위 분리 — 숫자 부분과 알파/한글 단위
  const qtyMatch = qtyToken.match(/^([\d.]+)(.*)$/);
  if (!qtyMatch) return null;
  const qty = Number(qtyMatch[1]);
  const qtyUnit = qtyMatch[2] || '';

  // rest = "분류, 품목명, 규격" 또는 "분류, 품목명"
  const parts = rest.split(',').map(s => s.trim()).filter(Boolean);
  const category = parts[0] || '';
  const itemName = parts[1] || '';
  const spec = parts.slice(2).join(', ') || '';

  return { category, itemName, spec, qty, qtyUnit, unitPrice };
}

// 파일 읽기
const wb = XLSX.readFile(SRC);
const sheet = wb.Sheets['Sheet1'];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

const records = [];
let currentDate = null;

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  const dateCell = row[0];
  const content = String(row[1] || '');
  const amount = row[2];

  if (typeof dateCell === 'number' && dateCell > 0) {
    // 거래 시작 행
    currentDate = excelSerialToDate(dateCell);
  }

  if (!content.startsWith('>>')) continue;
  const parsed = parseLine(content);
  if (!parsed) continue;

  records.push({
    date: currentDate ? currentDate.toISOString().slice(0, 10) : '',
    ...parsed,
    rowAmount: Number(amount) || 0,
  });
}

console.log(`총 명세 라인: ${records.length}건`);

// === 1. 전체 거래 이력 CSV ===
const histPath = path.join(OUT_DIR, '예스상사_거래이력.csv');
const histHeader = ['거래일', '분류', '품목명', '규격', '수량', '단위', '단가(원)', '명세금액(원)'];
const histLines = [histHeader.join(',')];
for (const r of records) {
  histLines.push([
    r.date,
    csvEscape(r.category),
    csvEscape(r.itemName),
    csvEscape(r.spec),
    r.qty,
    csvEscape(r.qtyUnit),
    r.unitPrice,
    r.rowAmount,
  ].join(','));
}
fs.writeFileSync(histPath, '﻿' + histLines.join('\n'), 'utf8'); // BOM 추가 (Excel 한글 깨짐 방지)
console.log(`거래 이력 CSV: ${histPath}`);

// === 2. 단가 변동 분석 ===
// key = `${category}::${itemName}::${spec}` 기준으로 시간순 단가 변화 추적
const groups = new Map();
for (const r of records) {
  const key = `${r.category}::${r.itemName}::${r.spec}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const changes = [];
for (const [key, list] of groups) {
  list.sort((a, b) => a.date.localeCompare(b.date));
  // 단가 변동 발생 케이스만
  const prices = [...new Set(list.map(r => r.unitPrice))];
  if (prices.length === 1) continue;
  const first = list[0];
  const last = list[list.length - 1];
  if (first.unitPrice === last.unitPrice) continue;
  const direction = last.unitPrice > first.unitPrice ? '인상' : '인하';
  const diff = last.unitPrice - first.unitPrice;
  const diffPct = first.unitPrice > 0 ? (diff / first.unitPrice * 100) : 0;
  changes.push({
    category: first.category,
    itemName: first.itemName,
    spec: first.spec,
    firstDate: first.date,
    firstPrice: first.unitPrice,
    lastDate: last.date,
    lastPrice: last.unitPrice,
    direction,
    diff,
    diffPct,
    occurrences: list.length,
  });
}

// 인상만 추출 + 변화율 큰 순 정렬
const increases = changes.filter(c => c.direction === '인상').sort((a, b) => b.diffPct - a.diffPct);
const decreases = changes.filter(c => c.direction === '인하').sort((a, b) => a.diffPct - b.diffPct);

console.log(`단가 변동 발생 품목: ${changes.length}개 (인상 ${increases.length}, 인하 ${decreases.length})`);

const changePath = path.join(OUT_DIR, '예스상사_단가변동.csv');
const changeHeader = ['분류', '품목명', '규격', '거래횟수', '최초거래일', '최초단가', '최종거래일', '최종단가', '변동', '변동액(원)', '변동률(%)'];
const changeLines = [changeHeader.join(',')];
for (const c of [...increases, ...decreases]) {
  changeLines.push([
    csvEscape(c.category),
    csvEscape(c.itemName),
    csvEscape(c.spec),
    c.occurrences,
    c.firstDate,
    c.firstPrice,
    c.lastDate,
    c.lastPrice,
    c.direction,
    c.diff,
    c.diffPct.toFixed(2),
  ].join(','));
}
fs.writeFileSync(changePath, '﻿' + changeLines.join('\n'), 'utf8');
console.log(`단가 변동 CSV: ${changePath}`);

console.log('');
console.log('=== 인상 품목 (상위 20개, 변동률 큰 순) ===');
for (const c of increases.slice(0, 20)) {
  console.log(`  [${c.category}] ${c.itemName} ${c.spec} | ${fmt(c.firstPrice)} → ${fmt(c.lastPrice)} (+${fmt(c.diff)}원, +${c.diffPct.toFixed(1)}%)`);
}
