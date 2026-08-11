/**
 * 엑셀 품목 일괄 임포트 — 기존 품목 전체 soft-delete + 새 데이터 insert
 *
 * 사용법:
 *   ts-node tools/import-items-from-xlsx.ts                    # 드라이런 (CSV 출력)
 *   ts-node tools/import-items-from-xlsx.ts --apply             # 실제 적용
 *
 * 입력: 품목목록_20260314092033.xlsx (헤더: 통계카테고리, 품목명, 규격, 단위, 매입단가)
 *
 * 동작:
 *   1) 키워드 + 통계카테고리 기반 자동 매핑 (3단 계층 중분류)
 *   2) 품목코드 자동 생성 (ITEM-0001 ~ ITEM-0505)
 *   3) 규격 → sub_category 필드
 *   4) 매입단가는 무시 (vendor 매핑 별도 작업)
 *   5) --apply: 기존 521개 품목 soft-delete + 신규 insert
 */
import { PrismaClient } from '@prisma/client';
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();
const XLSX_PATH = path.resolve('품목목록_20260314092033.xlsx');

interface RawRow {
  statsCategory: string;
  name: string;
  spec: string;
  uom: string;
  price: number | null;
}

interface MappedItem extends RawRow {
  code: string;
  category: string;
  stats_bucket: string;
  matched_rule: string;
}

// 통계카테고리 fallback
const FALLBACK: Record<string, string> = {
  '의료소모품': 'MED_OTHER',
  '의료기기 부속품': 'MED_OTHER',
  '일반소모품': 'FAC_OTHER',
  '사무용품': 'OFF_OTHER',
  '인쇄물': 'OFF_PAPER',
  '식음료': 'FOOD_DRINK',
  '기저귀': 'PAT_DIAPER',
  '일반비품': 'EQUIP_FURNITURE',
  '가전제품': 'EQUIP_APPLIANCE',
  '의료기기': 'EQUIP_MEDICAL',
  'PC': 'EQUIP_IT',
};

