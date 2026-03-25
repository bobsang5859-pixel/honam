import React, { useEffect, useState, useCallback } from 'react';
import { Ruler, Pencil, XCircle } from 'lucide-react';
import { api } from '../utils/api';
import { PageHeader, DataTable, Modal, EmptyState, FormField } from '../components/ui';
import type { Column } from '../components/ui';
import type { UsageBaseline, Item } from '@shared/types';

export default function BaselinesPage() {
  const [baselines, setBaselines] = useState<UsageBaseline[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [depts, setDepts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<UsageBaseline | null>(null);
  const [form, setForm] = useState({
    item_id: '', department_scope: 'ALL', period_type: 'MONTHLY',
    qty_per_patient: 0, effective_from: new Date().toISOString().slice(0, 10),
  });
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [itemSearch, setItemSearch] = useState('');
  const [filteredItems, setFilteredItems] = useState<Item[]>([]);

  const load = useCallback(() => {
    setLoading(true);
    api('/baselines').then(setBaselines).catch(console.error).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api('/items?is_active=true').then(setItems).catch(() => {});
    api('/departments').then(setDepts).catch(() => {});
  }, []);

  useEffect(() => {
    if (itemSearch.trim()) {
      setFilteredItems(items.filter(i => i.name.includes(itemSearch) || i.item_code.includes(itemSearch)).slice(0, 15));
    } else setFilteredItems([]);
  }, [itemSearch, items]);

  const showMsg = (type: 'ok' | 'err', text: string) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3000); };

  const openCreate = () => {
    setForm({ item_id: '', department_scope: 'ALL', period_type: 'MONTHLY', qty_per_patient: 0, effective_from: new Date().toISOString().slice(0, 10) });
    setItemSearch(''); setEditing(null); setModal('create');
  };

  const openEdit = (b: UsageBaseline) => {
    setForm({ item_id: b.item_id, department_scope: b.department_scope, period_type: b.period_type, qty_per_patient: b.qty_per_patient, effective_from: b.effective_from.slice(0, 10) });
    setItemSearch(b.item_name || ''); setEditing(b); setModal('edit');
  };

  const save = async () => {
    if (!form.item_id || form.qty_per_patient <= 0) { showMsg('err', '품목 및 환자당 수량을 입력해주세요.'); return; }
    setSubmitting(true);
    try {
      if (editing) {
        await api(`/baselines/${editing.id}`, { method: 'PUT', body: JSON.stringify(form) });
        showMsg('ok', '수정되었습니다.');
      } else {
        await api('/baselines', { method: 'POST', body: JSON.stringify(form) });
        showMsg('ok', '등록되었습니다.');
      }
      setModal(null); load();
    } catch (e: any) { showMsg('err', e.message); }
    finally { setSubmitting(false); }
  };

  const deactivate = async (id: string) => {
    if (!confirm('기준을 종료하시겠습니까?')) return;
    try {
      await api(`/baselines/${id}`, { method: 'PUT', body: JSON.stringify({ effective_to: new Date().toISOString().slice(0, 10) }) });
      showMsg('ok', '종료되었습니다.'); load();
    } catch (e: any) { showMsg('err', e.message); }
  };

  const columns: Column<UsageBaseline>[] = [
    {
      key: 'item', header: '품목명', cardPosition: 'title', sortable: true,
      sortValue: b => b.item_name || '',
      render: b => (
        <div>
          <div className="font-medium text-sm">{b.item_name}</div>
          <div className="text-xs text-slate-400">{b.item_code}</div>
        </div>
      ),
    },
    {
      key: 'scope', header: '적용 범위', cardPosition: 'body',
      render: b => <span className="text-sm">{b.department_scope === 'ALL' ? '전체' : depts.find((d: any) => d.id === b.department_scope)?.name || b.department_scope}</span>,
    },
    { key: 'period', header: '기간 유형', cardPosition: 'badge', render: b => <span className="badge-blue text-xs">{b.period_type === 'MONTHLY' ? '월간' : b.period_type}</span> },
    { key: 'qty', header: '환자당 수량', cardPosition: 'body', className: 'text-right', render: b => <span className="font-semibold">{b.qty_per_patient}</span> },
    { key: 'from', header: '적용 시작일', cardPosition: 'body', render: b => <span className="text-xs">{b.effective_from.slice(0, 10)}</span> },
    { key: 'to', header: '종료일', cardPosition: 'body', render: b => <span className="text-xs text-slate-400">{b.effective_to ? b.effective_to.slice(0, 10) : '현재 적용 중'}</span> },
    { key: 'version', header: '버전', cardPosition: 'hidden', className: 'text-center', render: b => <span className="text-xs text-slate-500">v{b.version}</span> },
    {
      key: 'actions', header: '', cardPosition: 'hidden', render: b => (
        <div className="flex gap-2">
          {!b.effective_to && <button onClick={(e) => { e.stopPropagation(); openEdit(b); }} className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1"><Pencil className="w-3 h-3" />수정</button>}
          {!b.effective_to && <button onClick={(e) => { e.stopPropagation(); deactivate(b.id); }} className="text-xs text-red-400 hover:underline inline-flex items-center gap-1"><XCircle className="w-3 h-3" />종료</button>}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={Ruler}
        title="사용량 기준"
        description="환자당 물품 사용 기준량 관리 (+-15% 정책 기준)"
        actions={<button onClick={openCreate} className="btn-primary">+ 기준 등록</button>}
      />

      {msg && <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}

      {loading ? (
        <div className="card p-0"><EmptyState message="로딩 중..." /></div>
      ) : (
        <DataTable
          columns={columns}
          data={baselines}
          keyField="id"
          emptyMessage="기준 데이터가 없습니다."
        />
      )}

      <Modal
        open={modal === 'create' || modal === 'edit'}
        onClose={() => setModal(null)}
        title={modal === 'create' ? '기준 등록' : '기준 수정'}
        footer={
          <>
            <button onClick={() => setModal(null)} className="btn-secondary">취소</button>
            <button onClick={save} disabled={submitting} className="btn-primary">{submitting ? '저장 중...' : '저장'}</button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="품목" required>
            <div className="relative">
              <input type="text" value={itemSearch} onChange={e => setItemSearch(e.target.value)} className="input" placeholder="품목명으로 검색" readOnly={!!editing} />
              {!editing && filteredItems.length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                  {filteredItems.map(item => (
                    <button key={item.id} onClick={() => { setForm(f => ({ ...f, item_id: item.id })); setItemSearch(item.name); setFilteredItems([]); }}
                      className="w-full text-left px-4 py-2 hover:bg-slate-50 text-sm border-b border-slate-50 last:border-0">
                      <span className="font-medium">{item.name}</span><span className="text-slate-400 ml-2 text-xs">{item.item_code}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </FormField>
          <FormField label="적용 범위">
            <select value={form.department_scope} onChange={e => setForm(f => ({ ...f, department_scope: e.target.value }))} className="input">
              <option value="ALL">전체 부서</option>
              {depts.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </FormField>
          <FormField label="기간 유형">
            <select value={form.period_type} onChange={e => setForm(f => ({ ...f, period_type: e.target.value }))} className="input">
              <option value="MONTHLY">월간</option>
              <option value="WEEKLY">주간</option>
            </select>
          </FormField>
          <FormField label="환자당 사용 수량" required>
            <input type="number" min="0" step="0.01" value={form.qty_per_patient} onChange={e => setForm(f => ({ ...f, qty_per_patient: Number(e.target.value) }))} className="input" />
          </FormField>
          <FormField label="적용 시작일">
            <input type="date" value={form.effective_from} onChange={e => setForm(f => ({ ...f, effective_from: e.target.value }))} className="input" />
          </FormField>
        </div>
      </Modal>
    </div>
  );
}
