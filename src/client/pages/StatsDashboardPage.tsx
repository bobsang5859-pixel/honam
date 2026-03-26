import React, { lazy, Suspense, useState } from 'react';
import { PieChart as PieChartIcon, Package, Users } from 'lucide-react';
import { PageHeader } from '../components/ui';
import { useAuth } from '../hooks/useAuth';

const SupplyStatsTab = lazy(() => import('./SupplyStatsTab'));
const PatientStatsTab = lazy(() => import('./PatientStatsTab'));

function Loading() {
  return <div className="text-center py-12 text-slate-400 text-sm">로딩 중...</div>;
}

export default function StatsDashboardPage() {
  const { user, hasPerm } = useAuth();
  const isAdmin = hasPerm('SYSTEM_ADMIN');
  const canSupply = isAdmin || hasPerm('STATS_VIEW') || hasPerm('STATS_VIEW_ALL');
  const canPatient = isAdmin || hasPerm('PATIENT_STATS_VIEW') || hasPerm('PATIENT_STATS_VIEW_ALL');
  const isAllSupply = isAdmin || hasPerm('STATS_VIEW_ALL');
  const isAllPatient = isAdmin || hasPerm('PATIENT_STATS_VIEW_ALL');
  const deptId = isAllSupply ? '' : ((user as any)?.department_id || '');
  const deptName = (user as any)?.department_name || '';

  const tabs = [
    ...(canSupply ? [{ key: 'supply' as const, label: '물품통계', icon: Package }] : []),
    ...(canPatient ? [{ key: 'patient' as const, label: '환자통계', icon: Users }] : []),
  ];
  const [tab, setTab] = useState<'supply' | 'patient'>(tabs[0]?.key || 'supply');

  return (
    <div>
      <PageHeader
        icon={PieChartIcon}
        title="통계"
        description={isAllSupply && isAllPatient ? '전체 통계' : `${deptName} 통계`}
      />

      {(!isAllSupply || !isAllPatient) && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
          현재 <strong>{deptName}</strong> 데이터만 조회됩니다.
        </div>
      )}

      {/* 탭 바 */}
      <div className="border-b border-slate-200 flex mb-6">
        {tabs.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition
                ${tab === t.key
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-slate-400 hover:text-slate-600 hover:border-slate-300'
                }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <Suspense fallback={<Loading />}>
        {tab === 'supply' && canSupply && <SupplyStatsTab deptId={deptId} />}
        {tab === 'patient' && canPatient && <PatientStatsTab deptId={deptId} />}
      </Suspense>
    </div>
  );
}
