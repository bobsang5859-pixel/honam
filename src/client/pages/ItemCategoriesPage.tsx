import React, { useEffect, useState, useCallback } from 'react';
import { FolderTree, Pencil, Trash2 } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { PageHeader, DataTable, Modal, EmptyState, FormField } from '../components/ui';
import type { Column } from '../components/ui';

interface ItemCategory {
  id: string; code: string; name: string; group: string; sort_order: number; is_active: boolean;
}
const BLANK = { code: '', name: '', group: 'CONSUMABLE', sort_order: 0, is_active: true };

export default function ItemCategoriesPage() {
  const { user } = useAuth();
  const canWrite = user?.permissions?.includes('BASIC_MANAGE');
  const [rows, setRows] = useState<ItemCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<ItemCategory | null>(null);
  const [form, setForm] = useState(BLANK);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api('/item-categories').then(setRows).catch(console.error).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text }); setTimeout(() => setMsg(null), 3000);
  };

  const openCreate = () => { setForm(BLANK); setEditing(null); setModal('create'); };
  const openEdit = (r: ItemCategory) => {
    setForm({ code: r.code, name: r.name, group: r.group, sort_order: r.sort_order, is_active: r.is_active });
    setEditing(r); setModal('edit');
  };
  const closeModal = () => { setModal(null); setEditing(null); };

  const handleSubmit = async () => {
    if (!form.code.trim() || !form.name.trim()) { showMsg('err', '코드와 이름은 필수입니다.'); return; }
    setSubmitting(true);
    try {
      if (modal === 'create') {
        await api('/item-categories', { method: 'POST', body: JSON.stringify(form) });
        showMsg('ok', '등록되었습니다.');
      } else if (editing) {
        await api(`/item-categories/${editing.id}`, { method: 'PUT', body: JSON.stringify(form) });
        showMsg('ok', '수정되었습니다.');
      }
      closeModal(); load();
    } catch (e: any) {
      showMsg('err', e.message ?? '오류가 발생했습니다.');
    } finally { setSubmitting(false); }
  };

  const handleDelete = async (r: ItemCategory) => {
    if (!confirm(`"${r.name}" 항목을 삭제하시겠습니까?`)) return;
    try {
      await api(`/item-categories/${r.id}`, { method: 'DELETE' });
      showMsg('ok', '삭제되었습니다.'); load();
    } catch (e: any) { showMsg('err', e.message ?? '삭제 실패'); }
  };

  const columns: Column<ItemCategory>[] = [
    { key: 'code', header: '코드', cardPosition: 'subtitle', render: r => <span className="font-mono text-xs text-slate-600">{r.code}</span> },
    { key: 'name', header: '이름', cardPosition: 'title', sortable: true, sortValue: r => r.name, render: r => <span className="font-medium text-slate-800">{r.name}</span> },
    {
      key: 'group', header: '그룹', cardPosition: 'badge', render: r => (
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${r.group === 'EQUIPMENT' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
          {r.group === 'EQUIPMENT' ? '비품' : '소모품'}
        </span>
      ),
    },
    { key: 'sort_order', header: '정렬순서', cardPosition: 'body', className: 'text-center', render: r => <span className="text-slate-600">{r.sort_order}</span> },
    {
      key: 'is_active', header: '사용여부', cardPosition: 'body', className: 'text-center', render: r => (
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${r.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
          {r.is_active ? '사용' : '미사용'}
        </span>
      ),
    },
    ...(canWrite ? [{
      key: 'actions', header: '관리', cardPosition: 'hidden' as const, className: 'text-center', render: (r: ItemCategory) => (
        <div className="flex gap-2 justify-center">
          <button onClick={(e) => { e.stopPropagation(); openEdit(r); }} className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"><Pencil className="w-3 h-3" />수정</button>
          <button onClick={(e) => { e.stopPropagation(); handleDelete(r); }} className="text-xs text-red-500 hover:underline inline-flex items-center gap-1"><Trash2 className="w-3 h-3" />삭제</button>
        </div>
      ),
    }] : []),
  ];

  return (
    <div>
      <PageHeader
        icon={FolderTree}
        title="분류 등록"
        description="품목 분류(category) 마스터 데이터를 관리합니다."
        actions={canWrite ? <button onClick={openCreate} className="btn-primary">+ 추가</button> : undefined}
      />

      {msg && (
        <div className={`mb-4 px-4 py-2.5 rounded text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="card p-0"><EmptyState message="불러오는 중..." /></div>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          keyField="id"
          emptyMessage="등록된 분류가 없습니다."
        />
      )}

      <Modal
        open={modal !== null}
        onClose={closeModal}
        title={modal === 'create' ? '분류 추가' : '분류 수정'}
        footer={
          <>
            <button onClick={closeModal} className="btn-secondary" disabled={submitting}>취소</button>
            <button onClick={handleSubmit} className="btn-primary" disabled={submitting}>
              {submitting ? '저장 중...' : '저장'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="코드" required>
            <input className="input" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
              placeholder="예: MEDICAL_FIXED" disabled={modal === 'edit'} />
          </FormField>
          <FormField label="이름" required>
            <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="예: 의료소모품(고정비용)" />
          </FormField>
          <FormField label="그룹">
            <select className="input" value={form.group} onChange={e => setForm(f => ({ ...f, group: e.target.value }))}>
              <option value="CONSUMABLE">소모품</option>
              <option value="EQUIPMENT">비품</option>
            </select>
          </FormField>
          <FormField label="정렬 순서">
            <input className="input" type="number" value={form.sort_order}
              onChange={e => setForm(f => ({ ...f, sort_order: Number(e.target.value) }))} />
          </FormField>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="is_active_ic" checked={form.is_active}
              onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} className="w-4 h-4 rounded" />
            <label htmlFor="is_active_ic" className="text-sm text-slate-700 cursor-pointer">사용여부</label>
          </div>
        </div>
      </Modal>
    </div>
  );
}
