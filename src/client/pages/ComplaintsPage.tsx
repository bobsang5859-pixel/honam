import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { PageHeader } from '../components/ui';
import { MessageSquare } from 'lucide-react';

interface Complaint {
  id: string;
  complaint_type: string;
  title: string;
  content: string;
  status: string;
  patient_id?: string;
  department_id?: string;
  resolved_at?: string;
  created_at: string;
}

export default function ComplaintsPage() {
  const [rows, setRows] = useState<Complaint[]>([]);
  const [filter, setFilter] = useState({ type: '', status: '' });
  const [modal, setModal] = useState<'add' | 'edit' | null>(null);
  const [form, setForm] = useState({ complaint_type: 'COMPLAINT', title: '', content: '' });
  const [editId, setEditId] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => {
    const q = new URLSearchParams();
    if (filter.type) q.set('complaint_type', filter.type);
    if (filter.status) q.set('status', filter.status);
    api(`/complaints?${q}`).then(setRows).catch(() => {});
  };

  useEffect(() => { load(); }, [filter]);

  const save = async () => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      if (modal === 'edit') {
        await api(`/complaints/${editId}`, { method: 'PUT', body: JSON.stringify(form) });
      } else {
        await api('/complaints', { method: 'POST', body: JSON.stringify(form) });
      }
      setModal(null);
      setForm({ complaint_type: 'COMPLAINT', title: '', content: '' });
      load();
    } catch { }
    finally { setSaving(false); }
  };

  const changeStatus = async (id: string, status: string) => {
    await api(`/complaints/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
    load();
  };

  const remove = async (id: string) => {
    if (!confirm('삭제하시겠습니까?')) return;
    await api(`/complaints/${id}`, { method: 'DELETE' });
    load();
  };

  const TYPE_LABEL: Record<string, string> = { COMPLAINT: '민원', COUNSEL: '상담' };
  const STATUS_LABEL: Record<string, string> = { OPEN: '미처리', IN_PROGRESS: '처리중', CLOSED: '완료' };
  const STATUS_COLOR: Record<string, string> = { OPEN: 'bg-red-100 text-red-700', IN_PROGRESS: 'bg-blue-100 text-blue-700', CLOSED: 'bg-green-100 text-green-700' };

  return (
    <div>
      <PageHeader icon={MessageSquare} title="민원 · 상담 관리" description="민원 및 상담 접수/처리" />

      <div className="flex items-center gap-3 mb-4">
        <select className="input text-sm" value={filter.type} onChange={e => setFilter(f => ({ ...f, type: e.target.value }))}>
          <option value="">전체 유형</option>
          <option value="COMPLAINT">민원</option>
          <option value="COUNSEL">상담</option>
        </select>
        <select className="input text-sm" value={filter.status} onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}>
          <option value="">전체 상태</option>
          <option value="OPEN">미처리</option>
          <option value="IN_PROGRESS">처리중</option>
          <option value="CLOSED">완료</option>
        </select>
        <button className="btn-primary ml-auto" onClick={() => { setModal('add'); setForm({ complaint_type: 'COMPLAINT', title: '', content: '' }); }}>등록</button>
      </div>

      <div className="card p-0 overflow-auto">
        <table className="tbl">
          <thead>
            <tr><th>유형</th><th>제목</th><th>상태</th><th>등록일</th><th>처리</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={5} className="text-center text-slate-400 py-8">데이터 없음</td></tr>
            ) : rows.map(r => (
              <tr key={r.id}>
                <td><span className={`text-xs px-2 py-0.5 rounded font-semibold ${r.complaint_type === 'COMPLAINT' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>{TYPE_LABEL[r.complaint_type] || r.complaint_type}</span></td>
                <td className="font-medium">{r.title}</td>
                <td><span className={`text-xs px-2 py-0.5 rounded font-semibold ${STATUS_COLOR[r.status] || ''}`}>{STATUS_LABEL[r.status] || r.status}</span></td>
                <td className="text-xs text-slate-500">{r.created_at?.slice(0, 10)}</td>
                <td>
                  <div className="flex gap-1">
                    {r.status === 'OPEN' && <button className="text-xs text-blue-600 hover:underline" onClick={() => changeStatus(r.id, 'IN_PROGRESS')}>처리시작</button>}
                    {r.status === 'IN_PROGRESS' && <button className="text-xs text-green-600 hover:underline" onClick={() => changeStatus(r.id, 'CLOSED')}>완료</button>}
                    <button className="text-xs text-slate-400 hover:underline" onClick={() => { setEditId(r.id); setForm({ complaint_type: r.complaint_type, title: r.title, content: r.content }); setModal('edit'); }}>수정</button>
                    <button className="text-xs text-red-400 hover:underline" onClick={() => remove(r.id)}>삭제</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setModal(null); }}>
          <div className="modal w-full max-w-2xl">
            <div className="modal-header">
              <h2 className="modal-title">{modal === 'edit' ? '수정' : '민원/상담 등록'}</h2>
              <button className="text-xl text-slate-400" onClick={() => setModal(null)}>&times;</button>
            </div>
            <div className="modal-body space-y-3">
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="label">유형</label>
                  <select className="input w-full" value={form.complaint_type} onChange={e => setForm(f => ({ ...f, complaint_type: e.target.value }))}>
                    <option value="COMPLAINT">민원</option>
                    <option value="COUNSEL">상담</option>
                  </select>
                </div>
                <div className="flex-[2]">
                  <label className="label">제목</label>
                  <input className="input w-full" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="제목" />
                </div>
              </div>
              <div>
                <label className="label">내용</label>
                <textarea className="input w-full" rows={4} value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} placeholder="내용 입력" style={{ minHeight: 100 }} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setModal(null)}>취소</button>
              <button className="btn-primary" disabled={saving || !form.title.trim()} onClick={save}>{saving ? '저장 중...' : '저장'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
