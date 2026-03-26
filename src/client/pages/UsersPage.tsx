import React, { useEffect, useState, useCallback } from 'react';
import { Users } from 'lucide-react';
import { api } from '../utils/api';
import { PageHeader } from '../components/ui';
import type { UserInfo } from '@shared/types';
import DepartmentsPage from './DepartmentsPage';

// ── 탭별 권한 정의 ─────────────────────────────────────────────
// 탭에 권한이 1개라도 있으면 해당 탭이 실제 네비게이션에 표시됩니다
// ※ 총무전산·총무구매는 총무구매 부서 소속 직원에게만 탭이 보입니다
interface PermItem { key: string; label: string; }
interface PermSection { label: string; items: PermItem[]; }
interface PermTab {
  key: string;
  label: string;
  desc: string;
  sections: PermSection[];
}

const PERM_TABS: PermTab[] = [
  { key: 'basic-registration', label: '기초등록', desc: '품목·업체·분류·기준량·환자관리', sections: [
    { label: '기초등록', items: [
      { key: 'ITEM_MANAGE', label: '품목 관리' },
      { key: 'VENDOR_MANAGE', label: '업체 관리' },
      { key: 'BASELINE_MANAGE', label: '기준량 관리' },
      { key: 'SCHEDULE_MANAGE', label: '신청주기 관리' },
      { key: 'AUDIT_VIEW', label: '감사로그 조회' },
      { key: 'PATIENT_VIEW', label: '환자 관리' },
    ] },
  ] },
  { key: 'request-use', label: '신청·사용', desc: '소모품/비품 신청, 사용등록, 대여, 수령검수', sections: [
    { label: '신청·사용', items: [
      { key: 'REQUEST_CREATE', label: '물품 신청' },
      { key: 'USAGE_MANAGE', label: '사용등록' },
      { key: 'LOAN_MANAGE', label: '대여 관리' },
      { key: 'RECEIPT_CHECK_VIEW', label: '수령 검수' },
    ] },
  ] },
  { key: 'purchase-work', label: '구매·입출고', desc: '승인, 발주, 입고, 불출, 재고 관리', sections: [
    { label: '구매·입출고', items: [
      { key: 'APPROVAL_MANAGE', label: '승인 관리' },
      { key: 'PO_MANAGE', label: '발주 관리' },
      { key: 'STOCK_IN_MANAGE', label: '입고 관리' },
      { key: 'STOCK_OUT_MANAGE', label: '불출 관리' },
      { key: 'INVENTORY_MANAGE', label: '재고 관리' },
    ] },
  ] },
  { key: 'stats-work', label: '통계', desc: '물품통계·환자통계 조회 권한', sections: [
    { label: '물품 통계', items: [
      { key: 'STATS_VIEW', label: '내 부서만' },
      { key: 'STATS_VIEW_ALL', label: '전체 조회' },
    ] },
    { label: '환자 통계', items: [
      { key: 'PATIENT_STATS_VIEW', label: '내 병동만' },
      { key: 'PATIENT_STATS_VIEW_ALL', label: '전체 조회' },
    ] },
  ] },
];

// 전체 권한 키 목록 (전체선택/해제용)
const ALL_PERM_KEYS = PERM_TABS.flatMap(t => t.sections.flatMap(s => s.items.map(i => i.key)));

