// 비용·낭비 분석 — 총무부 전용 (PURCHASE_MANAGE).
// 병동 메뉴엔 안 보임. 부서별 사용 패턴·자동 사유·비용 누계 표시.
//
// v1: 표 형태로 부서별 통계.
// v2 (Step 8 후): 자연어 리포트, Q&A.

import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';

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
  anomaly_pct: number;
};

type DashboardData = {
  period_months: number;
  since: string;
  department_stats: DeptStat[];
  summary: {
    total_departments: number;
    total_lines: number;
    total_cost: number;
    total_anomaly: number;
  };
  model_status: { exists: boolean; samples: number; version: string | null };
};

type ReadinessLevel = 'COLD_START' | 'PHASE_1' | 'PHASE_2' | 'PHASE_3';

type PerDeptReadiness = {
  department_id: string;
  department_name: string;
  operation_days: number;
  request_count: number;
  item_coverage: number;
  stockout_count: number;
  eligible_phase_1: boolean;
  eligible_phase_2: boolean;
};

type DataReadiness = {
  level: ReadinessLevel;
  thresholds: {
    phase_1: { min_operation_days: number; min_requests: number; min_item_coverage: number; min_stockouts: number };
    phase_2: { min_operation_days: number; min_requests: number; min_item_coverage: number };
    phase_3: { min_total_lines: number; min_operation_days: number };
  };
  global: { operation_days: number; total_lines: number; eligible_phase_3: boolean };
  per_dept: PerDeptReadiness[];
  next_milestone: string;
};

const LEVEL_LABEL: Record<ReadinessLevel, string> = {
  COLD_START: '데이터 누적 중 (가이드라인 100%)',
  PHASE_1: 'PHASE 1 — 부서별 평균 패턴 분석 가능',
  PHASE_2: 'PHASE 2 — 학습 가중치 자동 적용',
  PHASE_3: 'PHASE 3 — 이상 탐지·LLM 자격',
};

const LEVEL_BADGE_CLS: Record<ReadinessLevel, string> = {
  COLD_START: 'bg-slate-100 text-slate-600 border-slate-300',
  PHASE_1: 'bg-blue-50 text-blue-700 border-blue-300',
  PHASE_2: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  PHASE_3: 'bg-purple-50 text-purple-700 border-purple-300',
};

