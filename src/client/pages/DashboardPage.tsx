import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { PageHeader } from '../components/ui';
import {
  LayoutDashboard, ClipboardList, Package, CheckCircle2, AlertTriangle,
  PieChart, Calendar, Zap, Users, Settings, DollarSign, Monitor,
  Search as SearchIcon, Clock, FileText, ShoppingCart, BarChart3,
  Tag, Building2, Globe, Lock, User, MapPin, Pencil,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DashboardSummary, DeptCalendarEvent, SupplyPipeline } from '@shared/types';

// ─── 로컬 타입 ────────────────────────────────────────────────────────────────
interface RequestSchedule {
  id: string;
  request_type: string;
  open_from: string;
  open_to: string;
  period_label: string;
  is_active: boolean;
  is_upcoming: boolean;
}

type UserDirItem = { id: string; display_name: string; department_name: string };

// ─── 위젯 정의 ──────────────────────────────────────────────────────────────────
type WidgetKey = 'stats' | 'patients' | 'sla' | 'recent' | 'shortcuts' | 'calendar';

interface WidgetDef {
  key: WidgetKey;
  label: string;
  desc: string;
  icon: LucideIcon;
  perm?: string;
}

const WIDGET_DEFS: WidgetDef[] = [
  { key: 'stats',     label: '물품관리 통계', desc: '불출금액 · 신청건수 · 승인대기 · 재고부족', icon: PieChart },
  { key: 'patients',  label: '환자 현황',     desc: '입원 · 퇴원 · 사망 현황',               icon: Building2, perm: 'PATIENT_MANAGE' },
  { key: 'sla',       label: 'SLA 경고',      desc: '수령검수 24시간 초과 알림',              icon: Clock },
  { key: 'shortcuts', label: '업무 바로가기', desc: '자주 쓰는 업무 페이지를 배치',           icon: Zap },
  { key: 'recent',    label: '최근 신청',     desc: '최근 신청 현황 카드',                   icon: ClipboardList },
  { key: 'calendar',  label: '캘린더',        desc: '월간 캘린더 + 일정 타임라인',           icon: Calendar },
];

// ─── 업무 바로가기 메뉴 정의 ─────────────────────────────────────────────────────
interface ShortcutDef {
  key: string;
  label: string;
  path: string;
  icon: LucideIcon;
  grad: string;
  perm?: string;
  moduleId?: string; // 특정 모듈에만 속하는 바로가기 (모듈 비활성/부서 제한 시 숨김)
}

const ALL_SHORTCUTS: ShortcutDef[] = [
  { key: 'ward-requests',  label: '소모품 신청',   path: '/ward-requests',     icon: FileText,      grad: 'linear-gradient(135deg,#ecfdf5,#a7f3d0)' },
  { key: 'approvals',      label: '승인 처리',     path: '/approvals',         icon: CheckCircle2,  grad: 'linear-gradient(135deg,#eff6ff,#bfdbfe)', perm: 'PURCHASE_MANAGE' },
  { key: 'purchase-orders',label: '발주 관리',     path: '/purchase-orders',   icon: ShoppingCart,  grad: 'linear-gradient(135deg,#fef3c7,#fde68a)', perm: 'PURCHASE_MANAGE' },
  { key: 'stock-out',      label: '불출 관리',     path: '/stock-out',         icon: Package,       grad: 'linear-gradient(135deg,#fce7f3,#fbcfe8)', perm: 'PURCHASE_MANAGE' },
  { key: 'inventory',      label: '재고 현황',     path: '/inventory',         icon: BarChart3,     grad: 'linear-gradient(135deg,#e0e7ff,#c7d2fe)', perm: 'PURCHASE_MANAGE' },
  { key: 'receipt-check',  label: '수량 검수',     path: '/receipt-check',     icon: SearchIcon,    grad: 'linear-gradient(135deg,#f0fdf4,#dcfce7)', perm: 'PURCHASE_MANAGE' },
  { key: 'items',          label: '품목 관리',     path: '/items',             icon: Tag,           grad: 'linear-gradient(135deg,#fff7ed,#fed7aa)', perm: 'BASIC_MANAGE' },
  { key: 'patient-manage', label: '환자 관리',     path: '/patient-manage',    icon: Building2,     grad: 'linear-gradient(135deg,#f0fdfa,#99f6e4)', perm: 'PATIENT_MANAGE' },
  { key: 'system',         label: '시스템 설정',   path: '/system',            icon: Settings,      grad: 'linear-gradient(135deg,#f8fafc,#e2e8f0)', perm: 'SYSTEM_ADMIN' },
  { key: 'cost',           label: '비용 분석',     path: '/cost',              icon: DollarSign,    grad: 'linear-gradient(135deg,#fefce8,#fef08a)', perm: 'STATS_VIEW' },
  { key: 'equipment',      label: '비품 신청',     path: '/equipment-requests',icon: Monitor,       grad: 'linear-gradient(135deg,#ecfeff,#a5f3fc)' },
];

const SHORTCUTS_STORAGE = 'dashboard-shortcuts';

