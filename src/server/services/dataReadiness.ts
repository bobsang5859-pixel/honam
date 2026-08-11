// 학습 데이터 충분성 자동 판정.
//
// 가이드라인 만으로는 한계가 있어 부서·품목별 패턴 학습이 필요한데,
// 학습은 데이터가 충분히 쌓여야 의미가 있다. 이 모듈은 현재 데이터 상태를 보고
// 어느 학습 단계가 가능한지 판정한다.
//
// 단계:
//   COLD_START — 데이터 부족, 가이드라인 100%
//   PHASE_1   — 부서별 평균 패턴 산출 가능 (3개월 운영, 12회 이상 신청)
//   PHASE_2   — 학습 가중치 자동 산출 가능 (6개월 운영, 30회 이상 신청)
//   PHASE_3   — 이상 탐지·LLM 학습 자격 (1년 운영, 1000건 이상 라인)
//
// 사용처:
//   - CostAnalysisPage 학습 상태 패널
//   - nightly cron (단계 전환 시 알림)
//   - applyOverride 자동 공급 활성화 트리거 (Phase 2 도달 시)

import { prisma } from '../index';

export type ReadinessLevel = 'COLD_START' | 'PHASE_1' | 'PHASE_2' | 'PHASE_3';

export type ReadinessThresholds = {
  phase_1: {
    min_operation_days: number;
    min_requests: number;
    min_item_coverage: number;
    min_stockouts: number;
  };
  phase_2: {
    min_operation_days: number;
    min_requests: number;
    min_item_coverage: number;
  };
  phase_3: {
    min_total_lines: number;
    min_operation_days: number;
  };
};

export const READINESS_THRESHOLDS: ReadinessThresholds = {
  phase_1: {
    min_operation_days: 90,
    min_requests: 12,
    min_item_coverage: 5,   // 품목별 3건 이상 신청된 품목 수
    min_stockouts: 5,
  },
  phase_2: {
    min_operation_days: 180,
    min_requests: 30,
    min_item_coverage: 10,
  },
  phase_3: {
    min_total_lines: 1000,
    min_operation_days: 365,
  },
};

export type PerDeptReadiness = {
  department_id: string;
  department_name: string;
  operation_days: number;
  request_count: number;
  item_coverage: number;          // 신청 3건 이상 받은 품목 수
  stockout_count: number;
  eligible_phase_1: boolean;
  eligible_phase_2: boolean;
};

export type DataReadiness = {
  level: ReadinessLevel;
  thresholds: ReadinessThresholds;
  global: {
    operation_days: number;
    total_lines: number;
    eligible_phase_3: boolean;
  };
  per_dept: PerDeptReadiness[];
  next_milestone: string;
};

