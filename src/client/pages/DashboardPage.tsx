import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { ChevronLeft, ChevronRight, Plus, X, TrendingUp, Users, Building2, Activity, AlertTriangle, Package, ClipboardList, Heart, ShieldAlert, ChevronDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { DashboardSummary, DeptCalendarEvent } from '@shared/types';

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const EVENT_COLORS = ['#86efac', '#93c5fd', '#c4b5fd', '#fdba74', '#f9a8d4', '#fde047'];

function getMonthDays(year: number, month: number): (Date | null)[] {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const days: (Date | null)[] = [];
  for (let i = 0; i < first.getDay(); i++) days.push(null);
  for (let d = 1; d <= last.getDate(); d++) days.push(new Date(year, month, d));
  while (days.length % 7 !== 0) days.push(null);
  return days;
}
const isSameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const INS_LABEL: Record<string, string> = { HEALTH: '건강보험', MEDICAL_1: '의료급여1종', MEDICAL_2: '의료급여2종', WORKERS_COMP: '산재', AUTO_INS: '자동차' };
const GRP_LABEL: Record<string, string> = { HIGHEST: '최고도', HIGH: '고도', MEDIUM: '중도', LOW: '경도', SELECT: '선택', UNRATED: '미평가', INFECTION: '감염', PNEUMONIA: '폐렴', SEPSIS: '패혈증' };

export default function DashboardPage() {
  const { user, hasPerm } = useAuth();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [pStats, setPStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // 캘린더
  const [calDate, setCalDate] = useState(() => new Date());
  const [selDate, setSelDate] = useState(() => new Date());
  const [events, setEvents] = useState<DeptCalendarEvent[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [evForm, setEvForm] = useState({ title: '', end_date: '', color: EVENT_COLORS[0], event_type: 'EVENT' as string });
  const [evSaving, setEvSaving] = useState(false);

  const calYear = calDate.getFullYear(), calMonth = calDate.getMonth();
  const days = useMemo(() => getMonthDays(calYear, calMonth), [calYear, calMonth]);

  const loadEvents = useCallback(() => {
    api(`/dept-calendar?year=${calYear}&month=${calMonth + 1}`).then((r: any) => setEvents(Array.isArray(r) ? r : [])).catch(() => {});
  }, [calYear, calMonth]);

  useEffect(() => {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);
    Promise.all([
      api('/dashboard/summary').catch(() => null),
      api(`/patients/stats?date_from=${from}&date_to=${to}`).catch(() => null),
    ]).then(([d, p]) => { setData(d); setPStats(p); }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  const dayEvents = useMemo(() => {
    const dt = new Date(selDate.getFullYear(), selDate.getMonth(), selDate.getDate());
    return events.filter(ev => {
      const s = new Date(ev.event_date); const e = ev.end_date ? new Date(ev.end_date) : new Date(s);
      s.setHours(0,0,0,0); e.setHours(23,59,59,999);
      return s <= dt && dt <= e;
    });
  }, [events, selDate]);

  const saveEvent = async () => {
    if (!evForm.title.trim()) return;
    setEvSaving(true);
    try {
      await api('/dept-calendar', { method: 'POST', body: JSON.stringify({ ...evForm, event_date: fmtDate(selDate), end_date: evForm.end_date || fmtDate(selDate), visibility: 'DEPARTMENT' }) });
      setAddOpen(false); setEvForm({ title: '', end_date: '', color: EVENT_COLORS[0], event_type: 'EVENT' }); loadEvents();
    } catch { } finally { setEvSaving(false); }
  };

  const deleteEvent = async (id: string) => {
    if (!confirm('삭제하시겠습니까?')) return;
    try { await api(`/dept-calendar/${id}`, { method: 'DELETE' }); loadEvents(); } catch {}
  };

  if (loading) return <div className="flex items-center justify-center min-h-[60vh] text-slate-400">로딩 중...</div>;

  const o = pStats?.overall || {};
  const cmp = pStats?.comparison || {};
  const bd = pStats?.breakdown || {};
  const ch = pStats?.charges || {};
  const today = new Date();

  const isAdmin = hasPerm('SYSTEM_ADMIN');
  const isPurchase = hasPerm('PURCHASE_MANAGE');
  const isWard = hasPerm('REQUEST_USE') && !isAdmin && !isPurchase;
  const isFullView = isAdmin || isPurchase;

  return (
    <div className="space-y-5">
      {/* ─── 인사 + 날짜 ─── */}
      <div>
        <h1 className="text-xl font-bold text-slate-800">안녕하세요, {user?.display_name}님</h1>
        <p className="text-sm text-slate-400 mt-0.5">{today.getFullYear()}년 {today.getMonth() + 1}월 {today.getDate()}일 {DOW[today.getDay()]}요일</p>
      </div>

      {/* ─── 시스템 점검 알림 ─── */}
      {isFullView && (data?.alerts?.length ?? 0) > 0 && <AlertBanner alerts={data!.alerts!} summary={data!.alert_summary!} />}

      {/* ─── 상단 KPI ─── */}
      {isFullView ? (
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
          <KPI icon={TrendingUp} label="불출금액" value={`₩${((data?.month_issued_amount ?? 0) / 10000).toFixed(0)}만`} color="blue" />
          <KPI icon={ClipboardList} label="신청" value={`${data?.month_request_count ?? 0}`} color="indigo" />
          <KPI icon={AlertTriangle} label="승인대기" value={`${data?.pending_approval_count ?? 0}`} color="amber" />
          <KPI icon={Users} label="입원환자" value={`${o.total_occupied ?? 0}`} sub={`/${o.total_capacity ?? 0}`} color="teal" />
          <KPI icon={Activity} label="가동률" value={`${o.occupancy_rate ?? 0}%`} color="green" />
          <KPI icon={Heart} label="임종실" value={`${cmp.hospice_count?.current ?? 0}`} color="rose" />
        </div>
      ) : isWard ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KPI icon={Users} label="입원환자" value={`${o.total_occupied ?? 0}`} sub={`/${o.total_capacity ?? 0}`} color="teal" />
          <KPI icon={Activity} label="가동률" value={`${o.occupancy_rate ?? 0}%`} color="green" />
          <KPI icon={ClipboardList} label="신청" value={`${data?.month_request_count ?? 0}`} color="indigo" />
          <KPI icon={Heart} label="임종실" value={`${cmp.hospice_count?.current ?? 0}`} color="rose" />
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <KPI icon={ClipboardList} label="신청" value={`${data?.month_request_count ?? 0}`} color="indigo" />
          <KPI icon={TrendingUp} label="불출금액" value={`₩${((data?.month_issued_amount ?? 0) / 10000).toFixed(0)}만`} color="blue" />
          <KPI icon={AlertTriangle} label="승인대기" value={`${data?.pending_approval_count ?? 0}`} color="amber" />
        </div>
      )}

      {/* ─── 메인 영역 (좌: 차트 / 우: 캘린더) ─── */}
      <div className="grid lg:grid-cols-5 gap-5">

        {/* 좌측 3칸 */}
        <div className="lg:col-span-3 space-y-5">
          {/* 월별 추이 — 관리자/구매만 */}
          {isFullView && (
            <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
              <p className="text-sm font-bold text-slate-700 mb-4">월별 불출금액 추이</p>
              <div className="flex items-end gap-2 h-40">
                {(data?.monthly_trend ?? []).slice(-8).map((m, i, arr) => {
                  const max = Math.max(...arr.map(t => t.amount), 1);
                  const pct = (m.amount / max) * 100;
                  return (
                    <div key={m.month} className="flex-1 flex flex-col items-center gap-1">
                      <span className="text-[10px] text-slate-500 font-medium">{m.amount > 0 ? `${(m.amount / 10000).toFixed(0)}만` : ''}</span>
                      <div className="w-full rounded-t-lg transition-all" style={{ height: `${Math.max(pct, 4)}%`, background: `linear-gradient(180deg, ${COLORS[i % COLORS.length]}cc, ${COLORS[i % COLORS.length]})` }} />
                      <span className="text-[10px] text-slate-400">{m.month.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 분포 차트 — 관리자/병동 */}
          {(isAdmin || isWard) && (
            <div className="grid md:grid-cols-2 gap-4">
              <BarChart title="보험유형" data={bd.insurance_type} labels={INS_LABEL} />
              <BarChart title="환자군" data={bd.patient_group} labels={GRP_LABEL} />
            </div>
          )}

          {/* 부서별 + 급여/비급여 — 관리자/구매만 */}
          {isFullView && (
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
                <p className="text-sm font-bold text-slate-700 mb-3">부서별 불출금액</p>
                <div className="space-y-2">
                  {(data?.dept_comparison ?? []).slice(0, 6).map((d, i) => {
                    const max = Math.max(...(data?.dept_comparison ?? []).map(x => x.amount), 1);
                    return (
                      <div key={d.dept_name} className="flex items-center gap-2 text-xs">
                        <span className="w-16 text-right text-slate-500 truncate">{d.dept_name}</span>
                        <div className="flex-1 h-4 bg-gray-50 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${(d.amount / max) * 100}%`, background: COLORS[i % COLORS.length] }} />
                        </div>
                        <span className="w-16 text-right text-slate-600 font-medium">{(d.amount / 10000).toFixed(0)}만</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
                <p className="text-sm font-bold text-slate-700 mb-3">급여 / 비급여</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] font-semibold text-blue-600 mb-1">급여</p>
                    {Object.entries(ch.covered || {}).length > 0 ? Object.entries(ch.covered || {}).map(([n, v]: any) => (
                      <div key={n} className="flex justify-between text-xs py-1 border-b border-gray-50"><span className="text-slate-500">{n}</span><span className="font-medium">₩{(v.total || 0).toLocaleString()}</span></div>
                    )) : <p className="text-[10px] text-slate-300">-</p>}
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold text-amber-600 mb-1">비급여</p>
                    {Object.entries(ch.non_covered || {}).length > 0 ? Object.entries(ch.non_covered || {}).map(([n, v]: any) => (
                      <div key={n} className="flex justify-between text-xs py-1 border-b border-gray-50"><span className="text-slate-500">{n}</span><span className="font-medium">₩{(v.total || 0).toLocaleString()}</span></div>
                    )) : <p className="text-[10px] text-slate-300">-</p>}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 병동 사용자: 신청 현황 */}
          {isWard && (
            <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
              <p className="text-sm font-bold text-slate-700 mb-3">최근 신청 현황</p>
              {(data?.recent_requests ?? []).length > 0 ? (
                <div className="space-y-2">
                  {(data?.recent_requests ?? []).slice(0, 5).map(r => (
                    <div key={r.id} className="flex items-center justify-between py-2 border-b border-gray-50 text-xs">
                      <div>
                        <span className="font-medium text-slate-700">{r.request_no}</span>
                        <span className="text-slate-400 ml-2">{r.department_name}</span>
                      </div>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${r.status === 'APPROVED' ? 'bg-green-100 text-green-700' : r.status === 'SUBMITTED' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                        {r.status === 'APPROVED' ? '승인' : r.status === 'SUBMITTED' ? '제출' : r.status === 'REJECTED' ? '반려' : r.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : <p className="text-xs text-slate-300 text-center py-4">최근 신청 없음</p>}
            </div>
          )}

          {/* 일반 사용자: 내 부서 신청 현황 */}
          {!isFullView && !isWard && (
            <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
              <p className="text-sm font-bold text-slate-700 mb-3">내 부서 신청 현황</p>
              {(data?.recent_requests ?? []).length > 0 ? (
                <div className="space-y-2">
                  {(data?.recent_requests ?? []).slice(0, 5).map(r => (
                    <div key={r.id} className="flex items-center justify-between py-2 border-b border-gray-50 text-xs">
                      <span className="font-medium text-slate-700">{r.request_no}</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${r.status === 'APPROVED' ? 'bg-green-100 text-green-700' : r.status === 'SUBMITTED' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                        {r.status === 'APPROVED' ? '승인' : r.status === 'SUBMITTED' ? '제출' : r.status === 'REJECTED' ? '반려' : r.status}
                      </span>
                    </div>
                  ))}
                </div>
              ) : <p className="text-xs text-slate-300 text-center py-4">최근 신청 없음</p>}
            </div>
          )}
        </div>

        {/* 우측 2칸: 캘린더 (모든 사용자 공통) */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
            {/* 월 이동 */}
            <div className="flex items-center justify-between mb-4">
              <button onClick={() => setCalDate(new Date(calYear, calMonth - 1, 1))} className="p-1 rounded-lg hover:bg-gray-100"><ChevronLeft className="w-4 h-4 text-slate-500" /></button>
              <span className="text-sm font-bold text-slate-700">{calYear}년 {calMonth + 1}월</span>
              <button onClick={() => setCalDate(new Date(calYear, calMonth + 1, 1))} className="p-1 rounded-lg hover:bg-gray-100"><ChevronRight className="w-4 h-4 text-slate-500" /></button>
            </div>
            {/* 요일 */}
            <div className="grid grid-cols-7 text-center mb-1">
              {DOW.map((d, i) => <span key={d} className={`text-[10px] font-semibold py-1 ${i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-slate-400'}`}>{d}</span>)}
            </div>
            {/* 날짜 */}
            <div className="grid grid-cols-7 gap-px">
              {days.map((d, i) => {
                if (!d) return <div key={i} />;
                const isToday = isSameDay(d, today);
                const isSel = isSameDay(d, selDate);
                const hasEvent = events.some(ev => {
                  const s = new Date(ev.event_date); const e = ev.end_date ? new Date(ev.end_date) : new Date(s);
                  s.setHours(0,0,0,0); e.setHours(23,59,59,999);
                  return s <= d && d <= e;
                });
                return (
                  <button key={i} onClick={() => setSelDate(d)} className={`relative h-9 rounded-lg text-xs font-medium transition-all
                    ${isSel ? 'bg-blue-600 text-white shadow-md shadow-blue-200' : isToday ? 'bg-blue-50 text-blue-700 font-bold' : 'text-slate-600 hover:bg-gray-50'}
                    ${d.getDay() === 0 && !isSel ? 'text-red-400' : ''} ${d.getDay() === 6 && !isSel ? 'text-blue-400' : ''}
                  `}>
                    {d.getDate()}
                    {hasEvent && !isSel && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-blue-400" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 선택 날짜 일정 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-bold text-slate-700">{selDate.getMonth() + 1}월 {selDate.getDate()}일 일정</p>
              <button onClick={() => setAddOpen(true)} className="p-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100"><Plus className="w-4 h-4" /></button>
            </div>
            {dayEvents.length === 0 ? (
              <p className="text-xs text-slate-300 text-center py-6">일정이 없습니다</p>
            ) : (
              <div className="space-y-2">
                {dayEvents.map(ev => (
                  <div key={ev.id} className="flex items-center gap-2 p-2 rounded-lg bg-gray-50 group">
                    <div className="w-1 h-8 rounded-full flex-shrink-0" style={{ background: ev.color || '#93c5fd' }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-700 truncate">{ev.title}</p>
                      <p className="text-[10px] text-slate-400">{ev.event_date?.slice(5, 10)}{ev.end_date && ev.end_date !== ev.event_date ? ` ~ ${ev.end_date.slice(5, 10)}` : ''}</p>
                    </div>
                    <button onClick={() => deleteEvent(ev.id)} className="opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-red-400"><X className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 일정 추가 모달 */}
          {addOpen && (
            <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm space-y-3">
              <p className="text-sm font-bold text-slate-700">일정 추가 — {selDate.getMonth() + 1}/{selDate.getDate()}</p>
              <input className="input w-full" placeholder="일정 제목" value={evForm.title} onChange={e => setEvForm(f => ({ ...f, title: e.target.value }))} autoFocus />
              <div className="flex gap-2">
                <input type="date" className="input flex-1" value={evForm.end_date} onChange={e => setEvForm(f => ({ ...f, end_date: e.target.value }))} placeholder="종료일 (선택)" />
                <select className="input w-24" value={evForm.event_type} onChange={e => setEvForm(f => ({ ...f, event_type: e.target.value }))}>
                  <option value="EVENT">행사</option><option value="TASK">할일</option><option value="MEETING">회의</option><option value="OTHER">기타</option>
                </select>
              </div>
              <div className="flex gap-1.5">
                {EVENT_COLORS.map(c => (
                  <button key={c} onClick={() => setEvForm(f => ({ ...f, color: c }))} className={`w-6 h-6 rounded-full border-2 transition-all ${evForm.color === c ? 'border-slate-800 scale-110' : 'border-transparent'}`} style={{ background: c }} />
                ))}
              </div>
              <div className="flex gap-2">
                <button className="btn-secondary flex-1" onClick={() => setAddOpen(false)}>취소</button>
                <button className="btn-primary flex-1" disabled={evSaving || !evForm.title.trim()} onClick={saveEvent}>{evSaving ? '저장중...' : '저장'}</button>
              </div>
            </div>
          )}

          {/* 입퇴원 요약 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
            <p className="text-sm font-bold text-slate-700 mb-3">이번 달 입퇴원</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="text-center p-3 rounded-xl bg-green-50">
                <p className="text-lg font-extrabold text-green-700">{cmp.admitted_count?.current ?? 0}건</p>
                <p className="text-[10px] text-slate-400">입원</p>
              </div>
              <div className="text-center p-3 rounded-xl bg-slate-50">
                <p className="text-lg font-extrabold text-slate-700">{cmp.discharged_count?.current ?? 0}건</p>
                <p className="text-[10px] text-slate-400">퇴원</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 공통 컴포넌트 ─────────────────────────────────────────────────────────
function KPI({ icon: Icon, label, value, sub, color }: { icon: any; label: string; value: string; sub?: string; color: string }) {
  const bg: Record<string, string> = { blue: 'from-blue-500 to-blue-600', indigo: 'from-indigo-500 to-indigo-600', amber: 'from-amber-400 to-amber-500', teal: 'from-teal-500 to-teal-600', green: 'from-green-500 to-green-600', rose: 'from-rose-500 to-rose-600' };
  return (
    <div className={`bg-gradient-to-br ${bg[color] || bg.blue} rounded-2xl p-4 text-white shadow-lg shadow-${color}-200/50`}>
      <div className="flex items-center gap-2 mb-2 opacity-80">
        <Icon className="w-4 h-4" />
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <p className="text-2xl font-extrabold">{value}{sub && <span className="text-sm font-normal opacity-70">{sub}</span>}</p>
    </div>
  );
}

function BarChart({ title, data, labels }: { title: string; data: any; labels: Record<string, string> }) {
  const entries = Object.entries(data || {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 6);
  const total = entries.reduce((s, [, v]: any) => s + Number(v), 0);
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-sm">
      <p className="text-sm font-bold text-slate-700 mb-3">{title}</p>
      <div className="space-y-2">
        {entries.map(([k, v]: any, i) => {
          const pct = total > 0 ? (v / total * 100) : 0;
          return (
            <div key={k} className="flex items-center gap-2 text-xs">
              <span className="w-20 text-right text-slate-500 truncate">{labels[k] || k}</span>
              <div className="flex-1 h-5 bg-gray-50 rounded-full overflow-hidden">
                <div className="h-full rounded-full flex items-center justify-end pr-1.5 text-white font-semibold text-[9px]" style={{ width: `${Math.max(pct, 3)}%`, background: COLORS[i % COLORS.length] }}>
                  {pct >= 10 ? `${pct.toFixed(0)}%` : ''}
                </div>
              </div>
              <span className="w-10 text-right text-slate-600 font-semibold">{v}</span>
            </div>
          );
        })}
        {entries.length === 0 && <p className="text-xs text-slate-300 text-center py-4">데이터 없음</p>}
      </div>
    </div>
  );
}

/* ── 시스템 점검 알림 배너 ── */
function AlertBanner({ alerts, summary }: { alerts: any[]; summary: { critical: number; warning: number; info: number } }) {
  const [open, setOpen] = useState(true);
  const navigate = useNavigate();
  const total = alerts.length;
  if (total === 0) return null;

  const severityIcon = (s: string) => s === 'critical' ? '🔴' : s === 'warning' ? '🟡' : '🔵';
  const severityBg = (s: string) => s === 'critical' ? 'bg-red-50 border-red-200' : s === 'warning' ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200';
  const headerBg = summary.critical > 0 ? 'from-red-500 to-red-600' : summary.warning > 0 ? 'from-amber-500 to-amber-600' : 'from-blue-500 to-blue-600';

  return (
    <div className="rounded-2xl overflow-hidden border border-gray-200 shadow-sm">
      <button onClick={() => setOpen(!open)}
        className={`w-full bg-gradient-to-r ${headerBg} px-4 py-2.5 flex items-center justify-between text-white`}>
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4" />
          <span className="text-sm font-bold">시스템 점검 알림</span>
          <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full">{total}건</span>
          {summary.critical > 0 && <span className="text-xs bg-red-400/30 px-1.5 py-0.5 rounded-full">긴급 {summary.critical}</span>}
          {summary.warning > 0 && <span className="text-xs bg-amber-400/30 px-1.5 py-0.5 rounded-full">경고 {summary.warning}</span>}
        </div>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="bg-white divide-y divide-gray-50 max-h-64 overflow-y-auto">
          {alerts.map((a: any, i: number) => (
            <div key={a.id || i}
              onClick={() => a.link && navigate(a.link)}
              className={`px-4 py-2.5 flex items-start gap-3 ${a.link ? 'cursor-pointer hover:bg-gray-50' : ''} transition-colors`}>
              <span className="text-sm flex-shrink-0 mt-0.5">{severityIcon(a.severity)}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-700">{a.title}</p>
                <p className="text-xs text-slate-400 mt-0.5">{a.description}</p>
              </div>
              {a.link && <span className="text-xs text-slate-300 flex-shrink-0 mt-1">→</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
