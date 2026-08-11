import React, { useEffect, useState, useCallback } from 'react';
import { Building2, Pencil, ToggleLeft, ToggleRight } from 'lucide-react';
import { api } from '../utils/api';
import { PageHeader, DataTable, Modal, EmptyState, FormField } from '../components/ui';
import type { Column } from '../components/ui';
import type { Vendor } from '@shared/types';

export default function VendorsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Vendor | null>(null);
  const [form, setForm] = useState({ code: '', name: '', phone: '', email: '', lead_time_days: 3 });
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api('/vendors').then(setVendors).catch(console.error).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const showMsg = (type: 'ok' | 'err', text: string) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3000); };

  const openCreate = () => {
    setForm({ code: '', name: '', phone: '', email: '', lead_time_days: 3 });
    setEditing(null); setModal('create');
  };

  const openEdit = (v: Vendor) => {
    setForm({ code: v.code, name: v.name, phone: v.phone, email: v.email, lead_time_days: v.lead_time_days });
    setEditing(v); setModal('edit');
  };

  const save = async () => {
    if (!form.name) { showMsg('err', '업체명을 입력해주세요.'); return; }
    setSubmitting(true);
    try {
      if (editing) {
        await api(`/vendors/${editing.id}`, { method: 'PUT', body: JSON.stringify(form) });
        showMsg('ok', '수정되었습니다.');
      } else {
        await api('/vendors', { method: 'POST', body: JSON.stringify(form) });
        showMsg('ok', '등록되었습니다.');
      }
      setModal(null); load();
    } catch (e: any) { showMsg('err', e.message); }
    finally { setSubmitting(false); }
  };

  const toggle = async (id: string, current: boolean) => {
    try { await api(`/vendors/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: !current }) }); load(); }
    catch (e: any) { showMsg('err', e.message); }
  };

  const filtered = vendors.filter(v => !search || v.name.includes(search) || v.code.includes(search));

  const columns: Column<Vendor>[] = [
    { key: 'code', header: '코드', cardPosition: 'subtitle', render: v => <span className="font-mono text-xs text-slate-500">{v.code}</span> },
    { key: 'name', header: '업체명', cardPosition: 'title', sortable: true, sortValue: v => v.name, render: v => <span className="font-medium">{v.name}</span> },
    { key: 'phone', header: '전화', cardPosition: 'body', render: v => <span className="text-sm">{v.phone || '-'}</span> },
    { key: 'email', header: '이메일', cardPosition: 'body', render: v => <span className="text-sm text-slate-500">{v.email || '-'}</span> },
    { key: 'lead_time_days', header: '납기일수', cardPosition: 'body', className: 'text-center', render: v => <>{v.lead_time_days}일</> },
    { key: 'status', header: '상태', cardPosition: 'badge', render: v => <span className={v.is_active ? 'badge-green' : 'badge-gray'}>{v.is_active ? '활성' : '비활성'}</span> },
    {
      key: 'actions', header: '', cardPosition: 'hidden', render: v => (
        <div className="flex gap-2">
          <button onClick={(e) => { e.stopPropagation(); openEdit(v); }} className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1"><Pencil className="w-3 h-3" />수정</button>
          <button onClick={(e) => { e.stopPropagation(); toggle(v.id, v.is_active); }} className="text-xs text-slate-400 hover:text-slate-600 inline-flex items-center gap-1">
            {v.is_active ? <><ToggleRight className="w-3 h-3" />비활성화</> : <><ToggleLeft className="w-3 h-3" />활성화</>}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={Building2}
        title="업체 관리"
        description="공급 업체 등록 및 관리"
        actions={
          <div className="flex gap-2">
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} className="input w-48" placeholder="업체명/코드 검색" />
            <button onClick={openCreate} className="btn-primary">+ 업체 등록</button>
          </div>
        }
      />

      {msg && <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}

      {loading ? (
        <div className="card p-0"><EmptyState message="로딩 중..." /></div>
      ) : (
        <DataTable
          columns={columns}
          data={filtered}
          keyField="id"
          emptyMessage="업체가 없습니다."
        />
      )}

      <Modal
        open={modal === 'create' || modal === 'edit'}
        onClose={() => setModal(null)}
        title={modal === 'create' ? '업체 등록' : '업체 수정'}
        footer={
          <>
            <button onClick={() => setModal(null)} className="btn-secondary">취소</button>
            <button onClick={save} disabled={submitting} className="btn-primary">{submitting ? '저장 중...' : '저장'}</button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="업체 코드">
            <input type="text" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} className="input" placeholder={editing ? '' : '비우면 자동 생성 (V-####)'} />
          </FormField>
          <FormField label="업체명" required>
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" />
          </FormField>
          <FormField label="전화번호">
            <input type="text" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input" placeholder="02-0000-0000" />
          </FormField>
          <FormField label="이메일">
            <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="input" />
          </FormField>
          <FormField label="평균 납기일수">
            <input type="number" min="1" value={form.lead_time_days} onChange={e => setForm(f => ({ ...f, lead_time_days: Number(e.target.value) }))} className="input w-24" />
          </FormField>
        </div>
      </Modal>
    </div>
  );
}
