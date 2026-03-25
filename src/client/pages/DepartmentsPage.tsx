import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import type { Department } from '@shared/types';

type DepartmentRow = {
  dept: Department;
  parentName: string;
  isChild: boolean;
};

const MODULE_LABELS: Record<string, string> = {
  'chongmu-module':    '총무',
};

function sortByKoName(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name, 'ko');
}

function buildGroupedRows(departments: Department[]): DepartmentRow[] {
  const byId = new Map(departments.map((d) => [d.id, d]));
  const parents = departments.filter((d) => !d.parent_id).sort(sortByKoName);
  const children = departments.filter((d) => !!d.parent_id).sort(sortByKoName);

  const rows: DepartmentRow[] = [];
  const seen = new Set<string>();

  for (const parent of parents) {
    rows.push({ dept: parent, parentName: '-', isChild: false });
    seen.add(parent.id);

    for (const child of children) {
      if (child.parent_id !== parent.id) continue;
      rows.push({ dept: child, parentName: parent.name, isChild: true });
      seen.add(child.id);
    }
  }

  for (const child of children) {
    if (seen.has(child.id)) continue;
    rows.push({
      dept: child,
      parentName: byId.get(child.parent_id || '')?.name || '(상위 부서 없음)',
      isChild: true,
    });
  }

  return rows;
}

export default function DepartmentsPage() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Department | null>(null);
  const [form, setForm] = useState({ name: '', parent_id: '', module_id: '' });
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api('/departments').then(setDepartments).catch(console.error).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3000);
  };

  const openCreate = () => {
    setForm({ name: '', parent_id: '', module_id: '' });
    setEditing(null);
    setModal('create');
  };

  const openEdit = (d: Department) => {
    setForm({ name: d.name, parent_id: d.parent_id || '', module_id: (d as any).module_id || '' });
    setEditing(d);
    setModal('edit');
  };

  const save = async () => {
    if (!form.name.trim()) {
      showMsg('err', '부서명을 입력해주세요.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = { name: form.name.trim(), parent_id: form.parent_id || null, module_id: form.module_id || null };
      if (editing) {
        await api(`/departments/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showMsg('ok', '수정되었습니다.');
      } else {
        await api('/departments', { method: 'POST', body: JSON.stringify(payload) });
        showMsg('ok', '등록되었습니다.');
      }
      setModal(null);
      load();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const toggle = async (id: string, current: boolean) => {
    try {
      await api(`/departments/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: !current }) });
      load();
    } catch (e: any) {
      showMsg('err', e.message);
    }
  };

  const removeDepartment = async (d: Department) => {
    const confirmed = window.confirm(`'${d.name}' 부서를 삭제할까요?`);
    if (!confirmed) return;

    try {
      await api(`/departments/${d.id}`, { method: 'DELETE' });
      showMsg('ok', '삭제되었습니다.');
      load();
    } catch (e: any) {
      showMsg('err', e.message);
    }
  };

  const rows = useMemo(() => buildGroupedRows(departments), [departments]);

  const parentOptions = useMemo(() => {
    const topLevels = departments.filter((d) => !d.parent_id).sort(sortByKoName);
    if (!editing) return topLevels;
    return topLevels.filter((d) => d.id !== editing.id);
  }, [departments, editing]);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">부서 관리</h1>
          <p className="page-subtitle">소속(그룹)과 소속별 부서를 함께 관리합니다.</p>
        </div>
        <button onClick={openCreate} className="btn-primary">+ 부서 등록</button>
      </div>

      {msg && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      <div className="card p-0 overflow-hidden overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm">로딩 중...</div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm">등록된 부서가 없습니다.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>부서명</th>
                <th>소속(그룹)</th>
                <th>모듈</th>
                <th>상태</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ dept, parentName, isChild }) => (
                <tr key={dept.id} className={isChild ? '' : 'bg-slate-50/70'}>
                  <td className={`font-medium ${isChild ? 'pl-7' : ''}`}>
                    {isChild && <span className="text-gray-300 mr-2">└</span>}
                    {dept.name}
                  </td>
                  <td className="text-xs text-gray-500">{parentName}</td>
                  <td className="text-xs text-gray-500">
                    {(dept as any).module_id ? MODULE_LABELS[(dept as any).module_id] ?? (dept as any).module_id : <span className="text-gray-300">-</span>}
                  </td>
                  <td>
                    <span className={dept.is_active ? 'badge-green' : 'badge-gray'}>
                      {dept.is_active ? '활성' : '비활성'}
                    </span>
                  </td>
                  <td className="flex gap-2">
                    <button onClick={() => openEdit(dept)} className="text-xs text-accent-600 hover:underline">수정</button>
                    <button onClick={() => toggle(dept.id, dept.is_active)} className="text-xs text-gray-400 hover:text-gray-600">
                      {dept.is_active ? '비활성화' : '활성화'}
                    </button>
                    <button onClick={() => removeDepartment(dept)} className="text-xs text-red-500 hover:underline">삭제</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(modal === 'create' || modal === 'edit') && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
          <div className="modal w-full max-w-md">
            <div className="modal-header">
              <h2 className="modal-title">{modal === 'create' ? '부서 등록' : '부서 수정'}</h2>
              <button onClick={() => setModal(null)} className="text-gray-400 text-xl">&times;</button>
            </div>
            <div className="modal-body space-y-4">
              <div>
                <label className="label">부서명 *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="input"
                  placeholder="예: 2병동"
                />
              </div>
              <div>
                <label className="label">상위 부서(소속)</label>
                <select
                  value={form.parent_id}
                  onChange={(e) => setForm((f) => ({ ...f, parent_id: e.target.value }))}
                  className="input"
                >
                  <option value="">최상위 부서</option>
                  {parentOptions.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">사용 모듈</label>
                <select
                  value={form.module_id}
                  onChange={(e) => setForm((f) => ({ ...f, module_id: e.target.value }))}
                  className="input"
                >
                  <option value="">없음 (물품신청만)</option>
                  <option value="chongmu-module">총무</option>
                  <option value="management">관리</option>
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setModal(null)} className="btn-secondary">취소</button>
              <button onClick={save} disabled={submitting} className="btn-primary">{submitting ? '저장 중...' : '저장'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