export default function CostAnalysisPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState(3);
  const [readiness, setReadiness] = useState<DataReadiness | null>(null);

  useEffect(() => {
    setLoading(true);
    api(`/cost-analysis/dashboard?months=${months}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [months]);

  useEffect(() => {
    api('/cost-analysis/data-readiness')
      .then(setReadiness)
      .catch(() => setReadiness(null));
  }, []);

  // 추천 활성 상태
  const [inferenceEnabled, setInferenceEnabled] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);
  useEffect(() => {
    api('/cost-analysis/inference-status')
      .then((r: any) => setInferenceEnabled(Boolean(r.enabled)))
      .catch(() => setInferenceEnabled(false));
  }, []);

  const handleToggleInference = async () => {
    if (inferenceEnabled === null) return;
    const next = !inferenceEnabled;
    const msg = next
      ? '추천을 활성화합니다. 모든 부서의 신청 화면에 가이드라인 기반 권장량이 표시됩니다. 진행할까요?'
      : '추천을 비활성화합니다. 신청 화면에 권장량이 표시되지 않습니다. 진행할까요?';
    if (!confirm(msg)) return;
    setToggling(true);
    try {
      await api('/cost-analysis/inference-toggle', {
        method: 'POST',
        body: JSON.stringify({ enabled: next }),
      });
      setInferenceEnabled(next);
    } catch (e: any) {
      alert(e.message ?? '토글 실패');
    } finally {
      setToggling(false);
    }
  };

  const fmt = (n: number) => n.toLocaleString('ko-KR');

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">비용·낭비 분석</h1>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={months}
          onChange={(e) => setMonths(Number(e.target.value))}
        >
          <option value={1}>최근 1개월</option>
          <option value={3}>최근 3개월</option>
          <option value={6}>최근 6개월</option>
          <option value={12}>최근 12개월</option>
        </select>
      </div>

      {/* 학습 데이터 충분성 패널 */}
      {readiness && (
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b flex items-center justify-between bg-slate-50">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">학습 데이터 상태</span>
              <span className={`text-xs px-2 py-0.5 rounded border ${LEVEL_BADGE_CLS[readiness.level]}`}>
                {LEVEL_LABEL[readiness.level]}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded border ${
                inferenceEnabled === true ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                : inferenceEnabled === false ? 'bg-slate-100 text-slate-500 border-slate-300'
                : 'bg-slate-50 text-slate-400 border-slate-200'
              }`}>
                추천 {inferenceEnabled === null ? '...' : inferenceEnabled ? 'ON' : 'OFF'}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-500">
                운영 {readiness.global.operation_days}일 · 누적 라인 {fmt(readiness.global.total_lines)}건
              </span>
              {inferenceEnabled !== null && (
                <button
                  onClick={handleToggleInference}
                  disabled={toggling}
                  className={`px-3 py-1 text-xs font-semibold rounded border transition-colors ${
                    inferenceEnabled
                      ? 'bg-white text-red-600 border-red-300 hover:bg-red-50'
                      : 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                  } disabled:opacity-50`}
                  title={inferenceEnabled
                    ? '추천을 끕니다. 신청 화면에 권장량 표시 안 됨.'
                    : '데이터가 충분히 쌓였다고 판단되면 클릭. 모든 부서 신청 화면에 권장량 표시 시작.'}
                >
                  {toggling ? '처리 중...' : inferenceEnabled ? '추천 중지' : '추천 시작'}
                </button>
              )}
            </div>
          </div>
          <div className="px-4 py-2 text-xs text-slate-600 border-b bg-amber-50/50">
            다음 마일스톤: {readiness.next_milestone}
          </div>
          {readiness.per_dept.length > 0 && (
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-1.5">부서</th>
                  <th className="text-right px-3 py-1.5">운영일</th>
                  <th className="text-right px-3 py-1.5">신청건수</th>
                  <th className="text-right px-3 py-1.5">품목 커버리지</th>
                  <th className="text-right px-3 py-1.5">불출건수</th>
                  <th className="text-center px-3 py-1.5">P1</th>
                  <th className="text-center px-3 py-1.5">P2</th>
                </tr>
              </thead>
              <tbody>
                {readiness.per_dept
                  .filter(d => d.request_count > 0 || d.stockout_count > 0)
                  .sort((a, b) => b.request_count - a.request_count)
                  .map(d => (
                    <tr key={d.department_id} className="border-t">
                      <td className="px-3 py-1">{d.department_name}</td>
                      <td className={`text-right px-3 py-1 ${d.operation_days >= readiness.thresholds.phase_1.min_operation_days ? 'text-emerald-600' : 'text-slate-400'}`}>
                        {d.operation_days}/{readiness.thresholds.phase_1.min_operation_days}
                      </td>
                      <td className={`text-right px-3 py-1 ${d.request_count >= readiness.thresholds.phase_1.min_requests ? 'text-emerald-600' : 'text-slate-400'}`}>
                        {d.request_count}/{readiness.thresholds.phase_1.min_requests}
                      </td>
                      <td className={`text-right px-3 py-1 ${d.item_coverage >= readiness.thresholds.phase_1.min_item_coverage ? 'text-emerald-600' : 'text-slate-400'}`}>
                        {d.item_coverage}/{readiness.thresholds.phase_1.min_item_coverage}
                      </td>
                      <td className={`text-right px-3 py-1 ${d.stockout_count >= readiness.thresholds.phase_1.min_stockouts ? 'text-emerald-600' : 'text-slate-400'}`}>
                        {d.stockout_count}/{readiness.thresholds.phase_1.min_stockouts}
                      </td>
                      <td className="text-center px-3 py-1">
                        {d.eligible_phase_1 ? <span className="text-emerald-600 font-bold">✓</span> : <span className="text-slate-300">·</span>}
                      </td>
                      <td className="text-center px-3 py-1">
                        {d.eligible_phase_2 ? <span className="text-emerald-600 font-bold">✓</span> : <span className="text-slate-300">·</span>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {loading && <div className="text-sm text-slate-500">불러오는 중...</div>}

      {data && (
        <>
          {/* 요약 카드 */}
          <div className="grid grid-cols-4 gap-3">
            <SummaryCard label="대상 부서" value={`${data.summary.total_departments}개`} />
            <SummaryCard label="총 라인" value={fmt(data.summary.total_lines)} />
            <SummaryCard label="총 비용" value={`${fmt(data.summary.total_cost)}원`} />
            <SummaryCard
              label="이상 패턴 라인"
              value={fmt(data.summary.total_anomaly)}
              alert={data.summary.total_anomaly > 0}
            />
          </div>

          {/* 모델 상태 */}
          <div className="text-xs text-slate-500 border-l-2 border-slate-300 pl-3 py-1">
            {data.model_status.exists ? (
              <>자체 추론 모델 활성 — 학습 샘플 {fmt(data.model_status.samples)}건 (v{data.model_status.version})</>
            ) : (
              <>자체 추론 모델 미학습 — 룰 기반 100% 동작 중. 데이터 누적 후 자동 활성화 (Step 8).</>
            )}
          </div>

          {/* 부서별 표 */}
          <div className="bg-white border rounded-lg overflow-hidden">
            <div className="px-4 py-2 border-b text-sm font-medium">부서별 사용 패턴</div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2">부서</th>
                  <th className="text-right px-3 py-2">라인 수</th>
                  <th className="text-right px-3 py-2">비용</th>
                  <th className="text-right px-3 py-2">정상</th>
                  <th className="text-right px-3 py-2">이상</th>
                  <th className="text-right px-3 py-2">과소</th>
                  <th className="text-right px-3 py-2">매핑X</th>
                  <th className="text-right px-3 py-2">이상 비율</th>
                </tr>
              </thead>
              <tbody>
                {data.department_stats.map((s) => (
                  <tr key={s.department_id} className="border-t">
                    <td className="px-3 py-2">{s.department_name}</td>
                    <td className="text-right px-3 py-2">{fmt(s.total_lines)}</td>
                    <td className="text-right px-3 py-2">{fmt(s.total_cost)}원</td>
                    <td className="text-right px-3 py-2 text-green-600">{fmt(s.normal_lines)}</td>
                    <td className={`text-right px-3 py-2 ${s.anomaly_lines > 0 ? 'text-red-600 font-semibold' : 'text-slate-400'}`}>
                      {fmt(s.anomaly_lines)}
                    </td>
                    <td className={`text-right px-3 py-2 ${s.under_usage_lines > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
                      {fmt(s.under_usage_lines)}
                    </td>
                    <td className="text-right px-3 py-2 text-slate-400">{fmt(s.no_inference_lines)}</td>
                    <td className={`text-right px-3 py-2 ${s.anomaly_pct > 20 ? 'text-red-600 font-semibold' : ''}`}>
                      {s.anomaly_pct}%
                    </td>
                  </tr>
                ))}
                {data.department_stats.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-center px-3 py-6 text-slate-400">
                      이 기간 승인된 신청이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={`bg-white border rounded-lg p-3 ${alert ? 'border-red-300' : ''}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-lg font-semibold ${alert ? 'text-red-600' : ''}`}>{value}</div>
    </div>
  );
}
