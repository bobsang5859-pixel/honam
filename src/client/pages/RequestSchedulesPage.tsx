import React, { useEffect, useState } from 'react';
import { CalendarClock, Pencil, Trash2 } from 'lucide-react';
import { api } from '../utils/api';
import { useToast } from '../components/Toast';
import { PageHeader, DataTable, Modal, EmptyState, FormField } from '../components/ui';
import type { Column } from '../components/ui';

interface RequestSchedule {
  id: string;
  request_type: string;
  open_from: string;
  open_to: string;
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
  DIAPER: '기저귀',
  NIGHT_SNACK: '야간간식',
};
const SCHEDULE_TYPES = Object.keys(SCHEDULE_TYPE_LABEL);

export default function RequestSchedulesPage() {
  const { showToast } = useToast();
  const [schedules, setSchedules] = useState<RequestSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<ModalMode>(null);
  const [editing, setEditing] = useState<RequestSchedule | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    request_type: 'CONSUMABLE_MEDICAL',
    open_from: '', open_to: '', period_label: '', note: '',
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

  const openCreate = () => {
    setForm({ request_type: 'CONSUMABLE_REGULAR', open_from: '', open_to: '', period_label: '', note: '' });
    setEditing(null);
    setModal('create');
  };

  const openEdit = (row: RequestSchedule) => {
    setForm({
      request_type: row.request_type,
      open_from: row.open_from.slice(0, 16),
      open_to: row.open_to.slice(0, 16),
      period_label: row.period_label,
      note: row.note,
    });
    setEditing(row);
    setModal('edit');
  };

  const save = async () => {
    setSubmitting(true);
    try {
      if (modal === 'create') {
        await api('/request-schedules', { method: 'POST', body: JSON.stringify(form) });
      } else if (editing) {
        await api(`/request-schedules/${editing.id}`, { method: 'PUT', body: JSON.stringify(form) });
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
        footer={
          <>
            <button onClick={() => setModal(null)} className="btn-secondary">취소</button>
            <button onClick={save} disabled={submitting || !form.open_from || !form.open_to} className="btn-primary">
              {submitting ? '저장 중...' : '저장'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="요청 유형">
            <select value={form.request_type} onChange={(e) => setForm((f) => ({ ...f, request_type: e.target.value }))} className="input">
              {SCHEDULE_TYPES.map((t) => <option key={t} value={t}>{SCHEDULE_TYPE_LABEL[t]}</option>)}
            </select>
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="시작일시">
              <input type="datetime-local" value={form.open_from} onChange={(e) => setForm((f) => ({ ...f, open_from: e.target.value }))} className="input" />
            </FormField>
            <FormField label="종료일시">
              <input type="datetime-local" value={form.open_to} onChange={(e) => setForm((f) => ({ ...f, open_to: e.target.value }))} className="input" />
            </FormField>
          </div>
          <FormField label="기간 라벨">
            <input type="text" value={form.period_label} onChange={(e) => setForm((f) => ({ ...f, period_label: e.target.value }))} className="input" placeholder="예: 2026년 3월" />
          </FormField>
          <FormField label="비고">
            <input type="text" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} className="input" placeholder="선택 입력" />
          </FormField>
        </div>
      </Modal>
    </div>
  );
}
