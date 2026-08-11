// 비용·낭비 분석 — 총무부 전용. 병동 접근 X.
//
// PURCHASE_MANAGE 권한자만. 병동에는 메뉴 자체 안 보임.
//
// v1 제공:
//   - 부서별 권장 대비 신청 비율 (최근 N개월)
//   - 부서별 비용 누계
//   - 자동 사유 분포 (ANOMALY / UNDER_USAGE / NORMAL / COLD_START)
//   - 가이드라인 미매핑 품목 빈도 (개선 후보)
//
// v2 (Step 8 LLM 파인튜닝 후):
//   - 자연어 리포트 자동 생성
//   - Q&A 챗봇

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { inferRecommendedQty } from '../services/inferDemand';
import { inferRequestReason } from '../services/inferReason';
import { getModelStatus } from '../services/ml/predict';
import { getDataReadiness } from '../services/dataReadiness';

// 비용 = 실제 불출 원가. 활성 불출 상태 (취소/반려 제외) — cost.ts/patients.ts 와 동일 정의로 통일.
const ACTIVE_STOCK_OUT_STATUSES = ['POSTED', 'RECEIPT_PENDING', 'RECEIPT_CONFIRMED', 'RECEIPT_DIFF'];

const router = Router();
router.use(authMiddleware);

// 분석 대시보드 메인 — 부서별 사용 패턴 + 자동 사유 분포
router.get('/dashboard', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const months = Math.max(1, Math.min(12, Number(req.query.months ?? 3)));
    const since = new Date();
    since.setMonth(since.getMonth() - months);

    // 부서 목록
    const departments = await prisma.department.findMany({
      where: { deleted_at: null },
      select: { id: true, name: true },
    });

    // 라인 수·자동 사유 지표 = 신청 행동 기반 (얼마나 신청했나 vs 권장량).
    const requests = await prisma.wardRequest.findMany({
      where: {
        deleted_at: null,
        is_test: false,
        status: { in: ['APPROVED', 'PARTIAL_APPROVED'] },
        submitted_at: { gte: since },
      },
      include: { items: true },
    });

    // 비용 = 실제 불출 원가 (FIFO lot 할당 line_amount). 부서·기간(issued_at) 기준 집계.
    // 신청/승인이 아니라 "실제로 불출된 물품의 실제 원가"가 비용으로 잡힌다.
    const stockOuts = await prisma.stockOut.findMany({
      where: {
        deleted_at: null,
        is_test: false,
        status: { in: ACTIVE_STOCK_OUT_STATUSES as any },
        issued_at: { gte: since },
      },
      include: { lot_allocations: true },
    });
    const costByDept = new Map<string, number>();
    for (const so of stockOuts as any[]) {
      const amt = (so.lot_allocations ?? []).reduce(
        (s: number, a: any) => s + Number(a.line_amount ?? 0), 0,
      );
      costByDept.set(so.department_id, (costByDept.get(so.department_id) ?? 0) + amt);
    }

    // 부서별 통계 누적
    type DeptStat = {
      department_id: string;
      department_name: string;
      total_lines: number;
      total_cost: number;
      reason_counts: Record<string, number>;
      anomaly_lines: number;
      under_usage_lines: number;
      no_inference_lines: number;
      cold_start_lines: number;
      normal_lines: number;
    };
    const stats = new Map<string, DeptStat>();
    for (const d of departments) {
      stats.set(d.id, {
        department_id: d.id,
        department_name: d.name,
        total_lines: 0,
        total_cost: 0,
        reason_counts: {},
        anomaly_lines: 0,
        under_usage_lines: 0,
        no_inference_lines: 0,
        cold_start_lines: 0,
        normal_lines: 0,
      });
    }

    // 비용은 불출 기반(costByDept)으로 별도 집계 → 부서 통계에 주입.
    for (const [deptId, c] of costByDept) {
      const st = stats.get(deptId);
      if (st) st.total_cost = c;
    }

    for (const r of requests) {
      const stat = stats.get(r.department_id);
      if (!stat) continue;

      for (const it of r.items) {
        if (!it.item_id) continue;
        stat.total_lines += 1;

        // 자동 사유 추론 (현재 시점 기준 — 가이드라인은 정적이라 OK)
        let inference = null;
        try {
          inference = await inferRecommendedQty(r.department_id, it.item_id, 30);
        } catch {
          inference = null;
        }
        const reason = inferRequestReason({
          requested_qty: Number(it.requested_qty),
          inference,
          request_type: r.request_type,
        });
        stat.reason_counts[reason.code] = (stat.reason_counts[reason.code] ?? 0) + 1;
        if (reason.code === 'ANOMALY') stat.anomaly_lines += 1;
        else if (reason.code === 'UNDER_USAGE') stat.under_usage_lines += 1;
        else if (reason.code === 'NO_INFERENCE') stat.no_inference_lines += 1;
        else if (reason.code === 'COLD_START') stat.cold_start_lines += 1;
        else if (reason.code === 'NORMAL') stat.normal_lines += 1;
      }
    }

    const deptStats = Array.from(stats.values())
      // 신청 라인이 있거나 불출 비용이 있는 부서 (불출만 있고 신청 없는 부서도 노출)
      .filter((s) => s.total_lines > 0 || s.total_cost > 0)
      .map((s) => ({
        ...s,
        total_cost: Math.round(s.total_cost),
        anomaly_pct: s.total_lines > 0 ? Math.round((s.anomaly_lines / s.total_lines) * 100) : 0,
      }))
      .sort((a, b) => b.total_cost - a.total_cost);

    const modelStatus = getModelStatus();

    res.json({
      period_months: months,
      since: since.toISOString(),
      department_stats: deptStats,
      summary: {
        total_departments: deptStats.length,
        total_lines: deptStats.reduce((s, d) => s + d.total_lines, 0),
        total_cost: deptStats.reduce((s, d) => s + d.total_cost, 0),
        total_anomaly: deptStats.reduce((s, d) => s + d.anomaly_lines, 0),
      },
      model_status: modelStatus,
    });
  } catch (e) {
    console.error('[cost-analysis/dashboard] error:', e);
    res.status(500).json({ error: '분석 대시보드 조회 중 오류' });
  }
});

