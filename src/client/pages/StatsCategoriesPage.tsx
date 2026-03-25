import React, { useEffect, useState, useCallback } from 'react';
import { Tags } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { PageHeader, Modal } from '../components/ui';

interface StatsCategory {
  id: string; code: string; name: string; sort_order: number; is_active: boolean;
}
const BLANK = { code: '', name: '', sort_order: 0, is_active: true };

export default function StatsCategoriesPage() {
  const { user } = useAuth();
  const canWrite = user?.permissions?.includes('BASIC_MANAGE');
  const [rows, setRows] = useState<StatsCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<StatsCategory | null>(null);
  const [form, setForm] = useState(BLANK);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api('/stats-categories').then(setRows).catch(console.error).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text }); setTimeout(() => setMsg(null), 3000);
  };

  const openCreate = () => { setForm(BLANK); setEditing(null); setModal('create'); };
  const openEdit = (r: StatsCategory) => {
    setForm({ code: r.code, name: r.name, sort_order: r.sort_order, is_active: r.is_active });
    setEditing(r); setModal('edit');
  };
  const closeModal = () => { setModal(null); setEditing(null); };

  const handleSubmit = async () => {
    if (!form.code.trim() || !form.name.trim()) { showMsg('err', '코드와 이름은 필수입니다.'); return; }
    setSubmitting(true);
    try {
      if (modal === 'create') {
        await api('/stats-categories', { method: 'POST', body: JSON.stringify(form) });
        showMsg('ok', '등록되었습니다.');
      } else if (editing) {
        await api(`/stats-categories/${editing.id}`, { method: 'PUT', body: JSON.stringify(form) });
        showMsg('ok', '수정되었습니다.');
      }
      closeModal(); load();
    } catch (e: any) {
      showMsg('err', e.message ?? '오류가 발생했습니다.');
    } finally { setSubmitting(false); }
  };

  const handleDelete = async (r: StatsCategory) => {
    if (!confirm(`"${r.name}" 항목을 삭제하시겠습니까?`)) return;
    try {
      await api(`/stats-categories/${r.id}`, { method: 'DELETE' });
      showMsg('ok', '삭제되었습니다.'); load();
    } catch (e: any) { showMsg('err', e.message ?? '삭제 실패'); }
  };

  return (
    <div>
      <PageHeader
        icon={Tags}
        title="통계카테고리 등록"
        description="비용 통계 카테고리(stats_bucket) 마스터 데이터를 관리합니다."
        actions={canWrite ? <button onClick={openCreate} className="btn-primary">+ 추가</button> : undefined}
      />

      {msg && (
        <div className={`mb-4 px-4 py-2.5 rounded text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-slate-400">불러오는 중...</div>
      ) : (
        <div className="card p-0 overflow-hidden overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>코드</th>
                <th>이름</th>
                <th className="text-center">정렬순서</th>
                <th className="text-center">사용여부</th>
                {canWrite && <th className="text-center">관리</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={5} className="text-center py-10 text-slate-400">등록된 통계카테고리가 없습니다.</td></tr>
              )}
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="font-mono text-xs text-slate-600">{r.code}</td>
                  <td className="font-medium text-slate-800">{r.name}</td>
                  <td className="text-center text-slate-600">{r.sort_order}</td>
                  <td className="text-center">
                    <span className={r.is_active ? 'badge-green' : 'badge-gray'}>
                      {r.is_active ? '사용' : '미사용'}
                    </span>
                  </td>
                  {canWrite && (
                    <td className="text-center">
                      <button onClick={() => openEdit(r)} className="text-xs text-accent-600 hover:underline mr-3">수정</button>
                      <button onClick={() => handleDelete(r)} className="text-xs text-red-500 hover:underline">삭제</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!modal}
        onClose={closeModal}
        title={modal === 'create' ? '통계카테고리 추가' : '통계카테고리 수정'}
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
          <div>
            <label className="label">코드 <span className="text-red-500">*</span></label>
            <input className="input" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
              placeholder="예: MEDICAL" disabled={modal === 'edit'} />
          </div>
          <div>
            <label className="label">이름 <span className="text-red-500">*</span></label>
            <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="예: 의료비" />
          </div>
          <div>
            <label className="label">정렬 순서</label>
            <input className="input" type="number" value={form.sort_order}
              onChange={e => setForm(f => ({ ...f, sort_order: Number(e.target.value) }))} />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="is_active_sc" checked={form.is_active}
              onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} className="w-4 h-4 rounded" />
            <label htmlFor="is_active_sc" className="text-sm text-slate-700 cursor-pointer">사용여부</label>
          </div>
        </div>
      </Modal>
    </div>
  );
}
