import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PatientStatsPage from './PatientStatsPage';

export default function PatientStatsTab({ deptId }: { deptId: string }) {
  const [section, setSection] = useState<'operations' | 'finance' | 'info' | 'admin'>('operations');
  const [complaintStats, setComplaintStats] = useState<any>(null);
  const [financeData, setFinanceData] = useState<any>(null);

  useEffect(() => {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);
    const q = deptId ? `&department_id=${deptId}` : '';
    api(`/complaints/stats?date_from=${from}&date_to=${to}${q}`).then(setComplaintStats).catch(() => {});
    // 진료비 집계
    api(`/patients/stats?date_from=${from}&date_to=${to}${deptId ? `&department_id=${deptId}` : ''}`).then(d => {
      setFinanceData(d);
    }).catch(() => {});
  }, [deptId]);

  const SECTIONS = [
    { key: 'operations' as const, label: '병상 운영지표' },
    { key: 'finance' as const, label: '경영 및 재무' },
    { key: 'info' as const, label: '환자정보' },
    { key: 'admin' as const, label: '행정지표' },
  ];

  return (
    <div className="space-y-4">
      {/* 서브 탭 */}
      <div className="flex gap-2">
        {SECTIONS.map(s => (
          <button key={s.key} onClick={() => setSection(s.key)} className={`px-4 py-2 text-xs font-semibold rounded-lg transition-colors ${section === s.key ? 'bg-blue-600 text-white' : 'bg-gray-100 text-slate-500 hover:bg-gray-200'}`}>
            {s.label}
          </button>
        ))}
      </div>

      {/* 1. 병상 운영지표 — 기존 PatientStatsPage 재활용 */}
      {section === 'operations' && <PatientStatsPage />}

      {/* 2. 경영 및 재무 */}
      {section === 'finance' && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <FinKPI label="환자 수" value={`${financeData?.overall?.total_occupied ?? 0}명`} color="blue" />
            <FinKPI label="급여 합계" value={(() => {
              const covered = financeData?.charges?.covered || {};
              const total = Object.values(covered).reduce((s: number, v: any) => s + (v.total || 0), 0);
              return `₩${total.toLocaleString()}`;
            })()} color="green" />
            <FinKPI label="비급여 합계" value={(() => {
              const nc = financeData?.charges?.non_covered || {};
              const total = Object.values(nc).reduce((s: number, v: any) => s + (v.total || 0), 0);
              return `₩${total.toLocaleString()}`;
            })()} color="amber" />
            <FinKPI label="비급여 비중" value={(() => {
              const covered = Object.values(financeData?.charges?.covered || {}).reduce((s: number, v: any) => s + (v.total || 0), 0);
              const nc = Object.values(financeData?.charges?.non_covered || {}).reduce((s: number, v: any) => s + (v.total || 0), 0);
              const total = covered + nc;
              return total > 0 ? `${((nc / total) * 100).toFixed(1)}%` : '-';
            })()} color="rose" />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
              <p className="text-sm font-bold text-slate-700 mb-3">급여 항목별</p>
              {Object.entries(financeData?.charges?.covered || {}).length > 0 ? (
                <table className="w-full text-xs">
                  <thead><tr className="border-b"><th className="text-left py-1.5 text-slate-500">항목</th><th className="text-right py-1.5 text-slate-500">총액</th><th className="text-right py-1.5 text-slate-500">건수</th></tr></thead>
                  <tbody>
                    {Object.entries(financeData?.charges?.covered || {}).map(([name, v]: [string, any]) => (
                      <tr key={name} className="border-b border-gray-50"><td className="py-1.5">{name}</td><td className="text-right font-medium">₩{(v.total || 0).toLocaleString()}</td><td className="text-right text-slate-400">{v.count || 0}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="text-xs text-slate-300">데이터 없음</p>}
            </div>
            <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
              <p className="text-sm font-bold text-slate-700 mb-3">비급여 항목별</p>
              {Object.entries(financeData?.charges?.non_covered || {}).length > 0 ? (
                <table className="w-full text-xs">
                  <thead><tr className="border-b"><th className="text-left py-1.5 text-slate-500">항목</th><th className="text-right py-1.5 text-slate-500">총액</th><th className="text-right py-1.5 text-slate-500">건수</th></tr></thead>
                  <tbody>
                    {Object.entries(financeData?.charges?.non_covered || {}).map(([name, v]: [string, any]) => (
                      <tr key={name} className="border-b border-gray-50"><td className="py-1.5">{name}</td><td className="text-right font-medium">₩{(v.total || 0).toLocaleString()}</td><td className="text-right text-slate-400">{v.count || 0}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="text-xs text-slate-300">데이터 없음</p>}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
            <p className="text-sm font-bold text-slate-700 mb-2">진료비 수납 / 미수금</p>
            <p className="text-xs text-slate-400">진료비 데이터 입력 후 표시됩니다. (환자 편집 → 진료비 필드)</p>
          </div>
        </div>
      )}

      {/* 3. 환자정보 — PatientStatsPage에 이미 포함 (환자군/보험유형/특성화/특정기간) */}
      {section === 'info' && <PatientStatsPage />}

      {/* 4. 행정지표 — 민원/상담 */}
      {section === 'admin' && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <FinKPI label="총 건수" value={`${complaintStats?.total ?? 0}건`} color="blue" />
            <FinKPI label="민원" value={`${complaintStats?.complaint_count ?? 0}건`} color="red" />
            <FinKPI label="상담" value={`${complaintStats?.counsel_count ?? 0}건`} color="green" />
            <FinKPI label="처리율" value={`${complaintStats?.resolution_rate ?? 0}%`} color="amber" />
          </div>
          <div className="grid md:grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border p-4 text-center">
              <p className="text-2xl font-extrabold text-orange-600">{complaintStats?.open ?? 0}</p>
              <p className="text-[10px] text-slate-500 mt-1">미처리</p>
            </div>
            <div className="bg-white rounded-xl border p-4 text-center">
              <p className="text-2xl font-extrabold text-blue-600">{complaintStats?.in_progress ?? 0}</p>
              <p className="text-[10px] text-slate-500 mt-1">처리중</p>
            </div>
            <div className="bg-white rounded-xl border p-4 text-center">
              <p className="text-2xl font-extrabold text-green-600">{complaintStats?.closed ?? 0}</p>
              <p className="text-[10px] text-slate-500 mt-1">완료</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FinKPI({ label, value, color }: { label: string; value: string; color: string }) {
  const c: Record<string, string> = {
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    green: 'bg-green-50 border-green-200 text-green-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
  };
  return (
    <div className={`border rounded-xl p-3 ${c[color] || c.blue}`}>
      <p className="text-[10px] text-slate-500">{label}</p>
      <p className="text-lg font-extrabold mt-0.5">{value}</p>
    </div>
  );
}
