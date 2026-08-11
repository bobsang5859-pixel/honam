// Bing 이미지 검색에서 첫 번째 결과를 다운로드해 items.image_url 등록
// 사용: node tools/fetch-item-images.js <itemIds...>
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const Database = require('better-sqlite3');

const UPLOAD_DIR = path.join('uploads', 'items');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http://') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': UA, ...opts.headers }, timeout: 15000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(new URL(res.headers.location, url).href, opts));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

// 쇼핑몰 도메인 점수 (높을수록 우선)
const DOMAIN_SCORES = [
  { pat: /coupang\.com|coupangcdn/i, score: 100 },
  { pat: /(11st|11street)\.co\.kr/i, score: 95 },
  { pat: /gmarket\.co\.kr/i,        score: 95 },
  { pat: /ssg\.com|emart/i,          score: 92 },
  { pat: /lotteon\.com/i,            score: 90 },
  { pat: /homeplus/i,                score: 88 },
  { pat: /danawa\.com/i,             score: 85 },
  { pat: /naver|shopping/i,          score: 80 },
  { pat: /auction\.co\.kr/i,         score: 78 },
  { pat: /interpark/i,               score: 75 },
  { pat: /pstatic|nstatic/i,         score: 70 },
  { pat: /kakaocdn|tistory/i,        score: 50 },
  // 제외/감점
  { pat: /kream/i,                   score: -100 }, // 한정판 신발/패션
  { pat: /karroter|joongna/i,        score: -50 }, // 중고
  { pat: /\.kr\/files\//i,           score: -80 }, // 병원 게시판 등 일반 사이트
];

function scoreDomain(url) {
  let score = 0;
  for (const r of DOMAIN_SCORES) if (r.pat.test(url)) score = Math.max(score, r.score) + (score < 0 ? r.score : 0);
  return score;
}

async function naverSearchImageUrls(query, max = 15) {
  const url = `https://search.naver.com/search.naver?where=image&query=${encodeURIComponent(query)}`;
  const res = await fetchUrl(url);
  const html = res.body.toString('utf8');
  // search.pstatic.net 프록시 URL 안의 인코딩된 실제 URL 추출
  const matches = [...html.matchAll(/search\.pstatic\.net\/common\/\?src=([^&"]+)/g)];
  const decoded = matches
    .map(m => decodeURIComponent(m[1]))
    .filter(u => /^https?:\/\//.test(u))
    .filter(u => !/og_v3|favicon|sstatic\/search/.test(u));
  // 쇼핑몰(phinf, shop, coupang, 11st, gmarket) 우선
  const shopping = decoded.filter(u => /phinf|shop\d*\.|shop-phinf|shopping-phinf|coupang|11st|gmarket|interpark/i.test(u));
  const blog = decoded.filter(u => /blogfiles|tistory|kakaocdn/i.test(u));
  const other = decoded.filter(u => !shopping.includes(u) && !blog.includes(u));
  return [...shopping, ...other, ...blog].slice(0, max);
}

async function bingSearchImageUrls(query, max = 15) {
  // 사진 + medium+ 사이즈 필터
  const filter = '+filterui:photo-photo+filterui:imagesize-medium';
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&qft=${encodeURIComponent(filter)}&first=1&FORM=HDRSC2`;
  const res = await fetchUrl(url);
  const html = res.body.toString('utf8');
  const matches = [...html.matchAll(/m="(\{[^"]+\})"/g)];
  const urls = [];
  for (const m of matches) {
    try {
      const decoded = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const json = JSON.parse(decoded);
      if (json.murl && /^https?:\/\//.test(json.murl)) urls.push(json.murl);
    } catch (_) { /* skip */ }
  }
  // 도메인 점수 순으로 정렬
  urls.sort((a, b) => scoreDomain(b) - scoreDomain(a));
  return urls.slice(0, max);
}

// 카테고리 컨텍스트 키워드
function buildSearchQuery(name, category) {
  // 카테고리별 보조 키워드 (검색 정확도 향상)
  const ctx = {
    FOOD_WATER: '생수',
    FOOD_BEVERAGE: '음료',
    FOOD_INSTANT: '인스턴트',
    PAT_HYGIENE: '환자 위생용품',
    PAT_PAPER: '티슈',
    PAT_BAG: '비닐 봉투',
    PAT_HANDWASH: '핸드워시',
    PAT_DIAPER: '기저귀',
    DIAPER_MAIN: '기저귀',
    FAC_DETERGENT: '세제',
    FAC_SPONGE: '수세미',
    FAC_TOOL: '청소도구',
    FAC_PEST: '살충제 방향제',
    FAC_DISH: '일회용 식기 사무용',
    FAC_KIT_TOOL: '주방용품',
    OFF_PEN: '사무용 펜',
    OFF_CLIP: '사무용',
    OFF_CUTTING: '사무용',
    OFF_STN_OTHER: '사무용 문구',
    OFF_BASIC_PAPER: '복사용지',
    OFF_LABEL: '라벨지',
    OFF_FORM: '의료양식',
    OFF_PRINT: '사무용 인쇄',
    OFF_CLEARFILE: '클리어파일',
    OFF_GOVFILE: '정부화일',
    OFF_FILE_OTHER: '바인더',
    OFF_ENVELOPE: '봉투',
    OFF_BOX: '문서보관함',
    OFF_BAG: '쇼핑백',
    OFF_GIFT: '경조사 봉투',
    OFF_BATTERY: '건전지',
    OFF_STORAGE: '저장매체',
    OFF_CAMERA: '카메라 필름',
  };
  const suffix = ctx[category] || '';
  // 괄호 안 사이즈/색상은 그대로 유지
  return suffix ? `${name} ${suffix}` : name;
}

async function downloadImage(url, destPath) {
  const res = await fetchUrl(url);
  if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode);
  // Content-Type 으로 확장자 결정
  const ct = (res.headers['content-type'] || '').toLowerCase();
  let actualExt = path.extname(destPath).slice(1) || 'jpg';
  if (ct.includes('jpeg') || ct.includes('jpg')) actualExt = 'jpg';
  else if (ct.includes('png')) actualExt = 'png';
  else if (ct.includes('webp')) actualExt = 'webp';
  else if (ct.includes('gif')) actualExt = 'gif';
  const finalPath = destPath.replace(/\.[^.]+$/, '.' + actualExt);
  fs.writeFileSync(finalPath, res.body);
  return { size: res.body.length, path: finalPath, ext: actualExt };
}

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) { console.error('사용: node tools/fetch-item-images.js <itemId>...'); process.exit(1); }
  const db = new Database('prisma/hospital-supply.db');
  const results = [];
  for (const id of ids) {
    const item = db.prepare('SELECT id, item_code, name, category FROM items WHERE id=?').get(id);
    if (!item) { results.push({ id, status: 'NOT_FOUND' }); continue; }
    const query = buildSearchQuery(item.name, item.category);
    console.log('\n[' + item.name + '] 검색어: "' + query + '"');
    let succeeded = false;
    try {
      // 네이버 우선, 실패 시 Bing 폴백
      let urls = await naverSearchImageUrls(query, 15);
      if (urls.length === 0) {
        console.log('  → 네이버 결과 없음, Bing 시도');
        urls = await bingSearchImageUrls(query, 15);
      }
      if (urls.length === 0) { console.log('  → 이미지 URL 못 찾음'); results.push({ ...item, status: 'NO_RESULT' }); continue; }
      for (let i = 0; i < urls.length; i++) {
        const u = urls[i];
        try {
          console.log('  [' + (i+1) + '/' + urls.length + '] ' + u.slice(0, 90));
          const tmpPath = path.join(UPLOAD_DIR, `item-${item.id}-${Date.now()}.jpg`);
          const dl = await downloadImage(u, tmpPath);
          const fileName = path.basename(dl.path);
          const imageUrl = `/uploads/items/${fileName}`;
          db.prepare('UPDATE items SET image_url=? WHERE id=?').run(imageUrl, item.id);
          console.log('  ✓ 완료 (' + (dl.size / 1024).toFixed(1) + ' KB, .' + dl.ext + ')');
          results.push({ ...item, status: 'OK', imageUrl, size: dl.size, attempt: i + 1 });
          succeeded = true;
          break;
        } catch (e) {
          console.log('  ✗ 시도 ' + (i+1) + ' 실패: ' + e.message);
        }
      }
      if (!succeeded) results.push({ ...item, status: 'ALL_FAILED' });
    } catch (e) {
      console.log('  ✗ 검색 실패: ' + e.message);
      results.push({ ...item, status: 'SEARCH_ERROR', error: e.message });
    }
    // rate limit
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log('\n=== 결과 요약 ===');
  for (const r of results) {
    console.log((r.status === 'OK' ? '✓' : '✗') + ' ' + (r.name || r.id) + ' | ' + r.status + (r.error ? ' (' + r.error + ')' : ''));
  }
  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
