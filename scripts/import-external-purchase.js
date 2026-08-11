/**
 * 외부 거래내역을 external_purchase_records 테이블로 일괄 통합.
 *
 * 입력:
 *   - C:/Users/총무구매/Downloads/호남요양1월--4월매출내역.xlsx (예스상사)
 *   - C:/Users/총무구매/Downloads/호남THE선요양병원 거래원장.pdf (기저귀, 23.7~26.4)
 *
 * 출력:
 *   - external_purchase_records 278건
 *   - price_history 단가 변동 발생 시점 등록 (source='HISTORY')
 *
 * 매핑 (사용자 확정):
 *   예스상사 (vendor: 5ebeeede-371a-4002-93bb-38ebe0a7fc8f)
 *   기저귀 거래원장 거래처 = 중앙에스엔비 (시스템 vendor_id 자동 조회)
 *
 * 실행:
 *   node scripts/import-external-purchase.js           # dry-run
 *   node scripts/import-external-purchase.js --apply   # 실제 등록
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { PDFParse } = require('pdf-parse');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'prisma', 'hospital-supply.db');
const db = new Database(DB_PATH);

// --- 매핑 표 (사용자 확정) ---
// key = '예스상사:분류::품목명::규격' 또는 '기저귀:품명::규격'
const MAP = {
  // 예스상사
  '예스상사:크린랩::크린백25*35::100매': 'ITEM-0152',
  '예스상사:크린랩::크린지퍼백50매::25*30': 'ITEM-0153',
  '예스상사:지퍼백::크린지퍼백/식구25*30*70매 대::25*30*70': 'ITEM-0153',
  '예스상사:크린랩::쉐프위생백(중형)::25*35*100': 'ITEM-0152',
  '예스상사:수건::수건(얼굴수건)::': 'ITEM-0156',           // 행주
  '예스상사:수건::기성타올(중)::': 'ITEM-0154',              // 수건
  '예스상사:물수건::31*47::얼굴수건31*47': 'ITEM-0155',      // 안면수건
  '예스상사:고무장갑::명진 중 적색::1*10*10': 'ITEM-0165',
  '예스상사:고무장갑::노란장갑(손목)::1*10': 'ITEM-0166',
  '예스상사:고무장갑::명진 중 분홍::1*10*10': 'ITEM-0167',
  '예스상사:고무장갑::명진 중 미색::1*10*10': 'ITEM-0168',
  '예스상사:종이컵::종이컵::1B*1000': 'ITEM-0169',
  '예스상사:비닐::청색62(B)::50L': 'ITEM-0170',              // 쓰레기봉투 파랑
  '예스상사:비닐::쇼핑비닐(검정::대': 'ITEM-0171',           // 쓰레기봉투 흑색
  '예스상사:장갑::줄기사::': 'ITEM-0176',
  '예스상사:락스::락스13 Kg(백양::미성), *1': 'ITEM-0189',
  '예스상사:퐁퐁::퐁퐁 13kg(백양::미성), *1': 'ITEM-0188',
  '예스상사:비누::빨래비누(재활용)::1b*48': 'ITEM-0160',
  '예스상사:비누::옥돌비누::bx=80ea': 'ITEM-0159',           // 세수비누
  '예스상사:모기약::홈토피아 오렌지::1*24': 'ITEM-0173',     // 홈키파 에어졸
  // 기저귀
  '기저귀:투어스 S-Line 매직벨트::특대형10p*8팩': 'ITEM-0003',
  '기저귀:투어스 S-Line 매직벨트 대형 10p*8팩::(일반)': 'ITEM-0002',
  '기저귀:지스 위생매트::10p*20팩': 'ITEM-0004',
  '기저귀:소변패드 리필::30p*10': 'ITEM-0001',
  '기저귀:스마일 점보롤::2p*16롤': 'ITEM-0174',
  '기저귀:점보롤(리치)::2p*16롤': 'ITEM-0174',
};

// vendor id 조회
const YES_VENDOR_ID = db.prepare("SELECT id FROM vendors WHERE name='예스상사' LIMIT 1").get()?.id;
const DIAPER_VENDOR_ID = db.prepare("SELECT id FROM vendors WHERE name='중앙에스엔비' LIMIT 1").get()?.id;
if (!YES_VENDOR_ID) { console.error('ERROR: 예스상사 vendor 없음'); process.exit(1); }
if (!DIAPER_VENDOR_ID) { console.error('ERROR: 중앙에스엔비 vendor 없음'); process.exit(1); }

// item_code → id 조회
function getItemId(code) {
  const row = db.prepare('SELECT id FROM items WHERE item_code = ?').get(code);
  return row?.id;
}

// --- 예스상사 파싱 ---
function excelSerialToISO(serial) {
  const ms = (Number(serial) - 25569) * 86400 * 1000;
  return new Date(ms).toISOString();
}

function parseYesLine(content) {
  if (!content || !content.startsWith('>>')) return null;
  const body = content.replace(/^>>\s*/, '').trim();
  if (body.startsWith('부가세') || body.startsWith('(')) return null;
  const priceMatch = body.match(/@\s*([\d,]+)\s*$/);
  if (!priceMatch) return null;
  const unitPrice = Number(priceMatch[1].replace(/,/g, ''));
  const beforePrice = body.slice(0, priceMatch.index).replace(/[\s,]+$/, '').trim();
  const lastSpace = beforePrice.lastIndexOf(' ');
  if (lastSpace < 0) return null;
  const qtyToken = beforePrice.slice(lastSpace + 1).trim();
  const rest = beforePrice.slice(0, lastSpace).trim();
  const qtyMatch = qtyToken.match(/^([\d.]+)(.*)$/);
  if (!qtyMatch) return null;
  const qty = Number(qtyMatch[1]);
  const qtyUnit = qtyMatch[2] || '';
  const parts = rest.split(',').map(s => s.trim()).filter(Boolean);
  const category = parts[0] || '';
  const itemName = parts[1] || '';
  const spec = parts.slice(2).join(', ') || '';
  return { category, itemName, spec, qty, qtyUnit, unitPrice };
}

