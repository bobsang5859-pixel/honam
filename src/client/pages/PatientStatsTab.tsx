import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PatientStatsPage from './PatientStatsPage';
import { BigKpi, OverviewCard, MetricRow, ReportTable } from '../components/stats';

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
      {section === 'operations' && <PatientStatsPage section="operations" />}

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

          <div className="grid md:grid-cols-2 gap-4">
            <ReportTable
              title="급여 항목별"
              columns={[
                { key: 'name', label: '항목' },
                { key: 'total', label: '총액', align: 'right', render: (v: number) => `₩${(v || 0).toLocaleString()}` },
                { key: 'count', label: '건수', align: 'right' },
              ]}
              data={Object.entries(financeData?.charges?.covered || {}).map(([name, v]: [string, any]) => ({
                name, total: v.total || 0, count: v.count || 0,
              }))}
            />
            <ReportTable
              title="비급여 항목별"
              columns={[
                { key: 'name', label: '항목' },
                { key: 'total', label: '총액', align: 'right', render: (v: number) => `₩${(v || 0).toLocaleString()}` },
                { key: 'count', label: '건수', align: 'right' },
              ]}
              data={Object.entries(financeData?.charges?.non_covered || {}).map(([name, v]: [string, any]) => ({
                name, total: v.total || 0, count: v.count || 0,
              }))}
            />
          </div>

          <OverviewCard title="진료비 수납 / 미수금">
            <p className="text-xs text-slate-400">진료비 데이터 입력 후 표시됩니다. (환자 편집 → 진료비 필드)</p>
          </OverviewCard>
        </div>
      )}

      {/* 3. 환자정보 */}
      {section === 'info' && <PatientStatsPage section="info" />}

      {/* 4. 행정지표 — 민원/상담 */}
      {section === 'admin' && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <BigKpi label="총 건수" value={`${complaintStats?.total ?? 0}건`} color="blue" />
            <BigKpi label="민원" value={`${complaintStats?.complaint_count ?? 0}건`} color="red" />
            <BigKpi label="상담" value={`${complaintStats?.counsel_count ?? 0}건`} color="green" />
            <BigKpi label="처리율" value={`${complaintStats?.resolution_rate ?? 0}%`} color="amber" />
          </div>

          <OverviewCard title="처리 현황">
            <MetricRow label="미처리" value={`${complaintStats?.open ?? 0}건`} />
            <MetricRow label="처리중" value={`${complaintStats?.in_progress ?? 0}건`} />
            <MetricRow label="완료" value={`${complaintStats?.closed ?? 0}건`} />
          </OverviewCard>
        </div>
      )}
    </div>
  );
}
