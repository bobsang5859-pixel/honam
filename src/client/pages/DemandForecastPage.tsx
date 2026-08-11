import React, { useState, useEffect, useCallback } from 'react';
import { PieChart, Pie, Cell, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from 'recharts';
import { StatsKpiCard, StatsChartCard, StatsFilterBar, StatsTableCard } from '../components/stats';
import type { HiraDiseaseCodeResult, HiraInpatientStat } from '@shared/types';

interface ForecastItem {
  item_id: string;
  item_name: string;
  item_code: string;
  uom: string;
  department_id: string;
  department_name: string;
  daily_rate_per_patient: number;
  current_patients: number;
  daily_demand: number;
  current_stock: number;
  days_remaining: number;
  lead_time_days: number;
  safety_days: number;
  needs_reorder: boolean;
  reorder_by_date: string | null;
  recommended_order_qty: number;
  vendor_name: string | null;
  risk_level: 'critical' | 'warning' | 'safe' | 'no_data';
  data_days: number;
}

interface ForecastSummary {
  critical_count: number;
  warning_count: number;
  safe_count: number;
  no_data_count: number;
  total_items: number;
  items: ForecastItem[];
}

interface HistoryEntry {
  month: string;
  total_qty: number;
  patient_days: number;
  rate: number;
}

interface Department {
  id: string;
  name: string;
}

const RISK_LABELS = {
  critical: { label: '긴급', color: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
  warning: { label: '주의', color: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' },
  safe: { label: '안전', color: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
  no_data: { label: '데이터부족', color: 'bg-gray-100 text-gray-500', dot: 'bg-gray-400' },
};

function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}

export default function DemandForecastPage() {
  const [data, setData] = useState<ForecastSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [deptFilter, setDeptFilter] = useState('');
  const [months, setMonths] = useState(3);
  const [safetyDays, setSafetyDays] = useState(2);
  const [riskFilter, setRiskFilter] = useState<string>('all');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedItem, setSelectedItem] = useState<ForecastItem | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [search, setSearch] = useState('');

  // 질병 트렌드 참고
  const [diseasePanelOpen, setDiseasePanelOpen] = useState(false);
  const [diseaseSearch, setDiseaseSearch] = useState('');
  const [diseaseCodeResults, setDiseaseCodeResults] = useState<HiraDiseaseCodeResult[]>([]);
  const [selectedDisease, setSelectedDisease] = useState<HiraDiseaseCodeResult | null>(null);
  const [diseaseStats, setDiseaseStats] = useState<HiraInpatientStat[]>([]);
  const [diseaseStatsLoading, setDiseaseStatsLoading] = useState(false);
  const [showDiseaseDrop, setShowDiseaseDrop] = useState(false);

  const token = localStorage.getItem('token');
  const headers = { Authorization: `Bearer ${token}` };

  // 부서 목록 로드
  useEffect(() => {
    fetch('/api/departments', { headers })
      .then(r => r.json())
      .then(d => setDepartments(Array.isArray(d) ? d.filter((x: any) => x.is_active) : []))
      .catch(() => {});
  }, []);

  // 예측 데이터 로드
  const loadForecast = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (deptFilter) params.set('dept_id', deptFilter);
      params.set('months', String(months));
      params.set('safety_days', String(safetyDays));

      const res = await fetch(`/api/demand-forecast?${params}`, { headers });
      const json = await res.json();
      setData(json);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [deptFilter, months, safetyDays]);

  useEffect(() => { loadForecast(); }, [loadForecast]);

  // 품목 상세 (사용 추이)
  const openDetail = async (item: ForecastItem) => {
    setSelectedItem(item);
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams();
      if (item.department_id) params.set('dept_id', item.department_id);
      params.set('months', '6');
      const res = await fetch(`/api/demand-forecast/history/${item.item_id}?${params}`, { headers });
      const json = await res.json();
      setHistory(json.history || []);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  // 필터된 아이템
  const filteredItems = (data?.items || []).filter(item => {
    if (riskFilter !== 'all' && item.risk_level !== riskFilter) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!item.item_name.toLowerCase().includes(s) && !item.item_code.toLowerCase().includes(s) && !item.department_name.toLowerCase().includes(s)) return false;
    }
    return true;
  });

  // 질병 트렌드 검색
  const searchDiseaseCode = async (q: string) => {
    setDiseaseSearch(q);
    if (q.trim().length < 2) { setDiseaseCodeResults([]); setShowDiseaseDrop(false); return; }
    try {
      const isCode = /^[A-Z]\d/i.test(q.trim());
      const params = new URLSearchParams({ search: q.trim(), searchType: isCode ? 'SICK_CD' : 'SICK_NM', numOfRows: '8' });
      const res = await fetch(`/api/hira/disease-codes?${params}`, { headers });
      const json = await res.json();
      setDiseaseCodeResults(json.items ?? []);
      setShowDiseaseDrop(true);
    } catch { /* ignore */ }
  };

  const loadDiseaseStats = async (code: HiraDiseaseCodeResult) => {
    setSelectedDisease(code);
    setDiseaseSearch(`${code.sickCd} ${code.sickNm}`);
    setShowDiseaseDrop(false);
    setDiseaseStatsLoading(true);
    try {
      const year = new Date().getFullYear() - 1;
      const res = await fetch(`/api/hira-disease-stats/inpatient-outpatient?sickCd=${code.sickCd}&year=${year}&numOfRows=100`, { headers });
      const json = await res.json();
      setDiseaseStats(json.items ?? []);
    } catch { setDiseaseStats([]); }
    finally { setDiseaseStatsLoading(false); }
  };

  // 추이 차트 (simple bar chart with div)
  const maxQty = Math.max(...history.map(h => h.total_qty), 1);

  return (
    <div className="space-y-4">
      <StatsFilterBar>
        <div>
          <label className="label">부서</label>
          <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)} className="input w-36">
            <option value="">전체</option>
            {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">분석 기간</label>
          <select value={months} onChange={e => setMonths(Number(e.target.value))} className="input w-24">
            <option value={1}>1개월</option><option value={3}>3개월</option><option value={6}>6개월</option>
          </select>
        </div>
        <div>
          <label className="label">안전일수</label>
          <input type="number" value={safetyDays} onChange={e => setSafetyDays(Number(e.target.value))} min={0} max={14} className="input w-16" />
        </div>
        <div>
          <label className="label">검색</label>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="품목명/코드/부서" className="input w-40" />
        </div>
      </StatsFilterBar>

      {/* 요약 카드 */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatsKpiCard label="긴급 발주 필요" value={`${data.critical_count}건`} bgColor="bg-red-50" valueColor="text-red-700" onClick={() => setRiskFilter(riskFilter === 'critical' ? 'all' : 'critical')} active={riskFilter === 'critical'} activeRing="ring-red-400" />
          <StatsKpiCard label="주의" value={`${data.warning_count}건`} bgColor="bg-amber-50" valueColor="text-amber-700" onClick={() => setRiskFilter(riskFilter === 'warning' ? 'all' : 'warning')} active={riskFilter === 'warning'} activeRing="ring-amber-400" />
          <StatsKpiCard label="안전" value={`${data.safe_count}건`} bgColor="bg-green-50" valueColor="text-green-700" onClick={() => setRiskFilter(riskFilter === 'safe' ? 'all' : 'safe')} active={riskFilter === 'safe'} activeRing="ring-green-400" />
          <StatsKpiCard label="데이터 부족" value={`${data.no_data_count}건`} bgColor="bg-gray-50" valueColor="text-gray-600" onClick={() => setRiskFilter(riskFilter === 'no_data' ? 'all' : 'no_data')} active={riskFilter === 'no_data'} activeRing="ring-gray-400" />
        </div>
      )}

      {/* 위험도 분포 차트 */}
      {data && (data.critical_count > 0 || data.warning_count > 0 || data.safe_count > 0) && (
        <StatsChartCard title="위험도 분포" height={200}>
          <PieChart>
            <Pie
              data={[
                { name: '긴급', value: data.critical_count },
                { name: '주의', value: data.warning_count },
                { name: '안전', value: data.safe_count },
                { name: '데이터부족', value: data.no_data_count },
              ].filter(d => d.value > 0)}
              dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70}
              label={({ name, percent }: any) => `${name} ${(percent * 100).toFixed(0)}%`}>
              <Cell fill="#ef4444" />
              <Cell fill="#f59e0b" />
              <Cell fill="#10b981" />
              <Cell fill="#94a3b8" />
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        </StatsChartCard>
      )}

      {/* 테이블 */}
      {loading ? (
        <div className="text-center py-12 text-gray-400 text-sm">분석 중...</div>
      ) : (
        <StatsTableCard isEmpty={filteredItems.length === 0} emptyMessage="데이터가 없습니다">
          <table className="tbl">
            <thead>
              <tr className="bg-gray-50 text-gray-600 text-xs">
                <th className="px-3 py-2 text-left">상태</th>
                <th className="px-3 py-2 text-left">품목</th>
                <th className="px-3 py-2 text-left">부서</th>
                <th className="px-3 py-2 text-right">일일소모</th>
                <th className="px-3 py-2 text-right">현재재고</th>
                <th className="px-3 py-2 text-right">소진예상</th>
                <th className="px-3 py-2 text-right">리드타임</th>
                <th className="px-3 py-2 text-left">업체</th>
                <th className="px-3 py-2 text-right">권장발주량</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.length === 0 ? (
                <tr><td colSpan={9} className="text-center py-8 text-gray-400">데이터가 없습니다</td></tr>
              ) : filteredItems.map((item, idx) => {
                const risk = RISK_LABELS[item.risk_level];
                return (
                  <tr key={`${item.department_id}-${item.item_id}`}
                    className={`border-t hover:bg-gray-50 cursor-pointer ${idx % 2 === 0 ? '' : 'bg-gray-50/30'}`}
                    onClick={() => openDetail(item)}>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${risk.color}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${risk.dot}`} />
                        {risk.label}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-800">{item.item_name}</div>
                      <div className="text-[10px] text-gray-400">{item.item_code}</div>
                    </td>
                    <td className="px-3 py-2 text-gray-600">{item.department_name}</td>
                    <td className="px-3 py-2 text-right">{item.daily_demand.toFixed(1)} {item.uom}</td>
                    <td className="px-3 py-2 text-right font-medium">{fmt(item.current_stock)}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={item.days_remaining <= 3 ? 'text-red-600 font-bold' : item.days_remaining <= 7 ? 'text-amber-600 font-medium' : 'text-gray-700'}>
                        {item.days_remaining >= 999 ? '-' : `${item.days_remaining}일`}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-500">{item.lead_time_days}일</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{item.vendor_name || '-'}</td>
                    <td className="px-3 py-2 text-right">
                      {item.needs_reorder && item.recommended_order_qty > 0
                        ? <span className="text-red-600 font-medium">{fmt(item.recommended_order_qty)}</span>
                        : <span className="text-gray-400">-</span>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </StatsTableCard>
      )}

      {/* 질병 트렌드 참고 패널 */}
      <div className="card overflow-hidden">
        <button onClick={() => setDiseasePanelOpen(p => !p)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50">
          <span className="text-sm font-semibold text-gray-700">질병 트렌드 참고 (HIRA)</span>
          <span className="text-gray-400 text-xs">{diseasePanelOpen ? '접기 ▲' : '펼치기 ▼'}</span>
        </button>
        {diseasePanelOpen && (
          <div className="px-4 pb-4 border-t border-gray-100 pt-3">
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1">
                <input value={diseaseSearch} onChange={e => searchDiseaseCode(e.target.value)}
                  onFocus={() => diseaseCodeResults.length > 0 && setShowDiseaseDrop(true)}
                  className="input" placeholder="질병명/코드 검색 (예: 당뇨, E11)" />
                {showDiseaseDrop && diseaseCodeResults.length > 0 && (
                  <div className="absolute z-50 left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {diseaseCodeResults.map((c, i) => (
                      <button key={i} onClick={() => loadDiseaseStats(c)} className="w-full text-left px-3 py-2 hover:bg-blue-50 text-sm border-b border-gray-50">
                        <span className="font-mono font-medium text-teal-700 mr-2">{c.sickCd}</span>{c.sickNm}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {diseaseStatsLoading && <p className="text-xs text-gray-400 py-4 text-center">조회 중...</p>}
            {!diseaseStatsLoading && selectedDisease && diseaseStats.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-2">{selectedDisease.sickCd} {selectedDisease.sickNm} — {new Date().getFullYear() - 1}년 입원·외래별 통계</p>
                <div className="overflow-x-auto">
                  <table className="tbl text-xs">
                    <thead><tr><th>구분</th><th>성별</th><th className="text-right">환자수</th><th className="text-right">내원일수</th><th className="text-right">급여총액(천원)</th></tr></thead>
                    <tbody>
                      {diseaseStats.map((d, i) => (
                        <tr key={i}>
                          <td>{d.inpatOpat}</td><td>{d.sex}</td>
                          <td className="text-right">{fmt(d.ptntCnt)}</td>
                          <td className="text-right">{fmt(d.vstDdcnt)}</td>
                          <td className="text-right">{fmt(Math.round(d.rvdRpeTamtAmt / 1000))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {!diseaseStatsLoading && selectedDisease && diseaseStats.length === 0 && (
              <p className="text-xs text-gray-400 py-4 text-center">해당 질병의 통계 데이터가 없습니다.</p>
            )}
            {!selectedDisease && !diseaseStatsLoading && (
              <p className="text-xs text-gray-400 py-4 text-center">질병코드를 검색하면 입원·외래별 환자 통계를 참고할 수 있습니다.</p>
            )}
          </div>
        )}
      </div>

      {/* 상세 모달 */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setSelectedItem(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-800">{selectedItem.item_name}</h2>
                <p className="text-xs text-gray-400">{selectedItem.item_code} | {selectedItem.department_name}</p>
              </div>
              <button onClick={() => setSelectedItem(null)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
            </div>

            <div className="px-5 py-4 space-y-4">
              {/* 핵심 정보 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-[10px] text-gray-400">1인 1일 평균</div>
                  <div className="text-lg font-bold">{selectedItem.daily_rate_per_patient} {selectedItem.uom}</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-[10px] text-gray-400">현재 환자 수</div>
                  <div className="text-lg font-bold">{selectedItem.current_patients}명</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-[10px] text-gray-400">일일 예상 소모</div>
                  <div className="text-lg font-bold">{selectedItem.daily_demand.toFixed(1)} {selectedItem.uom}</div>
                </div>
                <div className={`rounded-lg p-3 ${selectedItem.days_remaining <= 3 ? 'bg-red-50' : selectedItem.days_remaining <= 7 ? 'bg-amber-50' : 'bg-green-50'}`}>
                  <div className="text-[10px] text-gray-400">재고 소진 예상</div>
                  <div className="text-lg font-bold">{selectedItem.days_remaining >= 999 ? '충분' : `${selectedItem.days_remaining}일`}</div>
                </div>
              </div>

              {/* 발주 추천 */}
              {selectedItem.needs_reorder && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <div className="text-sm font-medium text-red-700">
                    발주 추천: {fmt((selectedItem as any).recommended_order_purchase_qty ?? selectedItem.recommended_order_qty)} {(selectedItem as any).purchase_uom ?? selectedItem.uom}
                    {((selectedItem as any).pack_size ?? 1) > 1 && (selectedItem as any).purchase_uom !== (selectedItem as any).issue_uom && (
                      <span className="text-xs font-normal ml-2">(≈{fmt(selectedItem.recommended_order_qty)} {(selectedItem as any).issue_uom ?? selectedItem.uom})</span>
                    )}
                  </div>
                  <div className="text-xs text-red-500 mt-1">
                    {selectedItem.vendor_name && `업체: ${selectedItem.vendor_name} | `}
                    리드타임 {selectedItem.lead_time_days}일
                    {selectedItem.reorder_by_date && ` | 발주 기한: ${selectedItem.reorder_by_date}`}
                  </div>
                </div>
              )}

              {/* 6개월 사용 추이 */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">월별 사용 추이</h3>
                {historyLoading ? (
                  <div className="text-center py-4 text-gray-400 text-xs">로딩 중...</div>
                ) : history.length === 0 ? (
                  <div className="text-center py-4 text-gray-400 text-xs">데이터 없음</div>
                ) : (
                  <div className="space-y-1.5">
                    {history.map(h => (
                      <div key={h.month} className="flex items-center gap-2">
                        <span className="text-xs text-gray-500 w-16 shrink-0">{h.month}</span>
                        <div className="flex-1 bg-gray-100 rounded-full h-5 relative overflow-hidden">
                          <div
                            className="h-full bg-teal-400 rounded-full transition-all"
                            style={{ width: `${Math.max((h.total_qty / maxQty) * 100, 2)}%` }}
                          />
                          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-gray-700">
                            {fmt(h.total_qty)} {selectedItem.uom}
                          </span>
                        </div>
                        <span className="text-[10px] text-gray-400 w-20 text-right shrink-0">
                          {h.rate > 0 ? `${h.rate}/인일` : '-'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="text-[10px] text-gray-400 text-right">
                분석 기간: 최근 {selectedItem.data_days}일 | 현재 재고: {fmt(selectedItem.current_stock)} {selectedItem.uom}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
