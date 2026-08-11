/**
 * 거래원장 (중앙에스엔비) 정밀 재통합.
 *
 * 이전 파싱은 날짜 있는 매출 라인만 잡고, 같은 거래일 안의 후속 라인을 놓침.
 * 이번에 거래일 상속 로직 + 날짜 없이 시작하는 거래 라인도 포함.
 *
 * 동작:
 *   1. external_purchase_records 중 source_label='기저귀_거래원장' 모두 삭제
 *   2. PDF 정밀 파싱 (날짜 상속)
 *   3. 매핑 적용 후 external_purchase_records 재등록
 *   4. price_history 단가 변동 시점 재등록 (source='HISTORY', vendor=중앙에스엔비)
 *
 * 실행:
 *   node scripts/reimport-diaper-ledger.js          # dry-run
 *   node scripts/reimport-diaper-ledger.js --apply  # 실제
 */

const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'prisma', 'hospital-supply.db');
const db = new Database(DB_PATH);

console.log(`[reimport-diaper] mode = ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

// 매핑: 외부 품명 (정확히 일치) → 시스템 ITEM 코드
const MAP = {
  '투어스 S-Line 매직벨트 대형 10p*8팩::(일반)': 'ITEM-0002',  // 겉기저귀 (대)
  '투어스 S-Line 매직벨트::특대형10p*8팩': 'ITEM-0003',        // 겉기저귀 (특대)
  '지스 위생매트::10p*20팩': 'ITEM-0004',                      // 이지메트
  '소변패드 리필::30p*10': 'ITEM-0001',                        // 속기저귀
  '스마일 점보롤::2p*16롤': 'ITEM-0174',                       // 점보롤
  '점보롤(리치)::2p*16롤': 'ITEM-0174',                        // 점보롤 (같은 품목, 브랜드 다름)
  '들꽃향기 물티슈 (100매)::20*1(150*200)': 'ITEM-0237',       // 물티슈
  '핸드타올::100매*50밴드': 'ITEM-0192',                       // 핸드타올
  '핸드타올(라비)::100매*50밴드': 'ITEM-0192',                  // 핸드타올 (같은 품목, 브랜드 다름)
};

const VENDOR = db.prepare("SELECT id FROM vendors WHERE name='중앙에스엔비'").get();
if (!VENDOR) { console.error('중앙에스엔비 vendor 미발견'); process.exit(1); }
const itemIdMap = new Map();
for (const code of new Set(Object.values(MAP))) {
  const item = db.prepare('SELECT id FROM items WHERE item_code=?').get(code);
  if (!item) { console.error('item 미발견:', code); process.exit(1); }
  itemIdMap.set(code, item.id);
}

async function parsePdf() {
  const buffer = fs.readFileSync('C:/Users/총무구매/Downloads/호남THE선요양병원 거래원장.pdf');
  const parser = new PDFParse({ data: buffer });
  const data = await parser.getText();
  const lines = data.text.split(/\r?\n/);

  // 거래 라인 패턴: ...품명 단위 수량 단가 공급가액 세액 합계액 거래액 결제액 잔액
  const txRe = /^(.+?)\s+(\S+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)$/;

  let currentDate = null;
  const records = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (t.includes('거래장') || t.includes('조회일자') || t.includes('상호') || t.includes('주소') || t.includes('비고')
        || t.includes('거래일자 구분 품명') || /^\d+\/\d+/.test(t)
        || t === '매출' || t === '매입' || t.includes('월계') || t.includes('의료법인')) continue;

    const dm = t.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)$/);
    let body;
    if (dm) {
      currentDate = dm[1];
      body = dm[2];
    } else {
      body = t;
    }

    // 매출/매입/수금 키워드 제거
    const kindMatch = body.match(/^(매출|매입|수금)\s+(.+)$/);
    let isSugeum = false;
    if (kindMatch) {
      if (kindMatch[1] === '수금') isSugeum = true;
      body = kindMatch[2];
    }
    if (isSugeum) continue;
    if (!currentDate) continue;

    const tm = body.match(txRe);
    if (!tm) continue;

    const [, nameSpec, unit, qtyStr, priceStr, supplyStr, taxStr, totalStr] = tm;
    const lastSp = nameSpec.lastIndexOf(' ');
    const name = lastSp > 0 ? nameSpec.slice(0, lastSp).trim() : nameSpec.trim();
    const spec = lastSp > 0 ? nameSpec.slice(lastSp + 1).trim() : '';

    records.push({
      date: currentDate,
      name, spec, unit,
      qty: Number(qtyStr.replace(/,/g, '')),
      unitPrice: Number(priceStr.replace(/,/g, '')),
      amount: Number(totalStr.replace(/,/g, '')),
    });
  }

  return records;
}

async function main() {
  const all = await parsePdf();
  // 23년 7월부터
  const filtered = all.filter(r => r.date >= '2023-07-01');
  console.log(`정밀 파싱: 전체 ${all.length}건 / 23.7 이후 ${filtered.length}건`);

  const mapped = [];
  const unmapped = new Map();
  for (const r of filtered) {
    const key = `${r.name}::${r.spec}`;
    const code = MAP[key];
    if (!code) {
      unmapped.set(key, (unmapped.get(key) || 0) + 1);
      continue;
    }
    mapped.push({ ...r, item_code: code, item_id: itemIdMap.get(code) });
  }
  console.log(`매핑 성공: ${mapped.length}건 / 누락: ${[...unmapped.values()].reduce((a,b)=>a+b,0)}건`);
  for (const [k, n] of unmapped) console.log(`  (${n}건) ${k}`);

  // 품목별 단가 변동 분석
  console.log('');
  console.log('=== 품목별 단가 변동 ===');
  const byItem = new Map();
  for (const r of mapped) {
    if (!byItem.has(r.item_code)) byItem.set(r.item_code, []);
    byItem.get(r.item_code).push(r);
  }
  for (const [code, list] of byItem) {
    const prices = [...new Set(list.map(r => r.unitPrice))].sort((a,b)=>a-b);
    const name = db.prepare('SELECT name FROM items WHERE item_code=?').get(code).name;
    console.log(`  ${code} ${name} | ${list.length}건 | 단가: ${prices.map(p=>p.toLocaleString()).join(' → ')}원`);
  }

  if (!APPLY) {
    console.log('');
    console.log('DRY-RUN — 실제 적용은 --apply');
    db.close();
    return;
  }

  // 트랜잭션
  const tx = db.transaction(() => {
    // 1. 기존 기저귀 거래원장 데이터 삭제
    const delEpr = db.prepare(`DELETE FROM external_purchase_records WHERE source_label = '기저귀_거래원장'`).run();
    console.log(`기존 external_purchase_records 삭제: ${delEpr.changes}건`);

    // 2. 기존 price_history 중 source='HISTORY' 의 중앙에스엔비 데이터 삭제
    const delPh = db.prepare(`DELETE FROM price_history WHERE source='HISTORY' AND vendor_id = ?`).run(VENDOR.id);
    console.log(`기존 price_history 삭제: ${delPh.changes}건`);

    // 3. 정밀 데이터 등록
    const insEpr = db.prepare(`
      INSERT INTO external_purchase_records
        (id, item_id, vendor_id, source_label, transaction_date, qty, unit_label, unit_price, amount, external_name, note, created_at)
      VALUES (?, ?, ?, '기저귀_거래원장', ?, ?, ?, ?, ?, ?, '', CURRENT_TIMESTAMP)
    `);
    for (const r of mapped) {
      insEpr.run(uuidv4(), r.item_id, VENDOR.id,
        new Date(r.date + 'T00:00:00.000Z').toISOString(),
        r.qty, r.unit, r.unitPrice, r.amount,
        `${r.name} ${r.spec}`.trim());
    }
    console.log(`external_purchase_records 등록: ${mapped.length}건`);

    // 4. price_history 등록 — 단가 변동 시점만 + 첫 단가
    const insPh = db.prepare(`
      INSERT INTO price_history (id, item_id, vendor_id, price, currency, effective_from, source, created_at)
      VALUES (?, ?, ?, ?, 'KRW', ?, 'HISTORY', CURRENT_TIMESTAMP)
    `);
    let phCount = 0;
    for (const [code, list] of byItem) {
      list.sort((a,b) => a.date.localeCompare(b.date));
      let lastPrice = null;
      for (const r of list) {
        if (r.unitPrice !== lastPrice) {
          insPh.run(uuidv4(), itemIdMap.get(code), VENDOR.id, r.unitPrice,
            new Date(r.date + 'T00:00:00.000Z').toISOString());
          lastPrice = r.unitPrice;
          phCount += 1;
        }
      }
    }
    console.log(`price_history 등록: ${phCount}건`);
  });

  tx();
  console.log('✓ APPLY 완료');
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
