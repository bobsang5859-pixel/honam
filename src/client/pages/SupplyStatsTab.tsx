import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
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

export default function SupplyStatsTab({ deptId }: { deptId: string }) {
  const [cost, setCost] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });

  useEffect(() => {
    setLoading(true);
    const q = deptId ? `&department_id=${deptId}` : '';
    Promise.all([
      api(`/cost/statistics?year=${period.year}&month=${period.month}${q}`).catch(() => ({})),
      api(`/cost/vendor-summary?year=${period.year}${q}`).catch(() => []),
      api(`/patients/stats?date_from=${period.year}-${String(period.month).padStart(2,'0')}-01&date_to=${period.year}-${String(period.month).padStart(2,'0')}-28${deptId ? `&department_id=${deptId}` : ''}`).catch(() => null),
    ]).then(([costData, vendorData, patientData]) => {
      setCost({
        ...(costData || {}),
        by_vendor: Array.isArray(vendorData) ? vendorData : [],
        patient_count: patientData?.overall?.total_occupied ?? 0,
      });
    }).finally(() => setLoading(false));
  }, [period, deptId]);

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

  // 부서별 도넛 데이터
  const deptDonut = byDept.slice(0, 6).map((d: any) => ({
    name: d.dept_name || d.department_name,
    value: d.amount,
  }));
  const deptTotal = deptDonut.reduce((s: number, d: any) => s + d.value, 0);

  // 거래처별 도넛 데이터
  const vendorDonut = byVendor.slice(0, 6).map((v: any) => ({
    name: v.vendor_name,
    value: v.amount,
  }));
  const vendorTotal = vendorDonut.reduce((s: number, d: any) => s + d.value, 0);

  return (
    <div className="space-y-6">
      {/* 기간 선택 */}
      <div className="flex items-center gap-2 no-print">
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

      {/* ─── 핵심 KPI (그라데이션 카드) ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <BigKpi label="월 불출금액" value={`₩${totalIssued.toLocaleString()}`} color="blue" />
        <BigKpi label="월 구매금액" value={`₩${totalPurchased.toLocaleString()}`} color="green" />
        <BigKpi label="환자 수" value={`${patientCount}명`} color="teal" />
        <BigKpi label="1인당 재료비" value={perPatient > 0 ? `₩${perPatient.toLocaleString()}` : '-'} color="amber" />
      </div>

      {/* ─── 분석 개요 + 상위 품목 ─── */}
      <div className="grid lg:grid-cols-3 gap-4">
        {/* Pinterest 스타일 분석 개요 */}
        <OverviewCard title="분석 개요" period={`${period.year}년 ${period.month}월`}>
          <MetricRow label="불출금액" value={`₩${totalIssued.toLocaleString()}`} />
          <MetricRow label="구매금액" value={`₩${totalPurchased.toLocaleString()}`} />
          <MetricRow label="품목 수" value={`${byItem.length}건`} />
          <MetricRow label="거래처 수" value={`${byVendor.length}곳`} />
          <MetricRow label="환자 수" value={`${patientCount}명`} />
          <MetricRow label="1인당 재료비" value={perPatient > 0 ? `₩${perPatient.toLocaleString()}` : '-'} />
        </OverviewCard>

        {/* 상위 품목 (Pinterest 상위 핀 스타일) */}
        <OverviewCard title="상위 품목" period="불출금액 기준" className="lg:col-span-2">
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
        </OverviewCard>
      </div>

      {/* ─── 월별 추이 차트 (세일즈 리포트 스타일) ─── */}
      {monthly.length > 0 && (
        <StatsChartCard title="월별 구매비용 추이" subtitle="최근 12개월">
          <BarChart data={monthly.slice(-12).map((m: any) => ({
            label: String(m.month).slice(-2) + '월',
            amount: Math.round(m.amount),
            display: Math.round(m.amount / 10000),
          }))}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} />
            <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(v: number) => `${v.toLocaleString()}`} />
            <Tooltip
              contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}
              formatter={(v: any) => [`₩${Number(v).toLocaleString()}`, '금액']}
            />
            <Bar dataKey="amount" fill="#3b82f6" radius={[6, 6, 0, 0]} />
          </BarChart>
        </StatsChartCard>
      )}

      {/* ─── 도넛 차트 2개 (도넛 + 우측 범례) ─── */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h3 className="text-sm font-bold text-slate-700 mb-3">부서별 불출 비중</h3>
          {deptDonut.length > 0
            ? <DonutWithLegend data={deptDonut} />
            : <p className="text-xs text-slate-400 text-center py-8">데이터 없음</p>}
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h3 className="text-sm font-bold text-slate-700 mb-3">거래처별 구매 비중</h3>
          {vendorDonut.length > 0
            ? <DonutWithLegend data={vendorDonut} />
            : <p className="text-xs text-slate-400 text-center py-8">데이터 없음</p>}
        </div>
      </div>

      {/* ─── 거래처 상세 테이블 (세일즈 리포트 스타일) ─── */}
      {byVendor.length > 0 && (
        <ReportTable
          title="거래처별 거래 현황"
          columns={[
            { key: 'vendor_name', label: '거래처', width: '30%' },
            { key: 'amount', label: '금액', align: 'right', render: (v: number) => `₩${Number(v || 0).toLocaleString()}` },
            { key: 'pct', label: '매출비중(%)', align: 'right', render: (v: number) => `${v}%` },
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

      {/* ─── 재고 및 자원관리 ─── */}
      <OverviewCard title="재고 및 자원관리">
        <MetricRow label="재고 금액" value={`₩${(cost?.stock_value ?? 0).toLocaleString()}`} />
        <MetricRow label="적정재고 유지율" value={`${cost?.adequate_stock_rate ?? '-'}%`} />
        <MetricRow label="폐기/손실" value={`₩${(cost?.waste_amount ?? 0).toLocaleString()}`} />
        <p className="text-[11px] text-slate-400 mt-3 pt-3 border-t border-gray-50">상세 재고회전율 및 폐기 통계는 데이터 축적 후 표시됩니다.</p>
      </OverviewCard>
    </div>
  );
}
