import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission } from '../middleware/auth';

const router = Router();

// ── AppSetting 캐시 (webhook-service 패턴) ──
let _cachedKey: string | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000;

export async function getHiraApiKey(): Promise<string | null> {
  const now = Date.now();
  if (_cachedKey !== null && now - _cacheTime < CACHE_TTL) return _cachedKey;
  const row = await prisma.appSetting.findUnique({ where: { key: 'HIRA_API_KEY' } });
  _cachedKey = row?.value?.trim() || null;
  _cacheTime = now;
  return _cachedKey;
}

const HIRA_BASE = 'http://apis.data.go.kr/B551182/mcatInfoService1.2/getPaymentNonPaymentList1.2';
const DISEASE_BASE = 'http://apis.data.go.kr/B551182/diseaseInfoService1';

/**
 * GET /api/hira/items?search=검색어&pageNo=1&numOfRows=20
 * 건강보험심사평가원 치료재료 급여·비급여 목록 프록시
 */
router.get('/items', authMiddleware, requirePermission('BASIC_MANAGE'), async (req, res) => {
  try {
    const apiKey = await getHiraApiKey();
    if (!apiKey) {
      return res.status(400).json({ error: 'HIRA API 키가 설정되지 않았습니다. 시스템 설정에서 HIRA_API_KEY를 등록해 주세요.' });
    }

    const search = (req.query.search as string || '').trim();
    if (!search) {
      return res.status(400).json({ error: '검색어를 입력해 주세요.' });
    }

    const pageNo = parseInt(req.query.pageNo as string) || 1;
    const numOfRows = Math.min(parseInt(req.query.numOfRows as string) || 20, 100);

    // data.go.kr 서비스키는 이미 인코딩된 상태로 발급됨 → 직접 querystring에 삽입
    const params = new URLSearchParams({
      numOfRows: String(numOfRows),
      pageNo: String(pageNo),
      _type: 'json',
      itmNm: search,
    });
    const url = `${HIRA_BASE}?serviceKey=${apiKey}&${params.toString()}`;

    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      return res.status(502).json({ error: `HIRA API 응답 오류: ${resp.status} ${resp.statusText}` });
    }

    const text = await resp.text();

    // XML 응답 감지
    if (text.trimStart().startsWith('<?xml') || text.trimStart().startsWith('<')) {
      return res.status(502).json({ error: 'HIRA API가 XML 형식으로 응답했습니다. 서비스키를 확인해 주세요.' });
    }

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: 'HIRA API 응답을 파싱할 수 없습니다.' });
    }

    // 에러 응답 처리
    const header = json?.response?.header || json?.header;
    if (header && header.resultCode !== '00') {
      return res.status(502).json({ error: `HIRA API 오류: ${header.resultMsg || '알 수 없는 오류'}` });
    }

    const body = json?.response?.body || json?.body;
    const totalCount = body?.totalCount || 0;
    const rawItems = body?.items?.item;

    let items: any[] = [];
    if (rawItems) {
      items = Array.isArray(rawItems) ? rawItems : [rawItems];
    }

    // 필드 정규화
    const mapped = items.map((it: any) => ({
      itmNm: it.itmNm || '',
      mxUnprc: it.mxUnprc ? Number(it.mxUnprc) : null,
      unit: it.unit || '',
      mnfEntpNm: it.mnfEntpNm || '',
      impEntpNm: it.impEntpNm || '',
      nomNm: it.nomNm || '',
      payTpNm: it.payTpNm || '',
      mcatCd: it.mcatCd || '',
      mdivCdNm: it.mdivCdNm || '',
      ldgrpCdNm: it.ldgrpCdNm || '',
    }));

    return res.json({ items: mapped, totalCount, pageNo, numOfRows });
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'HIRA API 요청 시간 초과 (10초)' });
    }
    console.error('HIRA API error:', err);
    return res.status(500).json({ error: 'HIRA API 조회 중 오류가 발생했습니다.' });
  }
});

// ── 공통 HIRA fetch 헬퍼 ──
export async function fetchHiraApi(url: string): Promise<{ body: any; error?: string }> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) return { body: null, error: `HIRA API 응답 오류: ${resp.status}` };

  const text = await resp.text();
  if (text.trimStart().startsWith('<?xml') || text.trimStart().startsWith('<')) {
    return { body: null, error: 'HIRA API가 XML 형식으로 응답했습니다.' };
  }

  let json: any;
  try { json = JSON.parse(text); } catch { return { body: null, error: 'HIRA API 응답 파싱 실패' }; }

  const header = json?.response?.header || json?.header;
  if (header && header.resultCode !== '00') {
    return { body: null, error: `HIRA API 오류: ${header.resultMsg || '알 수 없는 오류'}` };
  }

  return { body: json?.response?.body || json?.body };
}

