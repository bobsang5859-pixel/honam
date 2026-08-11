import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { FolderTree, Pencil, Trash2, Lock } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { PageHeader, Modal, EmptyState, FormField } from '../components/ui';
import {
  CONSUMABLE_CATEGORIES, EQUIPMENT_CATEGORIES, MAJOR_GROUP_LABEL,
  getMajor, setUserMidCategories,
} from '@shared/types';
import type { MajorGroup } from '@shared/types';

// 분류(중분류) 관리 — 기본 분류는 시스템 고정(코드·통계 안정), 사용자 추가분만 관리.
// 대분류는 8개 카테고리체계가 5개 그룹으로 합쳐진 MajorGroup 기준.
interface UserMid {
  id: string; code: string; name: string;
  sort_order: number; is_active: boolean; item_count: number;
  major: MajorGroup; major_label: string;
}

// 사용자가 새 중분류를 만들 수 있는 대분류 (코드 접두어가 정해진 5개)
const MAJOR_ORDER: MajorGroup[] = ['MEDICAL', 'GENERAL', 'DIAPER', 'OFFICE', 'EQUIPMENT'];

// 기본 제공(고정) 분류 — 품목 등록 드롭다운에 뜨는 것과 동일
const FIXED = [...CONSUMABLE_CATEGORIES, ...EQUIPMENT_CATEGORIES].map(c => ({
  value: c.value, label: c.label, major: getMajor(c.value) as MajorGroup,
}));