function loadShortcuts(userId?: string): string[] {
  try {
    const raw = localStorage.getItem(userId ? `${SHORTCUTS_STORAGE}:${userId}` : SHORTCUTS_STORAGE);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return ['ward-requests', 'approvals', 'inventory'];
}

function saveShortcuts(keys: string[], userId?: string) {
  localStorage.setItem(userId ? `${SHORTCUTS_STORAGE}:${userId}` : SHORTCUTS_STORAGE, JSON.stringify(keys));
}

// ─── 위젯 프리셋 ────────────────────────────────────────────────────────────────
const ROLE_DEFAULTS: Record<string, WidgetKey[]> = {
  SYSTEM_ADMIN:     ['stats', 'patients', 'sla', 'shortcuts', 'recent', 'calendar'],
  PATIENT_MANAGE:   ['stats', 'patients', 'sla', 'shortcuts', 'recent', 'calendar'],
  PURCHASE_MANAGE:  ['stats', 'sla', 'shortcuts', 'recent', 'calendar'],
  REQUEST_USE:      ['stats', 'shortcuts', 'recent', 'calendar'],
};
const DEFAULT_WIDGETS: WidgetKey[] = ['stats', 'shortcuts', 'recent', 'calendar'];

function storageKey(userId?: string) {
  return userId ? `dashboard-widgets:${userId}` : 'dashboard-widgets';
}

function loadWidgets(userId?: string, perms?: string[]): WidgetKey[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  if (perms) {
    for (const [perm, defaults] of Object.entries(ROLE_DEFAULTS)) {
      if (perms.includes(perm)) return defaults;
    }
  }
  return DEFAULT_WIDGETS;
}

function saveWidgets(keys: WidgetKey[], userId?: string) {
  localStorage.setItem(storageKey(userId), JSON.stringify(keys));
}

// ─── 상수 ─────────────────────────────────────────────────────────────────────
const EVENT_COLORS = [
  '#86efac', '#93c5fd', '#c4b5fd',
  '#fdba74', '#f9a8d4', '#fde047',
];

const EVENT_TYPE_META: Record<string, { label: string; icon: LucideIcon; bg: string; text: string }> = {
  TASK:    { label: '할 일', icon: CheckCircle2,    bg: 'bg-blue-50',   text: 'text-blue-700'   },
  MEETING: { label: '회의',  icon: Users,           bg: 'bg-purple-50', text: 'text-purple-700' },
  EVENT:   { label: '행사',  icon: Calendar,        bg: 'bg-yellow-50', text: 'text-yellow-700' },
  OTHER:   { label: '기타',  icon: MapPin,          bg: 'bg-slate-50',  text: 'text-slate-600'  },
};

const VIS_META: Record<string, { label: string; icon: LucideIcon }> = {
  PRIVATE:    { label: '나만보기',   icon: Lock },
  DEPARTMENT: { label: '부서공개',   icon: Building2 },
  ALL:        { label: '전체공개',   icon: Globe },
  SPECIFIC:   { label: '특정사용자', icon: User },
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '임시저장', SUBMITTED: '제출', APPROVED: '승인',
  PARTIAL_APPROVED: '부분승인', REJECTED: '반려', CANCELLED: '취소',
};
const STATUS_CLASS: Record<string, string> = {
  DRAFT: 'badge-gray', SUBMITTED: 'badge-blue', APPROVED: 'badge-green',
  PARTIAL_APPROVED: 'badge-yellow', REJECTED: 'badge-red', CANCELLED: 'badge-gray',
};

const SCHED_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  CONSUMABLE_REGULAR: { bg: '#d9f99d', text: '#3f6212', label: '정기소모품' },
  DIAPER:             { bg: '#fce7f3', text: '#9d174d', label: '기저귀' },
  NIGHT_SNACK:        { bg: '#fef3c7', text: '#92400e', label: '야간당직간식' },
};

const HOUR_H = 56;
const TIMELINE_START = 7;
const TIMELINE_END = 21;

// ─── 유틸 ────────────────────────────────────────────────────────────────────
const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const formatDateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const timeToMinutes = (t: string) => {
  const parts = t.split(':').map(Number);
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
};

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

// ─── 월간 캘린더 헬퍼 ───────────────────────────────────────────────────────────
function getMonthDays(year: number, month: number): (Date | null)[] {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startPad = firstDay.getDay();
  const days: (Date | null)[] = [];
  for (let i = 0; i < startPad; i++) days.push(null);
  for (let d = 1; d <= lastDay.getDate(); d++) days.push(new Date(year, month, d));
  while (days.length % 7 !== 0) days.push(null);
  return days;
}

