import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
  LineChart, Line,
} from 'recharts';

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

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

  if (loading) return <div className="text-center py-12 text-slate-400 text-sm">로딩 중...</div>;

  const monthly = cost?.monthly_trend ?? [];
  const byDept = cost?.by_department ?? [];
  const byItem = cost?.by_item ?? [];
  const byVendor = cost?.by_vendor ?? [];

  return (
    <div className="space-y-6">
      {/* 기간 선택 */}
      <div className="flex items-center gap-3">
        <select className="input text-sm" value={period.year} onChange={e => setPeriod(p => ({ ...p, year: Number(e.target.value) }))}>
          {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}년</option>)}
        </select>
        <select className="input text-sm" value={period.month} onChange={e => setPeriod(p => ({ ...p, month: Number(e.target.value) }))}>
          {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}월</option>)}
        </select>
      </div>

      {/* ─── 1. 구매 및 비용통계 ─── */}
      <Section title="구매 및 비용통계">
        {/* KPI */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <KPI label="월 불출금액" value={`₩${(cost?.total_issued ?? 0).toLocaleString()}`} color="blue" />
          <KPI label="월 구매금액" value={`₩${(cost?.total_purchased ?? 0).toLocaleString()}`} color="green" />
          <KPI label="환자 수" value={`${cost?.patient_count ?? '-'}명`} color="teal" />
          <KPI label="1인당 재료비" value={cost?.patient_count > 0 ? `₩${Math.round((cost?.total_issued ?? 0) / cost.patient_count).toLocaleString()}` : '-'} color="amber" />
        </div>

        {/* 월별 추이 — 막대 + 라인 복합 차트 */}
        {monthly.length > 0 && (
          <div className="mb-5">
            <p className="text-xs font-bold text-slate-500 mb-3">월별 구매비용 추이</p>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={monthly.slice(-12).map((m: any) => ({ ...m, label: String(m.month).slice(-2) + '월', amt: Math.round(m.amount / 10000) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(v: number) => `${v}만`} />
                <Tooltip formatter={(v: any) => [`₩${(v * 10000).toLocaleString()}`, '금액']} />
                <Bar dataKey="amt" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* 부서별 파이 + 품목별 바 + 거래처 파이 */}
        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <p className="text-xs font-bold text-slate-500 mb-2">부서별 불출 비중</p>
            {byDept.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={byDept.slice(0, 6).map((d: any) => ({ name: d.dept_name || d.department_name, value: d.amount }))} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                    {byDept.slice(0, 6).map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: any) => `₩${Number(v).toLocaleString()}`} />
                </PieChart>
              </ResponsiveContainer>
            ) : <p className="text-xs text-slate-300 text-center py-8">데이터 없음</p>}
          </div>
          <BarList title="품목별 불출금액" data={byItem.slice(0, 8).map((d: any) => ({ name: d.item_name, value: d.amount }))} />
          <div>
            <p className="text-xs font-bold text-slate-500 mb-2">거래처별 구매 비중</p>
            {byVendor.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={byVendor.slice(0, 6).map((d: any) => ({ name: d.vendor_name, value: d.amount }))} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                    {byVendor.slice(0, 6).map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: any) => `₩${Number(v).toLocaleString()}`} />
                </PieChart>
              </ResponsiveContainer>
            ) : <p className="text-xs text-slate-300 text-center py-8">데이터 없음</p>}
          </div>
        </div>
      </Section>

      {/* ─── 2. 재고 및 자원관리 ─── */}
      <Section title="재고 및 자원관리 통계">
        <div className="grid md:grid-cols-3 gap-3 mb-4">
          <KPI label="재고 금액" value={`₩${(cost?.stock_value ?? 0).toLocaleString()}`} color="indigo" />
          <KPI label="적정재고 유지율" value={`${cost?.adequate_stock_rate ?? '-'}%`} color="green" />
          <KPI label="폐기/손실" value={`₩${(cost?.waste_amount ?? 0).toLocaleString()}`} color="red" />
        </div>
        <p className="text-xs text-slate-400">상세 재고회전율 및 폐기 통계는 데이터 축적 후 표시됩니다.</p>
      </Section>

      {/* ─── 3. 공급업체 및 단가 ─── */}
      <Section title="공급업체 및 단가 관리">
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-bold text-slate-500 mb-2">업체별 거래 비중</p>
            {byVendor.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={byVendor.slice(0, 8).map((v: any) => ({ name: v.vendor_name, value: v.amount }))} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                    {byVendor.slice(0, 8).map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: any) => `₩${Number(v).toLocaleString()}`} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : <p className="text-xs text-slate-300 text-center py-8">데이터 없음</p>}
          </div>
          <div>
            <p className="text-xs font-bold text-slate-500 mb-2">구매 단가 변동</p>
            <p className="text-xs text-slate-400">단가 변동 추이는 데이터 축적 후 표시됩니다.</p>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-5 py-3 bg-gray-50 hover:bg-gray-100 transition-colors">
        <span className="text-sm font-bold text-slate-700">{title}</span>
        <span className="text-slate-400 text-lg">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="p-5">{children}</div>}
    </div>
  );
}

function KPI({ label, value, color }: { label: string; value: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    green: 'bg-green-50 border-green-200 text-green-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    teal: 'bg-teal-50 border-teal-200 text-teal-700',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
  };
  return (
    <div className={`border rounded-xl p-3 ${colors[color] || colors.blue}`}>
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="text-lg font-extrabold mt-0.5">{value}</p>
    </div>
  );
}

function BarList({ title, data }: { title: string; data: { name: string; value: number }[] }) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div>
      <p className="text-xs font-bold text-slate-500 mb-2">{title}</p>
      {data.length > 0 ? (
        <div className="space-y-1.5">
          {data.slice(0, 6).map((d, i) => (
            <div key={d.name} className="flex items-center gap-2 text-xs">
              <span className="w-16 text-right text-slate-500 truncate">{d.name}</span>
              <div className="flex-1 h-4 bg-gray-50 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${(d.value / max) * 100}%`, background: COLORS[i % COLORS.length] }} />
              </div>
              <span className="w-14 text-right text-slate-600 font-medium">{d.value > 10000 ? `${(d.value / 10000).toFixed(0)}만` : d.value.toLocaleString()}</span>
            </div>
          ))}
        </div>
      ) : <p className="text-xs text-slate-300">데이터 없음</p>}
    </div>
  );
}
