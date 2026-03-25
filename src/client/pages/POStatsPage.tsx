import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  LineChart, Line, Legend,
} from 'recharts';
import { StatsChartCard, StatsTableCard, StatsFilterBar, StatsTabBar } from '../components/stats';

const API = '/api/po-stats';
function getToken() { return localStorage.getItem('token') || ''; }
function authHeaders() { return { Authorization: `Bearer ${getToken()}` }; }
function fmt(n: number) { return n.toLocaleString('ko-KR'); }

const TABS = [
  { key: 'lead', label: '리드타임' },
  { key: 'compliance', label: '납품정확도' },
  { key: 'price', label: '가격추이' },
];

export default function POStatsPage() {
  const now = new Date();
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const [tab, setTab] = useState('lead');
  const [dateFrom, setDateFrom] = useState(sixMonthsAgo.toISOString().slice(0, 10));
  const [dateTo, setDateTo] = useState(now.toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);

  const [leadData, setLeadData] = useState<any[]>([]);
  const [complianceData, setComplianceData] = useState<any[]>([]);
  const [priceData, setPriceData] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [selectedItem, setSelectedItem] = useState('');

  const loadLead = useCallback(async () => {
    setLoading(true);
    try { const res = await fetch(`${API}/lead-time?date_from=${dateFrom}&date_to=${dateTo}`, { headers: authHeaders() }); setLeadData(await res.json()); } catch { /* */ }
    setLoading(false);
  }, [dateFrom, dateTo]);

  const loadCompliance = useCallback(async () => {
    setLoading(true);
    try { const res = await fetch(`${API}/delivery-compliance?date_from=${dateFrom}&date_to=${dateTo}`, { headers: authHeaders() }); setComplianceData(await res.json()); } catch { /* */ }
    setLoading(false);
  }, [dateFrom, dateTo]);

  const loadPrice = useCallback(async () => {
    if (!selectedItem) return;
    setLoading(true);
    try { const res = await fetch(`${API}/price-trend?item_id=${selectedItem}&months=12`, { headers: authHeaders() }); setPriceData(await res.json()); } catch { /* */ }
    setLoading(false);
  }, [selectedItem]);

  const loadItems = useCallback(async () => {
    try { const res = await fetch(`${API}/items`, { headers: authHeaders() }); setItems(await res.json()); } catch { /* */ }
  }, []);

  useEffect(() => { loadItems(); }, [loadItems]);
  useEffect(() => { if (tab === 'lead') loadLead(); }, [tab, loadLead]);
  useEffect(() => { if (tab === 'compliance') loadCompliance(); }, [tab, loadCompliance]);
  useEffect(() => { if (tab === 'price') loadPrice(); }, [tab, loadPrice]);

  return (
    <div className="space-y-5">
      <StatsTabBar tabs={TABS} active={tab} onChange={setTab} />

      {/* Date filter (lead & compliance) */}
      {tab !== 'price' && (
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

      {/* Price tab filter */}
      {tab === 'price' && (
        <StatsFilterBar>
          <div>
            <label className="label">품목 선택</label>
            <select value={selectedItem} onChange={e => setSelectedItem(e.target.value)} className="input w-64">
              <option value="">-- 선택 --</option>
              {items.map((item: any) => <option key={item.id} value={item.id}>{item.name} ({item.code})</option>)}
            </select>
          </div>
        </StatsFilterBar>
      )}

      {loading && <p className="text-sm text-gray-500">로딩 중...</p>}

      {/* 리드타임 탭 */}
      {tab === 'lead' && !loading && (
        <div className="space-y-5">
          {leadData.length > 0 && (
            <StatsChartCard title="업체별 평균 리드타임 (일)">
              <BarChart data={leadData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="vendor_name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => [`${v}일`, '평균 리드타임']} />
                <Bar dataKey="avg_lead_days" fill="#0d9488" radius={[4, 4, 0, 0]} />
              </BarChart>
            </StatsChartCard>
          )}
          <StatsTableCard isEmpty={leadData.length === 0}>
            <table className="tbl">
              <thead><tr><th>업체명</th><th className="text-right">입고 건수</th><th className="text-right">평균 리드타임</th><th className="text-right">납품정확도</th></tr></thead>
              <tbody>
                {leadData.map((d: any, i: number) => (
                  <tr key={i}>
                    <td>{d.vendor_name}</td>
                    <td className="text-right">{fmt(d.total_receipts)}</td>
                    <td className="text-right">{d.avg_lead_days}일</td>
                    <td className="text-right">
                      <span className={d.accuracy_rate >= 90 ? 'text-green-600' : d.accuracy_rate >= 70 ? 'text-amber-600' : 'text-red-600'}>{d.accuracy_rate}%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StatsTableCard>
        </div>
      )}

      {/* 납품정확도 탭 */}
      {tab === 'compliance' && !loading && (
        <div className="space-y-5">
          {complianceData.length > 0 && (
            <StatsChartCard title="업체별 납기 준수율 (%)">
              <BarChart data={complianceData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="vendor_name" tick={{ fontSize: 11 }} interval={0} angle={-30} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                <Tooltip formatter={(v: any) => [`${v}%`, '준수율']} />
                <Bar dataKey="compliance_rate" fill="#0891b2" radius={[4, 4, 0, 0]} />
              </BarChart>
            </StatsChartCard>
          )}
          <StatsTableCard isEmpty={complianceData.length === 0}>
            <table className="tbl">
              <thead><tr><th>업체명</th><th className="text-right">총 건수</th><th className="text-right">정시 납품</th><th className="text-right">지연</th><th className="text-right">준수율</th></tr></thead>
              <tbody>
                {complianceData.map((d: any, i: number) => (
                  <tr key={i}>
                    <td>{d.vendor_name}</td>
                    <td className="text-right">{d.total}</td>
                    <td className="text-right text-green-600">{d.on_time}</td>
                    <td className="text-right text-red-600">{d.late}</td>
                    <td className="text-right font-semibold">
                      <span className={d.compliance_rate >= 90 ? 'text-green-600' : d.compliance_rate >= 70 ? 'text-amber-600' : 'text-red-600'}>{d.compliance_rate}%</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </StatsTableCard>
        </div>
      )}

      {/* 가격추이 탭 */}
      {tab === 'price' && !loading && (
        <div className="space-y-5">
          {priceData.length > 0 && (
            <StatsChartCard title="가격 변동 추이">
              <LineChart data={priceData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => [`${fmt(v)}원`, '단가']} />
                <Legend />
                <Line type="monotone" dataKey="price" stroke="#0d9488" name="단가" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </StatsChartCard>
          )}
          {priceData.length > 0 && (
            <StatsTableCard>
              <table className="tbl">
                <thead><tr><th>날짜</th><th className="text-right">단가</th><th>업체</th></tr></thead>
                <tbody>
                  {priceData.map((d: any, i: number) => (
                    <tr key={i}><td>{d.date}</td><td className="text-right">{fmt(d.price)}원</td><td>{d.vendor_name}</td></tr>
                  ))}
                </tbody>
              </table>
            </StatsTableCard>
          )}
          {selectedItem && priceData.length === 0 && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-card p-8 text-center text-gray-400 text-sm">가격 이력이 없습니다.</div>
          )}
        </div>
      )}
    </div>
  );
}