export async function getDataReadiness(): Promise<DataReadiness> {
  // 1. 운영 시작일 — 가장 오래된 WardRequest
  const oldestRequest = await prisma.wardRequest.findFirst({
    where: { deleted_at: null, is_test: false },
    orderBy: { submitted_at: 'asc' },
    select: { submitted_at: true },
  });
  const startDate = oldestRequest?.submitted_at ?? null;
  const now = new Date();
  const globalOperationDays = startDate
    ? Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  // 2. 부서 목록
  const departments = await prisma.department.findMany({
    where: { deleted_at: null, is_active: true },
    select: { id: true, name: true, code: true },
  });

  // 3. 부서별 신청 통계
  const reqStats = await prisma.wardRequest.groupBy({
    by: ['department_id'],
    where: {
      deleted_at: null,
      is_test: false,
      status: { in: ['SUBMITTED', 'APPROVED', 'PARTIAL_APPROVED'] },
    },
    _count: { _all: true },
    _min: { submitted_at: true },
  });
  const reqStatsMap = new Map(reqStats.map(s => [s.department_id, s]));

  // 4. 부서별 품목 커버리지 — 품목 단위로 3회 이상 신청된 품목 수
  const itemCoverageRows = await prisma.$queryRaw<Array<{ department_id: string; coverage: number }>>`
    SELECT department_id, COUNT(*) AS coverage FROM (
      SELECT wr.department_id, wri.item_id
      FROM ward_request_items wri
      JOIN ward_requests wr ON wr.id = wri.ward_request_id
      WHERE wr.deleted_at IS NULL
        AND wr.is_test = 0
        AND wri.item_id IS NOT NULL
      GROUP BY wr.department_id, wri.item_id
      HAVING COUNT(*) >= 3
    ) AS sub
    GROUP BY department_id
  `;
  const itemCoverageMap = new Map(itemCoverageRows.map(r => [r.department_id, Number(r.coverage)]));

  // 5. 부서별 stock_out 횟수
  const stockOutRows = await prisma.$queryRaw<Array<{ department_id: string; count: number }>>`
    SELECT department_id, COUNT(*) AS count
    FROM stock_out
    WHERE deleted_at IS NULL AND is_test = 0
    GROUP BY department_id
  `;
  const stockOutMap = new Map(stockOutRows.map(r => [r.department_id, Number(r.count)]));

  // 6. 부서별 readiness 산출
  const perDept: PerDeptReadiness[] = departments.map(d => {
    const stat = reqStatsMap.get(d.id);
    const requestCount = stat?._count?._all ?? 0;
    const firstReqDate = stat?._min?.submitted_at ?? null;
    const operationDays = firstReqDate
      ? Math.floor((now.getTime() - firstReqDate.getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    const itemCoverage = itemCoverageMap.get(d.id) ?? 0;
    const stockoutCount = stockOutMap.get(d.id) ?? 0;

    const eligible_phase_1 =
      operationDays >= READINESS_THRESHOLDS.phase_1.min_operation_days &&
      requestCount >= READINESS_THRESHOLDS.phase_1.min_requests &&
      itemCoverage >= READINESS_THRESHOLDS.phase_1.min_item_coverage &&
      stockoutCount >= READINESS_THRESHOLDS.phase_1.min_stockouts;

    const eligible_phase_2 =
      operationDays >= READINESS_THRESHOLDS.phase_2.min_operation_days &&
      requestCount >= READINESS_THRESHOLDS.phase_2.min_requests &&
      itemCoverage >= READINESS_THRESHOLDS.phase_2.min_item_coverage;

    return {
      department_id: d.id,
      department_name: d.name,
      operation_days: operationDays,
      request_count: requestCount,
      item_coverage: itemCoverage,
      stockout_count: stockoutCount,
      eligible_phase_1,
      eligible_phase_2,
    };
  });

  // 7. 전체 라인 수 (Phase 3 판정용)
  const totalLines = await prisma.wardRequestItem.count({
    where: {
      ward_request: { deleted_at: null, is_test: false, status: { in: ['SUBMITTED', 'APPROVED', 'PARTIAL_APPROVED'] } },
    },
  });
  const eligible_phase_3 =
    totalLines >= READINESS_THRESHOLDS.phase_3.min_total_lines &&
    globalOperationDays >= READINESS_THRESHOLDS.phase_3.min_operation_days;

  // 8. 단계 산출 — "어느 단계까지 도달 가능한가"
  // 정책: 부서 절반 이상이 Phase N 자격이면 Phase N 진입 (한 부서만 충족하면 부분 활성)
  const eligibleP1 = perDept.filter(d => d.eligible_phase_1).length;
  const eligibleP2 = perDept.filter(d => d.eligible_phase_2).length;
  const half = Math.max(1, Math.ceil(perDept.length / 2));

  let level: ReadinessLevel = 'COLD_START';
  if (eligible_phase_3) level = 'PHASE_3';
  else if (eligibleP2 >= half) level = 'PHASE_2';
  else if (eligibleP1 >= half) level = 'PHASE_1';

  // 9. 다음 마일스톤 — 사람 친화 메시지
  let nextMilestone: string;
  if (level === 'COLD_START') {
    const closest = [...perDept]
      .filter(d => !d.eligible_phase_1)
      .sort((a, b) => {
        const aShort = Math.max(0, READINESS_THRESHOLDS.phase_1.min_requests - a.request_count);
        const bShort = Math.max(0, READINESS_THRESHOLDS.phase_1.min_requests - b.request_count);
        return aShort - bShort;
      })[0];
    if (closest) {
      const reqShort = Math.max(0, READINESS_THRESHOLDS.phase_1.min_requests - closest.request_count);
      const dayShort = Math.max(0, READINESS_THRESHOLDS.phase_1.min_operation_days - closest.operation_days);
      nextMilestone = `${closest.department_name} — 신청 ${reqShort}건, 운영 ${dayShort}일 더 필요 (PHASE_1 도달 임박)`;
    } else {
      nextMilestone = '부서가 없어 측정 불가';
    }
  } else if (level === 'PHASE_1') {
    nextMilestone = `PHASE_2 까지: 부서 절반(${half}개)이 운영 ${READINESS_THRESHOLDS.phase_2.min_operation_days}일 + 신청 ${READINESS_THRESHOLDS.phase_2.min_requests}건 충족 필요`;
  } else if (level === 'PHASE_2') {
    nextMilestone = `PHASE_3 까지: 전체 라인 ${totalLines}/${READINESS_THRESHOLDS.phase_3.min_total_lines}, 운영 ${globalOperationDays}/${READINESS_THRESHOLDS.phase_3.min_operation_days}일`;
  } else {
    nextMilestone = '최고 단계 도달 — 이상 탐지·LLM 파인튜닝 자격';
  }

  return {
    level,
    thresholds: READINESS_THRESHOLDS,
    global: {
      operation_days: globalOperationDays,
      total_lines: totalLines,
      eligible_phase_3,
    },
    per_dept: perDept,
    next_milestone: nextMilestone,
  };
}
