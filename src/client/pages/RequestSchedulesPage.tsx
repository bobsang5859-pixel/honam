import React, { useEffect, useMemo, useState } from 'react';
import { CalendarClock, ChevronLeft, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { api } from '../utils/api';
import { useToast } from '../components/Toast';
import { PageHeader, DataTable, Modal, EmptyState, FormField } from '../components/ui';
import type { Column } from '../components/ui';

interface RequestSchedule {
  id: string;
  request_type: string;
  open_from: string;
  open_to: string;
  use_from: string | null;
  use_to: string | null;
  period_label: string;
  note: string;
  is_active: boolean;
  is_upcoming: boolean;
  is_past: boolean;
}

type ModalMode = 'create' | 'edit' | null;

const SCHEDULE_TYPE_LABEL: Record<string, string> = {
  CONSUMABLE_MEDICAL: '의료소모품',
  CONSUMABLE_REGULAR: '일반소모품',
  CONSUMABLE_OFFICE: '사무용품',
  DIAPER: '기저귀',
  NIGHT_SNACK: '야간간식',
};
const SCHEDULE_TYPES = Object.keys(SCHEDULE_TYPE_LABEL);

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const;

// 'YYYY-MM-DD' 로컬 포맷
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 'YYYY-MM-DDTHH:mm' → Date
function parseDateTime(s: string): Date {
  return new Date(s);
}

// 같은 날인지 (시간 무시)
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// a <= b (날짜만 비교)
function dateOnLE(a: Date, b: Date): boolean {
  return fmtDate(a) <= fmtDate(b);
}

// 자동 기간 라벨: 시작일 기준 "YYYY년 M월" (한 달 안에 끝나면), 아니면 "YYYY년 M월 ~ M월"
function autoPeriodLabel(start: Date | null, end: Date | null): string {
  if (!start) return '';
  const sy = start.getFullYear();
  const sm = start.getMonth() + 1;
  if (!end || (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth())) {
    return `${sy}년 ${sm}월`;
  }
  const ey = end.getFullYear();
  const em = end.getMonth() + 1;
  if (sy === ey) return `${sy}년 ${sm}월 ~ ${em}월`;
  return `${sy}년 ${sm}월 ~ ${ey}년 ${em}월`;
}

export default function RequestSchedulesPage() {
  const { showToast } = useToast();
  const [schedules, setSchedules] = useState<RequestSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<ModalMode>(null);
  const [editing, setEditing] = useState<RequestSchedule | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 폼 상태 — 날짜와 시간을 분리해 보관
  const [requestType, setRequestType] = useState('CONSUMABLE_MEDICAL');
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('18:00');
  // 사용기간 — 이 신청주기로 신청한 물품의 실제 사용 시작/종료 (신청기간과 별개)
  const [useStartDate, setUseStartDate] = useState<string>('');  // YYYY-MM-DD
  const [useEndDate, setUseEndDate] = useState<string>('');
  const [periodLabel, setPeriodLabel] = useState('');
  const [labelDirty, setLabelDirty] = useState(false);   // 사용자가 수동 편집했는지
  const [note, setNote] = useState('');

  // 캘린더에 보이는 월
  const [viewMonth, setViewMonth] = useState<Date>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const load = async () => {
    setLoading(true);
    try {
      const rows = await api('/request-schedules?include_past=true');
      setSchedules(Array.isArray(rows) ? rows : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // 시작/종료 날짜가 바뀔 때 자동 라벨 갱신 (사용자가 직접 수정 안 했으면)
  useEffect(() => {
    if (labelDirty) return;
    setPeriodLabel(autoPeriodLabel(startDate, endDate));
  }, [startDate, endDate, labelDirty]);

  const openCreate = () => {
    const today = new Date();
    setRequestType('CONSUMABLE_REGULAR');
    setStartDate(null);
    setEndDate(null);
    setStartTime('09:00');
    setEndTime('18:00');
    setUseStartDate('');
    setUseEndDate('');
    setPeriodLabel('');
    setLabelDirty(false);
    setNote('');
    setViewMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    setEditing(null);
    setModal('create');
  };

  const openEdit = (row: RequestSchedule) => {
    const from = parseDateTime(row.open_from);
    const to = parseDateTime(row.open_to);
    setRequestType(row.request_type);
    setStartDate(new Date(from.getFullYear(), from.getMonth(), from.getDate()));
    setEndDate(new Date(to.getFullYear(), to.getMonth(), to.getDate()));
    setStartTime(`${String(from.getHours()).padStart(2, '0')}:${String(from.getMinutes()).padStart(2, '0')}`);
    setEndTime(`${String(to.getHours()).padStart(2, '0')}:${String(to.getMinutes()).padStart(2, '0')}`);
    setUseStartDate(row.use_from ? fmtDate(new Date(row.use_from)) : '');
    setUseEndDate(row.use_to ? fmtDate(new Date(row.use_to)) : '');
    setPeriodLabel(row.period_label);
    setLabelDirty(true);   // 기존 라벨 보존, 자동 갱신 안 함
    setNote(row.note);
    setViewMonth(new Date(from.getFullYear(), from.getMonth(), 1));
    setEditing(row);
    setModal('edit');
  };

  const handleDayClick = (date: Date) => {
    if (!startDate || (startDate && endDate)) {
      // 새로 시작
      setStartDate(date);
      setEndDate(null);
      return;
    }
    // startDate만 있는 상태 → 종료 결정
    if (dateOnLE(date, startDate)) {
      // 시작 이전 날짜 클릭 → 시작을 그날로 옮김
      setStartDate(date);
      return;
    }
    setEndDate(date);
  };

  const goPrevMonth = () => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  const goNextMonth = () => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));
  const goToday = () => {
    const t = new Date();
    setViewMonth(new Date(t.getFullYear(), t.getMonth(), 1));
  };

  // 캘린더 셀(6주 x 7일 = 42칸)
  const calendarCells = useMemo(() => {
    const firstOfMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const startOffset = firstOfMonth.getDay(); // 0=일
    const start = new Date(firstOfMonth);
    start.setDate(start.getDate() - startOffset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [viewMonth]);

  const today = useMemo(() => new Date(), []);

  const save = async () => {
    if (!startDate) {
      showToast('캘린더에서 시작일을 선택하세요.', 'error');
      return;
    }
    const finalEnd = endDate ?? startDate;   // 단일 날짜라면 시작=종료
    setSubmitting(true);
    try {
      const payload = {
        request_type: requestType,
        open_from: `${fmtDate(startDate)}T${startTime}`,
        open_to: `${fmtDate(finalEnd)}T${endTime}`,
        use_from: useStartDate ? `${useStartDate}T00:00` : null,
        use_to: useEndDate ? `${useEndDate}T23:59` : null,
        period_label: periodLabel.trim(),
        note: note.trim(),
      };
      if (modal === 'create') {
        await api('/request-schedules', { method: 'POST', body: JSON.stringify(payload) });
      } else if (editing) {
        await api(`/request-schedules/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      }
      setModal(null);
      await load();
      showToast('요청 일정을 저장했습니다.', 'success');
    } catch (e: any) {
      showToast(e.message || '저장에 실패했습니다.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('요청 일정을 삭제할까요?')) return;
    try {
      await api(`/request-schedules/${id}`, { method: 'DELETE' });
      await load();
      showToast('요청 일정을 삭제했습니다.', 'success');
    } catch (e: any) {
      showToast(e.message || '삭제에 실패했습니다.', 'error');
    }
  };

  const columns: Column<RequestSchedule>[] = [
    { key: 'type', header: '유형', cardPosition: 'title', render: row => <span className="font-medium text-sm">{SCHEDULE_TYPE_LABEL[row.request_type] ?? row.request_type}</span> },
    { key: 'open_from', header: '시작', cardPosition: 'body', render: row => <span className="text-xs text-slate-600">{new Date(row.open_from).toLocaleString('ko-KR')}</span> },
    { key: 'open_to', header: '종료', cardPosition: 'body', render: row => <span className="text-xs text-slate-600">{new Date(row.open_to).toLocaleString('ko-KR')}</span> },
    { key: 'period_label', header: '기간라벨', cardPosition: 'subtitle', render: row => <span className="text-sm">{row.period_label || '-'}</span> },
    {
      key: 'status', header: '상태', cardPosition: 'badge', render: row => (
        row.is_active
          ? <span className="badge-green">진행중</span>
          : row.is_upcoming
          ? <span className="badge-blue">예정</span>
          : <span className="badge-gray">완료</span>
      ),
    },
    { key: 'note', header: '비고', cardPosition: 'hidden', render: row => <span className="text-xs text-slate-400">{row.note || '-'}</span> },
    {
      key: 'actions', header: '', cardPosition: 'hidden', render: row => (
        <div className="flex gap-2">
          <button onClick={(e) => { e.stopPropagation(); openEdit(row); }} className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1"><Pencil className="w-3 h-3" />편집</button>
          <button onClick={(e) => { e.stopPropagation(); remove(row.id); }} className="text-xs text-red-400 hover:underline inline-flex items-center gap-1"><Trash2 className="w-3 h-3" />삭제</button>
        </div>
      ),
    },
  ];

  const periodSummary = (() => {
    if (!startDate) return '날짜를 선택하세요';
    const end = endDate ?? startDate;
    if (sameDay(startDate, end)) {
      return `${fmtDate(startDate)} ${startTime} ~ ${endTime}`;
    }
    return `${fmtDate(startDate)} ${startTime} ~ ${fmtDate(end)} ${endTime}`;
  })();

  return (
    <div>
      <PageHeader
        icon={CalendarClock}
        title="신청주기 관리"
        description="정기 요청 기간을 관리합니다. 비정기 요청은 상시 가능합니다."
        actions={<button onClick={openCreate} className="btn-primary">+ 일정 추가</button>}
      />

      {loading ? (
        <div className="card p-0"><EmptyState message="불러오는 중..." /></div>
      ) : (
        <DataTable
          columns={columns}
          data={schedules}
          keyField="id"
          emptyMessage="등록된 일정이 없습니다."
        />
      )}

      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={modal === 'create' ? '요청 일정 추가' : '요청 일정 편집'}
        size="xl"
        footer={
          <>
            <button onClick={() => setModal(null)} className="btn-secondary">취소</button>
            <button onClick={save} disabled={submitting || !startDate} className="btn-primary">
              {submitting ? '저장 중...' : '저장'}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* 좌측: 캘린더 */}
          <div className="lg:col-span-3">
            <div className="flex items-center justify-between mb-3">
              <button type="button" onClick={goPrevMonth} className="p-2 rounded-lg hover:bg-slate-100" aria-label="이전 달">
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-3">
                <span className="text-lg font-semibold">
                  {viewMonth.getFullYear()}년 {viewMonth.getMonth() + 1}월
                </span>
                <button type="button" onClick={goToday} className="text-xs px-2 py-1 rounded-md border border-slate-200 hover:bg-slate-50">
                  오늘
                </button>
              </div>
              <button type="button" onClick={goNextMonth} className="p-2 rounded-lg hover:bg-slate-100" aria-label="다음 달">
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1 mb-1">
              {WEEKDAYS.map((w, i) => (
                <div key={w} className={`text-center text-xs font-semibold py-2 ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-slate-500'}`}>
                  {w}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {calendarCells.map((d, i) => {
                const inMonth = d.getMonth() === viewMonth.getMonth();
                const isToday = sameDay(d, today);
                const isStart = !!startDate && sameDay(d, startDate);
                const isEnd = !!endDate && sameDay(d, endDate);
                const inRange = !!startDate && !!endDate && dateOnLE(startDate, d) && dateOnLE(d, endDate);
                const dayOfWeek = d.getDay();

                let cls = 'h-14 sm:h-16 rounded-lg flex items-center justify-center text-sm transition-colors cursor-pointer select-none border ';
                if (isStart || isEnd) {
                  cls += 'bg-blue-500 text-white border-blue-500 font-semibold';
                } else if (inRange) {
                  cls += 'bg-blue-100 text-blue-700 border-blue-100';
                } else if (!inMonth) {
                  cls += 'text-slate-300 border-transparent hover:bg-slate-50';
                } else if (isToday) {
                  cls += 'border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100';
                } else {
                  cls += 'border-transparent hover:bg-slate-100 ';
                  cls += dayOfWeek === 0 ? 'text-red-500 ' : dayOfWeek === 6 ? 'text-blue-500 ' : 'text-slate-700 ';
                }

                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleDayClick(d)}
                    className={cls}
                  >
                    {d.getDate()}
                  </button>
                );
              })}
            </div>

            <p className="text-xs text-slate-400 mt-3">
              시작일을 클릭한 뒤 종료일을 다시 클릭하면 기간이 잡힙니다. 한 날만 선택하려면 같은 날을 다시 클릭하지 말고 그대로 두세요.
            </p>
          </div>

          {/* 우측: 입력 폼 */}
          <div className="lg:col-span-2 space-y-4">
            <FormField label="요청 유형">
              <select value={requestType} onChange={(e) => setRequestType(e.target.value)} className="input">
                {SCHEDULE_TYPES.map((t) => <option key={t} value={t}>{SCHEDULE_TYPE_LABEL[t]}</option>)}
              </select>
            </FormField>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] font-semibold text-slate-500 mb-1">신청기간 (캘린더에서 선택 — 부서가 신청할 수 있는 기간)</p>
              <p className="text-sm font-medium text-slate-800">{periodSummary}</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="신청 시작 시간">
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="input" />
              </FormField>
              <FormField label="신청 종료 시간">
                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="input" />
              </FormField>
            </div>

            <div className="rounded-xl border border-slate-200 bg-blue-50/50 p-3 space-y-2">
              <p className="text-[11px] font-semibold text-slate-500">사용기간 — 이 신청주기로 신청한 물품을 실제 사용하는 기간</p>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="사용 시작일">
                  <input type="date" value={useStartDate} onChange={(e) => setUseStartDate(e.target.value)} className="input" />
                </FormField>
                <FormField label="사용 종료일">
                  <input type="date" value={useEndDate} onChange={(e) => setUseEndDate(e.target.value)} className="input" />
                </FormField>
              </div>
              <p className="text-[11px] text-slate-400">신청기간과 다를 수 있습니다 (예: 5/4~5/9 신청 → 5월 3주차분 사용). 비워두면 미지정.</p>
            </div>

            <FormField label="기간 라벨">
              <input
                type="text"
                value={periodLabel}
                onChange={(e) => { setPeriodLabel(e.target.value); setLabelDirty(true); }}
                className="input"
                placeholder="자동 생성됨 (직접 수정 가능)"
              />
              {labelDirty && (
                <button
                  type="button"
                  onClick={() => { setLabelDirty(false); setPeriodLabel(autoPeriodLabel(startDate, endDate)); }}
                  className="text-[11px] text-blue-600 hover:underline mt-1"
                >
                  자동 라벨로 되돌리기
                </button>
              )}
            </FormField>

            <FormField label="비고">
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} className="input" placeholder="선택 입력" />
            </FormField>
          </div>
        </div>
      </Modal>
    </div>
  );
}
