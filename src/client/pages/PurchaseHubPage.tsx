/**
 * 발주 허브 — 「발주 준비 / 구매결의서 / 발주」 세 메뉴를 한 메뉴(발주)로 통합.
 *
 * 진입 시 탭: 발주대기 · 서류작성 · 발주내역 (업무 흐름순)
 *   - 발주대기 = 라우팅 작업대 (OrderRoutingPage)
 *   - 서류작성 = 구매결의서 작성·편집·출력 (PurchaseDecisionsPage)
 *   - 발주내역 = 발주서 생성·목록 + 기안서/구매결의서 출력 (PurchaseOrdersPage)
 *
 * 각 탭은 기존 페이지 컴포넌트를 그대로 호스팅(내부 로직 무변경). 활성 탭만 마운트.
 * 탭 상태는 URL ?tab= 에 실어 새로고침/딥링크에도 유지.
 */
import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Truck, FileText, ClipboardList, BarChart3 } from 'lucide-react';

const OrderRoutingPage     = lazy(() => import('./OrderRoutingPage'));
const PurchaseDecisionsPage = lazy(() => import('./PurchaseDecisionsPage'));
const PurchaseOrdersPage   = lazy(() => import('./PurchaseOrdersPage'));
const VendorAmountTab      = lazy(() => import('./VendorAmountTab'));

const TABS = [
  { key: 'routing',  label: '발주대기',   icon: Truck },
  { key: 'docs',     label: '서류작성',   icon: FileText },
  { key: 'history',  label: '발주내역',   icon: ClipboardList },
  { key: 'vendor-amounts', label: '업체별 금액', icon: BarChart3 },
] as const;

type TabKey = typeof TABS[number]['key'];

export default function PurchaseHubPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: TabKey = (TABS.some(t => t.key === raw) ? raw : 'routing') as TabKey;

  const setTab = (k: TabKey) => {
    const next = new URLSearchParams(params);
    next.set('tab', k);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-5 border-b border-slate-200 pb-2">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-1.5 transition-colors ${
                active ? 'bg-teal-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <Suspense fallback={<div className="card p-8 text-center text-slate-400">불러오는 중...</div>}>
        {tab === 'routing' && <OrderRoutingPage />}
        {tab === 'docs' && <PurchaseDecisionsPage />}
        {tab === 'history' && <PurchaseOrdersPage />}
        {tab === 'vendor-amounts' && (
          <div className="card p-5">
            <h2 className="text-base font-bold text-slate-800 mb-4">업체별 구매 금액</h2>
            <VendorAmountTab />
          </div>
        )}
      </Suspense>
    </div>
  );
}
