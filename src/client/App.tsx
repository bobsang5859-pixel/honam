import React, { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { api } from './utils/api';
import { setUserMidCategories } from '@shared/types';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import { canAccessMenu } from './utils/menuAccess';
import { ToastProvider } from './components/Toast';

const DashboardPage      = lazy(() => import('./pages/DashboardPage'));
const WardRequestPage    = lazy(() => import('./pages/WardRequestPage'));
const ApprovalPage       = lazy(() => import('./pages/ApprovalPage'));
const PurchaseOrdersPage = lazy(() => import('./pages/PurchaseOrdersPage'));
const PurchaseDecisionsPage = lazy(() => import('./pages/PurchaseDecisionsPage'));
const OrderRoutingPage   = lazy(() => import('./pages/OrderRoutingPage'));
const PurchaseHubPage    = lazy(() => import('./pages/PurchaseHubPage'));
const ReceiptsPage       = lazy(() => import('./pages/ReceiptsPage'));
const StockOutPage       = lazy(() => import('./pages/StockOutPage'));
const ReceiptCheckPage   = lazy(() => import('./pages/ReceiptCheckPage'));
const InventoryPage      = lazy(() => import('./pages/InventoryPage'));
const DeptInventoryPage  = lazy(() => import('./pages/DeptInventoryPage'));
const AuditLogPage       = lazy(() => import('./pages/AuditLogPage'));
const UsersPage          = lazy(() => import('./pages/UsersPage'));
const VendorsPage           = lazy(() => import('./pages/VendorsPage'));
const ItemsPage             = lazy(() => import('./pages/ItemsPage'));
const RecategorizePage      = lazy(() => import('./pages/RecategorizePage'));
const BaselinesPage         = lazy(() => import('./pages/BaselinesPage'));
const ItemCategoriesPage    = lazy(() => import('./pages/ItemCategoriesPage'));
const ExpenseScopesPage     = lazy(() => import('./pages/ExpenseScopesPage'));
const PatientStatsPage   = lazy(() => import('./pages/PatientStatsPage'));
const PatientManagePage  = lazy(() => import('./pages/PatientManagePage'));
const DeptCategoryPage      = lazy(() => import('./pages/DeptCategoryPage'));
const EquipmentRequestPage  = lazy(() => import('./pages/EquipmentRequestPage'));
const MyEquipmentPage       = lazy(() => import('./pages/MyEquipmentPage'));
const SystemPage            = lazy(() => import('./pages/SystemPage'));
const DocTemplatesPage      = lazy(() => import('./pages/DocTemplatesPage'));
const LoansPage             = lazy(() => import('./pages/LoansPage'));
const RequestSchedulesPage  = lazy(() => import('./pages/RequestSchedulesPage'));
const TreatmentTypesPage   = lazy(() => import('./pages/TreatmentTypesPage'));
const StatsDashboardPage   = lazy(() => import('./pages/StatsDashboardPage'));
const CostAnalysisPage     = lazy(() => import('./pages/CostAnalysisPage'));
const CostReconcilePage    = lazy(() => import('./pages/CostReconcilePage'));
const IncinerationPage     = lazy(() => import('./pages/IncinerationPage'));

function Loading() {
  return (
    <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
      <span>로딩 중...</span>
    </div>
  );
}

function ProtectedRoute({
  children,
  perm,
  anyPerm,
  menuKey,
}: {
  children: React.ReactNode;
  perm?: string;
  anyPerm?: string[];
  menuKey?: string;
}) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  // menu_permissions가 직접 지정된 경우 해당 키 포함 여부로 접근 허용
  if (menuKey) {
    const allowed = canAccessMenu(user, {
      key: menuKey,
      perm,
      anyPerm,
    });
    if (!allowed) return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  const { user, loading } = useAuth();
  // 로그인 후 사용자 추가 중분류를 1회 적재 — 분류 라벨/그룹 도출(getMidCategory 등)이 참조
  useEffect(() => {
    if (!user) return;
    api('/item-categories')
      .then((rows: any[]) => setUserMidCategories(
        (Array.isArray(rows) ? rows : [])
          .filter(r => r.is_active !== false && r.is_active !== 0)
          .map(r => ({ code: String(r.code), name: String(r.name) }))))
      .catch(() => {});
  }, [user]);
  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-100">
        <div className="text-center">
          <div className="text-3xl mb-3">🏥</div>
          <p className="text-gray-500 text-sm">로딩 중...</p>
        </div>
      </div>
    );
  }

  const defaultPath = '/';

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={defaultPath} replace /> : <LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route
          index
          element={
            <Suspense fallback={<Loading />}>
              <DashboardPage />
            </Suspense>
          }
        />
        <Route
          path="ward-requests"
          element={
            <ProtectedRoute anyPerm={['REQUEST_USE', 'PURCHASE_MANAGE']} menuKey="ward-requests">
              <Suspense fallback={<Loading />}><WardRequestPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="equipment-requests"
          element={
            <ProtectedRoute anyPerm={['REQUEST_USE', 'PURCHASE_MANAGE']} menuKey="equipment-requests">
              <Suspense fallback={<Loading />}><EquipmentRequestPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="my-equipment"
          element={
            <ProtectedRoute anyPerm={['REQUEST_USE', 'SYSTEM_ADMIN']}>
              <Suspense fallback={<Loading />}><MyEquipmentPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="approvals"
          element={
            <ProtectedRoute perm="PURCHASE_MANAGE" menuKey="approvals">
              <Suspense fallback={<Loading />}><ApprovalPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="purchase-orders"
          element={
            <ProtectedRoute perm="PURCHASE_MANAGE" menuKey="purchase-orders">
              <Suspense fallback={<Loading />}><PurchaseHubPage /></Suspense>
            </ProtectedRoute>
          }
        />
        {/* 구 메뉴 딥링크 호환 — 통합된 발주 허브의 해당 탭으로 리다이렉트 */}
        <Route path="order-routing" element={<Navigate to="/purchase-orders?tab=routing" replace />} />
        <Route path="purchase-decisions" element={<Navigate to="/purchase-orders?tab=docs" replace />} />
        <Route
          path="receipts"
          element={
            <ProtectedRoute perm="PURCHASE_MANAGE" menuKey="receipts">
              <Suspense fallback={<Loading />}><ReceiptsPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="stock-out"
          element={
            <ProtectedRoute perm="PURCHASE_MANAGE" menuKey="stock-out">
              <Suspense fallback={<Loading />}><StockOutPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="receipt-check"
          element={
            <ProtectedRoute anyPerm={['REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN']} menuKey="receipt-check">
              <Suspense fallback={<Loading />}><ReceiptCheckPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="inventory"
          element={
            <ProtectedRoute anyPerm={['REQUEST_USE', 'PURCHASE_MANAGE']} menuKey="inventory">
              <Suspense fallback={<Loading />}><InventoryPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="stats"
          element={
            <ProtectedRoute anyPerm={['STATS_VIEW', 'SYSTEM_ADMIN']} menuKey="stats-dashboard">
              <Suspense fallback={<Loading />}><StatsDashboardPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="cost-analysis"
          element={
            <ProtectedRoute perm="PURCHASE_MANAGE" menuKey="cost-analysis">
              <Suspense fallback={<Loading />}><CostAnalysisPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="cost-reconcile"
          element={
            <ProtectedRoute anyPerm={['STATS_VIEW_ALL', 'ACCOUNTING_CLOSE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN']} menuKey="cost-reconcile">
              <Suspense fallback={<Loading />}><CostReconcilePage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="audit-logs"
          element={
            <ProtectedRoute perm="BASIC_MANAGE" menuKey="audit-logs">
              <Suspense fallback={<Loading />}><AuditLogPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="items"
          element={
            <ProtectedRoute perm="BASIC_MANAGE" menuKey="items">
              <Suspense fallback={<Loading />}><ItemsPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="items/recategorize"
          element={
            <ProtectedRoute perm="BASIC_MANAGE">
              <Suspense fallback={<Loading />}><RecategorizePage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="vendors"
          element={
            <ProtectedRoute perm="BASIC_MANAGE" menuKey="vendors">
              <Suspense fallback={<Loading />}><VendorsPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="item-categories"
          element={
            <ProtectedRoute perm="BASIC_MANAGE" menuKey="item-categories">
              <Suspense fallback={<Loading />}><ItemCategoriesPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="expense-scopes"
          element={
            <ProtectedRoute perm="BASIC_MANAGE" menuKey="expense-scopes">
              <Suspense fallback={<Loading />}><ExpenseScopesPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="baselines"
          element={
            <ProtectedRoute perm="BASIC_MANAGE" menuKey="baselines">
              <Suspense fallback={<Loading />}><BaselinesPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="loans"
          element={
            <ProtectedRoute perm="REQUEST_USE" menuKey="loans">
              <Suspense fallback={<Loading />}><LoansPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="dept-inventory"
          element={
            <ProtectedRoute perm="REQUEST_USE" menuKey="dept-inventory">
              <Suspense fallback={<Loading />}><DeptInventoryPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="patient-manage"
          element={
            <ProtectedRoute perm="PATIENT_MANAGE" menuKey="patient-manage">
              <Suspense fallback={<Loading />}><PatientManagePage /></Suspense>
            </ProtectedRoute>
          }
        />
        {/* patient-stats는 /stats 내 환자통계 탭으로 통합 */}
        <Route
          path="dept-permissions"
          element={
            <ProtectedRoute perm="BASIC_MANAGE" menuKey="dept-permissions">
              <Suspense fallback={<Loading />}><DeptCategoryPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="users"
          element={
            <ProtectedRoute anyPerm={['BASIC_MANAGE', 'SYSTEM_ADMIN']} menuKey="users">
              <Suspense fallback={<Loading />}><UsersPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="system"
          element={
            <ProtectedRoute perm="SYSTEM_ADMIN" menuKey="system">
              <Suspense fallback={<Loading />}><SystemPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="doc-templates"
          element={
            <ProtectedRoute perm="SYSTEM_ADMIN" menuKey="doc-templates">
              <Suspense fallback={<Loading />}><DocTemplatesPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="request-schedules"
          element={
            <ProtectedRoute menuKey="request-schedules">
              <Suspense fallback={<Loading />}><RequestSchedulesPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="treatment-types"
          element={
            <ProtectedRoute perm="BASIC_MANAGE" menuKey="treatment-types">
              <Suspense fallback={<Loading />}><TreatmentTypesPage /></Suspense>
            </ProtectedRoute>
          }
        />
        <Route
          path="incineration"
          element={
            <ProtectedRoute perm="BASIC_MANAGE" menuKey="incineration">
              <Suspense fallback={<Loading />}><IncinerationPage /></Suspense>
            </ProtectedRoute>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
