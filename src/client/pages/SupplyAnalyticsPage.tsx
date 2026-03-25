import React, { useState, useEffect, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { StatsChartCard, StatsTableCard, StatsFilterBar, StatsTabBar } from '../components/stats';

const API = '/api/supply-analytics';
function getToken() { return localStorage.getItem('token') || ''; }
function authHeaders() { return { Authorization: `Bearer ${getToken()}` }; }
function fmt(n: number) { return n.toLocaleString('ko-KR'); }

const TABS = [
  { key: 'ward', label: '병동별 현황' },
  { key: 'anomalies', label: '이상 감지' },
  { key: 'cost', label: '원가 보고서' },
];

export default function SupplyAnalyticsPage() {
  const now = new Date();
  const [tab, setTab] = useState('ward');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [loading, setLoading] = useState(false);
  const [wardData, setWardData] = useState<any>(null);
  const [anomalyData, setAnomalyData] = useState<any>(null);
  const [threshold, setThreshold] = useState(150);
  const [costData, setCostData] = useState<any>(null);

  const loadWard = useCallback(async () => {
    setLoading(true);
    try { const res = await fetch(`${API}/ward-summary?year=${year}&month=${month}`, { headers: authHeaders() }); setWardData(await res.json()); } catch { /* */ }
    setLoading(false);
  }, [year, month]);

  const loadAnomalies = useCallback(async () => {
    setLoading(true);
    try { const res = await fetch(`${API}/anomalies?year=${year}&month=${month}&threshold=${threshold}`, { headers: authHeaders() }); setAnomalyData(await res.json()); } catch { /* */ }
    setLoading(false);
  }, [year, month, threshold]);

  const loadCost = useCallback(async () => {
    setLoading(true);
    try { const res = await fetch(`${API}/cost-report?year=${year}`, { headers: authHeaders() }); setCostData(await res.json()); } catch { /* */ }
    setLoading(false);
  }, [year]);

  useEffect(() => {
    if (tab === 'ward') loadWard();
    else if (tab === 'anomalies') loadAnomalies();
    else if (tab === 'cost') loadCost();
  }, [tab, loadWard, loadAnomalies, loadCost]);

  return (
    <div className="space-y-5">
      <StatsTabBar tabs={TABS} active={tab} onChange={setTab} />

      <StatsFilterBar>
        <div>
          <label className="label">연도</label>
          <select value={year} onChange={e => setYear(Number(e.target.value))} className="input w-28">
            {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(y => <option key={y} value={y}>{y}년</option>)}
          </select>
        </div>
        {tab !== 'cost' && (
          <div>
            <label className="label">월</label>
            <select value={month} onChange={e => setMonth(Number(e.target.value))} className="input w-20">
              {Array.from({ length: 12 }, (_, i) => i + 1).map(m => <option key={m} value={m}>{m}월</option>)}
            </select>
          </div>
        )}
        {tab === 'anomalies' && (
          <div>
            <label className="label">기준</label>
            <select value={threshold} onChange={e => setThreshold(Number(e.target.value))} className="input w-24">
              <option value={120}>120%</option>
              <option value={150}>150%</option>
              <option value={200}>200%</option>
            </select>
          </div>
        )}
        {loading && <span className="text-xs text-gray-400 self-center">로딩 중...</span>}
      </StatsFilterBar>

      {/* 병동별 현황 */}
      {tab === 'ward' && wardData?.wards?.length > 0 && (
        <StatsChartCard title="병동별 예상 vs 실제 원가" height={280}>
          <BarChart data={wardData.wards}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="department_name" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={50} />
            <YAxis tick={{ fontSize: 10 }} />
            <Tooltip formatter={(v: any) => [`${v.toLocaleString()}원`]} />
            <Legend />
            <Bar dataKey="expected_cost" fill="#94a3b8" name="예상원가" radius={[4, 4, 0, 0]} />
            <Bar dataKey="actual_cost" fill="#0d9488" name="실제불출" radius={[4, 4, 0, 0]} />
          </BarChart>
        </StatsChartCard>
      )}

      {tab === 'ward' && wardData && (
        <StatsTableCard isEmpty={!wardData.wards?.length}>
          <table className="tbl">
            <thead>
              <tr><th>병동</th><th className="text-right">환자수</th><th className="text-right">처치건</th><th className="text-right">예상원가</th><th className="text-right">실제불출</th><th className="text-right">차이</th><th className="text-right">비율</th></tr>
            </thead>
            <tbody>
              {wardData.wards?.map((w: any) => (
                <tr key={w.department_id}>
                  <td className="font-medium">{w.department_name}</td>
                  <td className="text-right">{w.patient_count}</td>
                  <td className="text-right">{w.treatment_count}</td>
                  <td className="text-right text-gray-600">{fmt(w.expected_cost)}원</td>
                  <td className="text-right font-medium">{fmt(w.actual_cost)}원</td>
                  <td className={`text-right font-medium ${w.diff > 0 ? 'text-red-600' : w.diff < 0 ? 'text-blue-600' : 'text-gray-400'}`}>
                    {w.diff > 0 ? '+' : ''}{fmt(w.diff)}원
                  </td>
                  <td className="text-right">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                      w.ratio > 150 ? 'bg-red-100 text-red-700' : w.ratio > 120 ? 'bg-amber-100 text-amber-700' : w.ratio > 0 ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                    }`}>{w.ratio}%</span>
                  </td>
                </tr>
              ))}
            </tbody>
            {wardData.wards?.length > 0 && (
              <tfoot className="bg-gray-50 font-medium">
                <tr>
                  <td>합계</td>
                  <td className="text-right">{wardData.wards.reduce((s: number, w: any) => s + w.patient_count, 0)}</td>
                  <td className="text-right">{wardData.wards.reduce((s: number, w: any) => s + w.treatment_count, 0)}</td>
                  <td className="text-right">{fmt(wardData.wards.reduce((s: number, w: any) => s + w.expected_cost, 0))}원</td>
                  <td className="text-right">{fmt(wardData.wards.reduce((s: number, w: any) => s + w.actual_cost, 0))}원</td>
                  <td className="text-right">{fmt(wardData.wards.reduce((s: number, w: any) => s + w.diff, 0))}원</td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </StatsTableCard>
      )}

      {/* 이상 감지 */}
      {tab === 'anomalies' && anomalyData && (
        <StatsTableCard isEmpty={!anomalyData.anomalies?.length} emptyMessage={`기준(${threshold}%) 이상의 이상 항목이 없습니다.`}>
          <table className="tbl">
            <thead>
              <tr><th>병동</th><th>품목</th><th className="text-right">예상수량</th><th className="text-right">실제불출</th><th className="text-right">초과분</th><th className="text-right">비율</th></tr>
            </thead>
            <tbody>
              {anomalyData.anomalies?.map((a: any, i: number) => (
                <tr key={i}>
                  <td>{a.department_name}</td>
                  <td className="font-medium">{a.item_name}</td>
                  <td className="text-right text-gray-600">{fmt(a.expected_qty)}</td>
                  <td className="text-right font-medium">{fmt(a.actual_qty)}</td>
                  <td className="text-right text-red-600">+{fmt(a.excess)}</td>
                  <td className="text-right">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                      a.ratio >= 300 ? 'bg-red-200 text-red-800' : a.ratio >= 200 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                    }`}>{a.ratio === 999 ? '예상없음' : `${a.ratio}%`}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </StatsTableCard>
      )}

      {/* 원가 보고서 */}
      {tab === 'cost' && costData?.monthly?.length > 0 && (
        <div className="space-y-5">
          <StatsTableCard>
            <table className="tbl">
              <thead><tr><th>월</th><th className="text-right">총 불출원가</th><th className="text-right">전월대비</th></tr></thead>
              <tbody>
                {costData.monthly.map((m: any, i: number) => {
                  const prev = i > 0 ? costData.monthly[i - 1].total_cost : 0;
                  const diff = i > 0 ? m.total_cost - prev : 0;
                  const diffPct = prev > 0 ? Math.round((diff / prev) * 100) : 0;
                  return (
                    <tr key={m.month}>
                      <td className="font-medium">{m.label}</td>
                      <td className="text-right">{fmt(m.total_cost)}원</td>
                      <td className={`text-right ${diff > 0 ? 'text-red-600' : diff < 0 ? 'text-blue-600' : 'text-gray-400'}`}>
                        {i > 0 ? `${diff > 0 ? '+' : ''}${fmt(diff)}원 (${diffPct > 0 ? '+' : ''}${diffPct}%)` : '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-gray-50 font-medium">
                <tr>
                  <td>합계</td>
                  <td className="text-right">{fmt(costData.monthly.reduce((s: number, m: any) => s + m.total_cost, 0))}원</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </StatsTableCard>

          <StatsChartCard title="월별 불출원가 추이" height={250}>
            <BarChart data={costData.monthly}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip formatter={(v: any) => [`${v.toLocaleString()}원`, '불출원가']} />
              <Bar dataKey="total_cost" fill="#0d9488" name="불출원가" radius={[4, 4, 0, 0]} />
            </BarChart>
          </StatsChartCard>
        </div>
      )}

      {tab === 'cost' && costData && !costData.monthly?.length && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-card p-8 text-center text-gray-400 text-sm">데이터가 없습니다.</div>
      )}
    </div>
  );
}