/**
 * GET /api/hira/disease-codes?search=검색어&searchType=SICK_NM&pageNo=1&numOfRows=20
 * 질병명칭/코드 조회
 */
router.get('/disease-codes', authMiddleware, async (req, res) => {
  try {
    const apiKey = await getHiraApiKey();
    if (!apiKey) return res.status(400).json({ error: 'HIRA API 키가 설정되지 않았습니다.' });

    const search = (req.query.search as string || '').trim();
    if (!search) return res.status(400).json({ error: '검색어를 입력해 주세요.' });

    const searchType = (req.query.searchType as string) === 'SICK_CD' ? 'SICK_CD' : 'SICK_NM';
    const pageNo = parseInt(req.query.pageNo as string) || 1;
    const numOfRows = Math.min(parseInt(req.query.numOfRows as string) || 20, 100);

    const params = new URLSearchParams({
      numOfRows: String(numOfRows), pageNo: String(pageNo), _type: 'json',
      sickType: '1', medTp: '1', diseaseType: searchType, searchText: search,
    });
    const url = `${DISEASE_BASE}/getDissNameCodeList1?serviceKey=${apiKey}&${params}`;

    const { body, error } = await fetchHiraApi(url);
    if (error) return res.status(502).json({ error });

    const totalCount = body?.totalCount || 0;
    const rawItems = body?.items?.item;
    let items: any[] = [];
    if (rawItems) items = Array.isArray(rawItems) ? rawItems : [rawItems];

    const mapped = items.map((it: any) => ({
      sickCd: it.sickCd || '',
      sickNm: it.sickNm || '',
      sickEngNm: it.sickEngNm || '',
    }));

    return res.json({ items: mapped, totalCount, pageNo, numOfRows });
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'HIRA API 요청 시간 초과' });
    }
    console.error('HIRA disease-codes error:', err);
    return res.status(500).json({ error: '질병코드 조회 중 오류가 발생했습니다.' });
  }
});

/**
 * POST /api/hira/sync-disease-codes
 * HIRA API에서 전체 질병코드(3단 분류, 양방)를 가져와 로컬 DiseaseCode 테이블에 upsert
 * A-Z 병렬 호출 → 벌크 upsert
 */
router.post('/sync-disease-codes', authMiddleware, requirePermission('BASIC_MANAGE'), async (_req, res) => {
  try {
    const apiKey = await getHiraApiKey();
    if (!apiKey) return res.status(400).json({ error: 'HIRA API 키가 설정되지 않았습니다.' });

    // 1) A-Z 병렬로 전체 질병코드 수집
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const allCodes: { code: string; name: string }[] = [];

    const fetches = letters.map(async (letter) => {
      const params = new URLSearchParams({
        numOfRows: '200', pageNo: '1', _type: 'json',
        sickType: '1', medTp: '1', diseaseType: 'SICK_CD', searchText: letter,
      });
      const url = `${DISEASE_BASE}/getDissNameCodeList1?serviceKey=${apiKey}&${params}`;
      const { body } = await fetchHiraApi(url);
      const rawItems = body?.items?.item;
      if (!rawItems) return;
      const items: any[] = Array.isArray(rawItems) ? rawItems : [rawItems];
      for (const it of items) {
        const code = (it.sickCd || '').trim();
        const name = (it.sickNm || '').trim();
        if (code && name) allCodes.push({ code, name });
      }
    });
    await Promise.all(fetches);

    // 2) 기존 코드 조회
    const existing = await prisma.diseaseCode.findMany({ select: { code: true, name: true } });
    const existingMap = new Map(existing.map(e => [e.code, e.name]));

    // 3) 신규/업데이트 분리 → DB 작업
    let inserted = 0, updated = 0;

    for (const { code, name } of allCodes) {
      const oldName = existingMap.get(code);
      if (oldName === undefined) {
        try {
          await prisma.diseaseCode.create({
            data: { id: uuidv4(), code, name, code_type: 'MAIN', is_active: true },
          });
          inserted++;
        } catch { /* P2002 duplicate - skip */ }
      } else if (oldName !== name) {
        await prisma.diseaseCode.update({ where: { code }, data: { name } });
        updated++;
      }
    }

    return res.json({
      message: `동기화 완료: 신규 ${inserted}건, 업데이트 ${updated}건 (총 ${allCodes.length}건 조회)`,
      inserted,
      updated,
      total: allCodes.length,
    });
  } catch (err: any) {
    console.error('HIRA sync error:', err);
    return res.status(500).json({ error: '질병코드 동기화 중 오류가 발생했습니다.' });
  }
});

export default router;
