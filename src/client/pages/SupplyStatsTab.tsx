import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { useToast } from '../components/Toast';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import { BigKpi, OverviewCard, MetricRow, StatsChartCard, ReportTable } from '../components/stats';

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

/* ── 도넛 + 우측 범례 레이아웃 ── */
function DonutWithLegend({ data, height = 240 }: { data: { name: string; value: number }[]; height?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="flex flex-col md:flex-row items-center gap-4">
      <div className="w-full md:w-1/2" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
              {data.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip formatter={(v: any) => `₩${Number(v).toLocaleString()}`} />
            <text x="50%" y="46%" textAnchor="middle" style={{ fontSize: 18, fontWeight: 800, fill: '#1e293b' }}>
              {data.length}
            </text>
            <text x="50%" y="56%" textAnchor="middle" style={{ fontSize: 11, fill: '#94a3b8' }}>
              {total > 0 ? '합계' : ''}
            </text>
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="w-full md:w-1/2 space-y-1">
        {data.map((d, i) => {
          const pct = total > 0 ? ((d.value / total) * 100).toFixed(1) : '0';
          return (
            <div key={d.name} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-gray-50 transition-colors">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                <span className="text-xs text-slate-600 truncate">{d.name}</span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-slate-400">{pct}%</span>
                <span className="text-xs font-bold text-slate-700">₩{d.value > 10000 ? `${(d.value / 10000).toFixed(0)}만` : d.value.toLocaleString()}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type ExpenseScopeTab = 'ALL' | 'PATIENT_DIRECT' | 'OPS_INDIRECT';
const SCOPE_TABS: { key: ExpenseScopeTab; label: string; desc: string }[] = [
  { key: 'ALL', label: '전체', desc: '환자직접비 + 운영간접비' },
  { key: 'PATIENT_DIRECT', label: '환자직접비', desc: '환자 진료에 직접 들어가는 비용' },
  { key: 'OPS_INDIRECT', label: '운영간접비', desc: '병원 운영 간접비용' },
];

type ReportTab = 'overview' | 'purchase' | 'issue';
const REPORT_TABS: { key: ReportTab; label: string; desc: string }[] = [
  { key: 'overview', label: '개요',  desc: 'KPI · 상위 품목 · 재고 요약' },
  { key: 'purchase', label: '매입',  desc: '업체별 / 분류별 / 품목별 매입 분석' },
  { key: 'issue',    label: '불출',  desc: '부서별 / 분류별 / 품목별 불출 분석' },
];

type PurchaseSubTab = 'p_vendor' | 'p_major' | 'p_item';
const PURCHASE_SUB_TABS: { key: PurchaseSubTab; label: string }[] = [
  { key: 'p_vendor', label: '업체별' },
  { key: 'p_major',  label: '분류별' },
  { key: 'p_item',   label: '품목별' },
];

type IssueSubTab = 'i_dept' | 'i_major' | 'i_item';
const ISSUE_SUB_TABS: { key: IssueSubTab; label: string }[] = [
  { key: 'i_dept',  label: '부서별' },
  { key: 'i_major', label: '분류별' },
  { key: 'i_item',  label: '품목별' },
];

export default function SupplyStatsTab({ deptId }: { deptId: string }) {
  const [cost, setCost] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [scope, setScope] = useState<ExpenseScopeTab>('ALL');
  const [reportTab, setReportTab] = useState<ReportTab>('overview');
  const [purchaseSubTab, setPurchaseSubTab] = useState<PurchaseSubTab>('p_vendor');
  const [issueSubTab, setIssueSubTab] = useState<IssueSubTab>('i_dept');
  // 업체별 매입 — 드롭다운: '' = 전체, 또는 vendor_id
  const [selectedVendor, setSelectedVendor] = useState<string>('');
  const [vendorDetail, setVendorDetail] = useState<any>(null);
  const [vendorDetailLoading, setVendorDetailLoading] = useState(false);
  const [diaper, setDiaper] = useState<any>(null);
  const [diaperLoading, setDiaperLoading] = useState(false);
  // 아래 state 들은 현재 비활성 블록 ({false && ...}) 안에서만 참조되지만,
  // useEffect 안에서 setter 가 사용되므로 ReferenceError 방지용으로 유지.
  // 사용자가 가격 변동/추이 분석/기저귀 탭을 다시 살리면 그대로 작동.
  const [priceChanges, setPriceChanges] = useState<any>(null);
  const [priceMonths, setPriceMonths] = useState(6);
  const [opReport, setOpReport] = useState<any>(null);
  const [opReportLoading, setOpReportLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    const q = deptId ? `&department_id=${deptId}` : '';
    const sq = scope !== 'ALL' ? `&expense_scope=${scope}` : '';
    const mm = String(period.month).padStart(2, '0');
    const lastDay = new Date(period.year, period.month, 0).getDate();
    // vendor-summary 는 year 가 아니라 date_from/date_to 를 받음 → 선택 월 전체 범위로 호출
    const dq = `date_from=${period.year}-${mm}-01&date_to=${period.year}-${mm}-${String(lastDay).padStart(2, '0')}`;
    Promise.all([
      api(`/cost/statistics?year=${period.year}&month=${period.month}${q}${sq}`).catch(() => ({})),
      api(`/cost/vendor-summary?${dq}${q}${sq}`).catch(() => null),
      api(`/patients/stats?date_from=${period.year}-${mm}-01&date_to=${period.year}-${mm}-28${deptId ? `&department_id=${deptId}` : ''}`).catch(() => null),
    ]).then(([costData, vendorData, patientData]) => {
      // vendor-summary 응답은 객체({vendor_order_amounts,...}) — 거래처별 구매금액으로 정규화
      const vendorRows = Array.isArray(vendorData)
        ? vendorData
        : ((vendorData?.vendor_order_amounts ?? []) as any[]).map((v: any) => ({
            vendor_id: v.vendor_id,
            vendor_name: v.vendor_name,
            amount: Number(v.order_amount_current ?? v.amount ?? 0),
          }));
      // 환자 수는 「항상 일평균」 — cost/statistics 의 patient_count_avg 우선,
      // 없으면 patients/stats 의 현재 입원자(legacy fallback).
      setCost({
        ...(costData || {}),
        by_vendor: vendorRows,
        patient_count: costData?.patient_count_avg ?? patientData?.overall?.total_occupied ?? 0,
        patient_count_avg: costData?.patient_count_avg ?? null,
        patient_count_recorded_days: costData?.patient_count_recorded_days ?? 0,
        concentration: vendorData?.concentration ?? null,
      });
    }).finally(() => setLoading(false));
  }, [period, deptId, scope]);

  // 가격 변동 — period 와 별개로 priceMonths 변경 시 재로드
  useEffect(() => {
    api(`/cost/price-changes?months=${priceMonths}&limit=30`)
      .then(setPriceChanges)
      .catch(() => setPriceChanges(null));
  }, [priceMonths]);

  // 기저귀 손익 — 비용구분 탭과 무관, period 변경 시 로드
  useEffect(() => {
    setDiaperLoading(true);
    const mm = String(period.month).padStart(2, '0');
    api(`/cost/diaper-pnl?year_month=${period.year}-${mm}`)
      .then(setDiaper)
      .catch(() => setDiaper(null))
      .finally(() => setDiaperLoading(false));
  }, [period]);

  // 거래처별 분석 — 드롭다운에서 특정 거래처 선택 시만 로드
  useEffect(() => {
    if (!selectedVendor) { setVendorDetail(null); return; }
    setVendorDetailLoading(true);
    const mm = String(period.month).padStart(2, '0');
    const sq = scope !== 'ALL' ? `&expense_scope=${scope}` : '';
    api(`/cost/vendor-detail?vendor_id=${selectedVendor}&year_month=${period.year}-${mm}${sq}`)
      .then(setVendorDetail)
      .catch(() => setVendorDetail(null))
      .finally(() => setVendorDetailLoading(false));
  }, [selectedVendor, period, scope]);

  // 운영 보고서 — period + scope + deptId 의존
  useEffect(() => {
    setOpReportLoading(true);
    const mm = String(period.month).padStart(2, '0');
    const q = deptId ? `&department_id=${deptId}` : '';
    const sq = scope !== 'ALL' ? `&expense_scope=${scope}` : '';
    api(`/cost/operational-report?year_month=${period.year}-${mm}${q}${sq}`)
      .then(setOpReport)
      .catch(() => setOpReport(null))
      .finally(() => setOpReportLoading(false));
  }, [period, deptId, scope]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
      </div>
    );
  }

  const monthly = cost?.monthly_trend ?? [];
  const byDept = cost?.by_department ?? [];
  const byItem = cost?.by_item ?? [];
  const byVendor = cost?.by_vendor ?? [];

  const totalIssued = cost?.total_issued ?? 0;
  const totalPurchased = cost?.total_purchased ?? 0;
  const patientCount = cost?.patient_count ?? 0;
  const perPatient = patientCount > 0 ? Math.round(totalIssued / patientCount) : 0;

  // 부서별 도넛 데이터 — 내역 있는 부서 전부 (slice 제거)
  const deptDonut = byDept.map((d: any) => ({
    name: d.dept_name || d.department_name,
    value: d.amount,
  }));
  const deptTotal = deptDonut.reduce((s: number, d: any) => s + d.value, 0);

  // 거래처별 도넛 데이터 — 내역 있는 거래처 전부 (slice 제거)
  const vendorDonut = byVendor.map((v: any) => ({
    name: v.vendor_name,
    value: v.amount,
  }));
  const vendorTotal = vendorDonut.reduce((s: number, d: any) => s + d.value, 0);

  // 개요 탭 — 매입/불출 분류별·업체별 도넛
  const purchaseByMajor: any[] = cost?.purchase_by_major ?? [];
  const issueByMajor: any[] = cost?.issue_by_major ?? [];
  const purchaseByVendor: any[] = cost?.purchase_by_vendor ?? [];
  // 분류별 도넛 — 5개 그룹(의료/일반/사무/기저귀/식음료) 으로 묶음 (표와 동일)
  const purchaseByMajorDonut = (cost?.purchase_groups ?? []).map((g: any) => ({ name: g.group, value: g.total }));
  const issueByMajorDonut = (cost?.issue_groups ?? []).map((g: any) => ({ name: g.group, value: g.total }));
  // 업체별 매입 도넛 — 매입 있는 업체 전부 (slice 제거)
  const purchaseByVendorDonut = purchaseByVendor.map((x: any) => ({ name: x.vendor_name, value: x.amount }));
  const inventoryAmount: number = cost?.inventory_amount ?? 0;

  // 추이 탭 — 월별 매입·사용 매트릭스 (monthly_purchase + monthly_trend 결합)
  const monthlyPurchase: any[] = cost?.monthly_purchase ?? [];
  const monthlyMatrix = monthly.map((m: any) => {
    const pur = monthlyPurchase.find((x: any) => x.month === m.month);
    const purchase = pur ? Number(pur.amount) : 0;
    const issue = Number(m.amount);
    return {
      month: m.month,
      month_label: String(m.month).slice(5) + '월',
      purchase,
      issue,
      gap: purchase - issue,
    };
  });

  // 운영간접비 탭에서는 「기저귀」 보고서 탭 숨김
  const availableReportTabs = REPORT_TABS;

  return (
    <div className="space-y-5">
      {/* ─── 1단: 비용구분 필터 + 기간 ─── */}
      <div className="flex flex-wrap items-center gap-3 no-print">
        <div className="inline-flex bg-slate-100 rounded-lg p-0.5">
          {SCOPE_TABS.map((t) => (
            <button
              key={t.key}
              title={t.desc}
              onClick={() => setScope(t.key)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition ${
                scope === t.key ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <select
            className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={period.year}
            onChange={e => setPeriod(p => ({ ...p, year: Number(e.target.value) }))}
          >
            {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}년</option>)}
          </select>
          <select
            className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={period.month}
            onChange={e => setPeriod(p => ({ ...p, month: Number(e.target.value) }))}
          >
            {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}월</option>)}
          </select>
        </div>
        {scope !== 'ALL' && (
          <span className="text-xs text-slate-500">
            ※ {SCOPE_TABS.find(t => t.key === scope)?.desc} 만 집계
          </span>
        )}
      </div>

      {/* ─── 2단: 보고서 탭 (개요/추이/부서·거래처/기저귀) ─── */}
      <div className="border-b border-slate-200 no-print">
        <div className="flex flex-wrap gap-1">
          {availableReportTabs.map((t) => (
            <button
              key={t.key}
              title={t.desc}
              onClick={() => setReportTab(t.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition -mb-px ${
                reportTab === t.key
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── 3단: 선택된 탭 내용 ─── */}
      {reportTab === 'overview' && (<div className="space-y-5">
      {/* ─── KPI 카드 4개 ─── */}
      {scope === 'OPS_INDIRECT' ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <BigKpi label="월 매입금액" value={`₩${totalPurchased.toLocaleString()}`} color="green" />
          <BigKpi label="월 불출금액" value={`₩${totalIssued.toLocaleString()}`} color="blue" />
          <BigKpi label="품목 수" value={`${byItem.length}건`} color="teal" />
          <BigKpi label="거래처 수" value={`${byVendor.length}곳`} color="amber" />
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <BigKpi label="월 매입금액" value={`₩${totalPurchased.toLocaleString()}`} color="green" />
          <BigKpi label="월 불출금액" value={`₩${totalIssued.toLocaleString()}`} color="blue" />
          <BigKpi label="환자 수 (일평균)" value={`${patientCount}명`} color="teal" />
          <BigKpi label="1인당 재료비" value={perPatient > 0 ? `₩${perPatient.toLocaleString()}` : '-'} color="amber" />
        </div>
      )}

      {/* 비용구분별 1인당 사용액 — 의료/일반 분해 (운영간접비 탭에선 의미 약함) */}
      {scope !== 'OPS_INDIRECT' && cost?.expense_scope_breakdown && patientCount > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white rounded-xl border border-emerald-100 p-3">
            <div className="text-[11px] text-emerald-700 font-semibold">의료소모품 1인당 (일평균 환자 기준)</div>
            <div className="text-lg font-bold text-emerald-700 mt-1">
              ₩{Math.round((cost.expense_scope_breakdown.PATIENT_DIRECT ?? 0) / patientCount).toLocaleString()}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">월 의료소모품 ₩{(cost.expense_scope_breakdown.PATIENT_DIRECT ?? 0).toLocaleString()} ÷ {patientCount}명</div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-3">
            <div className="text-[11px] text-slate-600 font-semibold">일반소모품 1인당</div>
            <div className="text-lg font-bold text-slate-700 mt-1">
              ₩{Math.round((cost.expense_scope_breakdown.OPS_INDIRECT ?? 0) / patientCount).toLocaleString()}
            </div>
            <div className="text-[10px] text-slate-400 mt-0.5">월 일반소모품 ₩{(cost.expense_scope_breakdown.OPS_INDIRECT ?? 0).toLocaleString()} ÷ {patientCount}명</div>
          </div>
        </div>
      )}

      {/* ─── 매입 ↔ 불출 좌우 매칭 ─── */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* 매입 분석 */}
        <div className="bg-white rounded-2xl border border-emerald-100 shadow-sm p-5 space-y-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-bold text-emerald-700">매입 분석</h3>
            <span className="text-[11px] text-slate-400">들어온 돈 · 총 ₩{totalPurchased.toLocaleString()}</span>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-slate-600 mb-2">분류별 매입</h4>
            {purchaseByMajorDonut.length > 0
              ? <DonutWithLegend data={purchaseByMajorDonut} height={200} />
              : <p className="text-xs text-slate-400 text-center py-6">데이터 없음</p>}
          </div>
          <div className="pt-3 border-t border-slate-50">
            <h4 className="text-xs font-semibold text-slate-600 mb-2">업체별 매입</h4>
            {purchaseByVendorDonut.length > 0
              ? <DonutWithLegend data={purchaseByVendorDonut} height={200} />
              : <p className="text-xs text-slate-400 text-center py-6">데이터 없음</p>}
          </div>
        </div>

        {/* 불출 분석 */}
        <div className="bg-white rounded-2xl border border-blue-100 shadow-sm p-5 space-y-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-bold text-blue-700">불출 분석</h3>
            <span className="text-[11px] text-slate-400">나간 돈 · 총 ₩{totalIssued.toLocaleString()}</span>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-slate-600 mb-2">분류별 불출</h4>
            {issueByMajorDonut.length > 0
              ? <DonutWithLegend data={issueByMajorDonut} height={200} />
              : <p className="text-xs text-slate-400 text-center py-6">데이터 없음</p>}
          </div>
          <div className="pt-3 border-t border-slate-50">
            <h4 className="text-xs font-semibold text-slate-600 mb-2">부서별 불출</h4>
            {deptDonut.length > 0
              ? <DonutWithLegend data={deptDonut} height={200} />
              : <p className="text-xs text-slate-400 text-center py-6">데이터 없음</p>}
          </div>
        </div>
      </div>

      {/* ─── 상위 품목 TOP 8 (불출금액 기준) ─── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-bold text-slate-700">상위 품목</h3>
          <span className="text-[11px] text-slate-400">불출금액 기준 · TOP 8{scope !== 'ALL' ? ` · ${SCOPE_TABS.find(t => t.key === scope)?.label ?? ''}` : ''}</span>
        </div>
        {byItem.length > 0 ? byItem.slice(0, 8).map((d: any, i: number) => {
          const max = byItem[0]?.amount || 1;
          const pct = Math.round((d.amount / max) * 100);
          return (
            <div key={d.item_name} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
              <span className="text-xs font-bold text-slate-400 w-5">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-700 truncate">{d.item_name}</p>
                <div className="mt-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: COLORS[i % COLORS.length] }} />
                </div>
              </div>
              <span className="text-sm font-bold text-slate-700 whitespace-nowrap">
                ₩{d.amount > 10000 ? `${(d.amount / 10000).toFixed(0)}만` : d.amount.toLocaleString()}
              </span>
            </div>
          );
        }) : <p className="text-xs text-slate-400 text-center py-6">데이터 없음</p>}
      </div>

      {/* ─── 재고 금액 (하단 카드) ─── */}
      <div className="bg-gradient-to-br from-slate-50 to-white rounded-2xl border border-slate-200 p-5 flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500">현재 재고 금액 (FIFO 평가)</div>
          <div className="text-2xl font-bold text-slate-800 mt-1">₩{inventoryAmount.toLocaleString()}</div>
          <div className="text-[10px] text-slate-400 mt-1">자산 추적 위치(창고)만 합산. 부서 보관함은 출고 시점 비용 인식이라 제외.</div>
        </div>
        <div className="text-3xl text-slate-300">📦</div>
      </div>
      </div>)}

      {/* ─── 매입 탭 — 서브탭 3개 (업체별/분류별/품목별) ─── */}
      {reportTab === 'purchase' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {PURCHASE_SUB_TABS.map((t) => {
              const isActive = purchaseSubTab === t.key;
              return (
                <button key={t.key} onClick={() => setPurchaseSubTab(t.key)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                    isActive ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                  }`}>
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* 업체별 — 드롭다운: 전체 또는 특정 거래처 */}
          {purchaseSubTab === 'p_vendor' && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500">거래처</label>
                <select
                  className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px]"
                  value={selectedVendor}
                  onChange={(e) => setSelectedVendor(e.target.value)}
                >
                  <option value="">전체 거래처</option>
                  {purchaseByVendor.map((v: any) => (
                    <option key={v.vendor_id} value={v.vendor_id}>{v.vendor_name}</option>
                  ))}
                </select>
                {selectedVendor && (
                  <button className="text-xs text-slate-500 hover:text-slate-700 underline" onClick={() => setSelectedVendor('')}>
                    전체 보기로 돌아가기
                  </button>
                )}
              </div>

              {!selectedVendor ? (
                <BreakdownAccordionPanel
                  kind="purchase"
                  entities={cost?.purchase_vendor_breakdown ?? []}
                  total={totalPurchased}
                />
              ) : (
                <VendorDetailPanel
                  vendors={purchaseByVendor}
                  selectedVendor={selectedVendor}
                  onSelect={setSelectedVendor}
                  loading={vendorDetailLoading}
                  data={vendorDetail}
                  hideSelect
                />
              )}
            </div>
          )}

          {/* 분류별 / 품목별 */}
          {(purchaseSubTab === 'p_major' || purchaseSubTab === 'p_item') && (
            <DetailAnalysisSection
              scope={scope}
              scopeLabel={SCOPE_TABS.find(t => t.key === scope)?.label ?? ''}
              detailTab={purchaseSubTab}
              showTabs={false}
              purchaseByMajor={purchaseByMajor}
              purchaseByItem={cost?.purchase_by_item ?? []}
              purchaseByVendor={purchaseByVendor}
              purchaseGroups={cost?.purchase_groups ?? []}
              issueByMajor={issueByMajor}
              issueByItem={byItem}
              issueByDept={byDept}
              issueGroups={cost?.issue_groups ?? []}
              totalPurchased={totalPurchased}
              totalIssued={totalIssued}
            />
          )}
        </div>
      )}

      {/* ─── 불출 탭 — 서브탭 3개 (부서별/분류별/품목별) ─── */}
      {reportTab === 'issue' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {ISSUE_SUB_TABS.map((t) => {
              const isActive = issueSubTab === t.key;
              return (
                <button key={t.key} onClick={() => setIssueSubTab(t.key)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${
                    isActive ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                  }`}>
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* 부서별 불출 — 아코디언 (펼치면 분류 분포) */}
          {issueSubTab === 'i_dept' && (
            <BreakdownAccordionPanel
              kind="issue"
              entities={cost?.issue_dept_breakdown ?? []}
              total={totalIssued}
            />
          )}

          {(issueSubTab === 'i_major' || issueSubTab === 'i_item') && (
            <DetailAnalysisSection
              scope={scope}
              scopeLabel={SCOPE_TABS.find(t => t.key === scope)?.label ?? ''}
              detailTab={issueSubTab}
              showTabs={false}
              purchaseByMajor={purchaseByMajor}
              purchaseByItem={cost?.purchase_by_item ?? []}
              purchaseByVendor={purchaseByVendor}
              purchaseGroups={cost?.purchase_groups ?? []}
              issueByMajor={issueByMajor}
              issueByItem={byItem}
              issueByDept={byDept}
              issueGroups={cost?.issue_groups ?? []}
              totalPurchased={totalPurchased}
              totalIssued={totalIssued}
            />
          )}
        </div>
      )}

      {/* ─── 비활성 (구) 추이 분석 탭 — 코드 보존, reportTab='trend' 가 없어서 미실행 ─── */}
      {false && reportTab === ('trend' as any) && (<div className="space-y-5">
      {/* 회전율 KPI */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl border border-amber-100 shadow-sm p-4">
          <div className="text-[11px] text-amber-700 font-semibold">재고 회전율 (이번 달)</div>
          <div className="text-xl font-bold text-amber-700 mt-1">{cost?.turnover_rate?.toFixed(2) ?? '0.00'} 회</div>
          <div className="text-[10px] text-slate-400 mt-0.5">사용금액 ÷ 현재재고. 높을수록 재고가 빨리 도는 중</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
          <div className="text-[11px] text-slate-500 font-semibold">이번 달 매입 - 사용</div>
          <div className={`text-xl font-bold mt-1 ${(totalPurchased - totalIssued) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {(totalPurchased - totalIssued) >= 0 ? '+' : ''}₩{(totalPurchased - totalIssued).toLocaleString()}
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">+ = 재고 증가, − = 재고 소진</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
          <div className="text-[11px] text-slate-500 font-semibold">현재 재고 금액</div>
          <div className="text-xl font-bold text-slate-700 mt-1">₩{inventoryAmount.toLocaleString()}</div>
          <div className="text-[10px] text-slate-400 mt-0.5">FIFO 평가 · 자산추적 위치만</div>
        </div>
      </div>

      {/* 월별 매입·사용 표 (12개월) */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 overflow-x-auto">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-bold text-slate-700">월별 매입·사용 추이 <span className="text-[11px] font-normal text-slate-400">(최근 12개월 · 단위: 만원)</span></h3>
          <span className="text-[10px] text-slate-400">갭 = 매입 - 사용. + 재고 증가 / − 소진</span>
        </div>
        {monthlyMatrix.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-6">데이터 없음</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-slate-600">월</th>
                <th className="text-right px-3 py-2 font-semibold text-emerald-700 whitespace-nowrap">매입금액</th>
                <th className="text-right px-3 py-2 font-semibold text-blue-700 whitespace-nowrap">사용금액</th>
                <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">갭 (매입-사용)</th>
              </tr>
            </thead>
            <tbody>
              {monthlyMatrix.map((r: any) => (
                <tr key={r.month} className={`border-t border-slate-50 ${r.month === cost?.year_month ? 'bg-amber-50/50' : ''}`}>
                  <td className="px-3 py-2 font-medium text-slate-700">{r.month_label}{r.month === cost?.year_month && <span className="ml-1 text-[10px] text-amber-600">(이번 달)</span>}</td>
                  <td className="text-right px-3 py-2 text-emerald-700 whitespace-nowrap" title={`₩${r.purchase.toLocaleString()}`}>
                    {r.purchase > 0 ? `₩${Math.round(r.purchase / 10000).toLocaleString()}만` : '-'}
                  </td>
                  <td className="text-right px-3 py-2 text-blue-700 whitespace-nowrap" title={`₩${r.issue.toLocaleString()}`}>
                    {r.issue > 0 ? `₩${Math.round(r.issue / 10000).toLocaleString()}만` : '-'}
                  </td>
                  <td className={`text-right px-3 py-2 font-semibold whitespace-nowrap ${r.gap > 0 ? 'text-emerald-600' : r.gap < 0 ? 'text-red-600' : 'text-slate-400'}`} title={`₩${r.gap.toLocaleString()}`}>
                    {r.gap === 0 ? '0' : `${r.gap > 0 ? '+' : ''}${Math.round(r.gap / 10000).toLocaleString()}만`}
                  </td>
                </tr>
              ))}
              {/* 12개월 합계 */}
              <tr className="border-t-2 border-slate-200 bg-slate-50">
                <td className="px-3 py-2 font-bold text-slate-700">12개월 합계</td>
                <td className="text-right px-3 py-2 font-bold text-emerald-700 whitespace-nowrap">₩{Math.round(monthlyMatrix.reduce((s, r) => s + r.purchase, 0) / 10000).toLocaleString()}만</td>
                <td className="text-right px-3 py-2 font-bold text-blue-700 whitespace-nowrap">₩{Math.round(monthlyMatrix.reduce((s, r) => s + r.issue, 0) / 10000).toLocaleString()}만</td>
                <td className="text-right px-3 py-2 font-bold whitespace-nowrap">
                  {(() => {
                    const sum = monthlyMatrix.reduce((s, r) => s + r.gap, 0);
                    return <span className={sum > 0 ? 'text-emerald-600' : sum < 0 ? 'text-red-600' : 'text-slate-400'}>{sum > 0 ? '+' : ''}{Math.round(sum / 10000).toLocaleString()}만</span>;
                  })()}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* ─── 카테고리 × 12개월 추이 매트릭스 (추이 탭 안) ─── */}
      <OperationalReportSection loading={opReportLoading} data={opReport} scope={scope} scopeLabel={SCOPE_TABS.find(t => t.key === scope)?.label ?? ''} show="trend" />

      {/* ─── (구) 상세 분석 — 비활성, 호출 안 됨 ─── */}

      {/* ─── 가격 변동 ─── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-700">가격 변동 추이</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              priceHistory 기반 — (품목 × 거래처) 별로 가장 최근 2건의 단가 비교
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">분석 기간</span>
            <select
              value={priceMonths}
              onChange={(e) => setPriceMonths(Number(e.target.value))}
              className="text-xs px-2 py-1 border border-slate-200 rounded bg-white"
            >
              <option value={3}>최근 3개월</option>
              <option value={6}>최근 6개월</option>
              <option value={12}>최근 12개월</option>
              <option value={24}>최근 24개월</option>
            </select>
          </div>
        </div>

        {!priceChanges ? (
          <div className="py-6 text-center text-xs text-slate-400">로딩 중...</div>
        ) : priceChanges.changes.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-400">해당 기간 가격 변동 없음</div>
        ) : (
          <>
            {/* 요약 메트릭 */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="p-3 rounded-lg bg-red-50 border border-red-100">
                <div className="text-xs text-red-600 mb-0.5">인상</div>
                <div className="text-lg font-bold text-red-700">{priceChanges.up_count}건</div>
              </div>
              <div className="p-3 rounded-lg bg-blue-50 border border-blue-100">
                <div className="text-xs text-blue-600 mb-0.5">인하</div>
                <div className="text-lg font-bold text-blue-700">{priceChanges.down_count}건</div>
              </div>
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-100">
                <div className="text-xs text-slate-500 mb-0.5">총 변동</div>
                <div className="text-lg font-bold text-slate-700">{priceChanges.total_changes}건</div>
              </div>
            </div>

            {/* 변동 큰 순 — 상위 N개 */}
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-left">코드</th>
                    <th className="px-3 py-2 text-left">품명</th>
                    <th className="px-3 py-2 text-left">거래처</th>
                    <th className="px-3 py-2 text-right">이전 단가</th>
                    <th className="px-3 py-2 text-right">현재 단가</th>
                    <th className="px-3 py-2 text-right">변동</th>
                    <th className="px-3 py-2 text-right">%</th>
                    <th className="px-3 py-2 text-center">변경일</th>
                  </tr>
                </thead>
                <tbody>
                  {priceChanges.changes.map((c: any, i: number) => {
                    const isUp = c.change_amount > 0;
                    return (
                      <tr key={i} className="border-t border-slate-100 hover:bg-slate-50/40">
                        <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{c.item_code}</td>
                        <td className="px-3 py-1.5">{c.name}</td>
                        <td className="px-3 py-1.5 text-slate-600">{c.vendor_name}</td>
                        <td className="px-3 py-1.5 text-right text-slate-600">₩{c.prev_price.toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-right font-medium">₩{c.current_price.toLocaleString()}</td>
                        <td className={`px-3 py-1.5 text-right font-medium ${isUp ? 'text-red-600' : 'text-blue-600'}`}>
                          {isUp ? '+' : ''}₩{c.change_amount.toLocaleString()}
                        </td>
                        <td className={`px-3 py-1.5 text-right font-bold ${isUp ? 'text-red-700' : 'text-blue-700'}`}>
                          {isUp ? '↑' : '↓'} {Math.abs(c.change_pct).toFixed(1)}%
                        </td>
                        <td className="px-3 py-1.5 text-center text-xs text-slate-500">
                          {c.effective_from ? new Date(c.effective_from).toLocaleDateString('ko-KR') : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-400 mt-2">변동률 큰 순 정렬 (인상·인하 모두). 상위 30건만 표시.</p>
          </>
        )}
      </div>
      </div>)}

      {/* ─── 비활성 (구) 부서·거래처 탭 ─── */}
      {false && reportTab === ('dept-vendor' as any) && (<div className="space-y-5">
        {/* 부서×비용구분 매트릭스 */}
        <OperationalReportSection loading={opReportLoading} data={opReport} scope={scope} scopeLabel={SCOPE_TABS.find(t => t.key === scope)?.label ?? ''} show="dept" />

        {/* 도넛 차트 2개 (부서·거래처 비중) */}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h3 className="text-sm font-bold text-slate-700 mb-3">
              부서별 불출 비중
              {scope !== 'ALL' && <span className="ml-1.5 text-[11px] font-medium text-slate-400">({SCOPE_TABS.find(t => t.key === scope)?.label})</span>}
            </h3>
            {deptDonut.length > 0
              ? <DonutWithLegend data={deptDonut} />
              : <p className="text-xs text-slate-400 text-center py-8">데이터 없음</p>}
          </div>
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <h3 className="text-sm font-bold text-slate-700 mb-3">
              거래처별 구매 비중
              {scope !== 'ALL' && <span className="ml-1.5 text-[11px] font-medium text-slate-400">({SCOPE_TABS.find(t => t.key === scope)?.label})</span>}
            </h3>
            {vendorDonut.length > 0
              ? <DonutWithLegend data={vendorDonut} />
              : <p className="text-xs text-slate-400 text-center py-8">데이터 없음</p>}
          </div>
        </div>

        {/* 거래처 의존도 — 상위 N 개 비중 (공급 리스크 지표) */}
        {cost?.concentration && (
          <div className="bg-amber-50/50 border border-amber-100 rounded-2xl p-4">
            <div className="flex items-baseline justify-between mb-2">
              <h4 className="text-sm font-bold text-amber-800">거래처 의존도</h4>
              <span className="text-[11px] text-slate-500">총 {cost.concentration.total_vendors}개 거래처 중 상위 비중</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-white rounded-lg p-3 text-center">
                <div className="text-[11px] text-slate-500">최대 거래처 1곳</div>
                <div className="text-lg font-bold text-amber-700 mt-0.5">{cost.concentration.top1_pct}%</div>
              </div>
              <div className="bg-white rounded-lg p-3 text-center">
                <div className="text-[11px] text-slate-500">상위 3곳</div>
                <div className="text-lg font-bold text-amber-700 mt-0.5">{cost.concentration.top3_pct}%</div>
              </div>
              <div className="bg-white rounded-lg p-3 text-center">
                <div className="text-[11px] text-slate-500">상위 5곳</div>
                <div className="text-lg font-bold text-amber-700 mt-0.5">{cost.concentration.top5_pct}%</div>
              </div>
            </div>
            <p className="text-[10px] text-slate-500 mt-2">
              ※ 상위 비중이 80%↑ 면 공급 리스크 — 한 거래처 사고 시 큰 영향. 적절한 분산 검토 권장.
            </p>
          </div>
        )}

        {/* 거래처 상세 테이블 */}
        {byVendor.length > 0 && (
          <ReportTable
            title="거래처별 거래 현황"
            columns={[
              { key: 'vendor_name', label: '거래처', width: '30%' },
              { key: 'amount', label: '금액', align: 'right', render: (v: number) => `₩${Number(v || 0).toLocaleString()}` },
              { key: 'pct', label: '매입비중(%)', align: 'right', render: (v: number) => `${v}%` },
            ]}
            data={byVendor.slice(0, 10).map((v: any) => ({
              vendor_name: v.vendor_name,
              amount: v.amount,
              pct: vendorTotal > 0 ? ((v.amount / vendorTotal) * 100).toFixed(1) : '0',
            }))}
            footer={{
              vendor_name: '합계',
              amount: `₩${vendorTotal.toLocaleString()}`,
              pct: '100%',
            }}
          />
        )}
      </div>)}

      {/* ─── 비활성 (구) 기저귀 탭 ─── 코드 보존 */}
      {false && reportTab === ('diaper' as any) && (<div className="space-y-5">
        <DiaperPnLPanel
          loading={diaperLoading}
          data={diaper}
          period={period}
          onReload={() => {
            // 팩당 장수 변경 후 통계 재로딩
            setDiaperLoading(true);
            const mm = String(period.month).padStart(2, '0');
            api(`/cost/diaper-pnl?year_month=${period.year}-${mm}`)
              .then(setDiaper)
              .catch(() => setDiaper(null))
              .finally(() => setDiaperLoading(false));
          }}
        />
      </div>)}
    </div>
  );
}

// ─── 운영 보고서 섹션 ─── 두 가지 표: 카테고리×12개월 추이, 부서×비용구분 매트릭스
// show prop: 'trend' = 카테고리 추이만 / 'dept' = 부서 매트릭스만 / 'both' = 둘 다
function OperationalReportSection({ loading, data, scope, scopeLabel, show = 'both' }: {
  loading: boolean; data: any; scope: string; scopeLabel: string; show?: 'trend' | 'dept' | 'both';
}) {
  if (loading) {
    return <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 text-center text-xs text-slate-400">운영 보고서 로딩 중...</div>;
  }
  if (!data) return null;
  const ymShort = (k: string) => k.slice(5) + '월'; // '2026-05' → '05월'
  const fmt = (n: number) => n > 0 ? `₩${Math.round(n / 10000).toLocaleString()}만` : '-';
  const fmtFull = (n: number) => `₩${Math.round(n).toLocaleString()}`;
  const trendRows: any[] = data?.category_trend?.rows ?? [];
  const monthlyTotals: number[] = data?.category_trend?.monthly_totals ?? [];
  const months: string[] = data?.months ?? [];

  // 셀 색강도 (heatmap) — 행 내 최댓값 기준
  const heatBg = (v: number, rowMax: number) => {
    if (v <= 0 || rowMax <= 0) return '';
    const r = v / rowMax;
    if (r < 0.1) return 'bg-blue-50';
    if (r < 0.3) return 'bg-blue-100';
    if (r < 0.6) return 'bg-blue-200/80';
    if (r < 0.85) return 'bg-blue-300/80';
    return 'bg-blue-400/70 text-white';
  };

  const deltaCell = (pct: number | null) => {
    if (pct == null) return <span className="text-slate-400">-</span>;
    if (pct === 0) return <span className="text-slate-500">0%</span>;
    const positive = pct > 0;
    return <span className={positive ? 'text-rose-600' : 'text-emerald-600'}>{positive ? '+' : ''}{pct}%</span>;
  };

  // 부서×비용구분 (의료소모품/일반소모품 2컬럼) — 사용자 친화적 큰 분류
  const scopeColumns: { key: string; label: string }[] = data?.dept_scope?.columns ?? [];
  const deptRows: any[] = data?.dept_scope?.rows ?? [];
  const colTotals: Record<string, number> = data?.dept_scope?.column_totals ?? {};
  const grandTotal: number = data?.dept_scope?.grand_total ?? 0;

  return (
    <div className="space-y-4">
      {show === 'both' && (
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-bold text-slate-800">운영 보고서</h2>
          <span className="text-[11px] text-slate-400">실무 운영계획용 정리표 — 추이 분석 + 부서별 사용 패턴</span>
          {scope !== 'ALL' && <span className="ml-1 text-[11px] text-slate-500">· {scopeLabel}</span>}
        </div>
      )}

      {/* (1) 카테고리 × 최근 12개월 추이 매트릭스 */}
      {(show === 'trend' || show === 'both') && (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 overflow-x-auto">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-bold text-slate-700">카테고리별 월별 추이 <span className="text-[11px] font-normal text-slate-400">(최근 12개월 · 단위: 만원)</span></h3>
          <span className="text-[10px] text-slate-400">전월비·전년동월비는 마지막 열</span>
        </div>
        {trendRows.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-6">데이터 없음</p>
        ) : (
          <table className="w-full text-xs min-w-[900px]">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-2 py-2 font-semibold text-slate-600 sticky left-0 bg-slate-50 min-w-[100px]">카테고리</th>
                {months.map((k) => <th key={k} className="text-right px-2 py-2 font-semibold text-slate-500 whitespace-nowrap">{ymShort(k)}</th>)}
                <th className="text-right px-2 py-2 font-semibold text-slate-600 whitespace-nowrap">전월비</th>
                <th className="text-right px-2 py-2 font-semibold text-slate-600 whitespace-nowrap">전년비</th>
              </tr>
            </thead>
            <tbody>
              {trendRows.map((r) => {
                const rowMax = Math.max(...r.values);
                return (
                  <tr key={r.major} className="border-t border-slate-50">
                    <td className="px-2 py-2 font-medium text-slate-700 sticky left-0 bg-white">{r.major_label}</td>
                    {r.values.map((v: number, i: number) => (
                      <td key={i} className={`text-right px-2 py-2 whitespace-nowrap ${heatBg(v, rowMax)}`} title={fmtFull(v)}>
                        {fmt(v)}
                      </td>
                    ))}
                    <td className="text-right px-2 py-2 whitespace-nowrap font-semibold">{deltaCell(r.mom_pct)}</td>
                    <td className="text-right px-2 py-2 whitespace-nowrap font-semibold">{deltaCell(r.yoy_pct)}</td>
                  </tr>
                );
              })}
              {/* 월별 합계 */}
              <tr className="border-t-2 border-slate-200 bg-slate-50">
                <td className="px-2 py-2 font-bold text-slate-700 sticky left-0 bg-slate-50">월 합계</td>
                {monthlyTotals.map((v, i) => <td key={i} className="text-right px-2 py-2 font-semibold text-slate-700 whitespace-nowrap" title={fmtFull(v)}>{fmt(v)}</td>)}
                <td className="px-2 py-2"></td>
                <td className="px-2 py-2"></td>
              </tr>
            </tbody>
          </table>
        )}
        <p className="text-[10px] text-slate-400 mt-2">셀 색이 진할수록 그 카테고리의 12개월 중 사용량이 많은 달. 마우스를 올리면 정확한 금액 표시.</p>
      </div>
      )}

      {/* (2) 부서 × 비용구분 매트릭스 — 의료/일반 2컬럼 */}
      {(show === 'dept' || show === 'both') && (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 overflow-x-auto">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-bold text-slate-700">부서×비용구분 사용 패턴 <span className="text-[11px] font-normal text-slate-400">(이번 달 · 단위: 만원)</span></h3>
          <span className="text-[10px] text-slate-400">의료소모품(환자직접비) vs 일반소모품(운영간접비) 비중을 한 줄로</span>
        </div>
        {deptRows.length === 0 || scopeColumns.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-6">데이터 없음</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-slate-600 sticky left-0 bg-slate-50 min-w-[110px]">부서</th>
                {scopeColumns.map((c) => (
                  <th key={c.key} className="text-right px-3 py-2 font-semibold text-slate-500 whitespace-nowrap">{c.label}</th>
                ))}
                <th className="text-right px-3 py-2 font-semibold text-slate-700 whitespace-nowrap">합계</th>
                {scopeColumns.length >= 2 && <th className="text-right px-3 py-2 font-semibold text-slate-500 whitespace-nowrap">의료 비중</th>}
                <th className="text-right px-3 py-2 font-semibold text-slate-500 whitespace-nowrap">환자수 (일평균)</th>
                <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">1인당</th>
              </tr>
            </thead>
            <tbody>
              {deptRows.map((r) => {
                const rowMax = Math.max(...scopeColumns.map((c) => r.by_scope[c.key] ?? 0));
                const medRatio = r.total > 0 ? (r.by_scope.PATIENT_DIRECT ?? 0) / r.total : 0;
                return (
                  <tr key={r.dept_id} className="border-t border-slate-50">
                    <td className="px-3 py-2 font-medium text-slate-700 sticky left-0 bg-white">{r.dept_name}</td>
                    {scopeColumns.map((c) => {
                      const v = r.by_scope[c.key] ?? 0;
                      return <td key={c.key} className={`text-right px-3 py-2 whitespace-nowrap ${heatBg(v, rowMax)}`} title={fmtFull(v)}>{fmt(v)}</td>;
                    })}
                    <td className="text-right px-3 py-2 font-semibold text-slate-800 whitespace-nowrap" title={fmtFull(r.total)}>{fmt(r.total)}</td>
                    {scopeColumns.length >= 2 && (
                      <td className="text-right px-3 py-2 text-slate-500 whitespace-nowrap">{r.total > 0 ? `${Math.round(medRatio * 100)}%` : '-'}</td>
                    )}
                    <td className="text-right px-3 py-2 text-slate-500 whitespace-nowrap">{r.avg_patient_count > 0 ? `${r.avg_patient_count}명` : '-'}</td>
                    <td className="text-right px-3 py-2 font-semibold text-slate-700 whitespace-nowrap" title={fmtFull(r.per_patient_amount)}>
                      {r.per_patient_amount > 0 ? `₩${Math.round(r.per_patient_amount / 1000).toLocaleString()}천` : '-'}
                    </td>
                  </tr>
                );
              })}
              {/* 합계 */}
              <tr className="border-t-2 border-slate-200 bg-slate-50">
                <td className="px-3 py-2 font-bold text-slate-700 sticky left-0 bg-slate-50">전체 합계</td>
                {scopeColumns.map((c) => <td key={c.key} className="text-right px-3 py-2 font-semibold text-slate-700 whitespace-nowrap" title={fmtFull(colTotals[c.key] ?? 0)}>{fmt(colTotals[c.key] ?? 0)}</td>)}
                <td className="text-right px-3 py-2 font-bold text-slate-900 whitespace-nowrap" title={fmtFull(grandTotal)}>{fmt(grandTotal)}</td>
                {scopeColumns.length >= 2 && (
                  <td className="text-right px-3 py-2 text-slate-500 whitespace-nowrap">
                    {grandTotal > 0 ? `${Math.round(((colTotals.PATIENT_DIRECT ?? 0) / grandTotal) * 100)}%` : '-'}
                  </td>
                )}
                <td className="px-3 py-2"></td>
                <td className="px-3 py-2"></td>
              </tr>
            </tbody>
          </table>
        )}
        <p className="text-[10px] text-slate-400 mt-2">
          ※ 분류는 품목 등록 시 정한 「비용구분」 기준. 의료소모품 = 환자 진료에 직접 들어가는 비용, 일반소모품 = 운영성 비용(사무·청소·식음료 등).
          셀 색이 진할수록 그 부서가 해당 비용구분에 가장 많이 지출한 쪽.
        </p>
      </div>
      )}
    </div>
  );
}

// ─── 상세 분석 섹션 ─── 추이 탭 안 6개 서브탭 + 금액 표
type DetailTab = 'p_major' | 'p_item' | 'p_vendor' | 'i_major' | 'i_item' | 'i_dept';
const DETAIL_TABS: { key: DetailTab; label: string; group: 'purchase' | 'issue' }[] = [
  { key: 'p_major',  label: '분류별 매입', group: 'purchase' },
  { key: 'p_item',   label: '품목별 매입', group: 'purchase' },
  { key: 'p_vendor', label: '업체별 매입', group: 'purchase' },
  { key: 'i_major',  label: '분류별 불출', group: 'issue' },
  { key: 'i_item',   label: '품목별 불출', group: 'issue' },
  { key: 'i_dept',   label: '부서별 불출', group: 'issue' },
];

function DetailAnalysisSection({
  scope, scopeLabel, detailTab, onChange, showTabs = true,
  purchaseByMajor, purchaseByItem, purchaseByVendor, purchaseGroups,
  issueByMajor, issueByItem, issueByDept, issueGroups,
  totalPurchased, totalIssued,
}: {
  scope: string; scopeLabel: string;
  detailTab: DetailTab; onChange?: (t: DetailTab) => void; showTabs?: boolean;
  purchaseByMajor: any[]; purchaseByItem: any[]; purchaseByVendor: any[]; purchaseGroups?: any[];
  issueByMajor: any[]; issueByItem: any[]; issueByDept: any[]; issueGroups?: any[];
  totalPurchased: number; totalIssued: number;
}) {
  const fmt = (n: number) => `₩${Math.round(Number(n) || 0).toLocaleString()}`;
  const pctFmt = (v: number, total: number) => total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '-';
  const active = DETAIL_TABS.find(t => t.key === detailTab) ?? DETAIL_TABS[0];

  // 표 정의 — 탭별 컬럼/데이터
  type Col = { key: string; label: string; align?: 'left' | 'right'; render?: (v: any, r: any) => any };
  let rows: any[] = [];
  let cols: Col[] = [];
  let total = 0;
  let totalLabel = '';

  // 분류별 매입/불출 — 그룹 헤더 + 중분류 들여쓰기 (별도 렌더링 분기에서 처리)
  const isGroupedView = detailTab === 'p_major' || detailTab === 'i_major';
  const groupedData: any[] = isGroupedView
    ? (detailTab === 'p_major' ? (purchaseGroups ?? []) : (issueGroups ?? []))
    : [];
  const groupedTotal = detailTab === 'p_major' ? totalPurchased : totalIssued;
  const groupedLabel = detailTab === 'p_major' ? '매입 합계' : '불출 합계';
  const groupedAmountLabel = detailTab === 'p_major' ? '매입금액' : '불출금액';

  if (detailTab === 'p_major') {
    // 표는 별도 분기에서 그려짐
    total = totalPurchased;
    totalLabel = '매입 합계';
  } else if (detailTab === 'p_item') {
    rows = purchaseByItem;
    total = totalPurchased;
    totalLabel = '매입 합계';
    cols = [
      { key: 'item_code', label: '코드' },
      { key: 'item_name', label: '품목' },
      { key: 'major', label: '분류' },
      { key: 'amount', label: '매입금액', align: 'right', render: (v) => fmt(v) },
      { key: 'pct', label: '비중', align: 'right', render: (_v, r) => pctFmt(r.amount, total) },
    ];
  } else if (detailTab === 'p_vendor') {
    rows = purchaseByVendor;
    total = totalPurchased;
    totalLabel = '매입 합계';
    cols = [
      { key: 'vendor_name', label: '거래처' },
      { key: 'amount', label: '매입금액', align: 'right', render: (v) => fmt(v) },
      { key: 'pct', label: '비중', align: 'right', render: (_v, r) => pctFmt(r.amount, total) },
    ];
  } else if (detailTab === 'i_major') {
    // 표는 별도 분기에서 그려짐
    total = totalIssued;
    totalLabel = '불출 합계';
  } else if (detailTab === 'i_item') {
    rows = issueByItem;
    total = totalIssued;
    totalLabel = '불출 합계';
    cols = [
      { key: 'item_code', label: '코드' },
      { key: 'item_name', label: '품목' },
      { key: 'major', label: '분류' },
      { key: 'amount', label: '불출금액', align: 'right', render: (v) => fmt(v) },
      { key: 'pct', label: '비중', align: 'right', render: (_v, r) => pctFmt(r.amount, total) },
    ];
  } else if (detailTab === 'i_dept') {
    rows = issueByDept;
    total = totalIssued;
    totalLabel = '불출 합계';
    cols = [
      { key: 'dept_name', label: '부서', render: (v, r) => v ?? r.department_name ?? '미정' },
      { key: 'amount', label: '불출금액', align: 'right', render: (v) => fmt(v) },
      { key: 'pct', label: '비중', align: 'right', render: (_v, r) => pctFmt(r.amount, total) },
    ];
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
      <div className="flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-700">{active.label}</h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {active.group === 'purchase' ? '발주(PO) 라인 합' : '불출(stock_out) 라인 합'} 기준 · 비용구분 필터와 연동
          </p>
        </div>
        {scope !== 'ALL' && <span className="text-[11px] text-slate-500">· {scopeLabel}</span>}
      </div>

      {/* 서브탭 — showTabs=true 일 때만 (그 자체로 호출되는 경우) */}
      {showTabs && onChange && (
        <div className="flex flex-wrap gap-1.5">
          {DETAIL_TABS.map((t) => {
            const isActive = detailTab === t.key;
            const groupColor = t.group === 'purchase'
              ? (isActive ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100')
              : (isActive ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700 hover:bg-blue-100');
            return (
              <button key={t.key} onClick={() => onChange(t.key)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition ${groupColor}`}>
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      {/* 표 — 분류별 매입/불출 은 그룹 헤더 + 중분류 들여쓰기, 나머지는 평탄 */}
      {isGroupedView ? (
        groupedData.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-8">데이터 없음</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-100">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-slate-600">분류</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">{groupedAmountLabel}</th>
                  <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">비중</th>
                </tr>
              </thead>
              <tbody>
                {groupedData.map((g: any) => (
                  <React.Fragment key={g.group}>
                    {/* 그룹 헤더 행 */}
                    <tr className="border-t border-slate-100 bg-slate-50/60">
                      <td className="px-3 py-2 font-bold text-slate-800">■ {g.group}</td>
                      <td className="text-right px-3 py-2 font-bold text-slate-800 whitespace-nowrap">{fmt(g.total)}</td>
                      <td className="text-right px-3 py-2 font-bold text-slate-600 whitespace-nowrap">{pctFmt(g.total, groupedTotal)}</td>
                    </tr>
                    {/* 그룹 안의 중분류 들여쓰기 */}
                    {(g.rows ?? []).map((r: any) => (
                      <tr key={r.mid_code} className="border-t border-slate-50 hover:bg-slate-50/40">
                        <td className="px-3 py-2 text-slate-600 pl-8">{r.mid_label}</td>
                        <td className="text-right px-3 py-2 whitespace-nowrap font-medium">{fmt(r.amount)}</td>
                        <td className="text-right px-3 py-2 whitespace-nowrap text-slate-500">{pctFmt(r.amount, groupedTotal)}</td>
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
                <tr className="border-t-2 border-slate-200 bg-slate-100">
                  <td className="px-3 py-2 font-bold text-slate-800">{groupedLabel}</td>
                  <td className="text-right px-3 py-2 font-bold text-slate-900 whitespace-nowrap">{fmt(groupedTotal)}</td>
                  <td className="text-right px-3 py-2 font-bold text-slate-500 whitespace-nowrap">100%</td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-8">데이터 없음</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-100">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                {cols.map((c) => (
                  <th key={c.key} className={`px-3 py-2 font-semibold text-slate-600 whitespace-nowrap text-${c.align ?? 'left'}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-50 hover:bg-slate-50/40">
                  {cols.map((c) => (
                    <td key={c.key} className={`px-3 py-2 text-${c.align ?? 'left'} ${c.align === 'right' ? 'whitespace-nowrap font-medium' : ''}`}>
                      {c.render ? c.render(r[c.key], r) : (r[c.key] ?? '-')}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t-2 border-slate-200 bg-slate-50">
                <td colSpan={cols.length - 2} className="px-3 py-2 font-bold text-slate-700">{totalLabel}</td>
                <td className="px-3 py-2 text-right font-bold text-slate-800 whitespace-nowrap">{fmt(total)}</td>
                <td className="px-3 py-2 text-right font-bold text-slate-500 whitespace-nowrap">100%</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// 매입/불출 아코디언 — 「업체별 매입」/「부서별 불출」 공용.
//   kind: 'purchase' = 업체별 매입 / 'issue' = 부서별 불출
//   entities: vendor_breakdown 또는 dept_breakdown 배열
//   total: totalPurchased 또는 totalIssued (전체 비중 분모)
function BreakdownAccordionPanel({ kind, entities, total }: {
  kind: 'purchase' | 'issue';
  entities: any[];
  total: number;
}) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const fmt = (n: number) => `₩${Math.round(Number(n) || 0).toLocaleString()}`;
  const pctFmt = (v: number, t: number) => t > 0 ? `${((v / t) * 100).toFixed(1)}%` : '-';
  const idOf = (e: any): string => kind === 'purchase' ? e.vendor_id : e.dept_id;
  const nameOf = (e: any): string => kind === 'purchase' ? e.vendor_name : e.dept_name;
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpanded(next);
  };
  const expandAll = () => setExpanded(new Set(entities.map(idOf)));
  const collapseAll = () => setExpanded(new Set());

  const labels = kind === 'purchase'
    ? { title: '업체별 매입', entityLabel: '거래처', amountLabel: '매입금액', sumLabel: '매입 합계',
        desc: '각 거래처의 분류·중분류 분포 (▶ 클릭해서 펼침). 비중은 거래처 안 100% 기준.' }
    : { title: '부서별 불출', entityLabel: '부서', amountLabel: '불출금액', sumLabel: '불출 합계',
        desc: '각 부서가 어떤 분류·중분류를 불출했는지 (▶ 클릭해서 펼침). 비중은 부서 안 100% 기준.' };

  if (entities.length === 0) {
    return <p className="text-xs text-slate-400 text-center py-10">데이터 없음</p>;
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
      <div className="flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-700">{labels.title}</h3>
          <p className="text-[11px] text-slate-400 mt-0.5">{labels.desc}</p>
        </div>
        <div className="flex gap-2 text-[11px]">
          <button className="text-blue-600 hover:underline" onClick={expandAll}>모두 펼치기</button>
          <span className="text-slate-300">·</span>
          <button className="text-slate-500 hover:underline" onClick={collapseAll}>모두 접기</button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-100">
        <table className="w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              <th className="text-left px-3 py-2 font-semibold text-slate-600 w-8"></th>
              <th className="text-left px-3 py-2 font-semibold text-slate-600">{labels.entityLabel}</th>
              <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">{labels.amountLabel}</th>
              <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">전체 비중</th>
            </tr>
          </thead>
          <tbody>
            {entities.map((e: any) => {
              const id = idOf(e);
              const isOpen = expanded.has(id);
              return (
                <React.Fragment key={id}>
                  <tr className="border-t border-slate-100 hover:bg-slate-50/40 cursor-pointer" onClick={() => toggle(id)}>
                    <td className="px-3 py-2 text-slate-400 text-center">{isOpen ? '▼' : '▶'}</td>
                    <td className="px-3 py-2 font-medium text-slate-700">{nameOf(e)}</td>
                    <td className="text-right px-3 py-2 whitespace-nowrap font-medium">{fmt(e.total)}</td>
                    <td className="text-right px-3 py-2 whitespace-nowrap text-slate-500">{pctFmt(e.total, total)}</td>
                  </tr>
                  {isOpen && (e.groups ?? []).map((g: any) => (
                    <React.Fragment key={`${id}-${g.group}`}>
                      <tr className="border-t border-slate-50 bg-slate-50/40">
                        <td className="px-3 py-1.5"></td>
                        <td className="px-3 py-1.5 pl-8 font-semibold text-slate-700">■ {g.group}</td>
                        <td className="text-right px-3 py-1.5 whitespace-nowrap font-semibold text-slate-700">{fmt(g.total)}</td>
                        <td className="text-right px-3 py-1.5 whitespace-nowrap text-slate-600">{pctFmt(g.total, e.total)}</td>
                      </tr>
                      {(g.rows ?? []).map((r: any) => (
                        <tr key={`${id}-${r.mid_code}`} className="border-t border-slate-50">
                          <td className="px-3 py-1.5"></td>
                          <td className="px-3 py-1.5 pl-14 text-slate-600">{r.mid_label}</td>
                          <td className="text-right px-3 py-1.5 whitespace-nowrap">{fmt(r.amount)}</td>
                          <td className="text-right px-3 py-1.5 whitespace-nowrap text-slate-500">{pctFmt(r.amount, e.total)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </React.Fragment>
              );
            })}
            <tr className="border-t-2 border-slate-200 bg-slate-100">
              <td className="px-3 py-2"></td>
              <td className="px-3 py-2 font-bold text-slate-800">{labels.sumLabel}</td>
              <td className="text-right px-3 py-2 font-bold text-slate-900 whitespace-nowrap">{fmt(total)}</td>
              <td className="text-right px-3 py-2 font-bold text-slate-500 whitespace-nowrap">100%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// 거래처별 분석 패널 — 거래처 드롭다운 + 그 거래처의 분류별 매입 표
function VendorDetailPanel({ vendors, selectedVendor, onSelect, loading, data, hideSelect = false }: {
  vendors: any[]; selectedVendor: string; onSelect: (id: string) => void;
  loading: boolean; data: any; hideSelect?: boolean;
}) {
  const fmt = (n: number) => `₩${Math.round(Number(n) || 0).toLocaleString()}`;
  const byMajor: any[] = data?.by_major ?? [];
  const total: number = data?.total_amount ?? 0;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
      {/* 거래처 선택 + 상단 KPI */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!hideSelect ? (
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">거래처</label>
            <select
              className="bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px]"
              value={selectedVendor}
              onChange={(e) => onSelect(e.target.value)}
            >
              <option value="">거래처를 선택하세요</option>
              {vendors.map((v: any) => (
                <option key={v.vendor_id} value={v.vendor_id}>{v.vendor_name}</option>
              ))}
            </select>
          </div>
        ) : (
          <h3 className="text-sm font-bold text-slate-800">{data?.vendor?.name ?? '거래처'} 분석</h3>
        )}
        {data && (
          <div className="flex gap-3 text-xs">
            <span className="text-slate-500">총 매입 <b className="text-emerald-700 ml-1">{fmt(total)}</b></span>
            <span className="text-slate-300">·</span>
            <span className="text-slate-500">발주 라인 <b className="text-slate-700 ml-1">{data.line_count ?? 0}건</b></span>
            <span className="text-slate-300">·</span>
            <span className="text-slate-500">분류 <b className="text-slate-700 ml-1">{byMajor.length}개</b></span>
          </div>
        )}
      </div>

      {/* 분류별 매입 표 */}
      {!selectedVendor ? (
        <p className="text-xs text-slate-400 text-center py-10">위 드롭다운에서 거래처를 선택하세요.</p>
      ) : loading ? (
        <p className="text-xs text-slate-400 text-center py-10">로딩 중...</p>
      ) : !data || byMajor.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-10">이번 달 해당 거래처의 매입 내역 없음.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-100">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-slate-600">분류</th>
                <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">매입금액</th>
                <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">비중</th>
              </tr>
            </thead>
            <tbody>
              {byMajor.map((r: any) => (
                <tr key={r.label} className="border-t border-slate-50 hover:bg-slate-50/40">
                  <td className="px-3 py-2 text-slate-700">{r.label}</td>
                  <td className="text-right px-3 py-2 whitespace-nowrap font-medium">{fmt(r.amount)}</td>
                  <td className="text-right px-3 py-2 whitespace-nowrap text-slate-500">
                    {total > 0 ? `${((r.amount / total) * 100).toFixed(1)}%` : '-'}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-slate-200 bg-slate-50">
                <td className="px-3 py-2 font-bold text-slate-700">합계</td>
                <td className="text-right px-3 py-2 font-bold text-slate-800 whitespace-nowrap">{fmt(total)}</td>
                <td className="text-right px-3 py-2 font-bold text-slate-500 whitespace-nowrap">100%</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[10px] text-slate-400">
        ※ 선택한 거래처의 해당 월 PO 라인을 분류(대분류)별로 합산. 비용구분 필터와 연동됨.
      </p>
    </div>
  );
}

function DiaperPnLPanel({ loading, data, period, onReload }: { loading: boolean; data: any; period: { year: number; month: number }; onReload?: () => void }) {
  const { showToast } = useToast();
  const fmt = (n: number) => `₩${Number(n || 0).toLocaleString()}`;
  const [editingCode, setEditingCode] = React.useState<string | null>(null);
  const [editVal, setEditVal] = React.useState<string>('');
  const [editDate, setEditDate] = React.useState<string>('');
  const [busy, setBusy] = React.useState(false);

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 text-center text-xs text-slate-400">기저귀 통계 로딩 중...</div>
    );
  }
  if (!data) return null;
  const { patients: pt, cost: c, per_in_house: pi, usage: us } = data;
  const breakdown = Array.isArray(c?.purchase_breakdown) ? c.purchase_breakdown : [];
  const usageByItem: any[] = Array.isArray(us?.by_item) ? us.by_item : [];
  const usageUom = usageByItem[0]?.uom || '팩';
  const allHave: boolean = !!us?.all_items_have_units;

  const beginEdit = (row: any) => {
    setEditingCode(row.item_code);
    setEditVal(row.current_units_per_pack != null ? String(row.current_units_per_pack) : '');
    setEditDate(new Date().toISOString().slice(0, 10));
  };
  const saveEdit = async (row: any) => {
    const n = Number(editVal);
    if (!Number.isInteger(n) || n < 1) { showToast('1 이상 정수를 입력하세요.', 'error'); return; }
    setBusy(true);
    try {
      await api('/cost/item-units-per-pack', {
        method: 'PATCH',
        body: JSON.stringify({ item_id: row.item_id, units_per_pack: n, effective_from: editDate || undefined }),
      });
      showToast(`${row.name} 팩당 ${n}장 — ${editDate || '오늘'} 부터 적용`, 'success');
      setEditingCode(null);
      onReload?.();
    } catch (e: any) {
      showToast(e?.message || '저장 실패', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-gradient-to-br from-amber-50/60 to-white rounded-2xl border border-amber-100 shadow-sm p-5 space-y-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-bold text-slate-800">기저귀 통계</h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {period.year}년 {period.month}월 · 사용 환자 분포 + 기저귀·이지메트 구매·소각비용
          </p>
        </div>
        <div className="px-3 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
          총 비용 {fmt(c.total)}
        </div>
      </div>

      {/* 환자 분포 — 일평균 (그 달 ward_room_boards 기록일 평균) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="bg-white rounded-xl border border-amber-100 px-3 py-2.5">
          <div className="text-[11px] text-slate-500">사용 환자 <span className="text-slate-400">(일평균)</span></div>
          <div className="text-lg font-bold text-slate-800">{pt.using}명</div>
        </div>
        <div className="bg-white rounded-xl border border-amber-200 px-3 py-2.5">
          <div className="text-[11px] text-amber-700">원내 사용 <span className="text-amber-500">(일평균)</span></div>
          <div className="text-lg font-bold text-amber-700">{pt.in_house}명</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-100 px-3 py-2.5">
          <div className="text-[11px] text-slate-500">본인 지참 <span className="text-slate-400">(일평균)</span></div>
          <div className="text-lg font-bold text-slate-700">{pt.personal}명</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-100 px-3 py-2.5">
          <div className="text-[11px] text-slate-400">미사용 <span className="text-slate-300">(일평균)</span></div>
          <div className="text-lg font-bold text-slate-500">{pt.none}명</div>
        </div>
      </div>
      <p className="text-[10px] text-slate-400 -mt-1">※ 그 달 병실현황판 기록 {pt.recorded_days}일치의 일평균 (실제 재원 환자 기준)</p>

      {/* 비용 */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <div className="bg-white rounded-xl border border-red-100 px-3 py-2.5">
          <div className="text-[11px] text-red-600">구매비용</div>
          <div className="text-base font-bold text-red-700">{fmt(c.purchase)}</div>
          <div className="text-[10px] text-slate-400 mt-0.5">기저귀(속/겉) + 이지메트</div>
        </div>
        <div className="bg-white rounded-xl border border-red-100 px-3 py-2.5">
          <div className="text-[11px] text-red-600">소각비용</div>
          <div className="text-base font-bold text-red-700">{fmt(c.incineration)}</div>
          <div className="text-[10px] text-slate-400 mt-0.5">{c.incineration_kg > 0 ? `${c.incineration_kg}kg` : '—'}</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 px-3 py-2.5">
          <div className="text-[11px] text-slate-600">총 비용</div>
          <div className="text-base font-bold text-slate-800">{fmt(c.total)}</div>
          <div className="text-[10px] text-slate-400 mt-0.5">구매 + 소각</div>
        </div>
      </div>

      {/* 사용량 — 품목별 표 + inline 편집 + 시점별 환산 장수 */}
      {us && usageByItem.length > 0 && (
        <div className="bg-white rounded-xl border border-blue-100 p-4">
          <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
            <div>
              <h4 className="text-sm font-bold text-blue-700">기저귀 사용량</h4>
              <p className="text-[11px] text-slate-500 mt-0.5">품목별 사용 팩수 × 팩당 장수 = 환산 장수. 시점별 이력 적용.</p>
            </div>
            {allHave && (
              <div className="text-right">
                <div className="text-[11px] text-slate-500">원내 1인당 1일 사용량</div>
                <div className="text-base font-bold text-blue-700">{us.per_patient_day} 장/일 <span className="text-[11px] text-slate-400">(이지메트 제외)</span></div>
              </div>
            )}
          </div>

          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-slate-600">품목</th>
                <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">사용 팩수</th>
                <th className="text-center px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">팩당 장수</th>
                <th className="text-right px-3 py-2 font-semibold text-slate-600 whitespace-nowrap">환산 장수</th>
              </tr>
            </thead>
            <tbody>
              {usageByItem.map((u: any) => {
                const editing = editingCode === u.item_code;
                return (
                  <tr key={u.item_code} className="border-t border-slate-50">
                    <td className="px-3 py-2 text-slate-700">
                      {u.name} <span className="text-slate-400">({u.item_code})</span>
                      {u.is_mat && <span className="ml-2 text-[10px] bg-slate-100 text-slate-500 px-1 rounded">사용량 계산 제외</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-700 whitespace-nowrap">{u.qty_pack.toLocaleString()} {u.uom}</td>
                    <td className="px-3 py-2 text-center whitespace-nowrap">
                      {editing ? (
                        <span className="inline-flex items-center gap-1">
                          <input
                            type="number"
                            className="input w-16 py-0.5 text-right text-xs"
                            autoFocus
                            value={editVal}
                            min={1}
                            onChange={(e) => setEditVal(e.target.value)}
                          />
                          <span className="text-[10px] text-slate-400">장</span>
                          <input
                            type="date"
                            className="input w-32 py-0.5 text-xs"
                            value={editDate}
                            onChange={(e) => setEditDate(e.target.value)}
                            title="적용 시작일 (이 날짜부터의 출고에 적용)"
                          />
                          <button className="text-emerald-600 text-xs" disabled={busy} onClick={() => saveEdit(u)}>저장</button>
                          <button className="text-slate-400 text-xs" onClick={() => setEditingCode(null)}>취소</button>
                        </span>
                      ) : u.current_units_per_pack != null ? (
                        <button className="text-blue-600 hover:underline" onClick={() => beginEdit(u)}>
                          {u.current_units_per_pack}장 ✎
                        </button>
                      ) : (
                        <button className="text-red-500 hover:underline" onClick={() => beginEdit(u)}>
                          ✎ 입력 필요
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                      {u.has_history ? (
                        <span className="text-blue-700">{u.qty_units.toLocaleString()} 장</span>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {allHave && (
                <tr className="border-t-2 border-slate-200 bg-slate-50">
                  <td className="px-3 py-2 font-bold text-slate-700">월 합계 (이지메트 제외)</td>
                  <td className="px-3 py-2"></td>
                  <td className="px-3 py-2"></td>
                  <td className="px-3 py-2 text-right font-bold text-blue-700 whitespace-nowrap">
                    {us.total_units_excl_mat.toLocaleString()} 장
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {!allHave && (
            <p className="text-[11px] text-amber-600 mt-3">
              ※ 「✎ 입력 필요」 표시된 품목의 팩당 장수를 입력하세요. 첫 입력 시에는 적용 시작일과 무관하게
              <b> 그 품목의 모든 과거 출고에도 같은 값으로 환산</b>됩니다. 이후 제품이 바뀌어 새 값으로 적용해야 할 땐
              ✎ 다시 클릭 → 적용 시작일을 그 날짜로 지정 → 그 이후 출고만 새 값 적용 (과거는 옛 값 유지).
            </p>
          )}
          {allHave && (
            <p className="text-[10px] text-slate-400 mt-3">
              ※ 환산 장수는 각 출고 시점의 「팩당 장수」 이력을 적용한 결과. 제품이 바뀌어 새 장수로 적용해야 할 땐 ✎ 클릭 → 적용 시작일을 그 날짜로.
            </p>
          )}
        </div>
      )}

      {/* 원내 1인당 구매원가 */}
      {pt.in_house > 0 && (
        <div className="bg-white rounded-xl border border-amber-100 p-3">
          <div className="text-[11px] text-slate-500 font-semibold mb-2">원내 환자 1인당 ({pt.in_house}명 일평균 기준)</div>
          <div className="text-center">
            <div className="text-[11px] text-slate-500">구매원가 (월)</div>
            <div className="text-base font-bold text-red-600">{fmt(pi.purchase)}</div>
          </div>
        </div>
      )}

      {/* 구매 품목 내역 */}
      {breakdown.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-100 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-slate-600">품목</th>
                <th className="text-right px-3 py-2 font-semibold text-slate-600">발주수량</th>
                <th className="text-right px-3 py-2 font-semibold text-slate-600">금액</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((b: any) => (
                <tr key={b.item_code} className="border-t border-slate-50">
                  <td className="px-3 py-2 text-slate-700">{b.name} <span className="text-slate-400">({b.item_code})</span></td>
                  <td className="px-3 py-2 text-right text-slate-600">{b.qty}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-700">{fmt(b.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-slate-400">
        ※ 환자 청구·수납 내역은 EMR 에서 별도 관리 — 본 시스템에는 회수금액·손익이 산출되지 않습니다.
        환자 분포는 그 달 병실현황판 일자별 기록의 평균치.
      </p>
    </div>
  );
}