export default function ItemCategoriesPage() {
  const { user } = useAuth();
  const canWrite = user?.permissions?.includes('BASIC_MANAGE');
  const [rows, setRows] = useState<UserMid[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<UserMid | null>(null);
  const [form, setForm] = useState<{ name: string; major: MajorGroup; is_active: boolean }>({
    name: '', major: 'MEDICAL', is_active: true,
  });
  const [submitting, setSubmitting] = useState(false);

  // 삭제 시 품목 이동 모달
  const [moveTarget, setMoveTarget] = useState<UserMid | null>(null);
  const [moveTo, setMoveTo] = useState('');

  const showMsg = (type: 'ok' | 'err', text: string) => { setMsg({ type, text }); setTimeout(() => setMsg(null), 3500); };

  const load = useCallback(() => {
    setLoading(true);
    api('/item-categories')
      .then((r: any[]) => {
        const list = (Array.isArray(r) ? r : []) as UserMid[];
        setRows(list);
        // 전역 레지스트리 갱신 — 다른 화면 라벨/그룹 도출이 즉시 반영
        setUserMidCategories(list.filter(x => x.is_active).map(x => ({ code: x.code, name: x.name })));
      })
      .catch(e => showMsg('err', e.message ?? '불러오기 실패'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setForm({ name: '', major: 'MEDICAL', is_active: true }); setEditing(null); setModal('create'); };
  const openEdit = (r: UserMid) => { setForm({ name: r.name, major: r.major, is_active: r.is_active }); setEditing(r); setModal('edit'); };
  const closeModal = () => { setModal(null); setEditing(null); };

  const handleSubmit = async () => {
    if (!form.name.trim()) { showMsg('err', '중분류명은 필수입니다.'); return; }
    setSubmitting(true);
    try {
      if (modal === 'create') {
        await api('/item-categories', { method: 'POST', body: JSON.stringify({ name: form.name.trim(), major: form.major }) });
        showMsg('ok', '중분류가 추가되었습니다.');
      } else if (editing) {
        await api(`/item-categories/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: form.name.trim(), is_active: form.is_active }),
        });
        showMsg('ok', '수정되었습니다.');
      }
      closeModal(); load();
    } catch (e: any) {
      showMsg('err', e.message ?? '오류가 발생했습니다.');
    } finally { setSubmitting(false); }
  };

  const doDelete = async (r: UserMid, target?: string) => {
    try {
      await api(`/item-categories/${r.id}`, {
        method: 'DELETE',
        ...(target ? { body: JSON.stringify({ move_to: target }) } : {}),
      });
      showMsg('ok', target ? `품목을 이동하고 "${r.name}" 분류를 삭제했습니다.` : '삭제되었습니다.');
      setMoveTarget(null); setMoveTo(''); load();
    } catch (e: any) { showMsg('err', e.message ?? '삭제 실패'); }
  };

  const handleDelete = (r: UserMid) => {
    if (r.item_count > 0) {
      // 등록된 품목이 있으면 → 어디로 옮길지 먼저 선택
      setMoveTarget(r); setMoveTo('');
      return;
    }
    if (!confirm(`중분류 "${r.name}" 을(를) 삭제하시겠습니까?`)) return;
    doDelete(r);
  };

  // 이동 대상 후보 — 기본 분류 전체 + 다른 사용자 중분류 (삭제 대상 제외)
  const moveOptions = useMemo(() => {
    if (!moveTarget) return [];
    const byMajor = new Map<MajorGroup, { value: string; label: string }[]>();
    const push = (mj: MajorGroup, value: string, label: string) => {
      const arr = byMajor.get(mj) ?? []; arr.push({ value, label }); byMajor.set(mj, arr);
    };
    for (const f of FIXED) push(f.major, f.value, f.label);
    for (const u of rows) if (u.code !== moveTarget.code) push(u.major, u.code, `${u.name} (사용자)`);
    return MAJOR_ORDER
      .filter(mj => byMajor.has(mj))
      .map(mj => ({ major: mj, label: MAJOR_GROUP_LABEL[mj], items: byMajor.get(mj)! }));
  }, [moveTarget, rows]);

  const userByMajor = useMemo(() => {
    const m = new Map<MajorGroup, UserMid[]>();
    for (const r of rows) { const arr = m.get(r.major) ?? []; arr.push(r); m.set(r.major, arr); }
    return m;
  }, [rows]);

  const fixedByMajor = useMemo(() => {
    const m = new Map<MajorGroup, { value: string; label: string }[]>();
    for (const f of FIXED) { const arr = m.get(f.major) ?? []; arr.push(f); m.set(f.major, arr); }
    return m;
  }, []);

  return (
    <div>
      <PageHeader
        icon={FolderTree}
        title="분류 관리"
        description="기본 분류는 시스템 고정(통계·코드 안정). 새 분류가 필요하면 대분류를 골라 직접 추가하세요. 추가한 분류는 품목 등록·통계에 바로 반영됩니다."
        actions={canWrite ? <button onClick={openCreate} className="btn-primary">+ 중분류 추가</button> : undefined}
      />

      {msg && (
        <div className={`mb-4 px-4 py-2.5 rounded text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="card p-0"><EmptyState message="불러오는 중..." /></div>
      ) : (
        <div className="space-y-4">
          {MAJOR_ORDER.map(mj => {
            const fixed = fixedByMajor.get(mj) ?? [];
            const userList = userByMajor.get(mj) ?? [];
            return (
              <div key={mj} className="card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="font-semibold text-slate-800">{MAJOR_GROUP_LABEL[mj]}</h3>
                  <span className="text-xs text-slate-400">기본 {fixed.length} · 사용자 {userList.length}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {fixed.map(f => (
                    <span key={f.value} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 text-xs"
                      title={`기본 분류 (고정) · ${f.value}`}>
                      <Lock className="w-3 h-3 text-slate-400" />{f.label}
                    </span>
                  ))}
                  {userList.map(u => (
                    <span key={u.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-xs">
                      <span className="font-medium">{u.name}</span>
                      <span className="text-blue-400 font-mono text-[10px]">{u.code}</span>
                      {u.item_count > 0 && <span className="text-blue-500">· 품목 {u.item_count}</span>}
                      {!u.is_active && <span className="text-slate-400">· 미사용</span>}
                      {canWrite && (
                        <>
                          <button onClick={() => openEdit(u)} className="ml-1 text-blue-500 hover:text-blue-700" title="수정"><Pencil className="w-3 h-3" /></button>
                          <button onClick={() => handleDelete(u)} className="text-red-400 hover:text-red-600" title="삭제"><Trash2 className="w-3 h-3" /></button>
                        </>
                      )}
                    </span>
                  ))}
                  {userList.length === 0 && fixed.length === 0 && (
                    <span className="text-xs text-slate-400">분류 없음</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 추가 / 수정 */}
      <Modal
        open={modal !== null}
        onClose={closeModal}
        title={modal === 'create' ? '중분류 추가' : '중분류 수정'}
        footer={
          <>
            <button onClick={closeModal} className="btn-secondary" disabled={submitting}>취소</button>
            <button onClick={handleSubmit} className="btn-primary" disabled={submitting}>{submitting ? '저장 중...' : '저장'}</button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="소속 대분류" required>
            {modal === 'edit' ? (
              <div className="input bg-slate-50 text-slate-600 cursor-not-allowed">{MAJOR_GROUP_LABEL[form.major]} <span className="text-[10px] text-slate-400">(변경 불가)</span></div>
            ) : (
              <select className="input" value={form.major} onChange={e => setForm(f => ({ ...f, major: e.target.value as MajorGroup }))}>
                {MAJOR_ORDER.map(mj => <option key={mj} value={mj}>{MAJOR_GROUP_LABEL[mj]}</option>)}
              </select>
            )}
          </FormField>
          <FormField label="중분류명" required>
            <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="예: 재활치료재료" autoFocus />
          </FormField>
          {modal === 'edit' && (
            <>
              <FormField label="코드">
                <div className="input bg-slate-50 text-slate-500 font-mono text-sm cursor-not-allowed">{editing?.code}</div>
              </FormField>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="mid_active" checked={form.is_active}
                  onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} className="w-4 h-4 rounded" />
                <label htmlFor="mid_active" className="text-sm text-slate-700 cursor-pointer">사용 (해제하면 품목 등록 목록에서 숨김)</label>
              </div>
            </>
          )}
          {modal === 'create' && (
            <p className="text-xs text-slate-500">코드는 대분류에 맞춰 자동 생성됩니다 (예: MED_U0001). 통계·품목코드는 이 대분류 기준으로 잡힙니다.</p>
          )}
        </div>
      </Modal>

      {/* 삭제 전 품목 이동 */}
      <Modal
        open={moveTarget !== null}
        onClose={() => { setMoveTarget(null); setMoveTo(''); }}
        title="분류 삭제 — 품목 이동"
        footer={
          <>
            <button onClick={() => { setMoveTarget(null); setMoveTo(''); }} className="btn-secondary">취소</button>
            <button
              onClick={() => moveTarget && moveTo && doDelete(moveTarget, moveTo)}
              disabled={!moveTo}
              className="btn-primary bg-red-600 hover:bg-red-700 disabled:opacity-50"
            >
              이동 후 삭제
            </button>
          </>
        }
      >
        {moveTarget && (
          <div className="space-y-4">
            <p className="text-sm text-slate-700">
              <b>"{moveTarget.name}"</b> 분류에 등록된 품목이 <b className="text-red-600">{moveTarget.item_count}개</b> 있습니다.
              삭제하려면 이 품목들을 옮길 다른 분류를 선택하세요.
            </p>
            <FormField label="이동할 분류" required>
              <select className="input" value={moveTo} onChange={e => setMoveTo(e.target.value)}>
                <option value="">분류 선택</option>
                {moveOptions.map(g => (
                  <optgroup key={g.major} label={g.label}>
                    {g.items.map(it => <option key={it.value} value={it.value}>{it.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </FormField>
            <p className="text-xs text-slate-500">선택한 분류로 {moveTarget.item_count}개 품목이 일괄 이동되며, 통계는 이동된 분류 기준으로 재집계됩니다.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
