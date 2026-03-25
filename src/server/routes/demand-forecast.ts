/**
 * 수요예측 API 라우트
 */
import { Router, Request, Response } from 'express';
import { authMiddleware, requireMenuAccess } from '../middleware/auth';
import { forecastDemand, getUsageHistory } from '../services/demand-forecast';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('demand-forecast', 'STATS_VIEW', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'));

/**
 * GET /api/demand-forecast
 * 품목별 수요 예측 (위험도순 정렬)
 * query: dept_id?, item_id?, months?(default 3), safety_days?(default 2)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const result = await forecastDemand({
      dept_id: req.query.dept_id as string | undefined,
      item_id: req.query.item_id as string | undefined,
      months: req.query.months ? Number(req.query.months) : 3,
      safety_days: req.query.safety_days ? Number(req.query.safety_days) : 2,
    });
    res.json(result);
  } catch (err) {
    console.error('Demand forecast error:', err);
    res.status(500).json({ error: '수요예측 처리 중 오류가 발생했습니다.' });
  }
});

/**
 * GET /api/demand-forecast/summary
 * 대시보드 위젯용 요약
 */
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const result = await forecastDemand({
      months: 3,
      safety_days: 2,
    });
    res.json({
      critical_count: result.critical_count,
      warning_count: result.warning_count,
      safe_count: result.safe_count,
      no_data_count: result.no_data_count,
      total_items: result.total_items,
      top_critical: result.items.filter(i => i.risk_level === 'critical').slice(0, 5),
    });
  } catch (err) {
    console.error('Demand forecast summary error:', err);
    res.status(500).json({ error: '요약 처리 중 오류가 발생했습니다.' });
  }
});

/**
 * GET /api/demand-forecast/history/:item_id
 * 품목별 월간 사용 추이 (6개월)
 * query: dept_id?, months?(default 6)
 */
router.get('/history/:item_id', async (req: Request, res: Response) => {
  try {
    const { item_id } = req.params;
    const deptId = req.query.dept_id as string | undefined;
    const months = req.query.months ? Number(req.query.months) : 6;

    const history = await getUsageHistory(item_id, deptId, months);
    res.json({ item_id, history });
  } catch (err) {
    console.error('Usage history error:', err);
    res.status(500).json({ error: '사용 추이 조회 중 오류가 발생했습니다.' });
  }
});

export default router;
