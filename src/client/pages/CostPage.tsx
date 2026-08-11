import React, { useEffect, useState, useMemo } from 'react';
import { api } from '../utils/api';
import { StatsKpiCard, StatsTableCard, StatsFilterBar, StatsTabBar } from '../components/stats';

const TABS = [
  { key: 'efficiency', label: '소모품효율' },
  { key: 'integrated', label: '통합현황' },
];

export default function CostPage() {
  const [pageTab, setPageTab] = useState('efficiency');

  // 비용 = 불출 실제원가. /cost/statistics 즉석계산(월마감/cost_statistics 폐지).
  const [costStat, setCostStat] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [yearMonth, setYearMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [deptFilter, setDeptFilter] = useState('');
  const [depts, setDepts] = useState<any[]>([]);

  const [effRange, setEffRange] = useState(() => {
    const today = new Date().toISOString().slice(0, 10);
    return { from: today, to: today };
  });
  const [effDept, setEffDept] = useState('');
  const [comparePrev, setComparePrev] = useState(true);
  const [efficiencyData, setEfficiencyData] = useState<any>(null);
  const [loadingEfficiency, setLoadingEfficiency] = useState(false);
  const [vendorSummary, setVendorSummary] = useState<any>(null);

  const [kpiVendor, setKpiVendor] = useState<any>(null);
  const [integratedStats, setIntegratedStats] = useState<any>(null);
  const [loadingIntegrated, setLoadingIntegrated] = useState(false);

  useEffect(() => { api('/departments').then(setDepts).catch(() => {}); }, []);

  useEffect(() => {
    const [y, m] = yearMonth.split('-');
    const params = new URLSearchParams({ year: y, month: String(Number(m)) });
    if (deptFilter) params.set('department_id', deptFilter);
    setLoading(true);
    api(`/cost/statistics?${params}`).then(setCostStat).catch(console.error).finally(() => setLoading(false));
  }, [yearMonth, deptFilter]);

  const showMsg = (type: 'ok' | 'err', text: string) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 4000); };

  const loadEfficiency = async () => {
    setLoadingEfficiency(true);
    try {
      const p = new URLSearchParams({ date_from: effRange.from, date_to: effRange.to });
      if (effDept) p.set('department_id', effDept);
      if (comparePrev) p.set('compare', 'previous');
      const r = await api(`/patients/analytics/consumables?${p.toString()}`);
      setEfficiencyData(r);
      const v = await api(`/cost/vendor-summary?${p.toString()}`);
      setVendorSummary(v);
    } catch (e: any) { showMsg('err', e.message || '소모품효율 통계를 불러오지 못했습니다.'); }
    finally { setLoadingEfficiency(false); }
  };

  useEffect(() => { if (pageTab === 'efficiency') loadEfficiency(); }, [pageTab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const [y, m] = yearMonth.split('-');
    const from = `${y}-${m}-01`;
    const lastDay = new Date(Number(y), Number(m), 0).getDate();
    const to = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
    api(`/cost/vendor-summary?date_from=${from}&date_to=${to}`).then(setKpiVendor).catch(() => {});
  }, [yearMonth]);

  const loadIntegrated = async () => {
    setLoadingIntegrated(true);
    try {
      const [y, m] = yearMonth.split('-');
      const from = `${y}-${m}-01`;
      const lastDay = new Date(Number(y), Number(m), 0).getDate();
      const to = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
      const data = await api(`/patients/stats?date_from=${from}&date_to=${to}`);
      setIntegratedStats(data);
    } catch { /* */ } finally { setLoadingIntegrated(false); }
  };
  useEffect(() => { if (pageTab === 'integrated') loadIntegrated(); }, [pageTab, yearMonth]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmt = (n: number) => new Intl.NumberFormat('ko-KR').format(Math.round(n));
  // 불출 실제원가 즉석계산 결과 (/cost/statistics)
  const totalAmt = Number(costStat?.total_issued ?? 0);
  const byDeptStat: any[] = Array.isArray(costStat?.by_department) ? costStat.by_department : [];
  const totalQty = byDeptStat.reduce((s, d) => s + Number(d.qty ?? 0), 0);
  const deptSummary = byDeptStat
    .map((d: any) => ({ name: d.department_name || d.department_id, amount: Number(d.amount ?? 0), qty: Number(d.qty ?? 0) }))
    .sort((a, b) => b.amount - a.amount);

  return (
    <div className="space-y-5">
      {msg && <div className={`p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}

      {/* KPI — 불출 실제원가(line_amount) 즉석계산 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatsKpiCard label="이달 총 불출금액" value={`${fmt(totalAmt)}원`} />
        <StatsKpiCard label="재고금액 (FIFO)" value={`${fmt(kpiVendor?.totals?.inventory_total_fifo ?? 0)}원`} />
        <StatsKpiCard label="이달 발주금액" value={`${fmt(kpiVendor?.totals?.order_total_current ?? 0)}원`} />
      </div>

      <StatsFilterBar>
        <div><label className="label">기준 월</label><input type="month" value={yearMonth} onChange={e => setYearMonth(e.target.value)} className="input w-36" /></div>
        <div><label className="label">부서</label><select value={deptFilter} onChange={e => setDeptFilter(e.target.value)} className="input w-40"><option value="">전체</option>{depts.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
      </StatsFilterBar>

      <StatsTabBar tabs={TABS} active={pageTab} onChange={setPageTab} />

      {pageTab === 'integrated' && (
        <div className="space-y-5 text-sm">
          {loadingIntegrated ? <div className="bg-white rounded-xl border border-gray-100 shadow-card p-8 text-center text-gray-400">로딩 중...</div> : (
            <>
              <div className="grid md:grid-cols-2 gap-4">
                <StatsTableCard title="환자 현황 요약">
                  {integratedStats?.overall ? (
                    <table className="tbl">
                      <tbody>
                        <tr><td className="text-gray-500">총 입원자수</td><td className="text-right font-semibold">{integratedStats.overall.total_occupied}명</td></tr>
                        <tr><td className="text-gray-500">잔여 병상</td><td className="text-right font-semibold">{integratedStats.overall.total_available}개</td></tr>
                        <tr><td className="text-gray-500">평균 가동률</td><td className="text-right font-semibold">{integratedStats.overall.occupancy_rate}%</td></tr>
                        <tr><td className="text-gray-500">기간 입원</td><td className="text-right font-semibold">{integratedStats.overall.admitted_count}건</td></tr>
                        <tr><td className="text-gray-500">기간 퇴원</td><td className="text-right font-semibold">{integratedStats.overall.discharged_count}건</td></tr>
                        <tr><td className="text-gray-500">평균 재원일수</td><td className="text-right font-semibold">{integratedStats.overall.avg_los}일</td></tr>
                      </tbody>
                    </table>
                  ) : <div className="p-4 text-center text-gray-400 text-xs">데이터 없음</div>}
                </StatsTableCard>
                <StatsTableCard title="보험유형 분포">
                  <table className="tbl">
                    <tbody>
                      {Object.entries(integratedStats?.breakdown?.insurance_type || {}).sort(([, a], [, b]) => Number(b) - Number(a)).map(([k, v]) => {
                        const labels: Record<string, string> = { HEALTH: '건강보험', MEDICAL_1: '의료급여 1종', MEDICAL_2: '의료급여 2종', WORKERS_COMP: '산재보험', AUTO_INS: '자동차보험' };
                        return <tr key={k}><td className="text-gray-500">{labels[k] ?? k}</td><td className="text-right font-semibold">{Number(v)}명</td></tr>;
                      })}
                    </tbody>
                  </table>
                </StatsTableCard>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <StatsTableCard title="환자군 분포">
                  <table className="tbl">
                    <tbody>
                      {[['HIGHEST', '최고도'], ['HIGH', '고도'], ['MEDIUM', '중도'], ['LOW', '경도'], ['SELECT', '선택'], ['UNRATED', '미평가'], ['INFECTION', '감염']].map(([k, l]) => (
                        <tr key={k}><td className="text-gray-500">{l}</td><td className="text-right font-semibold">{integratedStats?.breakdown?.patient_group?.[k] ?? 0}명</td></tr>
                      ))}
                    </tbody>
                  </table>
                </StatsTableCard>
                <div className="bg-white rounded-xl border border-gray-100 shadow-card p-5 space-y-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-700 mb-2">특성화 현황</p>
                    <div className="flex gap-4 text-xs">
                      {[['INFECT', '감염'], ['DIALYSIS', '투석'], ['REHAB', '재활']].map(([k, l]) => (
                        <div key={k} className="text-center"><p className="text-gray-500">{l}</p><p className="font-bold text-lg">{integratedStats?.breakdown?.specialization?.[k] ?? 0}명</p></div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-700 mb-2">기저귀 현황</p>
                    <div className="flex gap-4 text-xs">
                      {[['IN_HOUSE', '원내'], ['PERSONAL', '본인'], ['NONE', '미사용']].map(([k, l]) => (
                        <div key={k} className="text-center"><p className="text-gray-500">{l}</p><p className="font-bold text-lg">{integratedStats?.breakdown?.diaper?.[k] ?? 0}명</p></div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <StatsTableCard title={`부서별 불출금액 (${yearMonth})`} isEmpty={deptSummary.length === 0} emptyMessage="해당 기간 불출 데이터가 없습니다.">
                <table className="tbl">
                  <thead><tr><th>부서</th><th className="text-right">불출금액</th><th className="text-right">불출수량</th></tr></thead>
                  <tbody>
                    {deptSummary.map(d => (
                      <tr key={d.name}><td>{d.name}</td><td className="text-right font-semibold">{fmt(d.amount)}원</td><td className="text-right">{fmt(d.qty)}</td></tr>
                    ))}
                    <tr className="font-bold bg-gray-50"><td>합계</td><td className="text-right">{fmt(totalAmt)}원</td><td className="text-right">{fmt(totalQty)}</td></tr>
                  </tbody>
                </table>
              </StatsTableCard>

              <StatsTableCard title="업체별 발주금액 + 재고금액 (FIFO)">
                <table className="tbl">
                  <thead><tr><th>업체</th><th className="text-right">이달 발주금액</th><th className="text-right">직전 발주금액</th><th className="text-right">증감률</th><th className="text-right">재고금액(FIFO)</th></tr></thead>
                  <tbody>
                    {(kpiVendor?.vendor_order_amounts || []).map((r: any) => {
                      const inv = (kpiVendor?.vendor_inventory_amounts || []).find((x: any) => x.vendor_id === r.vendor_id);
                      return (
                        <tr key={r.vendor_id || r.vendor_name}>
                          <td>{r.vendor_name}</td>
                          <td className="text-right">{fmt(r.order_amount_current ?? 0)}원</td>
                          <td className="text-right">{fmt(r.order_amount_previous ?? 0)}원</td>
                          <td className={`text-right ${(r.diff_pct ?? 0) > 0 ? 'text-red-500' : (r.diff_pct ?? 0) < 0 ? 'text-blue-500' : ''}`}>{r.diff_pct ?? 0}%</td>
                          <td className="text-right">{fmt(inv?.inventory_amount_fifo ?? 0)}원</td>
                        </tr>
                      );
                    })}
                    {!(kpiVendor?.vendor_order_amounts?.length) && <tr><td colSpan={5} className="text-center text-gray-400">데이터 없음</td></tr>}
                  </tbody>
                </table>
              </StatsTableCard>
            </>
          )}
        </div>
      )}

      {pageTab === 'efficiency' && (
        <div className="space-y-5">
          <StatsFilterBar>
            <div><label className="label">시작일</label><input type="date" value={effRange.from} onChange={e => setEffRange(prev => ({ ...prev, from: e.target.value }))} className="input w-40" /></div>
            <div><label className="label">종료일</label><input type="date" value={effRange.to} onChange={e => setEffRange(prev => ({ ...prev, to: e.target.value }))} className="input w-40" /></div>
            <div><label className="label">부서(선택)</label><select value={effDept} onChange={e => setEffDept(e.target.value)} className="input w-44"><option value="">전체</option>{depts.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
            <label className="inline-flex items-center gap-2 text-sm text-gray-700 self-center"><input type="checkbox" checked={comparePrev} onChange={e => setComparePrev(e.target.checked)} />직전 비교</label>
            <button onClick={loadEfficiency} className="btn-secondary">조회</button>
          </StatsFilterBar>

          {loadingEfficiency || !efficiencyData ? (
            <div className="bg-white rounded-xl border border-gray-100 shadow-card p-8 text-center text-gray-400 text-sm">로딩 중...</div>
          ) : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatsKpiCard label="입원" value={efficiencyData?.admission_discharge?.total_admit ?? 0} />
                <StatsKpiCard label="퇴원" value={efficiencyData?.admission_discharge?.total_discharge ?? 0} />
                <StatsKpiCard label="ALOS" value={efficiencyData?.admission_discharge?.alos ?? 0} />
                <StatsKpiCard label="가동률" value={`${efficiencyData?.occupancy?.occupancy_rate ?? 0}%`} />
              </div>

              <StatsTableCard title="카테고리별 비용/PPD/증감률">
                <table className="tbl">
                  <thead><tr><th>카테고리</th><th className="text-right">비용(현재)</th><th className="text-right">비용(직전)</th><th className="text-right">증감률</th><th className="text-right">PPD(현재)</th></tr></thead>
                  <tbody>
                    {Object.entries(efficiencyData?.consumable_costs?.by_category?.current || {}).map(([k, v]) => (
                      <tr key={k}>
                        <td>{k}</td>
                        <td className="text-right">{Number(v || 0).toLocaleString()}</td>
                        <td className="text-right">{Number(efficiencyData?.consumable_costs?.by_category?.previous?.[k] ?? 0).toLocaleString()}</td>
                        <td className="text-right">{efficiencyData?.consumable_costs?.by_category?.diff_pct?.[k] ?? 0}%</td>
                        <td className="text-right">{efficiencyData?.consumable_costs?.ppd?.current?.[k] ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </StatsTableCard>

              <StatsTableCard title="비용 구조 (부서 사용 기준)">
                <table className="tbl">
                  <thead><tr><th>구분</th><th className="text-right">비용(현재)</th><th className="text-right">비용(직전)</th><th className="text-right">증감률</th></tr></thead>
                  <tbody>
                    <tr><td>환자직접비</td><td className="text-right">{Number(efficiencyData?.consumable_costs?.cost_structure?.current?.patient_direct ?? 0).toLocaleString()}</td><td className="text-right">{Number(efficiencyData?.consumable_costs?.cost_structure?.previous?.patient_direct ?? 0).toLocaleString()}</td><td className="text-right">{efficiencyData?.consumable_costs?.cost_structure?.diff_pct?.patient_direct ?? 0}%</td></tr>
                    <tr><td>운영간접비</td><td className="text-right">{Number(efficiencyData?.consumable_costs?.cost_structure?.current?.ops_indirect ?? 0).toLocaleString()}</td><td className="text-right">{Number(efficiencyData?.consumable_costs?.cost_structure?.previous?.ops_indirect ?? 0).toLocaleString()}</td><td className="text-right">{efficiencyData?.consumable_costs?.cost_structure?.diff_pct?.ops_indirect ?? 0}%</td></tr>
                    <tr className="font-semibold bg-gray-50"><td>합계</td><td className="text-right">{Number(efficiencyData?.consumable_costs?.cost_structure?.current?.total ?? 0).toLocaleString()}</td><td className="text-right">{Number(efficiencyData?.consumable_costs?.cost_structure?.previous?.total ?? 0).toLocaleString()}</td><td className="text-right">{efficiencyData?.consumable_costs?.cost_structure?.diff_pct?.total ?? 0}%</td></tr>
                  </tbody>
                </table>
              </StatsTableCard>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="bg-white rounded-xl border border-gray-100 shadow-card p-5">
                  <p className="text-sm font-semibold text-gray-700 mb-2">가동률 민감도</p>
                  <div className="text-xs text-gray-700 space-y-1">
                    <div>가동률 1% 변화당 비용 기울기: <b>{efficiencyData?.consumable_costs?.sensitivity?.slope_per_1pct ?? 0}</b></div>
                    <div>상관계수: <b>{efficiencyData?.consumable_costs?.sensitivity?.correlation ?? 0}</b></div>
                    <div>평균 가동률: <b>{efficiencyData?.consumable_costs?.sensitivity?.mean_occupancy_rate ?? 0}%</b></div>
                  </div>
                </div>
                <StatsTableCard title="기저귀 A/B/C">
                  <table className="tbl">
                    <thead><tr><th>그룹</th><th className="text-right">인원</th></tr></thead>
                    <tbody>
                      <tr><td>A(원내)</td><td className="text-right">{efficiencyData?.diaper_analysis?.group_abc?.A ?? 0}</td></tr>
                      <tr><td>B(본인)</td><td className="text-right">{efficiencyData?.diaper_analysis?.group_abc?.B ?? 0}</td></tr>
                      <tr><td>C(미사용)</td><td className="text-right">{efficiencyData?.diaper_analysis?.group_abc?.C ?? 0}</td></tr>
                    </tbody>
                  </table>
                </StatsTableCard>
              </div>

              <div className="bg-white rounded-xl border border-gray-100 shadow-card p-5">
                <p className="text-sm font-semibold text-gray-700 mb-2">경영진 요약</p>
                <ul className="list-disc ml-5 text-xs text-gray-700">
                  {(efficiencyData?.executive_summary?.strengths || []).map((t: string, i: number) => <li key={`s-${i}`}>{t}</li>)}
                  {(efficiencyData?.executive_summary?.weaknesses || []).map((t: string, i: number) => <li key={`w-${i}`}>{t}</li>)}
                  {(efficiencyData?.executive_summary?.recommendations || []).map((t: string, i: number) => <li key={`r-${i}`}>{t}</li>)}
                </ul>
              </div>

              <StatsTableCard title="업체별 발주/재고 금액">
                <table className="tbl">
                  <thead><tr><th>업체</th><th className="text-right">발주금액(현재)</th><th className="text-right">발주금액(직전)</th><th className="text-right">증감률</th><th className="text-right">재고금액(FIFO)</th></tr></thead>
                  <tbody>
                    {(vendorSummary?.vendor_order_amounts || []).map((r: any) => {
                      const inv = (vendorSummary?.vendor_inventory_amounts || []).find((x: any) => x.vendor_id === r.vendor_id || x.vendor_name === r.vendor_name);
                      return (
                        <tr key={r.vendor_id || r.vendor_name}>
                          <td>{r.vendor_name}</td>
                          <td className="text-right">{Number(r.order_amount_current ?? 0).toLocaleString()}</td>
                          <td className="text-right">{Number(r.order_amount_previous ?? 0).toLocaleString()}</td>
                          <td className="text-right">{r.diff_pct ?? 0}%</td>
                          <td className="text-right">{Number(inv?.inventory_amount_fifo ?? 0).toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </StatsTableCard>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
