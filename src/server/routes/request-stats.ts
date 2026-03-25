/**
 * 신청/승인 통계 API
 * - 부서별 승인율
 * - 승인 소요시간
 * - 신청량 vs 승인량 차이
 * - 신청 유형별 분포
 */
import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { authMiddleware } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

/**
 * GET / — 종합 신청/승인 통계
 * query: date_from, date_to, department_id?
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

    const where: any = {
      submitted_at: { gte: dateFrom, lte: dateTo },
      deleted_at: null,
      status: { not: 'DRAFT' },
    };
    if (req.query.department_id) {
      where.department_id = req.query.department_id;
    }

    const requests = await prisma.wardRequest.findMany({
      where,
      include: {
        department: { select: { id: true, name: true } },
        approval_actions: {
          include: {
            items: true,
          },
        },
        items: true,
      },
    });

    // ── 부서별 승인율 ──
    const deptMap = new Map<string, {
      name: string; total: number; approved: number; rejected: number; partial: number;
      totalDays: number; approvedCount: number;
      requestedQty: number; approvedQty: number;
    }>();

    // ── 유형별 분포 ──
    const typeMap = new Map<string, number>();

    for (const wr of requests) {
      const deptId = wr.department_id;
      const deptName = wr.department?.name || deptId;
      const entry = deptMap.get(deptId) || {
        name: deptName, total: 0, approved: 0, rejected: 0, partial: 0,
        totalDays: 0, approvedCount: 0,
        requestedQty: 0, approvedQty: 0,
      };

      entry.total += 1;

      // 유형별
      const rtype = wr.request_type || 'UNKNOWN';
      typeMap.set(rtype, (typeMap.get(rtype) || 0) + 1);

      // 승인 상태
      if (wr.status === 'APPROVED') entry.approved += 1;
      else if (wr.status === 'REJECTED') entry.rejected += 1;
      else if (wr.status === 'PARTIAL_APPROVED') entry.partial += 1;

      // 승인 소요시간
      if (wr.approval_actions.length > 0 && wr.submitted_at) {
        const firstAction = wr.approval_actions[0];
        const days = Math.max(0,
          (firstAction.created_at.getTime() - wr.submitted_at.getTime()) / (1000 * 60 * 60 * 24)
        );
        entry.totalDays += days;
        entry.approvedCount += 1;
      }

      // 수량 차이
      for (const item of wr.items) {
        entry.requestedQty += Number(item.requested_qty);
      }
      for (const action of wr.approval_actions) {
        for (const ai of action.items) {
          entry.approvedQty += Number(ai.approved_qty);
        }
      }

      deptMap.set(deptId, entry);
    }

    const byDepartment = Array.from(deptMap.entries()).map(([id, d]) => ({
      department_id: id,
      department_name: d.name,
      total_requests: d.total,
      approved: d.approved,
      rejected: d.rejected,
      partial: d.partial,
      approval_rate: d.total > 0 ? Math.round((d.approved + d.partial) / d.total * 1000) / 10 : 0,
      avg_approval_days: d.approvedCount > 0 ? Math.round(d.totalDays / d.approvedCount * 10) / 10 : 0,
      requested_qty: Math.round(d.requestedQty),
      approved_qty: Math.round(d.approvedQty),
      qty_diff_pct: d.requestedQty > 0
        ? Math.round((d.approvedQty - d.requestedQty) / d.requestedQty * 1000) / 10
        : 0,
    }));

    byDepartment.sort((a, b) => b.total_requests - a.total_requests);

    const byType = Array.from(typeMap.entries()).map(([type, count]) => ({
      request_type: type,
      count,
    }));
    byType.sort((a, b) => b.count - a.count);

    const totalRequests = requests.length;
    const totalApproved = requests.filter(r => r.status === 'APPROVED' || r.status === 'PARTIAL_APPROVED').length;

    res.json({
      summary: {
        total_requests: totalRequests,
        total_approved: totalApproved,
        overall_approval_rate: totalRequests > 0 ? Math.round(totalApproved / totalRequests * 1000) / 10 : 0,
      },
      by_department: byDepartment,
      by_type: byType,
    });
  } catch (e) {
    console.error('request-stats error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