// 학습 데이터 충분성 — 현재 데이터 상태 + 단계별 자격 + 다음 마일스톤
router.get('/data-readiness', requirePermission('PURCHASE_MANAGE'), async (_req: AuthRequest, res) => {
  try {
    const readiness = await getDataReadiness();
    res.json(readiness);
  } catch (e) {
    console.error('[cost-analysis/data-readiness] error:', e);
    res.status(500).json({ error: '학습 상태 조회 중 오류' });
  }
});

// 추천 활성 상태 — 운영자가 "추천 시작" 클릭 시 토글.
// 기본값 false. true 일 때만 ward-requests/recommendations 가 가이드라인 fallback 적용.
router.get('/inference-status', requirePermission('PURCHASE_MANAGE'), async (_req: AuthRequest, res) => {
  try {
    const flag = await (prisma as any).appSetting.findUnique({ where: { key: 'inference:enabled' } });
    const enabled = flag?.value === 'true';
    res.json({
      enabled,
      enabled_at: flag?.value === 'true' && flag?.updated_at ? flag.updated_at : null,
    });
  } catch (e) {
    console.error('[cost-analysis/inference-status] error:', e);
    res.status(500).json({ error: '추천 상태 조회 중 오류' });
  }
});

router.post('/inference-toggle', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    await (prisma as any).appSetting.upsert({
      where: { key: 'inference:enabled' },
      update: { value: String(enabled) },
      create: {
        id: uuidv4(),
        key: 'inference:enabled',
        value: String(enabled),
        description: '추천 시스템 활성 여부 (운영자 토글)',
      },
    });
    res.json({ enabled });
  } catch (e) {
    console.error('[cost-analysis/inference-toggle] error:', e);
    res.status(500).json({ error: '추천 토글 중 오류' });
  }
});

export default router;
