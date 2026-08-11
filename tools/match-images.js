// 폴더의 이미지 파일들을 품목과 매칭해서 등록
// 매칭 규칙:
// 1) 파일명(확장자 제외) === 품목명 → 정확 매치
// 2) 파일명을 표준화(공백·특수문자 제거 후 소문자) 후 품목명 표준화한 것과 비교
// 3) 정규식 일부 매칭 (필요 시 fallback)
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const FOLDERS = [
  'd:/hospital-supply-app/의료소모품 물품사진',
  'd:/hospital-supply-app/일반소모품 물품사진',
];
const UPLOAD_DIR = 'uploads/items';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database('prisma/hospital-supply.db');
const allItems = db.prepare("SELECT id, item_code, name FROM items WHERE deleted_at IS NULL").all();

// 표준화 함수: 공백·괄호·특수문자·이형 표기 정규화
function normalize(s) {
  return String(s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[x×X]/g, '*')
    .replace(/[—–―\-－ーㅡ丿\/]/g, '-')
    .replace(/인치/g, '"')
    .replace(/리퀴드/g, '리쿼드')
    .replace(/타월/g, '타올')
    .replace(/바이어포/g, 'biopore')
    .replace(/벤드/g, '밴드')
    .replace(/코튼볼/g, 'cottonball')
    .replace(/cotton ball/g, 'cottonball')
    .replace(/핀터볼/g, '필터볼')
    .replace(/아이리스시저|아이리스 시저/g, 'irisscissors')
    .replace(/바디클린져/g, '바디클렌져')
    .replace(/발톱깍이/g, '발톱깍기')
    .replace(/거즈/g, 'guaze')
    .replace(/삼다수\s*\(?300ml/g, '삼다수 (330ml)')
    .replace(/^\./, '')
    .replace(/[\s\(\)#·_\-*"']/g, '')
    .trim();
}

// 한 이미지를 여러 사이즈에 적용 (같은 제품 라인업)
const MULTI_SIZE_MAP = {
  'endotube':       ['ENDO TUBE (6)','ENDO TUBE (6.5)','ENDO TUBE (7)','ENDO TUBE (7.5)','ENDO TUBE (8)'],
  'foleycath':      ['S/Foley Cath (12Fr)','S/Foley Cath (14Fr)','S/Foley Cath (16Fr)','S/Foley Cath (18Fr)','S/Foley Cath (20Fr)','S/Foley cath (22Fr)','S/Foley cath (24Fr)'],
  'foleycath3way':  ['S/Foley Cath (16Fr(3way))'],
  'levintube':      ['Levin Tube (14Fr)','Levin Tube (16Fr)','Levin Tube (18Fr)'],
  'nelatoncath':    ['Nelaton Cath (6Fr)','Nelaton Cath (7Fr)','Nelaton Cath (8Fr)'],
  'speechcannuia':  ['Speechcannuia (9)','Speechcannuia (10)'],
  'suctiontip일체형': ['Suction Tip(일체형) (12Fr)','Suction Tip(일체형) (14Fr)','Suction Tip(일체형) (16Fr)','Suction Tip(일체형) (18Fr)'],
  'surgicalblade':  ['surgical blade (no.10)','surgical blade (no.11)'],
  'surgicalglove':  ['Surgical Glove (S)','Surgical Glove (M)','Surgical Glove (L)'],
  'ttube':          ['T-Tube (6)','T-Tube (6.5)','T-Tube (7)','T-Tube (7.5)','T-tube (8)'],
  '봉합사nylon':     ['봉합사(NYLON) (3)','봉합사(NYLON) (4)','봉합사(NYLON) (5)'],
  // 짧은 cc 파일들
  '1cc':  ['D/Syringe (1cc/26G)'],
  '3cc':  ['D/Syringe (3cc/23G)'],
  '5cc':  ['D/Syringe (5cc/23G)'],
  '10cc': ['D/Syringe (10cc/23G)'],
  '20cc': ['D/Syringe (20cc/23G)'],
  '60cc': ['Enema Syringe (60cc)'],
  'focep': ['Focep (16cm)'],
  // 추가 다중/단일 별칭
  '동방침':       ['동방침 (0.20*30mm)','동방침 (0.25*30mm)'],
  '부항':         ['부항 (1호)','부항 (3호)'],
  '탄력붕대3':    ['탄력붕대(E/B) (3*12\'s)'],
  '탄력붕대4':    ['탄력붕대(E/B) (4*12\'s)'],
  '탄력붕대6':    ['탄력붕대(E/B) (6*12\'s)'],
  '탈지면':       ['탈지면 (4*3/450g)'],
  '투약병':       ['투약병 (30㎖)','투약병 (60㎖)','투약병 (100㎖)'],
  '밴드에스':     ['밴드에스 (1*45\'s)'],
  '필터볼2호':    ['Cotton Ball/필터볼 (2호/450g)'],
  '필터볼3호':    ['Cotton Ball/필터볼 (3호/450g)'],
  '픽스롤':       ['Fix roll Tape (10cm*10cm)'],
  '비누':         ['세수비누'],
  '치약칫솔세트': ['칫솔/치약세트'],
  '크린지퍼백':   ['크린백','지퍼백'],
  'biopore종이반찬고': ['3M micropore (부직포)'],
  '고무장화': ['고무장화 (230)','고무장화 (235)','고무장화 (240)','고무장화 (245)','고무장화 (250)','고무장화 (255)','고무장화 (260)','고무장화 (265)','고무장화 (270)','고무장화 (275)','고무장화 (280)','고무장화 (285)','고무장화 (290)'],
  // 다중 매핑된 잔여
  'nasalcannular':       ['Nasal Cannular (240cm(green))','Nasal Cannular (소아용)'],
  'o2mask':              ['O2 Mask (성인)','O2 Mask (소아용)'],
};

// 품목 표준화 인덱스
const itemByNormName = new Map();
for (const it of allItems) itemByNormName.set(normalize(it.name), it);

const results = { matched: [], multipleMatches: [], unmatched: [] };

for (const folder of FOLDERS) {
  if (!fs.existsSync(folder)) { console.log('폴더 없음:', folder); continue; }
  const files = fs.readdirSync(folder).filter(f => /\.(jpe?g|png|webp|gif)$/i.test(f));
  console.log(`\n=== ${path.basename(folder)} (${files.length} 파일) ===`);
  for (const file of files) {
    const baseName = file.replace(/\.[^.]+$/, '');
    const norm = normalize(baseName);
    // 1) 다중 사이즈 맵핑 우선 (한 이미지 → 여러 사이즈)
    if (MULTI_SIZE_MAP[norm]) {
      for (const targetName of MULTI_SIZE_MAP[norm]) {
        const item = allItems.find(it => it.name === targetName);
        if (item) results.matched.push({ file, item });
      }
      continue;
    }

    let match = itemByNormName.get(norm);
    // 2) fallback: 엄격 부분 일치 (양쪽 6자 이상)
    if (!match) {
      const candidates = allItems.filter(it => {
        const itNorm = normalize(it.name);
        if (norm.length < 6 || itNorm.length < 6) return false;
        return itNorm.includes(norm) || norm.includes(itNorm);
      });
      if (candidates.length === 1) match = candidates[0];
      else if (candidates.length > 1) {
        results.multipleMatches.push({ file, candidates: candidates.map(c => c.name) });
        continue;
      }
    }
    if (!match) { results.unmatched.push(file); continue; }
    results.matched.push({ file, item: match });
  }
}

console.log(`\n=== 매칭 결과 ===`);
console.log('정확 매칭:', results.matched.length);
console.log('다중 매칭(애매):', results.multipleMatches.length);
console.log('미매칭:', results.unmatched.length);

console.log(`\n=== 다중 매칭 (애매) ===`);
results.multipleMatches.forEach(r => console.log('  ', r.file, '→', r.candidates.join(' | ')));

console.log(`\n=== 미매칭 ===`);
results.unmatched.forEach(f => console.log('  ', f));

// dry-run 모드 (--apply 없으면 적용 안 함)
if (process.argv.includes('--apply')) {
  console.log('\n=== 적용 중... ===');
  let applied = 0;
  for (const { file, item } of results.matched) {
    const folder = FOLDERS.find(f => fs.existsSync(path.join(f, file)));
    const srcPath = path.join(folder, file);
    const ext = path.extname(file).toLowerCase().replace('.jpeg', '.jpg');
    const destName = `item-${item.id}-${Date.now()}${ext}`;
    const destPath = path.join(UPLOAD_DIR, destName);
    fs.copyFileSync(srcPath, destPath);
    db.prepare('UPDATE items SET image_url=? WHERE id=?').run(`/uploads/items/${destName}`, item.id);
    applied++;
  }
  console.log('적용 완료:', applied, '건');
} else {
  console.log('\n※ 적용하려면 --apply 옵션 추가');
}
