import { useEffect, useMemo, useState } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { canAccessMenu } from '../utils/menuAccess';
import { useInactivityTimeout } from '../hooks/useInactivityTimeout';
import { api } from '../utils/api';
import AiChat from './AiChat';
import {
  LayoutDashboard, Package, Building2, FolderTree, BarChart3, DollarSign,
  Ruler, CalendarClock, HeartPulse, Flame, CheckCircle2, FileText,
  PackageCheck, PackageOpen, Boxes, ClipboardList, Monitor, PenLine,
  ArrowLeftRight, Wrench, ClipboardCheck, PieChart, User, Users,
  ScrollText, Settings, LogOut, Menu, X, ChevronDown, MessageSquare,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/* ─── 타입 ─────────────────────────────────────────────────────── */
interface MenuItem {
  key: string;
  path: string;
  label: string;
  icon: LucideIcon;
  perm?: string;
  anyPerm?: string[];
}

interface MenuSection {
  key: string;
  label: string;
  items: MenuItem[];
}

/* ─── 메뉴 정의 ──────────────────────────────────────────────── */
const MENU_SECTIONS: MenuSection[] = [
  {
    key: 'basic', label: '기초등록',
    items: [
      { key: 'items',              path: '/items',              label: '품목',     icon: Package,       perm: 'BASIC_MANAGE' },
      { key: 'vendors',            path: '/vendors',            label: '업체',     icon: Building2,     perm: 'BASIC_MANAGE' },
      { key: 'item-categories',    path: '/item-categories',    label: '분류',     icon: FolderTree,    perm: 'BASIC_MANAGE' },
      { key: 'stats-categories',   path: '/stats-categories',   label: '통계카테고리', icon: BarChart3,  perm: 'BASIC_MANAGE' },
      { key: 'expense-scopes',     path: '/expense-scopes',     label: '비용구분', icon: DollarSign,    perm: 'BASIC_MANAGE' },
      { key: 'baselines',          path: '/baselines',          label: '기준량',   icon: Ruler,         perm: 'BASIC_MANAGE' },
      { key: 'request-schedules',  path: '/request-schedules',  label: '신청주기', icon: CalendarClock, perm: 'BASIC_MANAGE' },
      { key: 'treatment-types',    path: '/treatment-types',    label: '처치유형', icon: HeartPulse,    perm: 'BASIC_MANAGE' },
      { key: 'incineration',       path: '/incineration',       label: '소각료',   icon: Flame,         perm: 'BASIC_MANAGE' },
      { key: 'patient-manage',     path: '/patient-manage',     label: '환자관리', icon: User,          perm: 'PATIENT_MANAGE' },
    ],
  },
  {
    key: 'purchase', label: '구매·재고',
    items: [
      { key: 'approvals',       path: '/approvals',       label: '승인',   icon: CheckCircle2, perm: 'PURCHASE_MANAGE' },
      { key: 'purchase-orders', path: '/purchase-orders', label: '발주',   icon: FileText,     perm: 'PURCHASE_MANAGE' },
      { key: 'receipts',        path: '/receipts',        label: '입고',   icon: PackageCheck, perm: 'PURCHASE_MANAGE' },
      { key: 'stock-out',       path: '/stock-out',       label: '불출',   icon: PackageOpen,  perm: 'PURCHASE_MANAGE' },
      { key: 'inventory',       path: '/inventory',       label: '재고',   icon: Boxes,        perm: 'PURCHASE_MANAGE' },
    ],
  },
  {
    key: 'request', label: '신청·사용',
    items: [
      { key: 'ward-requests',      path: '/ward-requests',      label: '소모품신청', icon: ClipboardList,  anyPerm: ['REQUEST_USE', 'PURCHASE_MANAGE'] },
      { key: 'equipment-requests', path: '/equipment-requests', label: '비품신청',   icon: Monitor,        anyPerm: ['REQUEST_USE', 'PURCHASE_MANAGE'] },
      { key: 'usage',              path: '/usage',              label: '사용등록',   icon: PenLine,        perm: 'REQUEST_USE' },
      { key: 'loans',              path: '/loans',              label: '대여',       icon: ArrowLeftRight, perm: 'REQUEST_USE' },
      { key: 'my-equipment',       path: '/my-equipment',       label: '수리신청',   icon: Wrench,         perm: 'REQUEST_USE' },
      { key: 'receipt-check',      path: '/receipt-check',      label: '수령검수',   icon: ClipboardCheck, perm: 'REQUEST_USE' },
    ],
  },
  {
    key: 'etc', label: '기타',
    items: [
      { key: 'stats-dashboard', path: '/stats',          label: '통계',     icon: PieChart, anyPerm: ['STATS_VIEW', 'SYSTEM_ADMIN'] },
      { key: 'complaints',      path: '/complaints',     label: '민원·상담', icon: MessageSquare, anyPerm: ['REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'] },
    ],
  },
  {
    key: 'system', label: '시스템',
    items: [
      { key: 'users',      path: '/users',      label: '사용자',   icon: Users,      anyPerm: ['BASIC_MANAGE', 'SYSTEM_ADMIN'] },
      { key: 'audit-logs', path: '/audit-logs', label: '감사로그', icon: ScrollText, perm: 'BASIC_MANAGE' },
      { key: 'system',     path: '/system',     label: '설정',     icon: Settings,   perm: 'SYSTEM_ADMIN' },
    ],
  },
];

/* ─── 레이아웃 ─────────────────────────────────────────────────── */
export default function Layout() {
  const { user, logout, hasPerm } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sessionOpts, setSessionOpts] = useState({ timeoutMin: 30, warnBeforeMin: 5 });

  // 세션 타임아웃 설정 로드
  useEffect(() => {
    if (!user) return;
    api('/system/settings')
      .then((rows: any[]) => {
        if (!Array.isArray(rows)) return;
        const get = (key: string, def: number) => {
          const r = rows.find((row: any) => row.key === key);
          return r ? (parseInt(r.value) || def) : def;
        };
        setSessionOpts({
          timeoutMin: get('SESSION_TIMEOUT_MIN', 30),
          warnBeforeMin: get('SESSION_WARN_BEFORE_MIN', 5),
        });
      })
      .catch(() => {});
  }, [user?.id]);

  useInactivityTimeout(logout, !!user, sessionOpts);

  // 라우트 변경 시 모바일 메뉴 닫기
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  // 권한 필터링된 메뉴
  const filteredSections = useMemo(() => {
    return MENU_SECTIONS.map(section => ({
      ...section,
      items: section.items.filter(item =>
        canAccessMenu(user ?? null, { key: item.key, perm: item.perm, anyPerm: item.anyPerm })
      ),
    })).filter(s => s.items.length > 0);
  }, [user]);

  const roleLabel = () => {
    if (hasPerm('SYSTEM_ADMIN')) return '시스템관리자';
    if (hasPerm('BASIC_MANAGE')) return '관리자';
    if (hasPerm('PURCHASE_MANAGE')) return '구매담당';
    if (hasPerm('REQUEST_USE')) return '부서';
    return '사용자';
  };

  const handleLogout = () => { logout(); navigate('/login'); };
  const toggleSection = (key: string) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));

  const expanded = hovered;

  /* ─── 사이드바 컨텐츠 (PC/모바일 공유) ───────────────────────── */
  const sidebarContent = (isMobile: boolean) => {
    const isExpanded = isMobile || expanded;

    return (
      <div className="flex flex-col h-full bg-white border-r border-gray-200">
        {/* 로고 */}
        <div className="flex items-center gap-3 px-4 py-5 flex-shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white font-bold text-sm flex-shrink-0 shadow-md shadow-blue-200">
            H
          </div>
          {isExpanded && (
            <div className="overflow-hidden">
              <p className="font-bold text-sm text-slate-800 leading-tight truncate">물품관리</p>
              <p className="text-[10px] text-slate-400 leading-tight">호남 The Sum</p>
            </div>
          )}
          {isMobile && (
            <button onClick={() => setMobileOpen(false)} className="ml-auto p-1 text-slate-400 hover:text-slate-600">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* 대시보드 */}
        <div className="px-3 pb-1">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 group ${
                isActive
                  ? 'bg-blue-50 text-blue-700 font-semibold'
                  : 'text-slate-500 hover:bg-gray-50 hover:text-slate-700'
              }`
            }
          >
            <LayoutDashboard className="w-5 h-5 flex-shrink-0" />
            {isExpanded && <span className="text-[13px] font-medium truncate">대시보드</span>}
          </NavLink>
        </div>

        <div className="mx-4 my-1 border-t border-gray-100" />

        {/* 메뉴 섹션 */}
        <nav className="flex-1 overflow-y-auto px-3 py-1 space-y-0.5">
          {filteredSections.map(section => {
            const isCollapsed = collapsed[section.key] ?? false;
            const hasActive = section.items.some(item => {
              const base = item.path.split('?')[0];
              return location.pathname === base || location.pathname.startsWith(`${base}/`);
            });

            return (
              <div key={section.key}>
                {/* 섹션 라벨 */}
                {isExpanded ? (
                  <button
                    onClick={() => toggleSection(section.key)}
                    className="flex items-center justify-between w-full px-3 py-2 mt-1 mb-0.5 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <span className={`text-[11px] font-semibold tracking-wide ${hasActive ? 'text-blue-600' : 'text-slate-400'}`}>
                      {section.label}
                    </span>
                    <ChevronDown className={`w-3 h-3 text-slate-300 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                  </button>
                ) : (
                  <div className="mx-3 my-2 border-t border-gray-100" />
                )}

                {/* 메뉴 아이템 */}
                {!isCollapsed && section.items.map(item => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.key}
                      to={item.path}
                      className={({ isActive }) =>
                        `flex items-center gap-3 px-3 py-2 rounded-xl transition-all duration-200 relative group ${
                          isActive
                            ? 'bg-gradient-to-r from-blue-50 to-indigo-50 text-blue-700 font-medium'
                            : 'text-slate-500 hover:bg-gray-50 hover:text-slate-700'
                        }`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-blue-600 rounded-r" />}
                          <Icon className="w-4.5 h-4.5 flex-shrink-0" style={{ width: 18, height: 18, opacity: isActive ? 1 : 0.5 }} />
                          {isExpanded && <span className="text-[13px] truncate">{item.label}</span>}
                          {!isExpanded && (
                            <div className="absolute left-full ml-2 px-2.5 py-1.5 bg-slate-800 text-white text-xs rounded-lg shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">
                              {item.label}
                            </div>
                          )}
                        </>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {/* 하단 사용자 정보 */}
        <div className="flex-shrink-0 mx-3 mb-3 mt-1 border-t border-gray-100 pt-3">
          {isExpanded ? (
            <>
              <div className="flex items-center gap-2.5 mb-2 px-2 py-2.5 rounded-xl bg-gray-50">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 shadow-sm">
                  {user?.display_name?.charAt(0) ?? 'U'}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-800 truncate">{user?.display_name}</p>
                  <p className="text-[10px] text-slate-400 truncate">
                    {user?.department_name ? `${user.department_name} · ` : ''}{roleLabel()}
                  </p>
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 text-xs text-slate-400 hover:text-red-500 px-2 py-1.5 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" /> 로그아웃
              </button>
            </>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-teal-500 flex items-center justify-center text-white text-xs font-bold">
                {user?.display_name?.charAt(0) ?? 'U'}
              </div>
              <button onClick={handleLogout} className="text-red-400 hover:text-red-300 transition-colors" title="로그아웃">
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ── PC 사이드바 ──────────────────────────────────────────── */}
      <aside
        className={`hidden md:flex flex-col fixed top-0 left-0 bottom-0 bg-white border-r border-gray-200 z-40 transition-all duration-200 ${
          expanded ? 'w-56' : 'w-16'
        }`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {sidebarContent(false)}
      </aside>

      {/* ── 모바일 오버레이 사이드바 ────────────────────────────── */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <div className="absolute top-0 left-0 bottom-0 w-64 bg-white shadow-xl overflow-hidden">
            {sidebarContent(true)}
          </div>
        </div>
      )}

      {/* ── 모바일 상단 헤더 ────────────────────────────────────── */}
      <header className="md:hidden fixed top-0 left-0 right-0 h-14 bg-white border-b border-slate-200 z-30 flex items-center px-4">
        <button onClick={() => setMobileOpen(true)} className="p-1 text-slate-600">
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex-1 text-center">
          <span className="font-bold text-sm text-slate-800">물품관리</span>
        </div>
        <div className="w-7 h-7 rounded-full bg-teal-500 flex items-center justify-center text-white text-xs font-bold">
          {user?.display_name?.charAt(0) ?? 'U'}
        </div>
      </header>

      {/* ── 메인 콘텐츠 ─────────────────────────────────────────── */}
      <main className={`transition-all duration-200 ${expanded ? 'md:ml-56' : 'md:ml-16'} pt-14 md:pt-0`}>
        <div className="p-4 md:p-6">
          <div className="max-w-[1600px] mx-auto">
            <Outlet />
          </div>
        </div>
      </main>

      {/* AI 어시스턴트 채팅 */}
      <AiChat />
    </div>
  );
}
