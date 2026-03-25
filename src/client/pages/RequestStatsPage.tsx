import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { StatsKpiCard, StatsChartCard, StatsTableCard, StatsFilterBar, StatsTabBar } from '../components/stats';

const API = '/api/request-stats';
function getToken() { return localStorage.getItem('token') || ''; }
function authHeaders() { return { Authorization: `Bearer ${getToken()}` }; }
function fmt(n: number) { return n.toLocaleString('ko-KR'); }

const COLORS = ['#0d9488', '#0891b2', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#6366f1', '#10b981'];

const TYPE_LABELS: Record<string, string> = {
  CONSUMABLE_REGULAR: '정기 소모품', DIAPER: '기저귀', NIGHT_SNACK: '야식',
  ADHOC: '수시', EQUIPMENT: '장비', CONSUMABLE: '소모품(구)', UNKNOWN: '기타',
};

const TABS = [
  { key: 'approval', label: '부서별 승인율' },
  { key: 'time', label: '승인 소요시간' },
  { key: 'qty', label: '수량 차이' },
  { key: 'type', label: '유형 분포' },
];

export default function RequestStatsPage() {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const [tab, setTab] = useState('approval');
  const [dateFrom, setDateFrom] = useState(sixMonthsAgo.toISOString().slice(0, 10));
  const [dateTo, setDateTo] = useState(now.toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}?date_from=${dateFrom}&date_to=${dateTo}`, { headers: authHeaders() });
      setData(await res.json());
    } catch { /* */ }
    setLoading(false);
  }, [dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const depts = data?.by_department || [];
  const types = (data?.by_type || []).map((t: any) => ({ ...t, label: TYPE_LABELS[t.request_type] || t.request_type }));
  const summary = data?.summary || {};

  return (
    <div className="space-y-5">
      <StatsTabBar tabs={TABS} active={tab} onChange={setTab} />

      <StatsFilterBar>
        <div>
          <label className="label">시작일</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="input w-40" />
        </div>
        <div>
          <label className="label">종료일</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="input w-40" />
        </div>
      </StatsFilterBar>

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatsKpiCard label="총 신청" value={fmt(summary.total_requests || 0)} valueColor="text-teal-600" />
        <StatsKpiCard label="승인 건수" value={fmt(summary.total_approved || 0)} valueColor="text-green-600" />
        <StatsKpiCard label="전체 승인율" value={`${summary.overall_approval_rate || 0}%`} valueColor="text-blue-600" />
      </div>

      {loading && <p className="text-sm text-gray-500">로딩 중...</p>}

      {/* 부서별 승인율 */}
      {tab === 'approval' && !loading && (
        <div className="space-y-5">
          {depts.length > 0 && (
            <StatsChartCard title="부서별 승인율 (%)">
              <BarChart data={depts}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="department_name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                <Tooltip formatter={(v: any) => [`${v}%`, '승인율']} />
                <Bar dataKey="approval_rate" fill="#0d9488" radius={[4, 4, 0, 0]} />
              </BarChart>
            </StatsChartCard>
          )}
          <StatsTableCard isEmpty={depts.length === 0}>
            <table className="tbl">
              <thead><tr><th>부서</th><th className="text-right">총 신청</th><th className="text-right">승인</th><th className="text-right">반려</th><th className="text-right">승인율</th></tr></thead>
              <tbody>
                {depts.map((d: any, i: number) => (
                  <tr key={i}>
                    <td>{d.department_name}</td>
                    <td className="text-right">{d.total_requests}</td>
                    <td className="text-right text-green-600">{d.approved + d.partial}</td>
                    <td className="text-right text-red-600">{d.rejected}</td>
                    <td className="text-right font-semibold">{d.approval_rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StatsTableCard>
        </div>
      )}

      {/* 승인 소요시간 */}
      {tab === 'time' && !loading && (
        <div className="space-y-5">
          {depts.length > 0 && (
            <StatsChartCard title="부서별 평균 승인 소요시간 (일)">
              <BarChart data={depts}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="department_name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => [`${v}일`, '평균 소요시간']} />
                <Bar dataKey="avg_approval_days" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </StatsChartCard>
          )}
          <StatsTableCard isEmpty={depts.length === 0}>
            <table className="tbl">
              <thead><tr><th>부서</th><th className="text-right">평균 소요시간</th><th className="text-right">총 신청</th></tr></thead>
              <tbody>
                {depts.map((d: any, i: number) => (
                  <tr key={i}>
                    <td>{d.department_name}</td>
                    <td className="text-right">{d.avg_approval_days}일</td>
                    <td className="text-right">{d.total_requests}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StatsTableCard>
        </div>
      )}

      {/* 수량 차이 */}
      {tab === 'qty' && !loading && (
        <StatsTableCard isEmpty={depts.length === 0}>
          <table className="tbl">
            <thead><tr><th>부서</th><th className="text-right">신청 수량</th><th className="text-right">승인 수량</th><th className="text-right">차이(%)</th></tr></thead>
            <tbody>
              {depts.map((d: any, i: number) => (
                <tr key={i}>
                  <td>{d.department_name}</td>
                  <td className="text-right">{fmt(d.requested_qty)}</td>
                  <td className="text-right">{fmt(d.approved_qty)}</td>
                  <td className="text-right">
                    <span className={d.qty_diff_pct < 0 ? 'text-red-600' : 'text-green-600'}>{d.qty_diff_pct > 0 ? '+' : ''}{d.qty_diff_pct}%</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </StatsTableCard>
      )}

      {/* 유형 분포 */}
      {tab === 'type' && !loading && (
        <div className="space-y-5">
          {types.length > 0 && (
            <StatsChartCard title="유형별 분포">
              <PieChart>
                <Pie data={types} dataKey="count" nameKey="label" cx="50%" cy="50%"
                  outerRadius={100} label={({ label, percent }: any) => `${label} ${(percent * 100).toFixed(0)}%`}>
                  {types.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </StatsChartCard>
          )}
          <StatsTableCard isEmpty={types.length === 0}>
            <table className="tbl">
              <thead><tr><th>유형</th><th className="text-right">건수</th></tr></thead>
              <tbody>
                {types.map((d: any, i: number) => (
                  <tr key={i}><td>{d.label}</td><td className="text-right">{fmt(d.count)}</td></tr>
                ))}
              </tbody>
            </table>
          </StatsTableCard>
        </div>
      )}
    </div>
  );
}
