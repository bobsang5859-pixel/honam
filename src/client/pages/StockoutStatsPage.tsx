import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from 'recharts';
import { StatsKpiCard, StatsChartCard, StatsTableCard, StatsFilterBar, StatsTabBar } from '../components/stats';

const API = '/api/stockout-stats';
function getToken() { return localStorage.getItem('token') || ''; }
function authHeaders() { return { Authorization: `Bearer ${getToken()}` }; }
function fmt(n: number) { return n.toLocaleString('ko-KR'); }

const COLORS = ['#0d9488', '#ef4444', '#f59e0b', '#8b5cf6', '#ec4899', '#6366f1'];

const TABS = [
  { key: 'rate', label: '발생률' },
  { key: 'resolution', label: '해결 소요시간' },
  { key: 'items', label: '문제 품목 TOP' },
  { key: 'type', label: '유형 분포' },
];

export default function StockoutStatsPage() {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const [tab, setTab] = useState('rate');
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

  const summary = data?.summary || {};
  const byType = data?.by_type || [];
  const byStatus = data?.by_status || [];
  const topItems = data?.top_items || [];
  const monthly = data?.monthly || [];
  const byDept = data?.by_department || [];

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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatsKpiCard label="총 출고 건수" value={fmt(summary.total_stock_outs || 0)} />
        <StatsKpiCard label="후속조치 발생" value={fmt(summary.with_follow_up || 0)} valueColor="text-red-600" />
        <StatsKpiCard label="발생률" value={`${summary.occurrence_rate || 0}%`} valueColor="text-amber-600" />
        <StatsKpiCard label="평균 해결시간" value={`${summary.avg_resolution_days || 0}일`} valueColor="text-teal-600" />
      </div>

      {loading && <p className="text-sm text-gray-500">로딩 중...</p>}

      {/* 발생률 탭 */}
      {tab === 'rate' && !loading && (
        <div className="space-y-5">
          {monthly.length > 0 && (
            <StatsChartCard title="월별 후속조치 발생 건수">
              <LineChart data={monthly}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line type="monotone" dataKey="count" stroke="#ef4444" strokeWidth={2} name="후속조치 건수" dot={{ r: 4 }} />
              </LineChart>
            </StatsChartCard>
          )}
          <StatsTableCard title="부서별 후속조치" isEmpty={byDept.length === 0}>
            <table className="tbl">
              <thead><tr><th>부서</th><th className="text-right">후속조치 건수</th></tr></thead>
              <tbody>
                {byDept.map((d: any, i: number) => (
                  <tr key={i}><td>{d.department_name}</td><td className="text-right">{d.count}</td></tr>
                ))}
              </tbody>
            </table>
          </StatsTableCard>
        </div>
      )}

      {/* 해결 소요시간 탭 */}
      {tab === 'resolution' && !loading && (
        <div className="space-y-5">
          <StatsTableCard title="상태별 현황" isEmpty={byStatus.length === 0}>
            <table className="tbl">
              <thead><tr><th>상태</th><th className="text-right">건수</th></tr></thead>
              <tbody>
                {byStatus.map((d: any, i: number) => (
                  <tr key={i}>
                    <td>
                      <span className={`inline-block px-2 py-0.5 rounded text-white text-[10px] ${d.status === 'OPEN' ? 'bg-red-500' : d.status === 'RESOLVED' ? 'bg-green-500' : 'bg-gray-400'}`}>
                        {d.label}
                      </span>
                    </td>
                    <td className="text-right">{d.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StatsTableCard>
          <div className="bg-white rounded-xl border border-gray-100 shadow-card p-6 text-center">
            <div className="text-4xl font-bold text-teal-600">{summary.avg_resolution_days || 0}일</div>
            <div className="text-sm text-gray-500 mt-1">평균 해결 소요시간</div>
            <div className="text-xs text-gray-400 mt-1">(해결된 {summary.resolved_count || 0}건 기준)</div>
          </div>
        </div>
      )}

      {/* 문제 품목 TOP */}
      {tab === 'items' && !loading && (
        <div className="space-y-5">
          {topItems.length > 0 && (
            <StatsChartCard title="후속조치 다빈도 품목" height={Math.max(200, topItems.length * 35)}>
              <BarChart data={topItems} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis dataKey="item_name" type="category" tick={{ fontSize: 10 }} width={140} />
                <Tooltip />
                <Bar dataKey="follow_up_count" fill="#ef4444" name="후속조치 건수" radius={[0, 4, 4, 0]} />
              </BarChart>
            </StatsChartCard>
          )}
          <StatsTableCard isEmpty={topItems.length === 0}>
            <table className="tbl">
              <thead><tr><th>순위</th><th>품목코드</th><th>품목명</th><th className="text-right">건수</th></tr></thead>
              <tbody>
                {topItems.map((d: any, i: number) => (
                  <tr key={i}>
                    <td className="font-semibold">{i + 1}</td>
                    <td className="text-gray-500 font-mono">{d.item_code}</td>
                    <td>{d.item_name}</td>
                    <td className="text-right text-red-600 font-semibold">{d.follow_up_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StatsTableCard>
        </div>
      )}

      {/* 유형 분포 */}
      {tab === 'type' && !loading && (
        <div className="space-y-5">
          {byType.length > 0 && (
            <StatsChartCard title="유형별 분포">
              <PieChart>
                <Pie data={byType} dataKey="count" nameKey="label" cx="50%" cy="50%"
                  outerRadius={100} label={({ label, percent }: any) => `${label} ${(percent * 100).toFixed(0)}%`}>
                  {byType.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </StatsChartCard>
          )}
          <StatsTableCard isEmpty={byType.length === 0}>
            <table className="tbl">
              <thead><tr><th>유형</th><th className="text-right">건수</th></tr></thead>
              <tbody>
                {byType.map((d: any, i: number) => (
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