function loadYesItems() {
  const wb = XLSX.readFile('C:/Users/총무구매/Downloads/호남요양1월--4월매출내역.xlsx');
  const sheet = wb.Sheets['Sheet1'];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const out = [];
  let curDate = null;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (typeof row[0] === 'number' && row[0] > 0) {
      curDate = excelSerialToISO(row[0]);
    }
    const content = String(row[1] || '');
    if (!content.startsWith('>>')) continue;
    const p = parseYesLine(content);
    if (!p) continue;
    const amount = Number(row[2]) || (p.qty * p.unitPrice);
    out.push({
      source: '예스상사',
      vendor_id: YES_VENDOR_ID,
      date: curDate,
      mapKey: `예스상사:${p.category}::${p.itemName}::${p.spec}`,
      externalName: `${p.category} > ${p.itemName} ${p.spec}`.trim(),
      qty: p.qty,
      unitLabel: p.qtyUnit,
      unitPrice: p.unitPrice,
      amount,
    });
  }
  return out;
}

// --- 기저귀 PDF 파싱 ---
async function loadDiaperItems() {
  const buffer = fs.readFileSync('C:/Users/총무구매/Downloads/호남THE선요양병원 거래원장.pdf');
  const parser = new PDFParse({ data: buffer });
  const data = await parser.getText();
  const lines = data.text.split(/\r?\n/);
  const out = [];
  const lineRe = /^(\d{4}-\d{2}-\d{2})\s+매출\s+(.+)$/;
  for (const line of lines) {
    const m = line.trim().match(lineRe);
    if (!m) continue;
    const [, date, rest] = m;
    if (date < '2023-07-01') continue;
    const tail = rest.match(/^(.*?)\s+(\S+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)$/);
    if (!tail) continue;
    const [, nameSpec, unit, qtyStr, priceStr, , , totalStr] = tail;
    const lastSp = nameSpec.lastIndexOf(' ');
    const name = lastSp > 0 ? nameSpec.slice(0, lastSp).trim() : nameSpec.trim();
    const spec = lastSp > 0 ? nameSpec.slice(lastSp + 1).trim() : '';
    out.push({
      source: '기저귀_거래원장',
      vendor_id: DIAPER_VENDOR_ID,
      date: new Date(date + 'T00:00:00.000Z').toISOString(),
      mapKey: `기저귀:${name}::${spec}`,
      externalName: `${name} ${spec}`.trim(),
      qty: Number(qtyStr.replace(/,/g, '')),
      unitLabel: unit,
      unitPrice: Number(priceStr.replace(/,/g, '')),
      amount: Number(totalStr.replace(/,/g, '')),
    });
  }
  return out;
}