// ─── 메인 페이지 ──────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { user, hasPerm } = useAuth();
  const canViewAll = hasPerm('PURCHASE_MANAGE') || hasPerm('SYSTEM_ADMIN');

  // 위젯 관리 (사용자별 + 역할별 기본값)
  const [activeWidgets, setActiveWidgets] = useState<WidgetKey[]>(() =>
    loadWidgets(user?.id, user?.permissions)
  );
  const [widgetModal, setWidgetModal] = useState(false);
  const isWidgetOn = (k: WidgetKey) => activeWidgets.includes(k);
  const toggleWidget = (k: WidgetKey) => {
    setActiveWidgets(prev => {
      const next = prev.includes(k) ? prev.filter(w => w !== k) : [...prev, k];
      saveWidgets(next, user?.id);
      return next;
    });
  };

  // 모듈 접근 제어
  const [moduleAccess, setModuleAccess] = useState<Record<string, { enabled: boolean; depts: string[] }>>({});
  useEffect(() => {
    if (!user) return;
    api('/system/module-access')
      .then((data: any) => { if (data && typeof data === 'object') setModuleAccess(data); })
      .catch(() => {});
  }, [user?.id]);

  const isModuleAccessible = (moduleId: string) => {
    const access = moduleAccess[moduleId];
    if (!access || Object.keys(moduleAccess).length === 0) return true;
    if (!access.enabled) return false;
    if (hasPerm('SYSTEM_ADMIN')) return true;
    if (access.depts.includes('ALL')) return true;
    const userDeptId = (user as any)?.department_id ?? '';
    return userDeptId && access.depts.includes(userDeptId);
  };

  // 업무 바로가기 관리
  const [activeShortcuts, setActiveShortcuts] = useState<string[]>(() => loadShortcuts(user?.id));
  const [shortcutModal, setShortcutModal] = useState(false);
  const availableShortcuts = useMemo(() =>
    ALL_SHORTCUTS.filter(s =>
      (!s.perm || hasPerm(s.perm)) &&
      (!s.moduleId || isModuleAccessible(s.moduleId))
    ),
    [user?.permissions, moduleAccess]
  );
  const toggleShortcut = (key: string) => {
    setActiveShortcuts(prev => {
      const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
      saveShortcuts(next, user?.id);
      return next;
    });
  };

  // 데이터
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [schedules, setSchedules] = useState<RequestSchedule[]>([]);
  const [deptEvents, setDeptEvents] = useState<DeptCalendarEvent[]>([]);

  // 선택된 날짜
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const calYear  = selectedDate.getFullYear();
  const calMonth = selectedDate.getMonth();

  // 일정 추가 모달
  const [addModal, setAddModal] = useState<{ date: string } | null>(null);
  const [evForm, setEvForm] = useState({
    title: '', end_date: '', color: EVENT_COLORS[0],
    event_type: 'EVENT', visibility: 'DEPARTMENT',
    shared_user_ids: [] as string[],
    start_time: '', end_time: '',
  });
  const [evSaving, setEvSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // 사용자 디렉토리
  const [userDir, setUserDir] = useState<UserDirItem[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [showUserDrop, setShowUserDrop] = useState(false);

  const loadDeptEvents = useCallback(() => {
    api(`/dept-calendar?year=${calYear}&month=${calMonth + 1}`)
      .then((res: DeptCalendarEvent[]) => setDeptEvents(Array.isArray(res) ? res : []))
      .catch(() => {});
  }, [calYear, calMonth]);

  useEffect(() => {
    api('/dashboard/summary').then(setData).finally(() => setLoading(false));
    api('/request-schedules?include_past=true').then(setSchedules).catch(() => {});
  }, []);

  useEffect(() => { loadDeptEvents(); }, [loadDeptEvents]);

  useEffect(() => {
    if (addModal && titleRef.current) titleRef.current.focus();
  }, [addModal]);

  useEffect(() => {
    if (evForm.visibility === 'SPECIFIC' && userDir.length === 0) {
      api('/users/directory').then(setUserDir).catch(() => {});
    }
  }, [evForm.visibility]);

  // 선택 날짜 이벤트
  const selectedDayEvents = useMemo(() => {
    const dt = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
    return deptEvents.filter(ev => {
      const start = new Date(ev.event_date);
      const end = ev.end_date ? new Date(ev.end_date) : new Date(start);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      return start <= dt && dt <= end;
    });
  }, [deptEvents, selectedDate]);

  const timedEvents  = selectedDayEvents.filter(e => e.start_time);
  const allDayEvents = selectedDayEvents.filter(e => !e.start_time);

  const datesWithEvents = useMemo(() => {
    const set = new Set<string>();
    deptEvents.forEach(ev => {
      const start = new Date(ev.event_date);
      const end = ev.end_date ? new Date(ev.end_date) : new Date(start);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        set.add(formatDateStr(new Date(d)));
      }
    });
    return set;
  }, [deptEvents]);

  const selectedDateSchedules = useMemo(() => {
    const dt = selectedDate;
    return schedules.filter(s => new Date(s.open_from) <= dt && dt <= new Date(s.open_to));
  }, [schedules, selectedDate]);

  // 월간 캘린더
  const monthDays = useMemo(() => getMonthDays(calYear, calMonth), [calYear, calMonth]);

  const goPrevMonth = () => { const d = new Date(calYear, calMonth - 1, 1); setSelectedDate(d); };
  const goNextMonth = () => { const d = new Date(calYear, calMonth + 1, 1); setSelectedDate(d); };

  const fmt = (n: number) => new Intl.NumberFormat('ko-KR').format(n);

  // 일정 모달
  const openAddModal = (dateStr: string) => {
    setEvForm({ title: '', end_date: dateStr, color: EVENT_COLORS[0], event_type: 'EVENT', visibility: 'DEPARTMENT', shared_user_ids: [], start_time: '', end_time: '' });
    setUserSearch('');
    setShowUserDrop(false);
    setAddModal({ date: dateStr });
  };

  const saveEvent = async () => {
    if (!evForm.title.trim() || !addModal) return;
    setEvSaving(true);
    try {
      await api('/dept-calendar', {
        method: 'POST',
        body: JSON.stringify({
          title: evForm.title.trim(),
          event_date: addModal.date,
          end_date: evForm.end_date && evForm.end_date !== addModal.date ? evForm.end_date : null,
          color: evForm.color,
          event_type: evForm.event_type,
          visibility: evForm.visibility,
          shared_user_ids: evForm.visibility === 'SPECIFIC' ? evForm.shared_user_ids : [],
          start_time: evForm.start_time || null,
          end_time: evForm.end_time || null,
        }),
      });
      setAddModal(null);
      loadDeptEvents();
    } catch { /* ignore */ } finally { setEvSaving(false); }
  };

  const deleteEvent = async (id: string) => {
    if (!confirm('이 일정을 삭제하시겠습니까?')) return;
    try {
      await api(`/dept-calendar/${id}`, { method: 'DELETE', body: JSON.stringify({}) });
      loadDeptEvents();
    } catch { /* ignore */ }
  };

  const canDelete = (ev: DeptCalendarEvent) =>
    ev.created_by === user?.id || ev.department_id === user?.department_id || hasPerm('SYSTEM_ADMIN');

  const filteredUsers = useMemo(() => {
    const q = userSearch.toLowerCase();
    return userDir.filter(u =>
      u.display_name.toLowerCase().includes(q) || u.department_name.toLowerCase().includes(q)
    ).slice(0, 20);
  }, [userDir, userSearch]);

  const toggleSharedUser = (uid: string) => {
    setEvForm(f => ({
      ...f,
      shared_user_ids: f.shared_user_ids.includes(uid)
        ? f.shared_user_ids.filter(id => id !== uid)
        : [...f.shared_user_ids, uid],
    }));
  };

  const selectedDateStr = formatDateStr(selectedDate);

  const getEventStyle = (ev: DeptCalendarEvent) => {
    const startMin = timeToMinutes(ev.start_time!);
    const endMin   = ev.end_time ? timeToMinutes(ev.end_time) : startMin + 60;
    const topPx    = (startMin - TIMELINE_START * 60) * (HOUR_H / 60);
    const heightPx = Math.max((endMin - startMin) * (HOUR_H / 60), 28);
    return { top: `${topPx}px`, height: `${heightPx}px` };
  };

  if (loading) return <div className="flex items-center justify-center h-48 text-slate-400 text-sm">Loading...</div>;
  if (!data)   return <div className="flex items-center justify-center h-48 text-slate-400 text-sm">No data</div>;

  return (
    <div className="flex flex-col lg:flex-row gap-6 items-start">

      {/* ─── 좌측 메인 콘텐츠 ────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        {/* 페이지 헤더 */}
        <PageHeader
          icon={LayoutDashboard}
          title="대시보드"
          description={`안녕하세요 ${user?.display_name}님 (${user?.department_name || '전체'})`}
          actions={
            <button
              onClick={() => setWidgetModal(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-slate-500 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
            >
              <Settings className="w-3.5 h-3.5" />
              위젯 관리
            </button>
          }
        />

        {/* ── 통계 위젯 ────────────────────────────────────── */}
        {isWidgetOn('stats') && !canViewAll && (
          /* ── 부서 사용자: 물품 조달 파이프라인 + 스케줄 예정일 ── */
          <div className="mb-6 space-y-4">
            {/* 메인 조달 파이프라인 */}
            <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-5">
              <p className="text-xs font-semibold text-slate-500 mb-4">물품 조달 진행현황</p>
              <div className="flex items-stretch overflow-x-auto">
                {([
                  { key: 'pending_approval',    label: '승인중',       color: '#3b82f6', bg: '#eff6ff', activeBg: '#dbeafe' },
                  { key: 'vendor_ordering',     label: '업체발주중',   color: '#f59e0b', bg: '#fffbeb', activeBg: '#fef3c7' },
                  { key: 'warehouse_receiving', label: '입고/검수',    color: '#8b5cf6', bg: '#f5f3ff', activeBg: '#ede9fe' },
                  { key: 'issue_pending',       label: '불출 준비중',  color: '#f97316', bg: '#fff7ed', activeBg: '#ffedd5' },
                  { key: 'completed',           label: '완료',         color: '#22c55e', bg: '#f0fdf4', activeBg: '#dcfce7' },
                ] as const).map((step, idx, arr) => {
                  const pipeline = data.supply_pipeline?.main;
                  const count = pipeline ? pipeline[step.key as keyof typeof pipeline] ?? 0 : 0;
                  const isLast = idx === arr.length - 1;
                  return (
                    <React.Fragment key={step.key}>
                      <div className="flex-1 min-w-[68px] rounded-xl py-3 px-2 text-center transition-shadow hover:shadow-md cursor-default"
                        style={{ background: count > 0 ? step.activeBg : step.bg }}>
                        <p className="text-2xl font-extrabold leading-tight" style={{ color: count > 0 ? step.color : '#cbd5e1' }}>{count}</p>
                        <p className="text-[10px] font-medium mt-1 leading-tight" style={{ color: count > 0 ? step.color : '#94a3b8' }}>{step.label}</p>
                      </div>
                      {!isLast && (
                        <div className="flex items-center px-0.5 shrink-0">
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="#cbd5e1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            </div>

            {/* 부족분 처리 파이프라인 (해당 건수 있을 때만) */}
            {data.supply_pipeline && (
              data.supply_pipeline.shortage.receipt_diff > 0 ||
              data.supply_pipeline.shortage.followup_open > 0 ||
              data.supply_pipeline.shortage.followup_resolved > 0
            ) && (
              <div className="rounded-2xl bg-white border border-red-100 shadow-sm p-5">
                <p className="text-xs font-semibold text-red-400 mb-4">수량 부족 처리현황</p>
                <div className="flex items-stretch overflow-x-auto">
                  {([
                    { key: 'receipt_diff',      label: '부족분 확인중',   color: '#ef4444', bg: '#fef2f2', activeBg: '#fee2e2' },
                    { key: 'followup_open',     label: '추가 불출 준비중', color: '#f59e0b', bg: '#fffbeb', activeBg: '#fef3c7' },
                    { key: 'followup_resolved', label: '완료',            color: '#22c55e', bg: '#f0fdf4', activeBg: '#dcfce7' },
                  ] as const).map((step, idx, arr) => {
                    const shortage = data.supply_pipeline?.shortage;
                    const count = shortage ? shortage[step.key as keyof typeof shortage] ?? 0 : 0;
                    const isLast = idx === arr.length - 1;
                    return (
                      <React.Fragment key={step.key}>
                        <div className="flex-1 min-w-[80px] rounded-xl py-3 px-2 text-center transition-shadow hover:shadow-md cursor-default"
                          style={{ background: count > 0 ? step.activeBg : step.bg }}>
                          <p className="text-2xl font-extrabold leading-tight" style={{ color: count > 0 ? step.color : '#cbd5e1' }}>{count}</p>
                          <p className="text-[10px] font-medium mt-1 leading-tight" style={{ color: count > 0 ? step.color : '#94a3b8' }}>{step.label}</p>
                        </div>
                        {!isLast && (
                          <div className="flex items-center px-0.5 shrink-0">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 이번 달 불출금액 + 스케줄 예정일 */}
            <div className="grid grid-cols-2 gap-4">
              <Link to="/ward-requests" className="rounded-2xl p-5 flex flex-col justify-between hover:shadow-lg transition-shadow"
                style={{ background: 'linear-gradient(135deg, #134e4a 0%, #0f766e 100%)', minHeight: '120px' }}>
                <p className="text-[10px] font-medium text-teal-200 opacity-80">우리 부서 이번 달 불출금액</p>
                <p className="text-2xl font-extrabold text-white leading-tight mt-2">{fmt(data.month_issued_amount)}<span className="text-sm">원</span></p>
              </Link>

              <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-5">
                <p className="text-[10px] font-semibold text-slate-400 mb-3">물품관리 스케줄 예정일</p>
                {(data.upcoming_schedules ?? []).length === 0 ? (
                  <p className="text-xs text-slate-300">예정된 스케줄이 없습니다</p>
                ) : (
                  <div className="space-y-2">
                    {(data.upcoming_schedules ?? []).slice(0, 3).map(s => {
                      const sc = SCHED_COLORS[s.request_type];
                      const from = new Date(s.open_from);
                      const to = new Date(s.open_to);
                      const isActive = new Date() >= from && new Date() <= to;
                      return (
                        <div key={s.id} className="flex items-center gap-2">
                          <span className="rounded-full px-2 py-0.5 text-[9px] font-semibold leading-4 shrink-0"
                            style={{ background: sc?.bg ?? '#f1f5f9', color: sc?.text ?? '#64748b' }}>
                            {sc?.label ?? s.request_type}
                          </span>
                          <span className="text-[10px] text-slate-500 tabular-nums">
                            {from.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })} ~ {to.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
                          </span>
                          {isActive && <span className="text-[9px] text-emerald-600 font-bold">진행중</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {isWidgetOn('stats') && canViewAll && (
          /* ── 관리자: 기존 벤토 그리드 통계 ── */
          <div className="grid grid-cols-2 lg:grid-cols-4 lg:grid-rows-2 gap-4 mb-6">
            {/* 불출금액 — 큰 틸 카드 */}
            <Link to="/stock-out" className="col-span-2 lg:col-span-1 lg:row-span-2 rounded-2xl p-5 flex flex-col justify-between hover:shadow-lg transition-shadow"
              style={{ background: 'linear-gradient(135deg, #134e4a 0%, #0f766e 100%)', minHeight: '120px' }}>
              <p className="text-xs font-medium text-teal-200 opacity-80">전체 불출금액</p>
              <div>
                <p className="text-2xl lg:text-3xl font-extrabold text-white leading-tight">{fmt(data.month_issued_amount)}<span className="text-base lg:text-lg">원</span></p>
              </div>
            </Link>

            {/* 신청건수 */}
            <Link to="/ward-requests" className="col-span-1 rounded-2xl p-5 flex flex-col items-center justify-center hover:shadow-lg transition-shadow"
              style={{ background: 'linear-gradient(135deg, #fb7185 0%, #e11d48 100%)' }}>
              <p className="text-[10px] font-medium text-rose-100 opacity-80 mb-1">전체 신청</p>
              <p className="text-3xl lg:text-4xl font-extrabold text-white">{data.month_request_count}</p>
            </Link>

            {/* 승인대기 + 재고부족 */}
            <div className="col-span-1 lg:col-span-2 rounded-2xl bg-white border border-slate-100 shadow-sm p-4 lg:p-5 flex gap-4 lg:gap-6 items-center">
              <Link to="/approvals" className="flex-1 text-center hover:opacity-70 transition-opacity">
                <p className="text-[10px] text-slate-400 font-medium mb-1">승인 대기</p>
                <p className="text-2xl lg:text-3xl font-extrabold text-amber-500">{data.pending_approval_count}</p>
              </Link>
              <div className="w-px h-10 lg:h-12 bg-slate-100" />
              <Link to="/inventory" className="flex-1 text-center hover:opacity-70 transition-opacity">
                <p className="text-[10px] text-slate-400 font-medium mb-1">재고 부족</p>
                <p className="text-2xl lg:text-3xl font-extrabold text-red-500">{data.low_stock_count}</p>
              </Link>
            </div>

            {/* 오늘의 요약 카드들 */}
            <div className="col-span-2 lg:col-span-3 grid grid-cols-3 gap-3 lg:gap-4">
              <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4 flex flex-col">
                <p className="text-[10px] text-slate-400 font-medium">신청 스케줄</p>
                <p className="text-2xl font-bold text-navy-800 mt-1">{schedules.filter(s => s.is_active).length}</p>
                <p className="text-[10px] text-emerald-500 mt-auto">진행중</p>
              </div>
              <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4 flex flex-col">
                <p className="text-[10px] text-slate-400 font-medium">오늘 일정</p>
                <p className="text-2xl font-bold text-navy-800 mt-1">{selectedDayEvents.length}</p>
                <p className="text-[10px] text-blue-500 mt-auto">{formatDateStr(new Date())}</p>
              </div>
              <div className="rounded-2xl p-4 flex flex-col justify-between"
                style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #0c4a6e 100%)' }}>
                <p className="text-[10px] text-sky-200 font-medium opacity-80">다음 스케줄</p>
                {(() => {
                  const upcoming = schedules.find(s => s.is_upcoming);
                  if (!upcoming) return <p className="text-sm text-white font-bold mt-1">없음</p>;
                  const sc = SCHED_COLORS[upcoming.request_type];
                  return (
                    <div className="mt-1">
                      <p className="text-sm text-white font-bold">{sc?.label ?? upcoming.request_type}</p>
                      <p className="text-[10px] text-sky-200 opacity-80">{new Date(upcoming.open_from).toLocaleDateString('ko-KR')}~</p>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* ── SLA 경고 ── */}
        {isWidgetOn('sla') && (data as any).sla_overdue_count > 0 && (
          <div className="mb-5 p-4 rounded-2xl text-sm flex items-center gap-3"
            style={{ background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)' }}>
            <Clock className="w-6 h-6 text-amber-600 shrink-0" />
            <div className="flex-1">
              <p className="font-semibold text-amber-800">수령검수 24시간 초과</p>
              <p className="text-xs text-amber-700 opacity-80">{(data as any).sla_overdue_count}건의 미처리 건이 있습니다.</p>
            </div>
            <Link to="/stock-out" className="px-3 py-1.5 rounded-xl bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 transition-colors">확인하기</Link>
          </div>
        )}

        {/* ── 환자 현황 ── */}
        {isWidgetOn('patients') && hasPerm('PATIENT_MANAGE') && (
          <div className="mb-6">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-3">환자 현황</p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {([
                { label: '현재 입원',  key: 'current_inpatient_count', grad: 'linear-gradient(135deg,#ecfdf5,#d1fae5)', color: 'text-emerald-700' },
                { label: '오늘 입원',  key: 'today_admission_count',   grad: 'linear-gradient(135deg,#f0fdf4,#dcfce7)', color: 'text-lime-700'    },
                { label: '오늘 퇴원',  key: 'today_discharge_count',   grad: 'linear-gradient(135deg,#f8fafc,#e2e8f0)', color: 'text-slate-700'   },
                { label: '이달 사망',  key: 'month_death_count',       grad: 'linear-gradient(135deg,#f9fafb,#f3f4f6)', color: 'text-slate-600'   },
              ] as const).map(item => (
                <Link key={item.key} to="/patient-manage"
                  className="rounded-2xl p-4 border border-slate-100 shadow-sm hover:shadow-md transition-shadow"
                  style={{ background: item.grad }}>
                  <p className="text-[10px] text-slate-500 font-medium">{item.label}</p>
                  <p className={`text-2xl font-bold mt-1 ${item.color}`}>{(data as any)[item.key] ?? 0}</p>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* ── 업무 바로가기 ── */}
        {isWidgetOn('shortcuts') && (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-navy-800">업무 바로가기</h3>
              <button onClick={() => setShortcutModal(true)} className="text-xs text-accent-600 hover:underline font-medium">편집</button>
            </div>
            {activeShortcuts.length === 0 ? (
              <button onClick={() => setShortcutModal(true)}
                className="w-full rounded-2xl border-2 border-dashed border-slate-200 p-6 text-center text-sm text-slate-400 hover:border-accent-400 hover:text-accent-600 transition-colors">
                + 바로가기를 추가하세요
              </button>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {activeShortcuts.map(key => {
                  const sc = ALL_SHORTCUTS.find(s => s.key === key);
                  if (!sc) return null;
                  if (sc.perm && !hasPerm(sc.perm)) return null;
                  if (sc.moduleId && !isModuleAccessible(sc.moduleId)) return null;
                  const ScIcon = sc.icon;
                  return (
                    <Link key={sc.key} to={sc.path}
                      className="rounded-2xl p-4 border border-slate-100 shadow-sm hover:shadow-md transition-all hover:scale-[1.02] flex items-center gap-3"
                      style={{ background: sc.grad }}>
                      <ScIcon className="w-6 h-6 text-slate-600 shrink-0" />
                      <span className="text-sm font-semibold text-slate-800">{sc.label}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── 최근 신청 현황 — 카드형 ── */}
        {isWidgetOn('recent') && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-navy-800">{canViewAll ? '전체' : '우리 부서'} 최근 신청 현황</h3>
              <Link to="/ward-requests" className="text-xs text-accent-600 hover:underline font-medium">전체보기 &gt;</Link>
            </div>
            {data.recent_requests.length === 0 ? (
              <div className="rounded-2xl bg-slate-50 border border-slate-100 p-8 text-center text-sm text-slate-400">
                신청 내역이 없습니다.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {data.recent_requests.slice(0, 6).map(r => (
                  <Link key={r.id} to="/ward-requests"
                    className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4 hover:shadow-md transition-shadow group">
                    <div className="flex items-start justify-between mb-2">
                      <p className="font-semibold text-sm text-navy-800 group-hover:text-accent-600 transition-colors">{r.request_no}</p>
                      <span className={`${STATUS_CLASS[r.status] || 'badge-gray'} text-[10px]`}>{STATUS_LABEL[r.status] || r.status}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-slate-500">{r.department_name}</span>
                      <span className="text-[10px] text-slate-300">|</span>
                      <span className="text-[10px] text-slate-400">{r.submitted_at ? new Date(r.submitted_at).toLocaleDateString('ko-KR') : '-'}</span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── 우측 캘린더 패널 ─────────────────────────────────────── */}
      {isWidgetOn('calendar') && (
        <div className="w-full lg:w-72 xl:w-80 shrink-0 sticky top-4 space-y-4">

          {/* 월간 캘린더 */}
          <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4">
            {/* 날짜 헤더 */}
            <div className="flex items-center justify-between mb-1">
              <div>
                <p className="text-lg font-bold text-navy-800 leading-tight">
                  {selectedDate.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })}
                  <span className="text-sm font-normal text-slate-400 ml-1">{DOW[selectedDate.getDay()]}요일</span>
                </p>
              </div>
              <div className="flex gap-1">
                <button onClick={goPrevMonth} className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 text-xs">&lt;</button>
                <button onClick={goNextMonth} className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 text-xs">&gt;</button>
              </div>
            </div>

            {/* 월 / 년 라벨 */}
            <p className="text-[10px] text-slate-400 mb-3">
              {calYear}년 {calMonth + 1}월
            </p>

            {/* 요일 헤더 */}
            <div className="grid grid-cols-7 mb-1">
              {DOW.map((d, i) => (
                <div key={d} className={`text-center text-[10px] font-medium py-1 ${i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-slate-400'}`}>{d}</div>
              ))}
            </div>

            {/* 날짜 그리드 */}
            <div className="grid grid-cols-7 gap-y-0.5">
              {monthDays.map((d, i) => {
                if (!d) return <div key={`empty-${i}`} />;
                const isSelected = isSameDay(d, selectedDate);
                const isToday = isSameDay(d, new Date());
                const hasEv = datesWithEvents.has(formatDateStr(d));
                const dayOfWeek = d.getDay();
                return (
                  <button
                    key={i}
                    onClick={() => setSelectedDate(new Date(d))}
                    className="relative flex flex-col items-center py-1 rounded-lg transition-colors"
                  >
                    <span className={`w-7 h-7 flex items-center justify-center rounded-full text-xs font-medium transition-colors ${
                      isSelected
                        ? 'bg-navy-800 text-white'
                        : isToday
                        ? 'bg-accent-500 text-white'
                        : dayOfWeek === 0
                        ? 'text-red-400 hover:bg-red-50'
                        : dayOfWeek === 6
                        ? 'text-blue-400 hover:bg-blue-50'
                        : 'text-slate-700 hover:bg-slate-100'
                    }`}>
                      {d.getDate()}
                    </span>
                    {hasEv && !isSelected && !isToday && (
                      <span className="absolute bottom-0 w-1 h-1 rounded-full bg-accent-400" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 타임라인 패널 */}
          <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4">
            {/* 신청 스케줄 배지 */}
            {selectedDateSchedules.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-3">
                {selectedDateSchedules.map(s => {
                  const c = SCHED_COLORS[s.request_type];
                  if (!c) return null;
                  return (
                    <span key={s.id} className="rounded-full px-2 py-0.5 text-[10px] font-medium leading-4" style={{ background: c.bg, color: c.text }}>
                      {c.label}
                    </span>
                  );
                })}
              </div>
            )}

            {/* 일정 추가 버튼 */}
            <button
              onClick={() => openAddModal(selectedDateStr)}
              className="w-full mb-3 flex items-center justify-center gap-1.5 py-2 rounded-xl border-2 border-dashed border-slate-200 text-xs text-slate-400 hover:border-accent-400 hover:text-accent-600 transition-colors"
            >
              <span className="text-base leading-none">+</span> 일정 추가
            </button>

            {/* 종일 이벤트 */}
            {allDayEvents.length > 0 && (
              <div className="mb-3">
                <p className="text-[10px] text-slate-400 font-medium mb-1.5 uppercase tracking-wider">종일</p>
                <div className="space-y-1">
                  {allDayEvents.map(ev => {
                    const EvIcon = EVENT_TYPE_META[ev.event_type ?? 'EVENT']?.icon;
                    return (
                      <div key={ev.id} className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs group" style={{ background: ev.color }}>
                        {EvIcon ? <EvIcon className="w-3.5 h-3.5 text-slate-600 shrink-0" /> : <span className="w-3.5 h-3.5 shrink-0" />}
                        <span className="truncate flex-1 font-medium text-slate-800">{ev.title}</span>
                        <span className="text-[10px] text-slate-500 opacity-0 group-hover:opacity-100 shrink-0">{ev.department_name}</span>
                        {canDelete(ev) && (
                          <button onClick={() => deleteEvent(ev.id)} className="hidden group-hover:block text-slate-500 hover:text-red-600 text-sm leading-none shrink-0">&times;</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 타임라인 — 스크롤 가능 (최대 높이 제한) */}
            <div className="relative overflow-y-auto rounded-lg" style={{ maxHeight: 'calc(100vh - 520px)', minHeight: '200px' }}>
              {/* 타임라인 콘텐츠 영역 — pt-3 으로 07:00 라벨 잘림 방지 */}
              <div className="relative pt-3" style={{ height: `${(TIMELINE_END - TIMELINE_START) * HOUR_H + 12}px` }}>
              {Array.from({ length: TIMELINE_END - TIMELINE_START }, (_, i) => i + TIMELINE_START).map(hour => (
                <div key={hour} className="absolute w-full flex items-start pointer-events-none" style={{ top: `${(hour - TIMELINE_START) * HOUR_H}px`, height: `${HOUR_H}px` }}>
                  <span className="text-[9px] text-slate-300 w-9 shrink-0 text-right pr-2 -mt-2 tabular-nums">{String(hour).padStart(2, '0')}:00</span>
                  <div className="flex-1 border-t border-slate-50 mt-0" />
                </div>
              ))}

              {/* 현재 시각 선 */}
              {isSameDay(selectedDate, new Date()) && (() => {
                const now = new Date();
                const nowMin = now.getHours() * 60 + now.getMinutes();
                const top = (nowMin - TIMELINE_START * 60) * (HOUR_H / 60);
                if (top < 0 || top > (TIMELINE_END - TIMELINE_START) * HOUR_H) return null;
                return (
                  <div className="absolute left-9 right-0 flex items-center pointer-events-none z-10" style={{ top: `${top}px` }}>
                    <div className="w-2 h-2 rounded-full bg-accent-500 -ml-1" />
                    <div className="flex-1 border-t-2 border-accent-500" />
                  </div>
                );
              })()}

              {/* 이벤트 블록 — 레퍼런스 스타일 (둥근 + 시간 범위) */}
              <div className="absolute left-9 right-0 top-0 bottom-0">
                {timedEvents.map(ev => {
                  const style = getEventStyle(ev);
                  const EvIcon = EVENT_TYPE_META[ev.event_type ?? 'EVENT']?.icon;
                  return (
                    <div
                      key={ev.id}
                      className="absolute inset-x-1 rounded-2xl px-3 py-1.5 text-xs cursor-pointer group shadow-sm border border-white/40"
                      style={{ ...style, background: ev.color }}
                    >
                      <div className="font-semibold leading-snug truncate text-slate-800 flex items-center gap-1">
                        {EvIcon && <EvIcon className="w-3 h-3 shrink-0" />} {ev.title}
                      </div>
                      <div className="text-[10px] text-slate-600 opacity-80 truncate">
                        {ev.start_time} — {ev.end_time ?? '?'}
                      </div>
                      {canDelete(ev) && (
                        <button onClick={e => { e.stopPropagation(); deleteEvent(ev.id); }}
                          className="absolute top-1.5 right-2 hidden group-hover:block text-slate-500 hover:text-red-600 text-sm leading-none">&times;</button>
                      )}
                    </div>
                  );
                })}
              </div>

              {selectedDayEvents.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <p className="text-xs text-slate-300 select-none">일정이 없습니다</p>
                  <p className="text-[10px] text-slate-200 mt-0.5">+ 일정 추가를 눌러보세요</p>
                </div>
              )}
              </div>{/* /타임라인 콘텐츠 영역 */}
            </div>{/* /스크롤 컨테이너 */}
          </div>
        </div>
      )}

      {/* ─── 위젯 관리 모달 ───────────────────────────────────────── */}
      {widgetModal && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setWidgetModal(false); }}>
          <div className="modal w-full max-w-sm">
            <div className="modal-header">
              <h2 className="modal-title">위젯 관리</h2>
              <button onClick={() => setWidgetModal(false)} className="text-slate-400 text-xl">&times;</button>
            </div>
            <div className="modal-body space-y-2">
              <p className="text-xs text-slate-400 mb-3">대시보드에 표시할 위젯을 선택하세요.</p>
              {WIDGET_DEFS.map(w => {
                if (w.perm && !hasPerm(w.perm)) return null;
                const on = isWidgetOn(w.key);
                const WIcon = w.icon;
                return (
                  <div key={w.key}
                    className={`flex items-center gap-3 p-3 rounded-xl border transition-colors cursor-pointer ${on ? 'border-accent-300 bg-accent-50/50' : 'border-slate-100 bg-white hover:bg-slate-50'}`}
                    onClick={() => toggleWidget(w.key)}>
                    <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                      <WIcon className="w-4 h-4 text-slate-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-navy-800">{w.label}</p>
                      <p className="text-[10px] text-slate-400 truncate">{w.desc}</p>
                    </div>
                    <div className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${on ? 'bg-accent-500' : 'bg-slate-300'}`}>
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="modal-footer">
              <button onClick={() => {
                const defaults = loadWidgets(undefined, user?.permissions);
                setActiveWidgets(defaults);
                saveWidgets(defaults, user?.id);
              }} className="btn-ghost text-xs">초기화</button>
              <button onClick={() => setWidgetModal(false)} className="btn-primary">닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── 바로가기 편집 모달 ────────────────────────────────────── */}
      {shortcutModal && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShortcutModal(false); }}>
          <div className="modal w-full max-w-sm">
            <div className="modal-header">
              <h2 className="modal-title">업무 바로가기 편집</h2>
              <button onClick={() => setShortcutModal(false)} className="text-slate-400 text-xl">&times;</button>
            </div>
            <div className="modal-body space-y-2">
              <p className="text-xs text-slate-400 mb-3">대시보드에 표시할 업무 페이지를 선택하세요.</p>
              {availableShortcuts.map(sc => {
                const on = activeShortcuts.includes(sc.key);
                const ScIcon = sc.icon;
                return (
                  <div key={sc.key}
                    className={`flex items-center gap-3 p-3 rounded-xl border transition-colors cursor-pointer ${on ? 'border-accent-300 bg-accent-50/50' : 'border-slate-100 bg-white hover:bg-slate-50'}`}
                    onClick={() => toggleShortcut(sc.key)}>
                    <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center shrink-0">
                      <ScIcon className="w-4 h-4 text-slate-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-navy-800">{sc.label}</p>
                      <p className="text-[10px] text-slate-400">{sc.path}</p>
                    </div>
                    <div className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${on ? 'bg-accent-500' : 'bg-slate-300'}`}>
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="modal-footer">
              <button onClick={() => setShortcutModal(false)} className="btn-primary">닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── 일정 추가 모달 ──────────────────────────────────────── */}
      {addModal && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setAddModal(null); }}>
          <div className="modal w-full max-w-md">
            <div className="modal-header">
              <h2 className="modal-title">{addModal.date} 일정 추가</h2>
              <button onClick={() => setAddModal(null)} className="text-slate-400 text-xl">&times;</button>
            </div>
            <div className="modal-body space-y-4">
              <div>
                <label className="label">제목 *</label>
                <input ref={titleRef} className="input" value={evForm.title}
                  onChange={e => setEvForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="일정 제목 입력"
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEvent(); } }} />
              </div>
              <div>
                <label className="label">일정 종류</label>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(EVENT_TYPE_META).map(([type, meta]) => {
                    const MetaIcon = meta.icon;
                    return (
                      <button key={type} type="button" onClick={() => setEvForm(f => ({ ...f, event_type: type }))}
                        className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-full border transition-colors ${
                          evForm.event_type === type ? `${meta.bg} ${meta.text} border-current font-semibold` : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400'
                        }`}><MetaIcon className="w-3 h-3" /> {meta.label}</button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">시작 시간</label>
                  <input className="input" type="time" value={evForm.start_time} onChange={e => setEvForm(f => ({ ...f, start_time: e.target.value }))} />
                </div>
                <div>
                  <label className="label">종료 시간</label>
                  <input className="input" type="time" value={evForm.end_time} onChange={e => setEvForm(f => ({ ...f, end_time: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="label">종료일 (다일정 선택)</label>
                <input className="input" type="date" value={evForm.end_date} min={addModal.date}
                  onChange={e => setEvForm(f => ({ ...f, end_date: e.target.value }))} />
              </div>
              <div>
                <label className="label">공개 범위</label>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(VIS_META).map(([vis, meta]) => {
                    const VisIcon = meta.icon;
                    return (
                      <button key={vis} type="button" onClick={() => setEvForm(f => ({ ...f, visibility: vis, shared_user_ids: [] }))}
                        className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-full border transition-colors ${
                          evForm.visibility === vis ? 'bg-navy-800 text-white border-navy-800 font-semibold' : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400'
                        }`}><VisIcon className="w-3 h-3" /> {meta.label}</button>
                    );
                  })}
                </div>
              </div>
              {evForm.visibility === 'SPECIFIC' && (
                <div>
                  <label className="label">공유할 사용자 선택</label>
                  {evForm.shared_user_ids.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {evForm.shared_user_ids.map(uid => {
                        const u = userDir.find(u => u.id === uid);
                        return (
                          <span key={uid} className="flex items-center gap-1 px-2 py-0.5 bg-accent-100 text-accent-800 text-xs rounded-full">
                            {u?.display_name ?? uid}
                            <button onClick={() => toggleSharedUser(uid)} className="hover:text-red-600">&times;</button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div className="relative">
                    <input className="input" placeholder="이름 또는 부서로 검색..." value={userSearch}
                      onChange={e => { setUserSearch(e.target.value); setShowUserDrop(true); }}
                      onFocus={() => setShowUserDrop(true)}
                      onBlur={() => setTimeout(() => setShowUserDrop(false), 150)} />
                    {showUserDrop && filteredUsers.length > 0 && (
                      <div className="absolute z-50 top-full left-0 right-0 bg-white border border-slate-200 rounded-b shadow-lg max-h-40 overflow-y-auto">
                        {filteredUsers.map(u => (
                          <div key={u.id}
                            className={`px-3 py-2 text-sm cursor-pointer hover:bg-accent-50 border-b border-slate-50 flex items-center gap-2 ${evForm.shared_user_ids.includes(u.id) ? 'bg-accent-50' : ''}`}
                            onMouseDown={() => { toggleSharedUser(u.id); setUserSearch(''); }}>
                            {evForm.shared_user_ids.includes(u.id) && <CheckCircle2 className="w-3 h-3 text-accent-600" />}
                            <span className="font-medium">{u.display_name}</span>
                            <span className="text-xs text-slate-400">{u.department_name}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <div>
                <label className="label">색상</label>
                <div className="flex gap-2">
                  {EVENT_COLORS.map(c => (
                    <button key={c} type="button" onClick={() => setEvForm(f => ({ ...f, color: c }))}
                      className={`w-7 h-7 rounded-full border-2 transition-transform ${evForm.color === c ? 'border-slate-600 scale-110' : 'border-transparent'}`}
                      style={{ background: c }} />
                  ))}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setAddModal(null)} className="btn-secondary">취소</button>
              <button onClick={saveEvent} disabled={evSaving || !evForm.title.trim()} className="btn-primary">{evSaving ? '저장 중...' : '저장'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
