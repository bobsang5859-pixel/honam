import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { api } from '../utils/api';
import { PageHeader } from '../components/ui';
import {
  PieChart, Pie, Cell, Tooltip,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  AreaChart, Area,
} from 'recharts';
import {
  BigKpi, StatsKpiCard, StatsFilterBar, StatsTabBar,
  OverviewCard, MetricRow, ComparisonTable, ReportTable,
} from '../components/stats';

const CHART_COLORS = ['#0d9488', '#0891b2', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#6366f1', '#10b981', '#f97316', '#64748b'];

type StatsTab = 'all' | 'occupancy' | 'group' | 'insurance' | 'special' | 'period' | 'caregiver' | 'diaper' | 'hospital' | 'address' | 'referral' | 'discharge' | 'discharge_reason' | 'covered' | 'non_covered';

const ALL_TABS: { key: StatsTab; label: string }[] = [
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
  { key: 'discharge', label: '퇴원경로' },
  { key: 'discharge_reason', label: '퇴원사유' },
  { key: 'covered', label: '급여' },
  { key: 'non_covered', label: '비급여' },
];

// 섹션별 탭 필터
export type StatsSection = 'all' | 'operations' | 'info';
const SECTION_TABS: Record<StatsSection, StatsTab[]> = {
  all: ALL_TABS.map(t => t.key),
  operations: ['all', 'occupancy'],
  info: ['group', 'insurance', 'special', 'period', 'caregiver', 'diaper', 'hospital', 'address', 'referral', 'discharge', 'discharge_reason', 'covered', 'non_covered'],
};

const patientGroupLabel: Record<string, string> = { HIGHEST: '최고도', HIGH: '고도', MEDIUM: '중도', LOW: '경도', SELECT: '선택', UNRATED: '미평가' };
const insuranceLabel: Record<string, string> = { HEALTH: '건강보험', MEDICAL_1: '의료급여 1종', MEDICAL_2: '의료급여 2종', WORKERS_COMP: '산재보험', AUTO_INS: '자동차보험' };
const specializationLabel: Record<string, string> = { INFECT: '감염', DIALYSIS: '투석', REHAB: '재활' };
const periodLabel: Record<string, string> = { PNEUMONIA: '폐렴', SEPSIS: '패혈증' };
const diaperLabel: Record<string, string> = { IN_HOUSE: '원내', PERSONAL: '본인', NONE: '미사용', CIRCLE: '원내', TRIANGLE: '본인' };
const caregiverLabel: Record<string, string> = { CLOSE: '밀착간병', OUTSOURCED: '외주간병', IN_HOUSE: '본원간병', NONE: '없음' };
const infectionStrainLabel: Record<string, string> = { CRE: 'CRE', VRE: 'VRE', MR: 'MR' };

const mapLabel = (kind: StatsTab, key: string) => {
  if (kind === 'group') return patientGroupLabel[key] ?? key;
  if (kind === 'insurance') return insuranceLabel[key] ?? key;
  if (kind === 'special') return specializationLabel[key] ?? key;
  if (kind === 'period') return periodLabel[key] ?? key;
  if (kind === 'caregiver') return caregiverLabel[key] ?? key;
  if (kind === 'diaper') return diaperLabel[key] ?? key;
  return key;
};

/* ── 도넛 + 우측 범례 레이아웃 ── */
function DonutWithLegend({ data, dataKey = 'count', nameKey = 'name', height = 260 }: {
  data: { name: string; count?: number; value?: number }[];
  dataKey?: string;
  nameKey?: string;
  height?: number;
}) {
  const total = data.reduce((s, d) => s + ((d as any)[dataKey] || 0), 0);
  return (
    <div className="flex flex-col md:flex-row items-center gap-4">
      <div className="w-full md:w-1/2" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey={dataKey} nameKey={nameKey}
              cx="50%" cy="50%"
              innerRadius={55} outerRadius={90}
              paddingAngle={2}
            >
              {data.map((_: any, i: number) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Pie>
            <Tooltip formatter={(v: any) => `${Number(v).toLocaleString()}`} />
            {/* 중앙 텍스트 */}
            <text x="50%" y="46%" textAnchor="middle" style={{ fontSize: 20, fontWeight: 800, fill: '#1e293b' }}>
              {total.toLocaleString()}
            </text>
            <text x="50%" y="56%" textAnchor="middle" style={{ fontSize: 11, fill: '#94a3b8' }}>
              합계
            </text>
          </PieChart>
        </ResponsiveContainer>
      </div>
      {/* 우측 범례 */}
      <div className="w-full md:w-1/2 space-y-1.5">
        {data.map((d, i) => {
          const val = (d as any)[dataKey] || 0;
          const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0';
          return (
            <div key={d.name} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-gray-50 transition-colors">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                <span className="text-xs text-slate-600 truncate">{d.name}</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-slate-400">{pct}%</span>
                <span className="text-xs font-bold text-slate-700 w-12 text-right">{val.toLocaleString()}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BreakdownCard({ title, data, labelMap, excludeUnregistered }: { title: string; data: Record<string, number>; labelMap: Record<string, string>; excludeUnregistered?: boolean }) {
  const allRows = Object.entries(data || {}).map(([k, v]) => ({ name: labelMap[k] ?? k, count: Number(v) })).sort((a, b) => b.count - a.count);
  const rows = excludeUnregistered ? allRows.filter(r => r.name !== '미등록' && r.name !== '미입력') : allRows;
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <OverviewCard title={title}>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-4">데이터 없음</p>
      ) : rows.map((r, i) => {
        const pct = total > 0 ? ((r.count / total) * 100).toFixed(1) : '0';
        return (
          <div key={r.name} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
            <div className="flex items-center gap-2.5">
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
              <span className="text-sm text-slate-600">{r.name}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400">{pct}%</span>
              <span className="text-sm font-bold text-slate-700 w-12 text-right">{r.count}명</span>
            </div>
          </div>
        );
      })}
    </OverviewCard>
  );
}


export default function PatientStatsPage({ section = 'all' as StatsSection }: { section?: StatsSection }) {
  const visibleTabs = ALL_TABS.filter(t => SECTION_TABS[section].includes(t.key));
  const [tab, setTab] = useState<StatsTab>(visibleTabs[0]?.key || 'all');
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
                        : tab === 'discharge_reason' ? stats.breakdown.discharge_reason
                          : {};
    const allRows = Object.entries(src || {})
      .map(([k, v]) => ({ name: mapLabel(tab, k), count: Number(v || 0) }))
      .sort((a, b) => b.count - a.count);
    // 입원전병원/거주지/유입경로/퇴원경로/퇴원사유: "미등록"/"미입력" 분리
    const freeTextTabs: StatsTab[] = ['hospital', 'address', 'referral', 'discharge', 'discharge_reason'];
    if (freeTextTabs.includes(tab)) {
      return allRows.filter(r => r.name !== '미등록' && r.name !== '미입력');
    }
    return allRows;
  }, [stats, tab]);

  // 미등록 건수 (분리 표시용)
  const unregisteredCount = useMemo(() => {
    if (!stats?.breakdown) return 0;
    const freeTextTabs: StatsTab[] = ['hospital', 'address', 'referral', 'discharge', 'discharge_reason'];
    if (!freeTextTabs.includes(tab)) return 0;
    const src =
      tab === 'hospital' ? stats.breakdown.prev_hospital
        : tab === 'address' ? stats.breakdown.address
          : tab === 'referral' ? stats.breakdown.referral_source
            : tab === 'discharge' ? stats.breakdown.discharge_type
              : tab === 'discharge_reason' ? stats.breakdown.discharge_reason : {};
    return Number((src || {})['미등록'] ?? 0) + Number((src || {})['미입력'] ?? 0);
  }, [stats, tab]);


  return (
    <div className="space-y-4">
      {section === 'operations' && (
        <PageHeader icon={BarChart3} title="병상 운영지표" description="가동률 및 입퇴원 현황" />
      )}
      {section === 'info' && (
        <PageHeader icon={BarChart3} title="환자정보 통계" description="환자군·보험·특성화 등 분포 분석" />
      )}
      {section === 'all' && (
        <PageHeader icon={BarChart3} title="환자 통계" description="환자 현황 및 분석 통계" />
      )}

      {/* 핵심 KPI — 운영지표/전체에서만 표시 */}
      {section !== 'info' && stats?.overall && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <BigKpi label="총 입원자수" value={`${stats.overall.total_occupied}명`} color="teal"
            trend={stats.comparison?.admitted_count?.diff_pct} trendLabel="전기 대비" />
          <BigKpi label="평균 가동률" value={`${stats.overall.occupancy_rate}%`} color="blue"
            trend={stats.comparison?.occupancy_rate?.diff_pct} trendLabel="전기 대비" />
          <BigKpi label="입원건수" value={`${stats.overall.admitted_count}건`} color="green" />
          <BigKpi label="퇴원건수" value={`${stats.overall.discharged_count}건`} color="amber" />
        </div>
      )}

      {/* 탭 바 (pill 스타일) */}
      <StatsTabBar tabs={visibleTabs} active={tab} onChange={(k) => setTab(k as any)} />

      {/* 필터 바 */}
      <StatsFilterBar>
        <div>
          <label className="text-[11px] font-medium text-slate-500 block mb-1">시작일</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-teal-500" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-slate-500 block mb-1">종료일</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-teal-500" />
        </div>
        <button onClick={load}
          className="self-end px-4 py-1.5 bg-slate-800 text-white text-sm font-semibold rounded-lg hover:bg-slate-700 transition-colors">
          조회
        </button>
      </StatsFilterBar>

      {/* 콘텐츠 영역 */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="text-center py-16 text-red-500 text-sm">{error}</div>
      ) : !stats ? (
        <div className="text-center py-16 text-slate-400 text-sm">데이터 없음</div>
      ) : (
        <div>
          {/* ── 전체 ── */}
          {tab === 'all' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatsKpiCard label="총 정원" value={stats.overall.total_capacity} />
                <StatsKpiCard label="잔여병상" value={stats.overall.total_available} />
                <StatsKpiCard label="입원자수" value={stats.overall.total_occupied} />
                <StatsKpiCard label="평균 가동률" value={`${stats.overall.occupancy_rate}%`} />
              </div>

              <ComparisonTable items={[
                { label: '입원건수', current: stats.comparison?.admitted_count?.current ?? 0, previous: stats.comparison?.admitted_count?.previous ?? 0, diff_pct: stats.comparison?.admitted_count?.diff_pct ?? 0 },
                { label: '퇴원건수', current: stats.comparison?.discharged_count?.current ?? 0, previous: stats.comparison?.discharged_count?.previous ?? 0, diff_pct: stats.comparison?.discharged_count?.diff_pct ?? 0 },
                { label: '임종실', current: stats.comparison?.hospice_count?.current ?? 0, previous: stats.comparison?.hospice_count?.previous ?? 0, diff_pct: stats.comparison?.hospice_count?.diff_pct ?? 0 },
                { label: '평균재원일수', current: stats.comparison?.avg_los?.current ?? 0, previous: stats.comparison?.avg_los?.previous ?? 0, diff_pct: stats.comparison?.avg_los?.diff_pct ?? 0, unit: '일' },
                { label: '평균가동률', current: stats.comparison?.occupancy_rate?.current ?? 0, previous: stats.comparison?.occupancy_rate?.previous ?? 0, diff_pct: stats.comparison?.occupancy_rate?.diff_pct ?? 0, unit: '%' },
              ]} />

              <div className="grid md:grid-cols-2 gap-4">
                <BreakdownCard title="환자군 분포" data={stats.breakdown?.patient_group ?? {}} labelMap={patientGroupLabel} />
                <BreakdownCard title="보험유형 분포" data={stats.breakdown?.insurance_type ?? {}} labelMap={insuranceLabel} />
                <BreakdownCard title="특성화 현황" data={stats.breakdown?.specialization ?? {}} labelMap={specializationLabel} />
                <BreakdownCard title="간병유형 분포" data={stats.breakdown?.caregiver_type ?? {}} labelMap={caregiverLabel} />
                <BreakdownCard title="기저귀 현황" data={stats.breakdown?.diaper ?? {}} labelMap={diaperLabel} />
                <BreakdownCard title="특정기간 현황" data={stats.breakdown?.period_type ?? {}} labelMap={periodLabel} />
                <BreakdownCard title="감염균주 현황" data={stats.breakdown?.infection_strain ?? {}} labelMap={infectionStrainLabel} />
                <BreakdownCard title="입원전병원 분포" data={stats.breakdown?.prev_hospital ?? {}} labelMap={{}} excludeUnregistered />
              </div>
            </div>
          )}

          {/* ── 병상가동율 ── */}
          {tab === 'occupancy' && (() => {
            const daily = stats.occupancy?.daily || [];
            const depts = (stats.departments || []).map((d: any) => {
              const rate = d.capacity > 0 ? Number(((d.occupied / d.capacity) * 100).toFixed(1)) : 0;
              return { ...d, rate };
            }).sort((a: any, b: any) => b.rate - a.rate);
            const totalCapacity = depts.reduce((s: number, d: any) => s + d.capacity, 0);
            const totalOccupied = depts.reduce((s: number, d: any) => s + d.occupied, 0);
            return (
              <div className="space-y-5">
                {/* KPI 카드 */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <BigKpi label="평균 가동률" value={`${stats.occupancy?.average_rate ?? '-'}%`} color="blue"
                    trend={stats.comparison?.occupancy_rate?.diff_pct} trendLabel="전기 대비" />
                  <BigKpi label="평균 입원자수" value={`${stats.occupancy?.average_occupied ?? '-'}명`} color="teal" />
                  <BigKpi label="90% 이상" value={`${(stats.occupancy?.kpi_days?.gte_90 || []).length}일`} color="green" />
                  <BigKpi label="80% 이하" value={`${(stats.occupancy?.kpi_days?.lte_80 || []).length}일`} color="red" />
                </div>

                {/* 최고/최저일 */}
                <div className="grid md:grid-cols-2 gap-3">
                  {stats.occupancy?.kpi_days?.max_day && (
                    <OverviewCard title="최고 가동률일">
                      <MetricRow label="날짜" value={stats.occupancy.kpi_days.max_day.date} />
                      <MetricRow label="가동률" value={`${stats.occupancy.kpi_days.max_day.occupancy_rate}%`} />
                      <MetricRow label="입원자수" value={`${stats.occupancy.kpi_days.max_day.occupied}명`} />
                    </OverviewCard>
                  )}
                  {stats.occupancy?.kpi_days?.min_day && (
                    <OverviewCard title="최저 가동률일">
                      <MetricRow label="날짜" value={stats.occupancy.kpi_days.min_day.date} />
                      <MetricRow label="가동률" value={`${stats.occupancy.kpi_days.min_day.occupancy_rate}%`} />
                      <MetricRow label="입원자수" value={`${stats.occupancy.kpi_days.min_day.occupied}명`} />
                    </OverviewCard>
                  )}
                </div>

                {/* 일별 가동률 추이 차트 */}
                {daily.length > 0 && (
                  <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-bold text-slate-700">일별 가동률 추이</h3>
                      <span className="text-xs text-slate-400">평균 {stats.occupancy?.average_rate ?? '-'}%</span>
                    </div>
                    <div style={{ height: 240 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={daily.map((d: any) => ({
                          date: d.date?.slice(5) || '',
                          rate: d.occupancy_rate,
                          occupied: d.occupied,
                          capacity: d.capacity,
                        }))} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id="occGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                          <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false}
                            interval={Math.max(0, Math.floor(daily.length / 10))} />
                          <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false}
                            domain={[Math.max(0, Math.min(...daily.map((d: any) => d.occupancy_rate)) - 10), 100]}
                            tickFormatter={(v: number) => `${v}%`} />
                          <Tooltip
                            contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 4px 20px rgba(0,0,0,0.12)', padding: '10px 14px' }}
                            labelStyle={{ fontWeight: 700, marginBottom: 4 }}
                            formatter={(v: any, name: any) => [
                              name === 'rate' ? `${v}%` : `${v}명`,
                              name === 'rate' ? '가동률' : '입원자',
                            ]}
                          />
                          <Area type="monotone" dataKey="rate" stroke="#3b82f6" strokeWidth={2.5}
                            fill="url(#occGrad)" name="rate" dot={false} activeDot={{ r: 5, fill: '#3b82f6', stroke: '#fff', strokeWidth: 2 }} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* 병동별 가동률 비교 (가로 바 + 수치) */}
                {depts.length > 0 && (
                  <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                    <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                      <h3 className="text-sm font-bold text-slate-700">병동별 가동률</h3>
                      <span className="text-xs text-slate-400">전체 {totalOccupied}/{totalCapacity} ({totalCapacity > 0 ? ((totalOccupied / totalCapacity) * 100).toFixed(1) : 0}%)</span>
                    </div>
                    <div className="divide-y divide-gray-50">
                      {depts.map((d: any) => (
                        <div key={d.department_id} className="px-5 py-3 flex items-center gap-4">
                          <span className="text-sm font-medium text-slate-700 w-20 flex-shrink-0">{d.department_name}</span>
                          <div className="flex-1 min-w-0">
                            <div className="h-6 bg-gray-100 rounded-full overflow-hidden relative">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  d.rate >= 90 ? 'bg-emerald-500' : d.rate >= 70 ? 'bg-blue-500' : d.rate >= 50 ? 'bg-amber-500' : 'bg-red-400'
                                }`}
                                style={{ width: `${Math.min(d.rate, 100)}%` }}
                              />
                              {d.rate > 15 && (
                                <span className="absolute inset-0 flex items-center px-3 text-[11px] font-bold text-white">
                                  {d.rate}%
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex-shrink-0 text-right w-24">
                            <span className="text-sm font-bold text-slate-700">{d.occupied}</span>
                            <span className="text-xs text-slate-400">/{d.capacity}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── 단일 분포 탭 (도넛+범례 + 테이블) ── */}
          {(['group', 'insurance', 'special', 'caregiver', 'period', 'hospital'] as StatsTab[]).includes(tab) && (
            <div className="space-y-4">
              {unregisteredCount > 0 && (
                <div className="px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-700">
                  미등록 <strong>{unregisteredCount}명</strong>은 통계에서 제외됩니다. 환자관리에서 데이터를 입력하면 통계에 반영됩니다.
                </div>
              )}
              {rowsForBreakdown.length > 0 && (
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                  <h3 className="text-sm font-bold text-slate-700 mb-4">{ALL_TABS.find(t => t.key === tab)?.label} 분포</h3>
                  <DonutWithLegend data={rowsForBreakdown} />
                </div>
              )}

              <ReportTable
                columns={[
                  { key: 'name', label: '항목' },
                  { key: 'count', label: '인원', align: 'right' as const, render: (v: number) => `${v}명` },
                  { key: 'pct', label: '비중', align: 'right' as const },
                ]}
                data={(() => {
                  const total = rowsForBreakdown.reduce((s, r) => s + r.count, 0);
                  return rowsForBreakdown.map(r => ({ ...r, pct: total > 0 ? `${((r.count / total) * 100).toFixed(1)}%` : '-' }));
                })()}
                footer={(() => {
                  const total = rowsForBreakdown.reduce((s, r) => s + r.count, 0);
                  return { name: '합계', count: `${total}명`, pct: '100%' };
                })()}
              />
            </div>
          )}

          {/* ── 거주지 (바 차트) ── */}
          {tab === 'address' && (
            <div className="space-y-4">
              {unregisteredCount > 0 && (
                <div className="px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-700">
                  미등록 <strong>{unregisteredCount}명</strong>은 통계에서 제외됩니다.
                </div>
              )}
              {rowsForBreakdown.length > 0 && (
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                  <h3 className="text-sm font-bold text-slate-700 mb-3">거주지별 분포</h3>
                  <div style={{ height: 280 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={rowsForBreakdown.slice(0, 15)} layout="vertical" margin={{ left: 80 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis type="number" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#64748b' }} width={75} />
                        <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0' }} />
                        <Bar dataKey="count" fill="#0d9488" name="인원" radius={[0, 6, 6, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
              <ReportTable
                columns={[
                  { key: 'name', label: '거주지' },
                  { key: 'count', label: '인원', align: 'right' as const, render: (v: number) => `${v}명` },
                ]}
                data={rowsForBreakdown}
              />
            </div>
          )}

          {/* ── 유입경로 / 퇴원경로 / 퇴원사유 ── */}
          {(['referral', 'discharge', 'discharge_reason'] as StatsTab[]).includes(tab) && (
            <div className="space-y-4">
              {unregisteredCount > 0 && (
                <div className="px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-700">
                  미등록 <strong>{unregisteredCount}명</strong>은 통계에서 제외됩니다.
                </div>
              )}
              {rowsForBreakdown.length > 0 && (
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                  <h3 className="text-sm font-bold text-slate-700 mb-4">{ALL_TABS.find(t => t.key === tab)?.label} 분포</h3>
                  <DonutWithLegend data={rowsForBreakdown} />
                </div>
              )}
              <ReportTable
                columns={[
                  { key: 'name', label: ALL_TABS.find(t => t.key === tab)?.label || '항목' },
                  { key: 'count', label: '건수', align: 'right' as const },
                ]}
                data={rowsForBreakdown}
              />
            </div>
          )}

          {/* ── 급여 / 비급여 ── */}
          {(tab === 'covered' || tab === 'non_covered') && (() => {
            const chargeData = tab === 'covered' ? stats?.charges?.covered : stats?.charges?.non_covered;
            const rows = Object.entries(chargeData || {}).map(([name, v]: [string, any]) => ({
              name, total: v.total || 0, count: v.count || 0, avg: v.count > 0 ? Math.round(v.total / v.count) : 0,
            })).sort((a, b) => b.total - a.total);
            const grandTotal = rows.reduce((s, r) => s + r.total, 0);
            const donutData = rows.map(r => ({ name: r.name, count: r.total }));
            return (
              <div className="space-y-4">
                {donutData.length > 0 && (
                  <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                    <h3 className="text-sm font-bold text-slate-700 mb-4">{tab === 'covered' ? '급여' : '비급여'} 항목별 금액</h3>
                    <DonutWithLegend data={donutData} />
                  </div>
                )}
                <ReportTable
                  title={tab === 'covered' ? '급여 항목 상세' : '비급여 항목 상세'}
                  columns={[
                    { key: 'name', label: '항목' },
                    { key: 'total', label: '총액', align: 'right' as const, render: (v: number) => `₩${v.toLocaleString()}` },
                    { key: 'count', label: '건수', align: 'right' as const },
                    { key: 'avg', label: '건당 평균', align: 'right' as const, render: (v: number) => `₩${v.toLocaleString()}` },
                  ]}
                  data={rows}
                  footer={{ name: '합계', total: `₩${grandTotal.toLocaleString()}`, count: '', avg: '' }}
                />
              </div>
            );
          })()}

          {/* ── 기저귀 ── */}
          {tab === 'diaper' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <BigKpi label="원내" value={`${stats?.diaper_analysis?.usage_counts?.in_house ?? 0}명`} color="teal" />
                <BigKpi label="본인" value={`${stats?.diaper_analysis?.usage_counts?.personal ?? 0}명`} color="blue" />
                <BigKpi label="미사용" value={`${stats?.diaper_analysis?.usage_counts?.none ?? 0}명`} color="slate" />
                <BigKpi label="원내 금액 합계" value={`₩${Number(stats?.diaper_analysis?.billing?.in_house_total_amount ?? 0).toLocaleString()}`} color="amber" />
              </div>

              {rowsForBreakdown.length > 0 && (
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                  <h3 className="text-sm font-bold text-slate-700 mb-4">기저귀 유형 분포</h3>
                  <DonutWithLegend data={rowsForBreakdown} height={220} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