async function main() {
  console.log(`[external-import] mode = ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  vendor 예스상사 = ${YES_VENDOR_ID}`);
  console.log(`  vendor 중앙에스엔비 = ${DIAPER_VENDOR_ID}`);
  console.log('');

  const yesRecords = loadYesItems();
  const diaperRecords = await loadDiaperItems();
  const all = [...yesRecords, ...diaperRecords];
  console.log(`예스상사: ${yesRecords.length}건, 기저귀: ${diaperRecords.length}건, 합계: ${all.length}건`);

  // 매핑 적용
  const resolved = [];
  const unresolved = new Map();
  for (const r of all) {
    const itemCode = MAP[r.mapKey];
    if (!itemCode) {
      unresolved.set(r.mapKey, (unresolved.get(r.mapKey) || 0) + 1);
      continue;
    }
    const itemId = getItemId(itemCode);
    if (!itemId) {
      console.error(`ERROR: item_code ${itemCode} not found for ${r.mapKey}`);
      continue;
    }
    resolved.push({ ...r, item_id: itemId, item_code: itemCode });
  }

  console.log(`매핑 성공: ${resolved.length}건 / 매핑 누락: ${[...unresolved.values()].reduce((a, b) => a + b, 0)}건`);
  if (unresolved.size > 0) {
    console.log('--- 누락된 매핑 키 ---');
    for (const [k, n] of unresolved) console.log(`  (${n}건) ${k}`);
  }

  // external_purchase_records 등록
  if (APPLY) {
    const insertEpr = db.prepare(`
      INSERT INTO external_purchase_records
        (id, item_id, vendor_id, source_label, transaction_date, qty, unit_label, unit_price, amount, external_name, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const tx = db.transaction((records) => {
      for (const r of records) {
        insertEpr.run(uuidv4(), r.item_id, r.vendor_id, r.source, r.date, r.qty, r.unitLabel, r.unitPrice, r.amount, r.externalName, '');
      }
    });
    tx(resolved);
    console.log(`✓ external_purchase_records: ${resolved.length}건 등록`);
  } else {
    console.log(`(dry-run) external_purchase_records: ${resolved.length}건 등록 예정`);
  }

  // price_history — 단가 변동 발생 시점 등록 (source='HISTORY')
  // 같은 (item_id, vendor_id) 조합에서 단가가 바뀐 순간만 추출
  const byItemVendor = new Map();
  for (const r of resolved) {
    const key = `${r.item_id}::${r.vendor_id}`;
    if (!byItemVendor.has(key)) byItemVendor.set(key, []);
    byItemVendor.get(key).push(r);
  }
  const priceEntries = [];
  for (const [key, list] of byItemVendor) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    let lastPrice = null;
    for (const r of list) {
      if (lastPrice === null || r.unitPrice !== lastPrice) {
        priceEntries.push({
          item_id: r.item_id,
          vendor_id: r.vendor_id,
          price: r.unitPrice,
          effective_from: r.date,
          source: 'HISTORY',
        });
        lastPrice = r.unitPrice;
      }
    }
  }
  console.log('');
  console.log(`price_history 등록 예정: ${priceEntries.length}건 (source='HISTORY')`);

  if (APPLY) {
    const insertPh = db.prepare(`
      INSERT INTO price_history (id, item_id, vendor_id, price, currency, effective_from, source, created_at)
      VALUES (?, ?, ?, ?, 'KRW', ?, ?, CURRENT_TIMESTAMP)
    `);
    const tx = db.transaction((entries) => {
      for (const e of entries) {
        insertPh.run(uuidv4(), e.item_id, e.vendor_id, e.price, e.effective_from, e.source);
      }
    });
    tx(priceEntries);
    console.log(`✓ price_history: ${priceEntries.length}건 등록`);
  } else {
    console.log(`(dry-run) price_history: ${priceEntries.length}건 등록 예정`);
    console.log('--- 단가 변동 발생 품목 ---');
    const variants = priceEntries.reduce((m, e) => {
      m[e.item_id] = (m[e.item_id] || []).concat(e.price);
      return m;
    }, {});
    for (const [iid, prices] of Object.entries(variants)) {
      if (new Set(prices).size > 1) {
        const code = db.prepare('SELECT item_code, name FROM items WHERE id = ?').get(iid);
        console.log(`  [${code?.item_code}] ${code?.name}: ${[...new Set(prices)].join(' → ')}원`);
      }
    }
  }

  db.close();
  console.log('');
  console.log(APPLY ? '완료' : 'DRY-RUN — 실제 적용은 --apply 추가');
}

main().catch(e => { console.error(e); process.exit(1); });
