import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getHiraApiKey, fetchHiraApi } from './hira-api';

const router = Router();

const DISEASE_BASE = 'http://apis.data.go.kr/B551182/diseaseInfoService1';

const STAT_ENDPOINTS: Record<string, string> = {
  'inpatient-outpatient': 'getDissByHsptlzFrgnStats1',
  'gender-age':           'getDissByGenderAgeStats1',
  'institution':          'getDissByClassesStats1',
  'region':               'getDissByAreaStats1',
};

/**
 * GET /api/hira-disease-stats/:type?sickCd=E11&year=2023&numOfRows=100&pageNo=1
 * type: inpatient-outpatient | gender-age | institution | region
 */
router.get('/:type', authMiddleware, async (req, res) => {
  try {
    const apiKey = await getHiraApiKey();
    if (!apiKey) return res.status(400).json({ error: 'HIRA API 키가 설정되지 않았습니다.' });

    const { type } = req.params;
    const operation = STAT_ENDPOINTS[type];
    if (!operation) return res.status(400).json({ error: `유효하지 않은 통계 유형: ${type}` });

    const sickCd = (req.query.sickCd as string || '').trim();
    if (!sickCd) return res.status(400).json({ error: '질병코드(sickCd)를 입력해 주세요.' });

    const year = (req.query.year as string || '').trim();
    const pageNo = parseInt(req.query.pageNo as string) || 1;
    const numOfRows = Math.min(parseInt(req.query.numOfRows as string) || 100, 1000);

    const params = new URLSearchParams({
      numOfRows: String(numOfRows),
      pageNo: String(pageNo),
      _type: 'json',
      sickCd,
      sickType: '1',
      medTp: '1',
    });
    if (year) params.set('year', year);

    const url = `${DISEASE_BASE}/${operation}?serviceKey=${apiKey}&${params}`;
    const { body, error } = await fetchHiraApi(url);
    if (error) return res.status(502).json({ error });

    const totalCount = body?.totalCount || 0;
    const rawItems = body?.items?.item || body?.items?.items;
    let items: any[] = [];
    if (rawItems) items = Array.isArray(rawItems) ? rawItems : [rawItems];

    // 숫자 필드 정규화
    const mapped = items.map((it: any) => ({
      ...it,
      ptntCnt: Number(it.ptntCnt) || 0,
      vstDdcnt: Number(it.vstDdcnt) || 0,
      specCnt: Number(it.specCnt) || 0,
      rvdRpeTamtAmt: Number(it.rvdRpeTamtAmt) || 0,
      rvdInsupBrdnAmt: Number(it.rvdInsupBrdnAmt) || 0,
    }));

    return res.json({ items: mapped, totalCount, pageNo, numOfRows });
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'HIRA API 요청 시간 초과' });
    }
    console.error('HIRA disease stats error:', err);
    return res.status(500).json({ error: '질병 통계 조회 중 오류가 발생했습니다.' });
  }
});

export default router;
