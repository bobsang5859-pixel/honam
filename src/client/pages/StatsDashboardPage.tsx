import React, { lazy, Suspense, useState } from 'react';
import { PieChart as PieChartIcon } from 'lucide-react';
import { PageHeader } from '../components/ui';

const CostPage           = lazy(() => import('./CostPage'));
const SupplyAnalyticsPage = lazy(() => import('./SupplyAnalyticsPage'));
const DemandForecastPage = lazy(() => import('./DemandForecastPage'));
const POStatsPage        = lazy(() => import('./POStatsPage'));
const RequestStatsPage   = lazy(() => import('./RequestStatsPage'));
const InventoryStatsPage = lazy(() => import('./InventoryStatsPage'));
const StockoutStatsPage  = lazy(() => import('./StockoutStatsPage'));
const PatientStatsPage   = lazy(() => import('./PatientStatsPage'));
const DiseaseStatsPage   = lazy(() => import('./DiseaseStatsPage'));

type TabKey = 'cost' | 'supply' | 'demand' | 'po' | 'request' | 'inventory' | 'stockout' | 'patient' | 'disease';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'cost', label: '비용 통계' },
  { key: 'supply', label: '물품 분석' },
  { key: 'demand', label: '수요예측' },
  { key: 'po', label: '발주/구매' },
  { key: 'request', label: '신청/승인' },
  { key: 'inventory', label: '재고회전' },
  { key: 'stockout', label: '출고오류' },
  { key: 'patient', label: '환자 통계' },
  { key: 'disease', label: '질병 통계' },
];

function Loading() {
  return <div className="text-center py-12 text-slate-400 text-sm">로딩 중...</div>;
}

export default function StatsDashboardPage() {
  const [tab, setTab] = useState<TabKey>('cost');

  return (
    <div>
      <PageHeader
        icon={PieChartIcon}
        title="통계 대시보드"
        description="통합 통계 분석"
      />

      {/* 탭 바 — 언더라인 스타일 */}
      <div className="border-b border-slate-200 flex overflow-x-auto mb-6">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition
              ${tab === t.key
                ? 'border-teal-600 text-teal-700'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
              }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 탭 내용 */}
      <Suspense fallback={<Loading />}>
        {tab === 'cost' && <CostPage />}
        {tab === 'supply' && <SupplyAnalyticsPage />}
        {tab === 'demand' && <DemandForecastPage />}
        {tab === 'po' && <POStatsPage />}
        {tab === 'request' && <RequestStatsPage />}
        {tab === 'inventory' && <InventoryStatsPage />}
        {tab === 'stockout' && <StockoutStatsPage />}
        {tab === 'patient' && <PatientStatsPage />}
        {tab === 'disease' && <DiseaseStatsPage />}
      </Suspense>
    </div>
  );
}