// 키워드 매핑 규칙 (recategorize-items.ts 와 동일 + 보강)
const RULES: Array<{ pattern: RegExp; category: string; note: string }> = [
  // ── 의료소모품 ────────────────────────────────────────────
  { pattern: /Nelaton|T-?Tube|T.?piece|Rectal\s*Tube|SURECAN|TWO-?lumen|cvc|PEG|gastric|stoma|urine\s*bag|foley|levin|ngt/i, category: 'MED_CATHETER', note: '카테터' },
  { pattern: /Nasal\s*Cannular|Nebu[il]izer|Speechcannu[il]a|TRACOE|STYLET|LARYNGO|M-?VAC|ventilator|humidifier|오투|O2|airway|air.?way|endo.?tube|breathing|흡인|suction|산소|마스크(?!.*보안)/i, category: 'MED_AIRWAY', note: '호흡' },
  { pattern: /Medicut|novo\s*fine|Dosi\s*Flow|3-?Way|insulin|heparin(?!.?cap)|수액세트|syringe|주사기|needle|주사바늘|주사|투약/i, category: 'MED_INJECTION', note: '주사·투약' },
  { pattern: /Decopore|micropore|테가덤|tegaderm|biopore|durapore|cotton|필터볼|band(?:age)?|gauze|거즈|솜|indicator|dressing|drape|swab|alcohol\s*swab/i, category: 'MED_DRESSING', note: '드레싱' },
  { pattern: /ECG|EKG|AED|monitor|probe|심전|혈당|glucometer|체온계|thermometer|ox[iy]meter|측정|검사지|test.?strip|혈압계|stethoscope|청진기/i, category: 'MED_MONITOR', note: '검사·모니터' },
  { pattern: /I\.?V\.?\s*CATH|catheter|heparine.?cap|connector|extension|port/i, category: 'MED_CATHETER', note: '카테터' },
  { pattern: /유리알콜램프|알콜램프|수술칼|surgical\s*blade|blade|scalpel|Focep|forceps|NYLON|suture|봉합/i, category: 'MED_OTHER', note: '수술·기타 의료' },

  // ── 환자 생활용품 ─────────────────────────────────────────
  { pattern: /기저귀|diaper/i, category: 'PAT_DIAPER', note: '기저귀' },
  { pattern: /샴푸|바디(?!오일)|비누|물티슈|가글|로션|클렌(져|저)|세수|목욕|수건|타월|towel|치약|칫솔|면도|발톱\s*니퍼|손톱|스킨/i, category: 'PAT_BATH', note: '세면·목욕' },
  { pattern: /각티슈|냅킨|티슈(?!페이퍼)|핫팻|핫팩|hot\s*pack|방석|슬리퍼|억제대|이쑤시개|침대명찰|환자복|목초액/i, category: 'PAT_OTHER', note: '환자용품' },

  // ── 직원 보호구 ───────────────────────────────────────────
  { pattern: /장갑|glove/i, category: 'STAFF_GLOVE', note: '장갑' },
  { pattern: /장화|boot|안전화|작업화|신발(?!장)/i, category: 'STAFF_SHOE', note: '신발' },
  { pattern: /앞치마|apron|가운|gown|n95|kf94|방진|방독|face.?shield|보안경|goggle|위생모|헤어캡|아크릴.?집게명찰|우의|레인코트/i, category: 'STAFF_OTHER', note: '보호구' },

  // ── 총무·시설 ─────────────────────────────────────────────
  { pattern: /수세미|빗자루|걸레|쓰레기(?!봉투)|휴지통|mop|broom|dust|소독|락스|세정제|세제|행주|먼지떨이|물병솔|변기솔|빨래집게|스퀴지|쓰레받이|세탁망|분무기|섬유유연제|습기제거제|워셔액|화장지|점보롤|두루마리|핸드타올|롤휴지|탈취|방향/i, category: 'FAC_CLEAN', note: '청소·위생' },
  { pattern: /PVC.?카|보관(상자|박스)|쉘프|랙(?!켓)|선반|파일박스|storage|bin|상자|박스(?!테)|opp.?봉투|비닐봉투|쓰레기봉투|쇼핑백|봉투(?!부)|바구니|카트|금고|서랍|트레이/i, category: 'FAC_STORAGE', note: '수납' },
  { pattern: /건전지|battery|SD.?카드|USB|\bTV\b|충전기|케이블|전구|LED|어댑터|전원|냉장고|세탁기|믹서기|드라이기|전자레인지|선풍기|정수기|네스프레소|커피머신|공기청정기|단말기|리모컨|카메라\s*필름/i, category: 'FAC_ELECTRONIC', note: '전자·가전' },
  { pattern: /고무줄|끈|자물쇠|도장|스탬프|일회용\s*(?:숟가락|젓가락|접시|식탁보|우산비닐|스푼)|아이스크림\s*스푼/i, category: 'FAC_OTHER', note: '시설 기타' },

  // ── 사무용품 ──────────────────────────────────────────────
  { pattern: /네임펜|볼펜|형광펜|연필|지우개|가위(?!.*수술)|\b칼(?!라)|딱풀|스카치|롤링펜|보드마카|유성매직|마커|사인펜|제침|수정액|수정테이프|매직(?!\s*테이프)|썬스타|압핀|주핀|자석(?!카드)|문방구|스테이?플러(?:심)?|클립(?!보드)|핀(?!셋)|본드|글루|접착제|자\s*\(/i, category: 'OFF_STATIONERY', note: '문구' },
  { pattern: /A4|A5|복사용지|라벨|광택.?라벨|리플렛|포스트잇|메모지|견출지|상장용지|스케치북|스프링노트|중고노트|노트(?!북|트북)|색종이|약\s*처방전|약티켓|혈액수혈처방전|컨설트용지|인계장|브로슈어|설문지|용지|인쇄/i, category: 'OFF_PAPER', note: '용지·라벨·인쇄물' },
  { pattern: /바인더|L자.?파일|클리어화일|정부화일|파일(?!박스)|봉투(?!부)|클립보드|펀치|문서보관|화일|카드링|책철/i, category: 'OFF_FILE', note: '파일' },
  { pattern: /키보드|마우스|본체|프린터|스캐너|팩스|복합기|usb.?메모리|사무용의자|책상|의자(?!.*환자)/i, category: 'OFF_EQUIP', note: '사무기기' },

  // ── 식음료 ───────────────────────────────────────────────
  { pattern: /삼다수|포카리|생수|주스|음료|피지워터|기픈물|우유|milk|병음료/i, category: 'FOOD_DRINK', note: '음료' },
  { pattern: /과자|빵|초콜릿|젤리|스낵|컵라면|라면|떡|쿠키|크래커/i, category: 'FOOD_SNACK', note: '간식' },
  { pattern: /꽃?소금|후추|설탕|조미료|간장|식초|참기름|고춧가루/i, category: 'FOOD_OTHER', note: '조미료' },

  // ── 비품(EQUIP_*) ─────────────────────────────────────────
  { pattern: /모니터|monitor/i, category: 'EQUIP_IT', note: '모니터' },
];

function classify(name: string, spec: string, statsCategory: string): { category: string; rule: string } {
  const text = `${name} ${spec}`;
  for (const r of RULES) {
    if (r.pattern.test(text)) return { category: r.category, rule: r.note };
  }
  const fb = FALLBACK[statsCategory];
  if (fb) return { category: fb, rule: `fallback-${statsCategory}` };
  return { category: 'MED_OTHER', rule: 'no-match' };
}

function inferStatsBucket(category: string): string {
  if (category === 'PAT_DIAPER') return 'DIAPER_CARE';
  if (category.startsWith('FOOD_')) return 'FOOD';
  if (category.startsWith('OFF_')) return 'OFFICE';
  if (category.startsWith('EQUIP_MEDICAL')) return 'MEDICAL';
  if (category.startsWith('EQUIP_')) return 'OFFICE';
  if (category.startsWith('MED_')) return 'MEDICAL';
  return 'GENERAL';
}

function inferExpenseScope(stats: string): string {
  return (stats === 'OFFICE' || stats === 'FOOD') ? 'OPS_INDIRECT' : 'PATIENT_DIRECT';
}

function escape(s: any): string {
  return `"${String(s ?? '').replace(/"/g, '""')}"`;
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`[import-items] Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

  if (!fs.existsSync(XLSX_PATH)) {
    console.error('파일 없음:', XLSX_PATH);
    process.exit(1);
  }
  const wb = XLSX.readFile(XLSX_PATH);
  const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }).slice(1) as any[][];

  const items: MappedItem[] = [];
  let idx = 1;
  for (const r of rawRows) {
    const statsCategory = String(r[0] ?? '').trim();
    const name = String(r[1] ?? '').trim();
    const spec = String(r[2] ?? '').trim();
    const uom = String(r[3] ?? '').trim() || 'EA';
    const priceRaw = r[4];
    const price = (priceRaw === '' || priceRaw === null || priceRaw === undefined) ? null : Number(priceRaw);

    if (!name) continue;
    const { category, rule } = classify(name, spec, statsCategory);
    items.push({
      statsCategory, name, spec, uom, price,
      code: `ITEM-${String(idx).padStart(4, '0')}`,
      category,
      stats_bucket: inferStatsBucket(category),
      matched_rule: rule,
    });
    idx++;
  }

  console.log(`[import-items] 매핑 완료: ${items.length}건`);

  // CSV 출력 (드라이런)
  const csvLines = ['code,name,spec,uom,price,stats_category(원본),new_category,stats_bucket,matched_rule'];
  for (const it of items) {
    csvLines.push([
      it.code, it.name, it.spec, it.uom, it.price ?? '',
      it.statsCategory, it.category, it.stats_bucket, it.matched_rule,
    ].map(escape).join(','));
  }
  const outPath = path.join(__dirname, 'import-items-dryrun.csv');
  fs.writeFileSync(outPath, '﻿' + csvLines.join('\n'), 'utf-8');
  console.log(`[import-items] CSV: ${outPath}`);

  // 분포 요약
  const dist: Record<string, number> = {};
  for (const it of items) dist[it.category] = (dist[it.category] || 0) + 1;
  console.log('\n== 새 category 분포 ==');
  Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(20)}: ${v}`));

  const otherCats = ['MED_OTHER', 'PAT_OTHER', 'STAFF_OTHER', 'FAC_OTHER', 'OFF_OTHER', 'FOOD_OTHER'];
  const otherCount = otherCats.reduce((a, c) => a + (dist[c] ?? 0), 0);
  console.log(`\n"기타": ${otherCount}/${items.length} (${((otherCount / items.length) * 100).toFixed(1)}%)`);

  if (!apply) {
    console.log('\n⚠️  DRY-RUN — DB 변경 없음. --apply 로 실제 적용.');
    await prisma.$disconnect();
    return;
  }

  // 적용 시작
  console.log('\n🔧 DB 변경 시작...');

  // 1. 기존 품목 모두 soft-delete
  const existing = await prisma.item.count({ where: { deleted_at: null } });
  const sd = await prisma.item.updateMany({
    where: { deleted_at: null },
    data: { deleted_at: new Date() },
  });
  console.log(`  기존 활성 품목 ${existing}건 → soft-delete: ${sd.count}건`);

  // 2. 새 품목 insert
  let created = 0;
  for (const it of items) {
    try {
      await prisma.item.create({
        data: {
          id: uuidv4(),
          item_code: it.code,
          name: it.name + (it.spec ? ` (${it.spec})` : ''), // 규격 있으면 이름에 합침
          category: it.category,
          sub_category: it.spec,
          stats_bucket: it.stats_bucket,
          expense_scope: inferExpenseScope(it.stats_bucket),
          uom: it.uom,
          pack_size: 1,
          min_order_qty: 1,
          is_regular_order: true,
          reorder_days_threshold: 7,
          is_active: true,
        } as any,
      });
      created++;
    } catch (e: any) {
      console.error(`  실패: ${it.code} ${it.name} — ${e.message}`);
    }
  }
  console.log(`  신규 insert: ${created}/${items.length}건`);
  console.log('\n✅ 완료. 가격 정보는 vendor 등록 후 별도 워크플로로 입력하세요.');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('[import-items] error:', e);
  process.exit(1);
});
