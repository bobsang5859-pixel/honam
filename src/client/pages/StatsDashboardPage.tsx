import React, { lazy, Suspense, useState, useCallback } from 'react';
import { BarChart3, Package, Users, Printer, FileText } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { api } from '../utils/api';
import { generateSupplyReport, generatePatientReport } from '../utils/statsReport';

const SupplyStatsTab = lazy(() => import('./SupplyStatsTab'));
const PatientStatsTab = lazy(() => import('./PatientStatsTab'));

function Loading() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
    </div>
  );
}

export default function StatsDashboardPage() {
  const { user, hasPerm } = useAuth();
  const isAdmin = hasPerm('SYSTEM_ADMIN');
  const canSupply = isAdmin || hasPerm('STATS_VIEW') || hasPerm('STATS_VIEW_ALL');
  const canPatient = isAdmin || hasPerm('PATIENT_STATS_VIEW') || hasPerm('PATIENT_STATS_VIEW_ALL');
  const isAllSupply = isAdmin || hasPerm('STATS_VIEW_ALL');
  const deptId = isAllSupply ? '' : ((user as any)?.department_id || '');
  const deptName = (user as any)?.department_name || '';

  const tabs = [
    ...(canSupply ? [{ key: 'supply' as const, label: '물품통계', icon: Package }] : []),
    ...(canPatient ? [{ key: 'patient' as const, label: '환자통계', icon: Users }] : []),
  ];
  const [tab, setTab] = useState<'supply' | 'patient'>(tabs[0]?.key || 'supply');
  const [exporting, setExporting] = useState(false);

  const handlePrint = useCallback(() => { window.print(); }, []);

  const handleWordExport = useCallback(async () => {
    setExporting(true);
    try {
      const now = new Date();
      const q = deptId ? `&department_id=${deptId}` : '';

      if (tab === 'supply') {
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const [costData, vendorData, patientData] = await Promise.all([
          api(`/cost/statistics?year=${year}&month=${month}${q}`).catch(() => ({})),
          api(`/cost/vendor-summary?year=${year}${q}`).catch(() => []),
          api(`/patients/stats?date_from=${year}-${String(month).padStart(2, '0')}-01&date_to=${year}-${String(month).padStart(2, '0')}-28${q}`).catch(() => null),
        ]);
        const cost = {
          ...(costData || {}),
          by_vendor: Array.isArray(vendorData) ? vendorData : [],
          patient_count: patientData?.overall?.total_occupied ?? 0,
        };
        await generateSupplyReport(cost, { year, month });
      } else {
        const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        const to = now.toISOString().slice(0, 10);
        const [statsData, complaintsData] = await Promise.all([
          api(`/patients/stats?date_from=${from}&date_to=${to}${q}`).catch(() => null),
          api(`/complaints/stats?date_from=${from}&date_to=${to}${q}`).catch(() => null),
        ]);
        await generatePatientReport(statsData, complaintsData, null, { from, to });
      }
    } catch (e) {
      console.error('보고서 생성 실패:', e);
    } finally {
      setExporting(false);
    }
  }, [tab, deptId]);

  const now = new Date();
  const printDate = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;
  const reportTitle = tab === 'supply' ? '물품 통계 보고서' : '환자 통계 보고서';

  return (
    <div>
      {/* 인쇄 시에만 보이는 보고서 헤더 */}
      <div className="print-header hidden">
        <h1>{reportTitle}</h1>
        <p>{isAllSupply ? '전체 부서' : deptName} | 출력일: {printDate}</p>
      </div>

      {/* 헤더 */}
      <div className="mb-6 no-print">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 flex items-center justify-center">
              <BarChart3 className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-extrabold text-slate-800">통계 대시보드</h1>
              <p className="text-xs text-slate-400">{isAllSupply ? '전체 부서' : deptName} 데이터</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleWordExport}
              disabled={exporting}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50"
            >
              <FileText className="w-4 h-4" />
              {exporting ? '생성 중...' : 'Word 보고서'}
            </button>
            <button
              onClick={handlePrint}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-slate-600 hover:bg-gray-50 transition-colors shadow-sm"
            >
              <Printer className="w-4 h-4" />
              인쇄
            </button>
          </div>
        </div>
      </div>

      {/* 탭 바 */}
      <div className="flex gap-1 mb-6 bg-gray-100 rounded-xl p-1 w-fit no-print">
        {tabs.map(t => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-lg transition-all
                ${active
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-400 hover:text-slate-600'
                }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {!isAllSupply && (
        <div className="mb-4 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-700 no-print">
          현재 <strong>{deptName}</strong> 데이터만 조회됩니다.
        </div>
      )}

      <Suspense fallback={<Loading />}>
        {tab === 'supply' && canSupply && <SupplyStatsTab deptId={deptId} />}
        {tab === 'patient' && canPatient && <PatientStatsTab deptId={deptId} />}
      </Suspense>
    </div>
  );
}
