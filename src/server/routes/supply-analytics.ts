/**
 * 물품 분석 API
 * - 병동별 예상/실제 불출원가 비교
 * - 품목별 불출 추이
 * - 이상 감지 (예상 대비 초과)
 */
import { Router, Request, Response } from 'express';
import { prisma } from '../index';
import { authMiddleware } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

/**
 * GET /ward-summary — 병동별 불출원가 vs 예상원가
 * query: year, month
 */
router.get('/ward-summary', async (req: Request, res: Response) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = Number(req.query.month) || (new Date().getMonth() + 1);

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    const daysInMonth = endDate.getDate();

    // 1. 모든 활성 병동
    const departments = await prisma.department.findMany({
      where: { is_active: true, deleted_at: null, name: { contains: '병동' } },
      select: { id: true, name: true },
    });

    const result = [];

    for (const dept of departments) {
      // 2. 실제 불출 원가 (해당 월)
      const stockOuts = await prisma.stockOut.findMany({
        where: {
          department_id: dept.id,
          issued_at: { gte: startDate, lte: endDate },
          status: { not: 'REVERSED' },
        },
        include: {
          items: {
            include: {
              item: {
                include: {
                  price_history: {
                    orderBy: { effective_from: 'desc' },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      });

      let actualCost = 0;
      const actualItems: Record<string, { name: string; qty: number; cost: number }> = {};

      for (const so of stockOuts) {
        for (const si of so.items) {
          const price = si.item.price_history.length > 0 ? Number(si.item.price_history[0].price) : 0;
          const qty = Number(si.issued_qty);
          const cost = price * qty;
          actualCost += cost;
          if (!actualItems[si.item_id]) {
            actualItems[si.item_id] = { name: si.item.name, qty: 0, cost: 0 };
          }
          actualItems[si.item_id].qty += qty;
          actualItems[si.item_id].cost += cost;
        }
      }

      // 3. 예상 소모량 (처치 기반)
      const activeTreatments = await prisma.patientTreatment.findMany({
        where: {
          patient: { department_id: dept.id, status: 'ADMITTED' },
          deleted_at: null,
          started_at: { lte: endDate },
          OR: [
            { ended_at: null },
            { ended_at: { gte: startDate } },
          ],
        },
        include: {
          treatment_type: {
            include: {
              supply_maps: {
                include: {
                  item: {
                    include: {
                      price_history: {
                        orderBy: { effective_from: 'desc' },
                        take: 1,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      let expectedCost = 0;
      const expectedItems: Record<string, { name: string; qty: number; cost: number }> = {};

      for (const pt of activeTreatments) {
        // 해당 월 내 활성 일수 계산
        const ptStart = new Date(pt.started_at) > startDate ? new Date(pt.started_at) : startDate;
        const ptEnd = pt.ended_at && new Date(pt.ended_at) < endDate ? new Date(pt.ended_at) : endDate;
        const activeDays = Math.max(1, Math.ceil((ptEnd.getTime() - ptStart.getTime()) / (1000 * 60 * 60 * 24)) + 1);
        const activeWeeks = activeDays / 7;

        for (const sm of pt.treatment_type.supply_maps) {
          const qtyDaily = Number(sm.qty_per_day) * activeDays;
          const qtyWeekly = Number(sm.qty_per_week) * activeWeeks;
          const totalQty = qtyDaily + qtyWeekly;
          const price = sm.item.price_history.length > 0 ? Number(sm.item.price_history[0].price) : 0;
          const cost = price * totalQty;

          expectedCost += cost;
          if (!expectedItems[sm.item_id]) {
            expectedItems[sm.item_id] = { name: sm.item.name, qty: 0, cost: 0 };
          }
          expectedItems[sm.item_id].qty += totalQty;
          expectedItems[sm.item_id].cost += cost;
        }
      }

      const diff = actualCost - expectedCost;
      const ratio = expectedCost > 0 ? Math.round((actualCost / expectedCost) * 100) : (actualCost > 0 ? 999 : 0);

      result.push({
        department_id: dept.id,
        department_name: dept.name,
        expected_cost: Math.round(expectedCost),
        actual_cost: Math.round(actualCost),
        diff: Math.round(diff),
        ratio,
        patient_count: new Set(activeTreatments.map(t => t.patient_id)).size,
        treatment_count: activeTreatments.length,
        top_items: Object.entries(actualItems)
          .sort((a, b) => b[1].cost - a[1].cost)
          .slice(0, 5)
          .map(([id, v]) => ({ item_id: id, ...v, expected: expectedItems[id]?.qty || 0 })),
      });
    }

    res.json({ year, month, days_in_month: daysInMonth, wards: result });
  } catch (e: any) {
    console.error('[supply-analytics] ward-summary error:', e);
    res.status(500).json({ error: e.message || '서버 오류' });
  }
});

/**
 * GET /item-trend — 품목별 불출 추이 (최근 6개월)
 * query: item_id (required), department_id (optional)
 */
router.get('/item-trend', async (req: Request, res: Response) => {
  try {
    const { item_id, department_id } = req.query;
    if (!item_id) return res.status(400).json({ error: 'item_id required' });

    const months = 6;
    const now = new Date();
    const result = [];

    for (let i = months - 1; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const label = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;

      const where: any = {
        item_id: item_id as string,
        stock_out: {
          issued_at: { gte: start, lte: end },
          status: { not: 'REVERSED' },
        },
      };
      if (department_id) {
        where.stock_out.department_id = department_id as string;
      }

      const agg = await prisma.stockOutItem.aggregate({
        where,
        _sum: { issued_qty: true },
      });

      result.push({
        month: label,
        quantity: Number(agg._sum.issued_qty || 0),
      });
    }

    res.json({ item_id, department_id: department_id || null, trend: result });
  } catch (e: any) {
    console.error('[supply-analytics] item-trend error:', e);
    res.status(500).json({ error: e.message || '서버 오류' });
  }
});

/**
 * GET /anomalies — 이상 감지 (예상 대비 초과 품목)
 * query: year, month, threshold (default 150 = 150%)
 */
router.get('/anomalies', async (req: Request, res: Response) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = Number(req.query.month) || (new Date().getMonth() + 1);
    const threshold = Number(req.query.threshold) || 150;

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const departments = await prisma.department.findMany({
      where: { is_active: true, deleted_at: null, name: { contains: '병동' } },
      select: { id: true, name: true },
    });

    const anomalies: any[] = [];

    for (const dept of departments) {
      // 실제 불출
      const stockOutItems = await prisma.stockOutItem.findMany({
        where: {
          stock_out: {
            department_id: dept.id,
            issued_at: { gte: startDate, lte: endDate },
            status: { not: 'REVERSED' },
          },
        },
        include: { item: { select: { id: true, name: true } } },
      });

      const actualByItem: Record<string, { name: string; qty: number }> = {};
      for (const si of stockOutItems) {
        if (!actualByItem[si.item_id]) actualByItem[si.item_id] = { name: si.item.name, qty: 0 };
        actualByItem[si.item_id].qty += Number(si.issued_qty);
      }

      // 예상 소모량
      const treatments = await prisma.patientTreatment.findMany({
        where: {
          patient: { department_id: dept.id, status: 'ADMITTED' },
          deleted_at: null,
          started_at: { lte: endDate },
          OR: [{ ended_at: null }, { ended_at: { gte: startDate } }],
        },
        include: {
          treatment_type: { include: { supply_maps: true } },
        },
      });

      const expectedByItem: Record<string, number> = {};
      for (const pt of treatments) {
        const ptStart = new Date(pt.started_at) > startDate ? new Date(pt.started_at) : startDate;
        const ptEnd = pt.ended_at && new Date(pt.ended_at) < endDate ? new Date(pt.ended_at) : endDate;
        const days = Math.max(1, Math.ceil((ptEnd.getTime() - ptStart.getTime()) / (1000 * 60 * 60 * 24)) + 1);
        const weeks = days / 7;

        for (const sm of pt.treatment_type.supply_maps) {
          const qty = Number(sm.qty_per_day) * days + Number(sm.qty_per_week) * weeks;
          expectedByItem[sm.item_id] = (expectedByItem[sm.item_id] || 0) + qty;
        }
      }

      // 이상 탐지
      for (const [itemId, actual] of Object.entries(actualByItem)) {
        const expected = expectedByItem[itemId] || 0;
        if (expected > 0) {
          const ratio = Math.round((actual.qty / expected) * 100);
          if (ratio >= threshold) {
            anomalies.push({
              department_id: dept.id,
              department_name: dept.name,
              item_id: itemId,
              item_name: actual.name,
              expected_qty: Math.round(expected),
              actual_qty: actual.qty,
              ratio,
              excess: Math.round(actual.qty - expected),
            });
          }
        } else if (actual.qty > 0 && expected === 0) {
          // 예상 없이 불출된 항목
          anomalies.push({
            department_id: dept.id,
            department_name: dept.name,
            item_id: itemId,
            item_name: actual.name,
            expected_qty: 0,
            actual_qty: actual.qty,
            ratio: 999,
            excess: actual.qty,
          });
        }
      }
    }

    anomalies.sort((a, b) => b.ratio - a.ratio);

    res.json({ year, month, threshold, anomalies });
  } catch (e: any) {
    console.error('[supply-analytics] anomalies error:', e);
    res.status(500).json({ error: e.message || '서버 오류' });
  }
});

/**
 * GET /cost-report — 병원 전체 원가 보고서
 * query: year
 */
router.get('/cost-report', async (req: Request, res: Response) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();

    const monthlyData = [];

    for (let m = 1; m <= 12; m++) {
      const start = new Date(year, m - 1, 1);
      const end = new Date(year, m, 0, 23, 59, 59);

      if (start > new Date()) break; // 미래 월은 스킵

      const stockOutItems = await prisma.stockOutItem.findMany({
        where: {
          stock_out: {
            issued_at: { gte: start, lte: end },
            status: { not: 'REVERSED' },
          },
        },
        include: {
          item: {
            include: {
              price_history: { orderBy: { effective_from: 'desc' }, take: 1 },
            },
          },
          stock_out: { select: { department_id: true } },
        },
      });

      let totalCost = 0;
      const byDept: Record<string, number> = {};

      for (const si of stockOutItems) {
        const price = si.item.price_history.length > 0 ? Number(si.item.price_history[0].price) : 0;
        const cost = price * Number(si.issued_qty);
        totalCost += cost;
        const deptId = (si as any).stock_out?.department_id || 'unknown';
        byDept[deptId] = (byDept[deptId] || 0) + cost;
      }

      monthlyData.push({
        month: m,
        label: `${year}-${String(m).padStart(2, '0')}`,
        total_cost: Math.round(totalCost),
        by_department: byDept,
      });
    }

    res.json({ year, monthly: monthlyData });
  } catch (e: any) {
    console.error('[supply-analytics] cost-report error:', e);
    res.status(500).json({ error: e.message || '서버 오류' });
  }
});

export default router;
