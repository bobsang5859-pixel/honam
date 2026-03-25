import { Router } from 'express';
import { prisma } from '../index';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);
const ACTIVE_STOCK_OUT_STATUSES = ['POSTED', 'RECEIPT_PENDING', 'RECEIPT_CONFIRMED', 'RECEIPT_DIFF'];

router.get('/summary', async (req: AuthRequest, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const canViewAll = req.user?.permissions.some(p => ['SYSTEM_ADMIN', 'PURCHASE_MANAGE', 'STATS_VIEW'].includes(p));
    const deptFilter = canViewAll ? {} : { department_id: req.user?.department_id ?? '' };

    // 이번 달 불출 금액
    const stockOuts = await prisma.stockOut.findMany({
      where: {
        status: { in: ACTIVE_STOCK_OUT_STATUSES as any },
        issued_at: { gte: monthStart, lte: monthEnd },
        ...deptFilter,
      },
      include: { items: { include: { item: { include: { price_history: { orderBy: { effective_from: 'desc' }, take: 1 } } } } } },
    });
    const monthIssuedAmount = stockOuts.reduce((total: number, so: any) =>
      total + so.items.reduce((s: number, it: any) =>
        s + Number(it.issued_qty) * (it.item.price_history?.[0] ? Number(it.item.price_history[0].price) : 0), 0), 0);

    // 이번 달 신청 건수
    const monthRequestCount = await prisma.wardRequest.count({
      where: {
        deleted_at: null,
        submitted_at: { gte: monthStart },
        ...deptFilter,
      },
    });

    // 승인 대기 건수
    const pendingApprovalCount = await prisma.wardRequest.count({
      where: { deleted_at: null, status: 'SUBMITTED' },
    });

    // 재고 부족 건수
    const allInv = await prisma.inventory.findMany({
      include: { item: true },
    });
    const lowStockCount = allInv.filter((i: any) => Number(i.on_hand_qty) <= i.item.reorder_days_threshold).length;

    // 최근 6개월 추이
    const monthly_trend = [];
    for (let i = 5; i >= 0; i--) {
      const mStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const sos = await prisma.stockOut.findMany({
        where: { status: { in: ACTIVE_STOCK_OUT_STATUSES as any }, issued_at: { gte: mStart, lte: mEnd }, ...deptFilter },
        include: { items: { include: { item: { include: { price_history: { orderBy: { effective_from: 'desc' }, take: 1 } } } } } },
      });
      const amount = sos.reduce((t: number, so: any) =>
        t + so.items.reduce((s: number, it: any) =>
          s + Number(it.issued_qty) * (it.item.price_history?.[0] ? Number(it.item.price_history[0].price) : 0), 0), 0);
      monthly_trend.push({
        month: `${mStart.getFullYear()}-${String(mStart.getMonth() + 1).padStart(2, '0')}`,
        amount: Math.round(amount),
      });
    }

    // 환자 현황 집계
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
    const monthStartPatient = new Date(today.getFullYear(), today.getMonth(), 1);

    const currentInpatientCount = await (prisma as any).patient.count({
      where: { status: 'ADMITTED', deleted_at: null },
    }).catch(() => 0);
    const todayAdmissionCount = await (prisma as any).patientEvent.count({
      where: { event_type: 'ADMISSION', event_date: { gte: todayStart, lte: todayEnd } },
    }).catch(() => 0);
    const todayDischargeCount = await (prisma as any).patientEvent.count({
      where: { event_type: 'DISCHARGE', event_date: { gte: todayStart, lte: todayEnd } },
    }).catch(() => 0);
    const monthDeathCount = await (prisma as any).patientEvent.count({
      where: { event_type: 'DEATH', event_date: { gte: monthStartPatient, lte: monthEnd } },
    }).catch(() => 0);

    // 수령검수 SLA 초과 (24시간 이상 RECEIPT_PENDING)
    const slaThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const slaOverdueCount = await prisma.stockOut.count({
      where: { status: 'RECEIPT_PENDING', issued_at: { lte: slaThreshold } },
    }).catch(() => 0);

    // 최근 신청 목록
    const recentRequests = await prisma.wardRequest.findMany({
      where: { deleted_at: null, ...deptFilter },
      include: { department: true },
      orderBy: { submitted_at: 'desc' },
      take: 10,
    });

    // 다빈도 불출 품목 TOP 5 (이번 달)
    const itemAmountMap: Map<string, { item_name: string; amount: number }> = new Map();
    for (const so of stockOuts) {
      for (const it of (so as any).items) {
        const price = it.item.price_history?.[0] ? Number(it.item.price_history[0].price) : 0;
        const amt = Number(it.issued_qty) * price;
        const key = it.item_id;
        const existing = itemAmountMap.get(key);
        if (existing) existing.amount += amt;
        else itemAmountMap.set(key, { item_name: it.item.name, amount: amt });
      }
    }
    const top_items = [...itemAmountMap.values()]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5)
      .map(i => ({ item_name: i.item_name, amount: Math.round(i.amount) }));

    // 상태별 신청 건수 (부서 필터 적용)
    const statusCounts: Record<string, number> = {};
    for (const st of ['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIAL_APPROVED', 'REJECTED']) {
      statusCounts[st] = await prisma.wardRequest.count({
        where: { deleted_at: null, status: st, ...deptFilter },
      });
    }

    // 물품 조달 파이프라인 (부서 사용자만)
    let supplyPipeline = null;
    if (!canViewAll && req.user?.department_id) {
      const deptId = req.user.department_id;
      const deptWhere = { department_id: deptId, deleted_at: null };
      const deptSourceFilter = { sources: { some: { ward_request: deptWhere } } };

      const [
        pendingApproval, vendorOrdering, warehouseReceiving,
        issuePending, completed,
        receiptDiff, followupOpen, followupResolved,
      ] = await Promise.all([
        prisma.wardRequest.count({ where: { status: 'SUBMITTED', ...deptWhere } }),
        prisma.purchaseOrder.count({
          where: { status: { in: ['SENT', 'PARTIAL_RECEIVED'] }, deleted_at: null, ...deptSourceFilter },
        }),
        (prisma as any).goodsReceipt.count({
          where: { status: 'PENDING', deleted_at: null, purchase_order: { deleted_at: null, ...deptSourceFilter } },
        }).catch(() => 0),
        prisma.stockOut.count({ where: { department_id: deptId, status: 'RECEIPT_PENDING' } }),
        prisma.stockOut.count({
          where: { department_id: deptId, status: 'RECEIPT_CONFIRMED', receipt_confirmed_at: { gte: monthStart } },
        }),
        prisma.stockOut.count({ where: { department_id: deptId, status: 'RECEIPT_DIFF' } }),
        (prisma as any).stockOutFollowUp.count({
          where: { department_id: deptId, action_type: 'ISSUE_ADD', status: 'OPEN' },
        }).catch(() => 0),
        (prisma as any).stockOutFollowUp.count({
          where: { department_id: deptId, status: 'RESOLVED', resolved_at: { gte: monthStart } },
        }).catch(() => 0),
      ]);

      supplyPipeline = {
        main: { pending_approval: pendingApproval, vendor_ordering: vendorOrdering, warehouse_receiving: warehouseReceiving, issue_pending: issuePending, completed },
        shortage: { receipt_diff: receiptDiff, followup_open: followupOpen, followup_resolved: followupResolved },
      };
    }

    // 예정 스케줄 (오늘 이후)
    const upcomingSchedules = await (prisma as any).requestSchedule.findMany({
      where: { open_to: { gte: now } },
      orderBy: { open_from: 'asc' },
      take: 5,
    }).catch(() => []);

    res.json({
      month_issued_amount: Math.round(monthIssuedAmount),
      month_request_count: monthRequestCount,
      pending_approval_count: pendingApprovalCount,
      low_stock_count: lowStockCount,
      current_inpatient_count: currentInpatientCount,
      today_admission_count: todayAdmissionCount,
      today_discharge_count: todayDischargeCount,
      month_death_count: monthDeathCount,
      sla_overdue_count: slaOverdueCount,
      monthly_trend,
      top_items,
      request_status_counts: statusCounts,
      supply_pipeline: supplyPipeline,
      upcoming_schedules: upcomingSchedules.map((s: any) => ({
        id: s.id,
        request_type: s.request_type,
        period_label: s.period_label,
        open_from: s.open_from,
        open_to: s.open_to,
      })),
      dept_comparison: [],
      recent_requests: recentRequests.map((r: any) => ({
        id: r.id,
        request_no: r.request_no,
        department_name: r.department?.name,
        status: r.status,
        submitted_at: r.submitted_at,
      })),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

export default router;
