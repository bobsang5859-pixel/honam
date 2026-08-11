import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PatientStatsPage from './PatientStatsPage';
import { BigKpi, OverviewCard } from '../components/stats';

export default function PatientStatsTab({
  deptId,
  departments,
  onDeptChange,
  canViewAll,
}: {
  deptId: string;
  departments?: Array<{ id: string; name: string }>;
  onDeptChange?: (id: string) => void;
  canViewAll?: boolean;
}) {
  const [section, setSection] = useState<'operations' | 'finance' | 'info'>('operations');
  const [financeData, setFinanceData] = useState<any>(null);

  useEffect(() => {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);
    api(`/patients/stats?date_from=${from}&date_to=${to}${deptId ? `&department_id=${deptId}` : ''}`).then(d => {
      setFinanceData(d);
    }).catch(() => {});
  }, [deptId]);

  const SECTIONS = [
    { key: 'operations' as const, label: '병상 운영지표' },
    { key: 'finance' as const, label: '경영 및 재무' },
    { key: 'info' as const, label: '환자정보' },
  ];

  return (
    <div className="space-y-5">
      {/* 서브 탭 (pill 스타일) */}
      <div className="flex gap-1.5 bg-gray-100 rounded-xl p-1 w-fit no-print">
        {SECTIONS.map(s => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={`px-4 py-2 text-xs font-semibold rounded-lg transition-all
              ${section === s.key
                ? 'bg-white text-slate-800 shadow-sm'
                : 'text-slate-400 hover:text-slate-600'
              }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* 1. 병상 운영지표 */}
      {section === 'operations' && (
        <PatientStatsPage
          section="operations"
          deptId={deptId}
          departments={departments}
          onDeptChange={onDeptChange}
          canViewAll={canViewAll}
        />
      )}

      {/* 2. 경영 및 재무 */}
      {section === 'finance' && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <BigKpi label="환자 수" value={`${financeData?.overall?.total_occupied ?? 0}명`} color="blue" />
            <BigKpi label="급여 합계" value={(() => {
              const covered = financeData?.charges?.covered || {};
              const total = Object.values(covered).reduce((s: number, v: any) => s + (v.total || 0), 0);
              return `₩${total.toLocaleString()}`;
            })()} color="green" />
            <BigKpi label="비급여 합계" value={(() => {
              const nc = financeData?.charges?.non_covered || {};
              const total = Object.values(nc).reduce((s: number, v: any) => s + (v.total || 0), 0);
              return `₩${total.toLocaleString()}`;
            })()} color="amber" />
            <BigKpi label="비급여 비중" value={(() => {
              const covered = Object.values(financeData?.charges?.covered || {}).reduce((s: number, v: any) => s + (v.total || 0), 0);
              const nc = Object.values(financeData?.charges?.non_covered || {}).reduce((s: number, v: any) => s + (v.total || 0), 0);
              const total = covered + nc;
              return total > 0 ? `${((nc / total) * 100).toFixed(1)}%` : '-';
            })()} color="rose" />
          </div>

          {(() => {
            const months: string[] = financeData?.charges?.months ?? [];
            const monthlyTotals = financeData?.charges?.monthly_totals ?? {};
            const covered = financeData?.charges?.covered || {};
            const nonCovered = financeData?.charges?.non_covered || {};
            const fmt = (n: number) => `₩${(n || 0).toLocaleString()}`;
            return (
              <>
                {/* 월별 합계 (기간이 여러 달이면 표시) */}
                {months.length > 1 && (
                  <div className="bg-white border rounded-lg overflow-hidden">
                    <div className="px-4 py-2 border-b text-sm font-medium bg-slate-50">월별 합계</div>
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-slate-600 text-xs">
                        <tr>
                          <th className="text-left px-3 py-1.5">월</th>
                          <th className="text-right px-3 py-1.5">급여</th>
                          <th className="text-right px-3 py-1.5">비급여</th>
                          <th className="text-right px-3 py-1.5">합계</th>
                          <th className="text-right px-3 py-1.5">비급여 비중</th>
                        </tr>
                      </thead>
                      <tbody>
                        {months.map(m => {
                          const r = monthlyTotals[m] || { covered: 0, non_covered: 0 };
                          const total = r.covered + r.non_covered;
                          const ncPct = total > 0 ? (r.non_covered / total) * 100 : 0;
                          return (
                            <tr key={m} className="border-t">
                              <td className="px-3 py-1.5">{m}</td>
                              <td className="text-right px-3 py-1.5 text-emerald-700">{fmt(r.covered)}</td>
                              <td className="text-right px-3 py-1.5 text-amber-700">{fmt(r.non_covered)}</td>
                              <td className="text-right px-3 py-1.5 font-semibold">{fmt(total)}</td>
                              <td className="text-right px-3 py-1.5 text-slate-500">{ncPct.toFixed(1)}%</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* 항목별 — 월별 컬럼으로 표시 */}
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="bg-white border rounded-lg overflow-hidden">
                    <div className="px-4 py-2 border-b text-sm font-medium bg-slate-50">급여 항목별 (월)</div>
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="text-left px-3 py-1.5">항목</th>
                          {months.map(m => <th key={m} className="text-right px-3 py-1.5">{m}</th>)}
                          <th className="text-right px-3 py-1.5">합계</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(covered).map(([name, v]: [string, any]) => (
                          <tr key={name} className="border-t">
                            <td className="px-3 py-1.5">{name}</td>
                            {months.map(m => (
                              <td key={m} className="text-right px-3 py-1.5">{fmt(v.by_month?.[m] ?? 0)}</td>
                            ))}
                            <td className="text-right px-3 py-1.5 font-semibold">{fmt(v.total || 0)}</td>
                          </tr>
                        ))}
                        {Object.keys(covered).length === 0 && (
                          <tr><td colSpan={months.length + 2} className="text-center px-3 py-4 text-slate-400">데이터 없음</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="bg-white border rounded-lg overflow-hidden">
                    <div className="px-4 py-2 border-b text-sm font-medium bg-slate-50">비급여 항목별 (월)</div>
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="text-left px-3 py-1.5">항목</th>
                          {months.map(m => <th key={m} className="text-right px-3 py-1.5">{m}</th>)}
                          <th className="text-right px-3 py-1.5">합계</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(nonCovered).map(([name, v]: [string, any]) => (
                          <tr key={name} className="border-t">
                            <td className="px-3 py-1.5">{name}</td>
                            {months.map(m => (
                              <td key={m} className="text-right px-3 py-1.5">{fmt(v.by_month?.[m] ?? 0)}</td>
                            ))}
                            <td className="text-right px-3 py-1.5 font-semibold">{fmt(v.total || 0)}</td>
                          </tr>
                        ))}
                        {Object.keys(nonCovered).length === 0 && (
                          <tr><td colSpan={months.length + 2} className="text-center px-3 py-4 text-slate-400">데이터 없음</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            );
          })()}

          <OverviewCard title="진료비 수납 / 미수금">
            <p className="text-xs text-slate-400">진료비 데이터 입력 후 표시됩니다. (환자 편집 → 진료비 필드)</p>
          </OverviewCard>
        </div>
      )}

      {/* 3. 환자정보 */}
      {section === 'info' && (
        <PatientStatsPage
          section="info"
          deptId={deptId}
          departments={departments}
          onDeptChange={onDeptChange}
          canViewAll={canViewAll}
        />
      )}

    </div>
  );
}
