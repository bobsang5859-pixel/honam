/**
 * 출고 오류/후속조치 통계 API
 * - 후속조치 발생률
 * - 해결 소요시간
 * - 문제 품목 TOP N
 * - 유형별 분포
 */
import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { authMiddleware } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

/**
 * GET / — 종합 출고오류 통계
 * query: date_from, date_to, top_n (default 10)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const dateFrom = req.query.date_from
      ? new Date(req.query.date_from as string)
      : new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const dateTo = req.query.date_to
      ? new Date(req.query.date_to as string)
      : now;
    const topN = Number(req.query.top_n) || 10;

    // 기간 내 전체 출고 건수
    const totalStockOuts = await prisma.stockOut.count({
      where: {
        issued_at: { gte: dateFrom, lte: dateTo },
        deleted_at: null,
      },
    });

    // 후속조치 목록
    const followUps = await prisma.stockOutFollowUp.findMany({
      where: {
        created_at: { gte: dateFrom, lte: dateTo },
      },
      include: {
        item: { select: { id: true, code: true, name: true } },
        department: { select: { id: true, name: true } },
      },
    });

    // 후속조치가 있는 출고 건수 (유니크 stock_out_id)
    const uniqueStockOutIds = new Set(followUps.map(f => f.stock_out_id));
    const stockOutsWithFollowUp = uniqueStockOutIds.size;

    // 발생률
    const occurrenceRate = totalStockOuts > 0
      ? Math.round(stockOutsWithFollowUp / totalStockOuts * 1000) / 10
      : 0;

    // 해결 소요시간
    const resolved = followUps.filter(f => f.resolved_at);
    let avgResolutionDays = 0;
    if (resolved.length > 0) {
      const totalDays = resolved.reduce((sum, f) => {
        const days = (f.resolved_at!.getTime() - f.created_at.getTime()) / (1000 * 60 * 60 * 24);
        return sum + Math.max(0, days);
      }, 0);
      avgResolutionDays = Math.round(totalDays / resolved.length * 10) / 10;
    }

    // 유형별 분포
    const typeMap = new Map<string, number>();
    for (const f of followUps) {
      typeMap.set(f.action_type, (typeMap.get(f.action_type) || 0) + 1);
    }
    const byType = Array.from(typeMap.entries()).map(([type, count]) => ({
      action_type: type,
      count,
      label: type === 'ISSUE_ADD' ? '추가출고' : type === 'COLLECT_BACK' ? '회수' : type,
    }));

    // 상태별 분포
    const statusMap = new Map<string, number>();
    for (const f of followUps) {
      statusMap.set(f.status, (statusMap.get(f.status) || 0) + 1);
    }
    const byStatus = Array.from(statusMap.entries()).map(([status, count]) => ({
      status,
      count,
      label: status === 'OPEN' ? '미해결' : status === 'RESOLVED' ? '해결' : status === 'CANCELLED' ? '취소' : status,
    }));

    // 문제 품목 TOP N
    const itemMap = new Map<string, { code: string; name: string; count: number }>();
    for (const f of followUps) {
      if (!f.item) continue;
      const entry = itemMap.get(f.item_id) || { code: f.item.code, name: f.item.name, count: 0 };
      entry.count += 1;
      itemMap.set(f.item_id, entry);
    }
    const topItems = Array.from(itemMap.entries())
      .map(([id, d]) => ({ item_id: id, item_code: d.code, item_name: d.name, follow_up_count: d.count }))
      .sort((a, b) => b.follow_up_count - a.follow_up_count)
      .slice(0, topN);

    // 부서별 분포
    const deptMap = new Map<string, { name: string; count: number }>();
    for (const f of followUps) {
      const entry = deptMap.get(f.department_id) || { name: f.department?.name || '', count: 0 };
      entry.count += 1;
      deptMap.set(f.department_id, entry);
    }
    const byDepartment = Array.from(deptMap.entries())
      .map(([id, d]) => ({ department_id: id, department_name: d.name, count: d.count }))
      .sort((a, b) => b.count - a.count);

    // 월별 추이
    const monthlyMap = new Map<string, number>();
    for (const f of followUps) {
      const key = f.created_at.toISOString().slice(0, 7);
      monthlyMap.set(key, (monthlyMap.get(key) || 0) + 1);
    }
    const monthly = Array.from(monthlyMap.entries())
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month));

    res.json({
      summary: {
        total_stock_outs: totalStockOuts,
        with_follow_up: stockOutsWithFollowUp,
        occurrence_rate: occurrenceRate,
        total_follow_ups: followUps.length,
        resolved_count: resolved.length,
        avg_resolution_days: avgResolutionDays,
      },
      by_type: byType,
      by_status: byStatus,
      by_department: byDepartment,
      top_items: topItems,
      monthly,
    });
  } catch (e) {
    console.error('stockout-stats error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
