import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { api } from '../utils/api';
import { PageHeader } from '../components/ui';
import {
  PieChart, Pie, Cell, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { StatsKpiCard, StatsChartCard, StatsTableCard, StatsFilterBar, StatsTabBar } from '../components/stats';

const CHART_COLORS = ['#0d9488', '#0891b2', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#6366f1', '#10b981', '#f97316', '#64748b'];

type StatsTab = 'all' | 'occupancy' | 'group' | 'insurance' | 'special' | 'period' | 'caregiver' | 'diaper' | 'hospital' | 'address' | 'referral' | 'discharge';

const TABS: { key: StatsTab; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'occupancy', label: '병상가동율' },
  { key: 'group', label: '환자군' },
  { key: 'insurance', label: '보험유형' },
  { key: 'special', label: '특성화' },
  { key: 'period', label: '특정기간' },
  { key: 'caregiver', label: '간병유형' },
  { key: 'diaper', label: '기저귀' },
  { key: 'hospital', label: '입원전병원' },
  { key: 'address', label: '거주지' },
  { key: 'referral', label: '유입경로' },
  { key: 'discharge', label: '퇴원유형' },
];

const patientGroupLabel: Record<string, string> = {
  HIGHEST: '최고도',
  HIGH: '고도',
  MEDIUM: '중도',
  LOW: '경도',
  SELECT: '선택',
  UNRATED: '미평가',
};

const insuranceLabel: Record<string, string> = {
  HEALTH: '건강보험 (일반)',
  HEALTH_REDUCED_SEVERE: '건강보험 본인부담경감 (중증질환)',
  HEALTH_REDUCED_RARE: '건강보험 본인부담경감 (희귀난치성)',
  MEDICAL_1: '의료급여 1종',
  MEDICAL_2: '의료급여 2종',
  WORKERS_COMP: '산재보험',
  AUTO_INS: '자동차보험',
};

const specializationLabel: Record<string, string> = {
  INFECT: '감염',
  DIALYSIS: '투석',
  REHAB: '재활',
};

const periodLabel: Record<string, string> = {
  PNEUMONIA: '폐렴',
  SEPSIS: '패혈증',
};

const diaperLabel: Record<string, string> = {
  IN_HOUSE: '원내',
  PERSONAL: '본인',
  NONE: '미사용',
  CIRCLE: '원내',
  TRIANGLE: '본인',
};

const caregiverLabel: Record<string, string> = {
  CLOSE: '밀착간병',
  OUTSOURCED: '외주간병',
  IN_HOUSE: '본원간병',
  NONE: '간병유형 없음',
};

const infectionStrainLabel: Record<string, string> = {
  CRE: 'CRE',
  VRE: 'VRE',
  MR: 'MR',
};

const mapLabel = (kind: StatsTab, key: string) => {
  if (kind === 'group') return patientGroupLabel[key] ?? key;
  if (kind === 'insurance') return insuranceLabel[key] ?? key;
  if (kind === 'special') return specializationLabel[key] ?? key;
  if (kind === 'period') return periodLabel[key] ?? key;
  if (kind === 'caregiver') return caregiverLabel[key] ?? key;
  if (kind === 'diaper') return diaperLabel[key] ?? key;
  return key;
};


function BreakdownTable({ title, data, labelMap }: { title: string; data: Record<string, number>; labelMap: Record<string, string> }) {
  const rows = Object.entries(data || {})
    .map(([k, v]) => ({ name: labelMap[k] ?? k, count: Number(v) }))
    .sort((a, b) => b.count - a.count);
  return (
    <div className="border rounded-lg p-3">
      <p className="text-xs font-semibold text-slate-600 mb-2">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-400">데이터 없음</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {rows.map(r => (
              <tr key={r.name} className="border-b last:border-0">
                <td className="py-1 text-slate-600">{r.name}</td>
                <td className="py-1 text-right font-semibold">{r.count}명</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function PatientStatsPage() {
  const [tab, setTab] = useState<StatsTab>('all');
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 7) + '-01');
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<any>(null);


  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ date_from: from, date_to: to });
      const data = await api(`/patients/stats?${p.toString()}`);
      setStats(data);
    } catch (e: any) {
      setError(e.message || '통계를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rowsForBreakdown = useMemo(() => {
    if (!stats?.breakdown) return [] as { name: string; count: number }[];
    const src =
      tab === 'group' ? stats.breakdown.patient_group
        : tab === 'insurance' ? stats.breakdown.insurance_type
          : tab === 'special' ? stats.breakdown.specialization
            : tab === 'period' ? stats.breakdown.period_type
              : tab === 'caregiver' ? stats.breakdown.caregiver_type
              : tab === 'diaper' ? stats.breakdown.diaper
                : tab === 'hospital' ? stats.breakdown.prev_hospital
                  : tab === 'address' ? stats.breakdown.address
                    : tab === 'referral' ? stats.breakdown.referral_source
                      : tab === 'discharge' ? stats.breakdown.discharge_type
                        : {};
    return Object.entries(src || {})
      .map(([k, v]) => ({ name: mapLabel(tab, k), count: Number(v || 0) }))
      .sort((a, b) => b.count - a.count);
  }, [stats, tab]);


  return (
    <div className="space-y-3">
      <PageHeader icon={BarChart3} title="환자 통계" description="환자 현황 및 분석 통계" />
      {/* KPI 헤더 바 */}
      {stats?.overall && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatsKpiCard label="총 입원자수" value={`${stats.overall.total_occupied}명`} />
          <StatsKpiCard label="평균 가동률" value={`${stats.overall.occupancy_rate}%`} />
          <StatsKpiCard label="기간 입원건수" value={`${stats.overall.admitted_count}건`} />
          <StatsKpiCard label="기간 퇴원건수" value={`${stats.overall.discharged_count}건`} />
        </div>
      )}

      <StatsTabBar tabs={TABS} active={tab} onChange={(k) => setTab(k as any)} />

      <StatsFilterBar>
        <div><label className="label">시작일</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input w-40" /></div>
        <div><label className="label">종료일</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input w-40" /></div>
        <button onClick={load} className="btn-secondary self-end">조회</button>
      </StatsFilterBar>

      <div className="bg-white rounded-xl border border-gray-100 shadow-card p-5 text-sm">
        {loading ? (
          <div className="text-center py-10 text-slate-400">로딩 중...</div>
        ) : error ? (
          <div className="text-center py-10 text-red-500">{error}</div>
        ) : !stats ? (
          <div className="text-center py-10 text-slate-400">데이터 없음</div>
        ) : (
          <>
            {tab === 'all' && (
              <div className="space-y-3">
                <div className="grid md:grid-cols-4 gap-3">
                  <div className="stat-card"><p className="text-xs text-slate-500">총 정원</p><p className="text-xl font-bold">{stats.overall.total_capacity}</p></div>
                  <div className="stat-card"><p className="text-xs text-slate-500">총 잔여병상</p><p className="text-xl font-bold">{stats.overall.total_available}</p></div>
                  <div className="stat-card"><p className="text-xs text-slate-500">총 입원자수</p><p className="text-xl font-bold">{stats.overall.total_occupied}</p></div>
                  <div className="stat-card"><p className="text-xs text-slate-500">평균 가동률</p><p className="text-xl font-bold">{stats.overall.occupancy_rate}%</p></div>
                </div>
                <table className="tbl">
                  <thead><tr><th>지표</th><th>현재</th><th>직전</th><th>증감률</th></tr></thead>
                  <tbody>
                    <tr><td>입원건수</td><td>{stats?.comparison?.admitted_count?.current ?? 0}</td><td>{stats?.comparison?.admitted_count?.previous ?? 0}</td><td>{stats?.comparison?.admitted_count?.diff_pct ?? 0}%</td></tr>
                    <tr><td>퇴원건수</td><td>{stats?.comparison?.discharged_count?.current ?? 0}</td><td>{stats?.comparison?.discharged_count?.previous ?? 0}</td><td>{stats?.comparison?.discharged_count?.diff_pct ?? 0}%</td></tr>
                    <tr><td>사망건수</td><td>{stats?.comparison?.deceased_count?.current ?? 0}</td><td>{stats?.comparison?.deceased_count?.previous ?? 0}</td><td>{stats?.comparison?.deceased_count?.diff_pct ?? 0}%</td></tr>
                    <tr><td>평균재원일수</td><td>{stats?.comparison?.avg_los?.current ?? 0}</td><td>{stats?.comparison?.avg_los?.previous ?? 0}</td><td>{stats?.comparison?.avg_los?.diff_pct ?? 0}%</td></tr>
                    <tr><td>평균가동률</td><td>{stats?.comparison?.occupancy_rate?.current ?? 0}%</td><td>{stats?.comparison?.occupancy_rate?.previous ?? 0}%</td><td>{stats?.comparison?.occupancy_rate?.diff_pct ?? 0}%</td></tr>
                  </tbody>
                </table>

                {/* breakdown 분포표 2열 그리드 */}
                <div className="grid md:grid-cols-2 gap-3">
                  <BreakdownTable title="환자군 분포" data={stats.breakdown?.patient_group ?? {}} labelMap={patientGroupLabel} />
                  <BreakdownTable title="보험유형 분포" data={stats.breakdown?.insurance_type ?? {}} labelMap={insuranceLabel} />
                  <BreakdownTable title="특성화 현황" data={stats.breakdown?.specialization ?? {}} labelMap={specializationLabel} />
                  <BreakdownTable title="간병유형 분포" data={stats.breakdown?.caregiver_type ?? {}} labelMap={caregiverLabel} />
                  <BreakdownTable title="기저귀 현황" data={stats.breakdown?.diaper ?? {}} labelMap={diaperLabel} />
                  <BreakdownTable title="특정기간 현황" data={stats.breakdown?.period_type ?? {}} labelMap={periodLabel} />
                  <BreakdownTable title="감염균주 현황" data={stats.breakdown?.infection_strain ?? {}} labelMap={infectionStrainLabel} />
                  <BreakdownTable title="입원전병원 분포" data={stats.breakdown?.prev_hospital ?? {}} labelMap={{}} />
                </div>
              </div>
            )}

            {tab === 'occupancy' && (
              <div className="space-y-2">
                <div className="text-xs text-slate-600">
                  90% 이상: {(stats?.occupancy?.kpi_days?.gte_90 || []).join(', ') || '-'}<br />
                  80% 이하: {(stats?.occupancy?.kpi_days?.lte_80 || []).join(', ') || '-'}
                </div>
                <table className="tbl">
                  <thead><tr><th>병동</th><th>환자명</th><th>환자 수</th><th>합계(정원)</th></tr></thead>
                  <tbody>
                    {(stats.departments || []).map((d: any) => (
                      <tr key={d.department_id}>
                        <td>{d.department_name}</td>
                        <td className="text-xs">{(d.patients || []).map((p: any) => p.name).join(', ') || '-'}</td>
                        <td>{d.occupied}</td>
                        <td>{d.occupied}/{d.capacity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {(['group', 'insurance', 'special', 'caregiver'] as StatsTab[]).includes(tab) && (
              <table className="tbl">
                <thead><tr><th>항목</th><th>인원</th></tr></thead>
                <tbody>
                  {rowsForBreakdown.length === 0 ? (
                    <tr><td colSpan={2} className="text-center text-slate-400">데이터 없음</td></tr>
                  ) : rowsForBreakdown.map((r) => (
                    <tr key={r.name}><td>{r.name}</td><td>{r.count}</td></tr>
                  ))}
                </tbody>
              </table>
            )}

            {tab === 'period' && (
              <table className="tbl">
                <thead><tr><th>항목</th><th>인원</th></tr></thead>
                <tbody>
                  {rowsForBreakdown.length === 0 ? (
                    <tr><td colSpan={2} className="text-center text-slate-400">데이터 없음</td></tr>
                  ) : rowsForBreakdown.map((r) => (
                    <tr key={r.name}><td>{r.name}</td><td>{r.count}</td></tr>
                  ))}
                </tbody>
              </table>
            )}

            {tab === 'hospital' && (
              <table className="tbl">
                <thead><tr><th>입원전 병원</th><th>인원</th></tr></thead>
                <tbody>
                  {rowsForBreakdown.length === 0 ? (
                    <tr><td colSpan={2} className="text-center text-slate-400">데이터 없음</td></tr>
                  ) : rowsForBreakdown.map((r) => (
                    <tr key={r.name}><td>{r.name}</td><td>{r.count}</td></tr>
                  ))}
                </tbody>
              </table>
            )}

            {tab === 'address' && (
              <div className="space-y-4">
                {rowsForBreakdown.length > 0 && (
                  <StatsChartCard title="거주지별 분포">
                    <BarChart data={rowsForBreakdown.slice(0, 15)}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={60} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="count" fill="#0d9488" name="인원" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </StatsChartCard>
                )}
                <table className="tbl">
                  <thead><tr><th>거주지</th><th>인원</th></tr></thead>
                  <tbody>
                    {rowsForBreakdown.length === 0 ? (
                      <tr><td colSpan={2} className="text-center text-slate-400">데이터 없음</td></tr>
                    ) : rowsForBreakdown.map((r) => (
                      <tr key={r.name}><td>{r.name}</td><td>{r.count}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'referral' && (
              <div className="space-y-4">
                {rowsForBreakdown.length > 0 && (
                  <StatsChartCard title="분포">
                      <PieChart>
                        <Pie data={rowsForBreakdown} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={100}
                          label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`}>
                          {rowsForBreakdown.map((_: any, i: number) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                        </Pie>
                        <Tooltip />
                        <Legend />
                      </PieChart>
                  </StatsChartCard>
                )}
                <table className="tbl">
                  <thead><tr><th>유입경로</th><th>인원</th></tr></thead>
                  <tbody>
                    {rowsForBreakdown.length === 0 ? (
                      <tr><td colSpan={2} className="text-center text-slate-400">데이터 없음</td></tr>
                    ) : rowsForBreakdown.map((r) => (
                      <tr key={r.name}><td>{r.name}</td><td>{r.count}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'discharge' && (
              <div className="space-y-4">
                {rowsForBreakdown.length > 0 && (
                  <StatsChartCard title="분포">
                      <PieChart>
                        <Pie data={rowsForBreakdown} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={100}
                          label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`}>
                          {rowsForBreakdown.map((_: any, i: number) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                        </Pie>
                        <Tooltip />
                        <Legend />
                      </PieChart>
                  </StatsChartCard>
                )}
                <table className="tbl">
                  <thead><tr><th>퇴원유형</th><th>인원</th></tr></thead>
                  <tbody>
                    {rowsForBreakdown.length === 0 ? (
                      <tr><td colSpan={2} className="text-center text-slate-400">데이터 없음</td></tr>
                    ) : rowsForBreakdown.map((r) => (
                      <tr key={r.name}><td>{r.name}</td><td>{r.count}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'diaper' && (
              <div className="space-y-3">
                <div className="grid md:grid-cols-4 gap-3">
                  <div className="stat-card"><p className="text-xs text-slate-500">원내</p><p className="text-xl font-bold">{stats?.diaper_analysis?.usage_counts?.in_house ?? 0}</p></div>
                  <div className="stat-card"><p className="text-xs text-slate-500">본인</p><p className="text-xl font-bold">{stats?.diaper_analysis?.usage_counts?.personal ?? 0}</p></div>
                  <div className="stat-card"><p className="text-xs text-slate-500">미사용</p><p className="text-xl font-bold">{stats?.diaper_analysis?.usage_counts?.none ?? 0}</p></div>
                  <div className="stat-card"><p className="text-xs text-slate-500">원내 금액 합계</p><p className="text-xl font-bold">{Number(stats?.diaper_analysis?.billing?.in_house_total_amount ?? 0).toLocaleString()}원</p></div>
                </div>

              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
