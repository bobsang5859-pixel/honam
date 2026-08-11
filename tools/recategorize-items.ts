/**
 * Phase A — 품목 3단 계층 재매핑 스크립트
 *
 * 사용법:
 *   ts-node tools/recategorize-items.ts             # 드라이런 (CSV 출력만)
 *   ts-node tools/recategorize-items.ts --apply     # 실제 DB 업데이트
 *
 * 로직:
 *   1. items 테이블에서 활성 품목 전체 로드
 *   2. 각 품목에 대해 RULES 배열을 순회하며 첫 매칭되는 규칙의 category 부여
 *   3. 매칭 없으면 legacy category 기반 fallback
 *   4. 결과를 tools/recategorize-dryrun.csv 에 저장
 *   5. --apply 플래그가 있으면 DB 업데이트도 수행
 */

import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

interface Rule {
  pattern: RegExp;
  category: string;
  note?: string;
}

// 우선순위 높은 규칙 → 낮은 규칙 순. 첫 매칭 승리.
// 구체적 품목을 먼저 매칭해야 일반 규칙이 덮어쓰지 않음.
const RULES: Rule[] = [
  // ─── 의료 — 구체적 기구명 먼저 ───────────────────────────
  { pattern: /Nelaton|T-?Tube|T.?piece|Rectal\s*Tube|SURECAN|TWO-?lumen|cvc|PEG|gastric|stoma|urine\s*bag|foley|levin|ngt/i, category: 'MED_CATHETER', note: '카테터·튜브' },
  { pattern: /Nasal\s*Cannular|Nebu[il]izer|Speechcannu[il]a|TRACOE|STYLET|LARYNGO|M-?VAC|T-?piece|ventilator|humidifier|오투|O2/i, category: 'MED_AIRWAY', note: '호흡기 기구' },
  { pattern: /Medicut|novo\s*fine|Dosi\s*Flow|3-?Way|insulin|heparin(?!.?cap)|수액세트/i, category: 'MED_INJECTION', note: '주사·투약 기구' },
  { pattern: /Decopore|micropore|테가덤|tegaderm|biopore|durapore|cotton|필터볼|band(?:age)?|gauze|거즈|솜|indicator|dressing|drape|swab|\balcohol\s*swab/i, category: 'MED_DRESSING', note: '드레싱' },
  { pattern: /ECG|EKG|AED|monitor|probe|심전|혈당|glucometer|체온계|thermometer|ox[iy]meter|측정|검사지|test.?strip|혈압계|stethoscope|청진기/i, category: 'MED_MONITOR', note: '검사·모니터' },
  { pattern: /유리알콜램프|알콜램프|수술칼|수술기구|surgical\s*blade|blade|scalpel|Focep|forceps|NYLON|suture|봉합|scissors\s*surg|술기/i, category: 'MED_OTHER', note: '수술·기타 의료' },

  // ─── 의료 — 포괄 키워드 ──────────────────────────────────
  { pattern: /syringe|주사기|needle|주사바늘|vial|ampule|주사|투약/i, category: 'MED_INJECTION', note: '주사' },
  { pattern: /airway|air.?way|endo.?tube|breathing.?set|흡인|suction|산소|트라키|마스크(?!.*보안)/i, category: 'MED_AIRWAY', note: '호흡' },
  { pattern: /I\.?V\.?\s*CATH|catheter|heparine.?cap|connector|extension|port|line(?!.+card)/i, category: 'MED_CATHETER', note: '카테터' },

  // ─── 환자 생활용품 ─────────────────────────────────────
  { pattern: /기저귀|diaper/i, category: 'PAT_DIAPER', note: '기저귀' },
  { pattern: /샴푸|바디(?!오일)|비누|물티슈|가글|로션|클렌(져|저)|세수|목욕|수건|타월|towel|치약|칫솔|면도|발톱\s*니퍼|손톱|스킨/i, category: 'PAT_BATH', note: '세면·목욕' },
  { pattern: /각티슈|냅킨|티슈(?!페이퍼)|핫팻|핫팩|hot\s*pack|방석|슬리퍼|억제대|이쑤시개|침대명찰|환자복|환자\s|목초액/i, category: 'PAT_OTHER', note: '기타 환자용품' },

  // ─── 직원 보호구 ───────────────────────────────────────
  { pattern: /장갑|glove/i, category: 'STAFF_GLOVE', note: '장갑' },
  { pattern: /장화|boot|안전화|작업화|신발(?!장)/i, category: 'STAFF_SHOE', note: '신발' },
  { pattern: /앞치마|apron|가운|gown|n95|kf94|방진|방독|face.?shield|보안경|goggle|위생모|헤어캡|아크릴.?집게명찰|우의|레인코트|일회용\s*(?:비닐|앞치마|헤어|가운)/i, category: 'STAFF_OTHER', note: '기타 보호구' },

  // ─── 총무·시설 ─────────────────────────────────────────
  { pattern: /수세미|빗자루|걸레|쓰레기(?!봉투)|휴지통|mop|broom|dust|소독|락스|세정제|세제|행주|먼지떨이|물병솔|변기솔|빨래집게|스퀴지|쓰레받이|세탁망|분무기|섬유유연제|습기제거제|워셔액|화장지|점보롤|두루마리|핸드타올|롤휴지|탈취|방향/i, category: 'FAC_CLEAN', note: '청소·위생' },
  { pattern: /PVC.?카|보관(상자|박스)|쉘프|랙(?!켓)|선반|파일박스|storage|bin|상자|박스(?!테)|opp.?봉투|비닐봉투|쓰레기봉투|쇼핑백|봉투(?!부)|바구니|카트|금고|서랍|트레이/i, category: 'FAC_STORAGE', note: '수납·저장' },
  { pattern: /건전지|battery|SD.?카드|USB|\bTV\b|충전기|케이블|전구|LED|어댑터|전원|냉장고|세탁기|믹서기|드라이기|전자레인지|선풍기|정수기|네스프레소|커피머신|공기청정기|단말기|리모컨|카메라\s*필름|모니터(?!.*의료)/i, category: 'FAC_ELECTRONIC', note: '전자·가전' },
  { pattern: /고무줄|끈|자물쇠|도장|스탬프|일회용\s*(?:숟가락|젓가락|접시|식탁보|우산비닐|스푼)|아이스크림\s*스푼/i, category: 'FAC_OTHER', note: '총무 기타' },

  // ─── 사무용품 ──────────────────────────────────────────
  { pattern: /네임펜|볼펜|형광펜|연필|지우개|가위(?!.*수술)|\b칼(?!라)|딱풀|스카치|롤링펜|보드마카|유성매직|마커|사인펜|제침|수정액|수정테이프|매직(?!\s*테이프)|썬스타|압핀|주핀|자석(?!카드)|문방구|스테이?플러(?:심)?|클립(?!보드)|핀(?!셋)|본드|글루|접착제|자\s*\(/i, category: 'OFF_STATIONERY', note: '필기·문구' },
  { pattern: /A4|A5|복사용지|라벨|광택.?라벨|리플렛|포스트잇|메모지|견출지|상장용지|스케치북|스프링노트|중고노트|노트(?!북|트북)|색종이|약\s*처방전|약티켓|혈액수혈처방전|컨설트용지|인계장|브로슈어|설문지|용지/i, category: 'OFF_PAPER', note: '용지·라벨' },
  { pattern: /바인더|L자.?파일|클리어화일|정부화일|파일(?!박스)|봉투(?!부)|클립보드|펀치|문서보관|화일|카드링|책철/i, category: 'OFF_FILE', note: '파일·봉투' },
  { pattern: /키보드|마우스|본체|프린터|스캐너|팩스|복합기|usb.?메모리|사무용의자|사무가구|책상|의자(?!.*환자)/i, category: 'OFF_EQUIP', note: '사무기기·가구' },

  // ─── 식음료 ───────────────────────────────────────────
  { pattern: /삼다수|포카리|생수|주스|음료|피지워터|기픈물|우유|milk|물\s*\(.+ml|병음료/i, category: 'FOOD_DRINK', note: '음료' },
  { pattern: /과자|빵|초콜릿|젤리|스낵|컵라면|라면|떡|쿠키|크래커/i, category: 'FOOD_SNACK', note: '간식' },
  { pattern: /꽃?소금|후추|설탕|조미료|간장|식초|참기름|고춧가루/i, category: 'FOOD_OTHER', note: '조미료' },
];

// 레거시 category → 새 fallback category
const LEGACY_FALLBACK: Record<string, string> = {
  MEDICAL_FIXED: 'MED_OTHER',
  MEDICAL_ACT: 'MED_OTHER',
  GENERAL_PATIENT: 'PAT_OTHER',
  GENERAL_STAFF: 'STAFF_OTHER',
  GENERAL_MGMT: 'FAC_OTHER',
  GENERAL_SERVICE: 'FOOD_OTHER',
  OFFICE_SUPPLY: 'OFF_OTHER',
  OFFICE_SEMI: 'OFF_EQUIP',  // 사무기기 = OFF_EQUIP 직결
};

// stats_bucket 우선 판단 — 기저귀/식음료는 이게 있으면 강제
function statsBucketOverride(statsBucket: string | null): string | null {
  if (statsBucket === 'DIAPER_CARE') return 'PAT_DIAPER';
  if (statsBucket === 'FOOD') return 'FOOD_DRINK'; // 대부분 음료
  return null;
}

function classify(item: { name: string; item_code: string; category: string; stats_bucket: string | null }): { new_category: string; rule: string } {
  // 1. stats_bucket 강제 (기저귀/식음료)
  const override = statsBucketOverride(item.stats_bucket);
  if (override) return { new_category: override, rule: `stats_bucket=${item.stats_bucket}` };

  // 2. 규칙 순회
  const searchText = `${item.name} ${item.item_code}`;
  for (const rule of RULES) {
    if (rule.pattern.test(searchText)) {
      return { new_category: rule.category, rule: rule.note ?? rule.pattern.source };
    }
  }

  // 3. 레거시 category fallback
  const fb = LEGACY_FALLBACK[item.category];
  if (fb) return { new_category: fb, rule: `legacy-${item.category}` };

  return { new_category: 'MED_OTHER', rule: 'no-match' };
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`[recategorize] Mode: ${apply ? 'APPLY (will update DB)' : 'DRY-RUN (csv only)'}`);

  const items = await prisma.item.findMany({
    where: { is_active: true, deleted_at: null },
    select: { id: true, item_code: true, name: true, category: true, stats_bucket: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });
  console.log(`[recategorize] Loaded ${items.length} active items`);

  const rows: Array<{ id: string; item_code: string; name: string; old: string; bucket: string; new: string; rule: string }> = [];
  const bucketCount: Record<string, number> = {};

  for (const item of items) {
    const { new_category, rule } = classify(item);
    rows.push({
      id: item.id,
      item_code: item.item_code,
      name: item.name,
      old: item.category,
      bucket: item.stats_bucket ?? '',
      new: new_category,
      rule,
    });
    bucketCount[new_category] = (bucketCount[new_category] || 0) + 1;
  }

  // CSV 출력
  const csvLines = ['id,item_code,name,old_category,stats_bucket,new_category,matched_rule'];
  for (const r of rows) {
    const escape = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    csvLines.push([r.id, r.item_code, r.name, r.old, r.bucket, r.new, r.rule].map(escape).join(','));
  }
  const outPath = path.join(__dirname, 'recategorize-dryrun.csv');
  fs.writeFileSync(outPath, '﻿' + csvLines.join('\n'), 'utf-8'); // BOM for Excel Korean
  console.log(`[recategorize] CSV written: ${outPath}`);

  // 분포 요약
  console.log('\n── 새 category 분포 ──');
  const sorted = Object.entries(bucketCount).sort((a, b) => b[1] - a[1]);
  sorted.forEach(([cat, cnt]) => console.log(`  ${cat.padEnd(20)}: ${cnt}개`));

  // "기타" 비율
  const otherCats = ['MED_OTHER', 'PAT_OTHER', 'STAFF_OTHER', 'FAC_OTHER', 'OFF_OTHER', 'FOOD_OTHER'];
  const otherCount = otherCats.reduce((a, c) => a + (bucketCount[c] ?? 0), 0);
  const otherPct = ((otherCount / items.length) * 100).toFixed(1);
  console.log(`\n── "기타" 분류 비율: ${otherCount}/${items.length} (${otherPct}%) ──`);
  console.log('   (권장: 10% 이하. 10% 초과면 RULES 키워드 추가 필요)');

  if (!apply) {
    console.log('\n⚠️  DRY-RUN — CSV만 출력됨. DB는 변경되지 않음.');
    console.log('    확인 후 --apply 플래그로 재실행하면 실제 적용됩니다.');
    await prisma.$disconnect();
    return;
  }

  // 실제 적용
  console.log('\n🔧 DB 업데이트 시작...');
  let updated = 0;
  for (const r of rows) {
    if (r.old === r.new) continue; // 변경 없음
    await prisma.item.update({
      where: { id: r.id },
      data: { category: r.new },
    });
    updated++;
  }
  console.log(`✅ ${updated}개 품목 category 업데이트 완료 (나머지 ${items.length - updated}개는 변경 불필요).`);

  await prisma.$disconnect();
}

main().catch(e => {
  console.error('[recategorize] error:', e);
  process.exit(1);
});