export default function UsersPage({ embedded }: { embedded?: boolean } = {}) {
  const [activeTab, setActiveTab] = useState<'users' | 'depts'>('users');
  const [activePermTab, setActivePermTab] = useState<string>(PERM_TABS[0].key);

  const [users, setUsers] = useState<UserInfo[]>([]);
  const [depts, setDepts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<UserInfo | null>(null);
  const [form, setForm] = useState({
    username: '', display_name: '', password: '',
    department_id: '', direct_permissions: [] as string[],
  });
  const [selectedParentId, setSelectedParentId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api('/users').then(setUsers).catch(console.error).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api('/departments').then(setDepts).catch(() => {}); }, []);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text }); setTimeout(() => setMsg(null), 3000);
  };

  const openCreate = () => {
    setForm({ username: '', display_name: '', password: '', department_id: '', direct_permissions: [] });
    setSelectedParentId('');
    setActivePermTab(PERM_TABS[0].key);
    setEditing(null); setModal('create');
  };

  const openEdit = (u: UserInfo) => {
    setForm({
      username: u.username, display_name: u.display_name, password: '',
      department_id: u.department_id || '',
      direct_permissions: (u as any).direct_permissions ?? [],
    });
    const currentDept = depts.find((d: any) => d.id === u.department_id);
    setSelectedParentId(currentDept?.parent_id ?? currentDept?.id ?? '');
    setActivePermTab(PERM_TABS[0].key);
    setEditing(u); setModal('edit');
  };

  const togglePerm = (key: string) => {
    setForm(f => ({
      ...f,
      direct_permissions: f.direct_permissions.includes(key)
        ? f.direct_permissions.filter(p => p !== key)
        : [...f.direct_permissions, key],
    }));
  };

  const save = async () => {
    if (!form.username || !form.display_name) { showMsg('err', '아이디와 이름을 입력해주세요.'); return; }
    if (!editing && !form.password) { showMsg('err', '비밀번호를 입력해주세요.'); return; }
    setSubmitting(true);
    try {
      const body: any = {
        username: form.username,
        display_name: form.display_name,
        department_id: form.department_id || null,
        direct_permissions: form.direct_permissions.length > 0 ? form.direct_permissions : null,
      };
      if (form.password) body.password = form.password;
      if (editing) {
        await api(`/users/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
        showMsg('ok', '수정되었습니다.');
      } else {
        await api('/users', { method: 'POST', body: JSON.stringify(body) });
        showMsg('ok', '사용자가 등록되었습니다.');
      }
      setModal(null); load();
    } catch (e: any) { showMsg('err', e.message); }
    finally { setSubmitting(false); }
  };

  const toggle = async (id: string, current: boolean) => {
    try {
      await api(`/users/${id}`, { method: 'PUT', body: JSON.stringify({ is_active: !current }) });
      load();
    } catch (e: any) { showMsg('err', e.message); }
  };

  const removeUser = async (u: UserInfo) => {
    if (!confirm(`"${u.display_name}" 사용자를 삭제하시겠습니까?`)) return;
    try {
      await api(`/users/${u.id}`, { method: 'DELETE' });
      showMsg('ok', '삭제되었습니다.');
      load();
    } catch (e: any) { showMsg('err', e.message); }
  };

  // 사용자가 가진 권한 수 (roles에서 오는 것 + direct_permissions)
  const getPermCount = (u: UserInfo) => {
    const dp = (u as any).direct_permissions;
    return Array.isArray(dp) ? dp.length : 0;
  };

  return (
    <div>
      {!embedded && (
        <div className="flex gap-0 mb-4 border-b border-gray-200">
          {(['users', 'depts'] as const).map(t => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === t ? 'border-teal-500 text-teal-600' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {t === 'users' ? '사용자' : '부서'}
            </button>
          ))}
        </div>
      )}

      {!embedded && activeTab === 'depts' && <DepartmentsPage />}

      {(embedded || activeTab === 'users') && (
        <>
          {!embedded && (
            <PageHeader
              icon={Users}
              title="사용자 관리"
              description="계정 및 업무 권한 관리"
              actions={<button onClick={openCreate} className="btn-primary">+ 사용자 등록</button>}
            />
          )}
          {embedded && (
            <div className="flex justify-end mb-4">
              <button onClick={openCreate} className="btn-primary">+ 사용자 등록</button>
            </div>
          )}

          {msg && (
            <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {msg.text}
            </div>
          )}

          <div className="card p-0 overflow-hidden overflow-x-auto">
            {loading ? (
              <div className="flex items-center justify-center py-16 text-slate-400 text-sm">로딩 중...</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>아이디</th><th>이름</th><th>부서</th><th>업무 권한</th><th>상태</th><th>최종로그인</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id}>
                      <td className="font-medium text-sm">{u.username}</td>
                      <td>{u.display_name}</td>
                      <td className="text-xs text-slate-500">{u.department_name || '-'}</td>
                      <td>
                        {getPermCount(u) > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {((u as any).direct_permissions ?? []).map((p: string) => {
                              const item = PERM_TABS.flatMap(t => t.sections.flatMap(s => s.items)).find(i => i.key === p);
                              return (
                                <span key={p} className="badge-blue text-[10px]">{item?.label ?? p}</span>
                              );
                            })}
                          </div>
                        ) : (u.roles || []).length > 0 ? (
                          <span className="badge-purple text-[10px]">{(u.roles || []).join(', ')}</span>
                        ) : (
                          <span className="badge-gray text-[10px]">없음</span>
                        )}
                      </td>
                      <td><span className={u.is_active ? 'badge-green' : 'badge-gray'}>{u.is_active ? '활성' : '비활성'}</span></td>
                      <td className="text-xs text-slate-400">{u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('ko-KR') : '-'}</td>
                      <td className="flex gap-2">
                        <button onClick={() => openEdit(u)} className="text-xs text-accent-600 hover:underline">수정</button>
                        <button onClick={() => toggle(u.id, u.is_active)} className="text-xs text-slate-400 hover:text-slate-600">
                          {u.is_active ? '비활성화' : '활성화'}
                        </button>
                        <button onClick={() => removeUser(u)} className="text-xs text-red-400 hover:text-red-600">삭제</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* 사용자 등록/수정 모달 */}
      {(modal === 'create' || modal === 'edit') && (
        <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setModal(null); }}>
          <div className="modal w-full max-w-lg">
            <div className="modal-header">
              <h2 className="modal-title">{modal === 'create' ? '사용자 등록' : '사용자 수정'}</h2>
              <button onClick={() => setModal(null)} className="text-slate-400 text-xl">&times;</button>
            </div>
            <div className="modal-body space-y-4">
              {/* 기본 정보 */}
              <div>
                <label className="label">아이디 *</label>
                <input type="text" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} className="input" disabled={!!editing} />
              </div>
              <div>
                <label className="label">이름 *</label>
                <input type="text" value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} className="input" />
              </div>
              <div>
                <label className="label">비밀번호 {editing ? '(변경 시만 입력)' : '*'}</label>
                <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} className="input" placeholder={editing ? '변경하지 않으면 빈칸' : '비밀번호 입력'} />
              </div>

              {/* 소속 부서 */}
              <div>
                <label className="label">소속 부서</label>
                {(() => {
                  const parents = depts.filter((d: any) => !d.parent_id && d.code !== 'CENTRAL');
                  const children = depts.filter((d: any) => d.parent_id);
                  const selectedParent = parents.find((p: any) => p.id === selectedParentId);
                  const childrenOfSelected = selectedParentId ? children.filter((c: any) => c.parent_id === selectedParentId) : [];
                  const selectedDeptName = form.department_id ? depts.find((d: any) => d.id === form.department_id)?.name : null;
                  return (
                    <div className="border border-gray-200 rounded-xl overflow-hidden">
                      <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs text-slate-500 flex items-center gap-2">
                        {selectedDeptName
                          ? <><span className="text-teal-600 font-medium">{selectedParent?.name}</span><span>›</span><span className="font-semibold text-slate-700">{selectedDeptName}</span></>
                          : <span>부서를 선택해주세요</span>}
                        {form.department_id && (
                          <button onClick={() => { setForm(f => ({ ...f, department_id: '' })); setSelectedParentId(''); }}
                            className="ml-auto text-slate-400 hover:text-red-500 text-xs">✕ 초기화</button>
                        )}
                      </div>
                      <div className="p-2">
                        <p className="text-[10px] text-slate-400 mb-1.5 px-1">상위 부서</p>
                        <div className="flex flex-wrap gap-1.5">
                          {parents.map((p: any) => (
                            <button key={p.id} type="button"
                              onClick={() => {
                                setSelectedParentId(p.id);
                                const kids = children.filter((c: any) => c.parent_id === p.id);
                                if (kids.length === 0) setForm(f => ({ ...f, department_id: p.id }));
                                else setForm(f => ({ ...f, department_id: '' }));
                              }}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border"
                              style={{ background: selectedParentId === p.id ? '#0f2744' : 'white', color: selectedParentId === p.id ? 'white' : '#374151', borderColor: selectedParentId === p.id ? '#0f2744' : '#e5e7eb' }}
                            >{p.name}</button>
                          ))}
                        </div>
                      </div>
                      {selectedParentId && childrenOfSelected.length > 0 && (
                        <div className="p-2 border-t border-gray-100 bg-slate-50">
                          <p className="text-[10px] text-slate-400 mb-1.5 px-1">{selectedParent?.name} 하위 부서</p>
                          <div className="flex flex-wrap gap-1.5">
                            {childrenOfSelected.map((c: any) => (
                              <button key={c.id} type="button"
                                onClick={() => setForm(f => ({ ...f, department_id: c.id }))}
                                className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border"
                                style={{ background: form.department_id === c.id ? '#14b8a6' : 'white', color: form.department_id === c.id ? 'white' : '#374151', borderColor: form.department_id === c.id ? '#14b8a6' : '#e5e7eb' }}
                              >{c.name}</button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* 업무 권한 */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <label className="label mb-0">업무 권한 부여</label>
                  <div className="flex gap-2 text-xs">
                    <button type="button" onClick={() => setForm(f => ({ ...f, direct_permissions: ALL_PERM_KEYS }))} className="text-blue-600 hover:underline">전체 선택</button>
                    <button type="button" onClick={() => setForm(f => ({ ...f, direct_permissions: [] }))} className="text-slate-400 hover:underline">전체 해제</button>
                  </div>
                </div>

                {/* 카드형 그룹 */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {PERM_TABS.map(tab => {
                    const tabKeys = tab.sections.flatMap(s => s.items.map(i => i.key));
                    const checkedCount = tabKeys.filter(k => form.direct_permissions.includes(k)).length;
                    const allChecked = tabKeys.every(k => form.direct_permissions.includes(k));
                    const someChecked = checkedCount > 0;
                    const toggleAll = () => {
                      if (allChecked) {
                        setForm(f => ({ ...f, direct_permissions: f.direct_permissions.filter(p => !tabKeys.includes(p)) }));
                      } else {
                        setForm(f => ({ ...f, direct_permissions: [...new Set([...f.direct_permissions, ...tabKeys])] }));
                      }
                    };
                    const colors = allChecked ? 'border-blue-300 bg-blue-50/50' : someChecked ? 'border-amber-200 bg-amber-50/30' : 'border-gray-200 bg-white';
                    return (
                      <div key={tab.key} className={`border rounded-xl p-4 transition-colors ${colors}`}>
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <p className="text-sm font-bold text-slate-700">{tab.label}</p>
                            <p className="text-[10px] text-slate-400 mt-0.5">{tab.desc}</p>
                          </div>
                          <button type="button" onClick={toggleAll} className={`text-[10px] px-2.5 py-1 rounded-lg border font-semibold transition-colors ${allChecked ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-slate-400 border-gray-200 hover:border-blue-300'}`}>
                            {allChecked ? 'ON' : 'OFF'}
                          </button>
                        </div>
                        <div className="space-y-2">
                          {tab.sections.map(section => (
                            <div key={section.label}>
                              {tab.sections.length > 1 && (
                                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1 mt-1 border-b border-gray-100 pb-1">{section.label}</p>
                              )}
                              <div className="space-y-1">
                                {section.items.map(item => {
                                  const checked = form.direct_permissions.includes(item.key);
                                  return (
                                    <label key={item.key} className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${checked ? 'bg-white shadow-sm border border-blue-100' : 'hover:bg-gray-50'}`}>
                                      <input type="checkbox" checked={checked} onChange={() => togglePerm(item.key)} className="rounded accent-blue-500" />
                                      <span className={`text-xs ${checked ? 'text-slate-800 font-semibold' : 'text-slate-400'}`}>{item.label}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] text-slate-400 mt-2">선택된 권한: {form.direct_permissions.length}개</p>
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
