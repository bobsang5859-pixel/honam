// 기저귀 거래원장 PDF 파싱
// 입력: C:/Users/총무구매/Downloads/호남THE선요양병원 거래원장.pdf
// 출력: dist/기저귀_거래이력.csv (2023-07 부터 매출만)

const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const SRC = 'C:/Users/총무구매/Downloads/호남THE선요양병원 거래원장.pdf';
const OUT_DIR = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function csvEscape(s) {
  const str = String(s ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

async function main() {
  const buffer = fs.readFileSync(SRC);
  const parser = new PDFParse({ data: buffer });
  const data = await parser.getText();
  const text = data.text;
  fs.writeFileSync(path.join(OUT_DIR, '_diaper_raw.txt'), text, 'utf8');

  // 라인 분리 — 줄 단위 처리
  const lines = text.split(/\r?\n/);
  const records = [];

  // 매출 라인 패턴 — 다양한 변형 대응
  // 예: "2023-01-04 매출 지스 위생매트 10p*20팩 박스 1 40,000 40,000 0 40,000 40,000 0 160,000"
  // 컬럼: 거래일자 구분 품명 규격 단위 수량 단가 공급가액 세액 합계액 거래액 결제액 잔액
  // 단위는 보통 한글 한 단어 (박스/팩/봉/EA 등), 수량은 정수, 금액은 콤마 포함
  const lineRe = /^(\d{4}-\d{2}-\d{2})\s+(매출|수금|매입)\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const m = line.match(lineRe);
    if (!m) continue;
    const [, date, kind, rest] = m;

    if (kind === '수금') {
      // 수금 라인 — 잔액만 추출 (참고용)
      records.push({ date, kind, name: '', spec: '', unit: '', qty: 0, unitPrice: 0, amount: 0, _raw: rest });
      continue;
    }

    // 매출 라인 — 뒷부분이 "..품명 규격 단위 수량 단가 ...금액..."
    // 뒤에서부터 숫자 7개가 금액 컬럼. 그 앞이 수량/단가 (수량은 단위 앞)
    // 단위가 한 단어라 가정: 박스/팩/봉/EA/개/매/PCS 등
    // 정규식: "...품명_규격 단위 수량 단가 공급 세 합계 거래 결제 잔액"

    const tail = rest.match(/^(.*?)\s+(\S+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)$/);
    if (!tail) {
      records.push({ date, kind, name: rest, spec: '', unit: '', qty: 0, unitPrice: 0, amount: 0, _raw: rest, _parsed: false });
      continue;
    }
    const [, nameSpec, unit, qtyStr, priceStr, supplyStr, taxStr, totalStr, txStr, payStr, balanceStr] = tail;
    const qty = Number(qtyStr.replace(/,/g, ''));
    const unitPrice = Number(priceStr.replace(/,/g, ''));
    const amount = Number(totalStr.replace(/,/g, ''));

    // 품명/규격 분리 — 마지막 공백 split (대부분 규격은 "10p*20팩" 같이 한 단어)
    const lastSp = nameSpec.lastIndexOf(' ');
    const name = lastSp > 0 ? nameSpec.slice(0, lastSp).trim() : nameSpec.trim();
    const spec = lastSp > 0 ? nameSpec.slice(lastSp + 1).trim() : '';

    records.push({ date, kind, name, spec, unit, qty, unitPrice, amount, balance: Number(balanceStr.replace(/,/g, '')) });
  }

  console.log(`총 라인: ${records.length}건`);

  // 2023-07 이후 매출만 추출
  const filtered = records.filter(r => r.kind === '매출' && r.date >= '2023-07-01');
  console.log(`23년 7월 이후 매출 라인: ${filtered.length}건`);

  // 품명별 집계 — 확인용
  const byName = new Map();
  for (const r of filtered) {
    const key = `${r.name}::${r.spec}`;
    if (!byName.has(key)) byName.set(key, { count: 0, totalQty: 0, totalAmount: 0, priceVariants: new Set() });
    const e = byName.get(key);
    e.count += 1;
    e.totalQty += r.qty;
    e.totalAmount += r.amount;
    e.priceVariants.add(r.unitPrice);
  }

  console.log('');
  console.log('=== 품명별 집계 ===');
  console.log('품명                              | 규격          | 건수 | 총수량 | 총금액(원)    | 단가 변동');
  for (const [key, e] of byName) {
    const [name, spec] = key.split('::');
    const prices = [...e.priceVariants].sort((a, b) => a - b);
    const priceLabel = prices.length === 1 ? `${prices[0].toLocaleString()}원` : `${prices.map(p => p.toLocaleString()).join(' → ')}원`;
    console.log(
      (name || '').padEnd(34) + ' | '
      + (spec || '').padEnd(14) + ' | '
      + String(e.count).padStart(4) + ' | '
      + String(e.totalQty).padStart(6) + ' | '
      + e.totalAmount.toLocaleString().padStart(13) + ' | '
      + priceLabel
    );
  }

  // CSV 출력
  const csvPath = path.join(OUT_DIR, '기저귀_거래이력.csv');
  const header = ['거래일', '품명', '규격', '단위', '수량', '단가(원)', '금액(원)'];
  const csvLines = [header.join(',')];
  for (const r of filtered) {
    csvLines.push([
      r.date,
      csvEscape(r.name),
      csvEscape(r.spec),
      csvEscape(r.unit),
      r.qty,
      r.unitPrice,
      r.amount,
    ].join(','));
  }
  fs.writeFileSync(csvPath, '﻿' + csvLines.join('\n'), 'utf8');
  console.log('');
  console.log(`거래 이력 CSV: ${csvPath}`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
