import React, { useState, useEffect, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { StatsKpiCard, StatsChartCard, StatsTableCard, StatsFilterBar, StatsTabBar } from '../components/stats';

const API = '/api/inventory-stats';
function getToken() { return localStorage.getItem('token') || ''; }
function authHeaders() { return { Authorization: `Bearer ${getToken()}` }; }
function fmt(n: number) { return n.toLocaleString('ko-KR'); }

const TABS = [
  { key: 'turnover', label: '재고 회전율' },
  { key: 'dwell', label: '로트 체류일수' },
];

export default function InventoryStatsPage() {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const [tab, setTab] = useState('turnover');
  const [dateFrom, setDateFrom] = useState(sixMonthsAgo.toISOString().slice(0, 10));
  const [dateTo, setDateTo] = useState(now.toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);
  const [turnoverData, setTurnoverData] = useState<any>(null);
  const [dwellData, setDwellData] = useState<any[]>([]);

  const loadTurnover = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/turnover?date_from=${dateFrom}&date_to=${dateTo}`, { headers: authHeaders() });
      setTurnoverData(await res.json());
    } catch { /* */ }
    setLoading(false);
  }, [dateFrom, dateTo]);

  const loadDwell = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/lot-dwell?months=6`, { headers: authHeaders() });
      const d = await res.json();
      setDwellData(d.items || []);
    } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { if (tab === 'turnover') loadTurnover(); }, [tab, loadTurnover]);
  useEffect(() => { if (tab === 'dwell') loadDwell(); }, [tab, loadDwell]);

  const summary = turnoverData?.summary || {};
  const items = turnoverData?.items || [];

  return (
    <div className="space-y-5">
      <StatsTabBar tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'turnover' && (
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
      )}

      {loading && <p className="text-sm text-gray-500">로딩 중...</p>}

      {/* 회전율 탭 */}
      {tab === 'turnover' && !loading && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatsKpiCard label="전체 회전율" value={summary.overall_turnover || 0} valueColor="text-teal-600" />
            <StatsKpiCard label="총 출고금액" value={`${fmt(summary.total_issued_amount || 0)}원`} valueColor="text-blue-600" />
            <StatsKpiCard label="현재 재고가치" value={`${fmt(summary.total_inventory_value || 0)}원`} valueColor="text-amber-600" />
            <StatsKpiCard label="품목 수" value={summary.item_count || 0} valueColor="text-gray-600" />
          </div>

          {items.length > 0 && (
            <StatsChartCard title="품목별 회전율 (상위 20)">
              <BarChart data={items.slice(0, 20)}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="item_name" tick={{ fontSize: 10 }} interval={0} angle={-45} textAnchor="end" height={80} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => [v, '회전율']} />
                <Bar dataKey="turnover_rate" fill="#0d9488" radius={[4, 4, 0, 0]} />
              </BarChart>
            </StatsChartCard>
          )}

          <StatsTableCard isEmpty={items.length === 0}>
            <table className="tbl">
              <thead><tr><th>품목코드</th><th>품목명</th><th className="text-right">출고금액</th><th className="text-right">현재재고가치</th><th className="text-right">회전율</th></tr></thead>
              <tbody>
                {items.map((d: any, i: number) => (
                  <tr key={i}>
                    <td className="text-gray-500 font-mono">{d.item_code}</td>
                    <td>{d.item_name}</td>
                    <td className="text-right">{fmt(d.issued_amount)}원</td>
                    <td className="text-right">{fmt(d.current_inventory_value)}원</td>
                    <td className="text-right font-semibold">
                      <span className={d.turnover_rate >= 5 ? 'text-green-600' : d.turnover_rate >= 1 ? 'text-amber-600' : 'text-red-600'}>
                        {d.turnover_rate === 999 ? '∞' : d.turnover_rate}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StatsTableCard>
        </div>
      )}

      {/* 로트 체류일수 탭 */}
      {tab === 'dwell' && !loading && (
        <div className="space-y-5">
          {dwellData.length > 0 && (
            <StatsChartCard title="품목별 평균 로트 체류일수 (상위 20)">
              <BarChart data={dwellData.slice(0, 20)} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis dataKey="item_name" type="category" tick={{ fontSize: 10 }} width={120} />
                <Tooltip formatter={(v: any) => [`${v}일`, '평균 체류일수']} />
                <Bar dataKey="avg_dwell_days" fill="#f59e0b" radius={[0, 4, 4, 0]} />
              </BarChart>
            </StatsChartCard>
          )}

          <StatsTableCard isEmpty={dwellData.length === 0}>
            <table className="tbl">
              <thead><tr><th>품목코드</th><th>품목명</th><th className="text-right">평균 체류일수</th><th className="text-right">소진 로트 수</th></tr></thead>
              <tbody>
                {dwellData.map((d: any, i: number) => (
                  <tr key={i}>
                    <td className="text-gray-500 font-mono">{d.item_code}</td>
                    <td>{d.item_name}</td>
                    <td className="text-right">
                      <span className={d.avg_dwell_days > 60 ? 'text-red-600' : d.avg_dwell_days > 30 ? 'text-amber-600' : 'text-green-600'}>
                        {d.avg_dwell_days}일
                      </span>
                    </td>
                    <td className="text-right">{d.lot_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StatsTableCard>
        </div>
      )}
    </div>
  );
}
