import React, { useEffect, useState, useCallback } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../utils/api';
import { PageHeader } from '../components/ui';
import { ALL_CATEGORIES, CONSUMABLE_CATEGORIES, EQUIPMENT_CATEGORIES } from '@shared/types';

type CatValue = string;

interface DeptPerm {
  department_id: string;
  department_name: string;
  parent_id: string | null;
  categories: CatValue[];
}

function sortDepts(depts: DeptPerm[]): DeptPerm[] {
  const parents = depts.filter(d => !d.parent_id);
  const children = depts.filter(d => d.parent_id);
  const result: DeptPerm[] = [];
  for (const p of parents) {
    result.push(p);
    result.push(...children.filter(c => c.parent_id === p.department_id));
  }
  for (const c of children) {
    if (!parents.find(p => p.department_id === c.parent_id)) result.push(c);
  }
  return result;
}

const ALL_CAT_VALUES = ALL_CATEGORIES.map(c => c.value);
const CONSUMABLE_VALUES = CONSUMABLE_CATEGORIES.map(c => c.value);
const EQUIPMENT_VALUES = EQUIPMENT_CATEGORIES.map(c => c.value);

export default function DeptCategoryPage() {
  const [depts, setDepts] = useState<DeptPerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [edits, setEdits] = useState<Record<string, Set<CatValue>>>({});

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3000);
  };

  const load = useCallback(() => {
    setLoading(true);
    api('/dept-permissions')
      .then((data: DeptPerm[]) => {
        const sorted = sortDepts(data);
        setDepts(sorted);
        const init: Record<string, Set<CatValue>> = {};
        for (const d of sorted) init[d.department_id] = new Set(d.categories);
        setEdits(init);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (dept_id: string, cat: CatValue) => {
    setEdits(prev => {
      const s = new Set(prev[dept_id] ?? []);
      if (s.has(cat)) s.delete(cat); else s.add(cat);
      return { ...prev, [dept_id]: s };
    });
  };

  const toggleGroup = (dept_id: string, group: CatValue[], all: boolean) => {
    setEdits(prev => {
      const s = new Set(prev[dept_id] ?? []);
      if (all) group.forEach(v => s.delete(v));
      else group.forEach(v => s.add(v));
      return { ...prev, [dept_id]: s };
    });
  };

  const setAll = (dept_id: string, checked: boolean) => {
    setEdits(prev => ({
      ...prev,
      [dept_id]: checked ? new Set(ALL_CAT_VALUES) : new Set(),
    }));
  };

  const save = async (dept_id: string) => {
    setSaving(dept_id);
    try {
      const categories = Array.from(edits[dept_id] ?? []);
      await api(`/dept-permissions/${dept_id}`, { method: 'PUT', body: JSON.stringify({ categories }) });
      showMsg('ok', '저장되었습니다.');
      setDepts(prev => prev.map(d => d.department_id === dept_id ? { ...d, categories } : d));
    } catch (e: any) {
      showMsg('err', e.message ?? '오류가 발생했습니다.');
    } finally {
      setSaving(null);
    }
  };

  const isDirty = (d: DeptPerm) => {
    const cur = edits[d.department_id] ?? new Set();
    if (cur.size !== d.categories.length) return true;
    return d.categories.some(c => !cur.has(c));
  };

  return (
    <div>
      <PageHeader
        icon={ShieldCheck}
        title="품목 신청 권한"
        description="부서별로 신청 가능한 품목 카테고리를 설정합니다. 항목이 없으면 전체 허용(기본값)."
      />

      {msg && (
        <div className={`mb-4 px-4 py-2 rounded-lg text-sm font-medium ${msg.type === 'ok' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 text-sm">로딩 중...</div>
      ) : depts.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-slate-400 text-sm">등록된 부서가 없습니다.</div>
      ) : (
        <div className="space-y-3">
          {depts.map(d => {
            const cats = edits[d.department_id] ?? new Set<CatValue>();
            const dirty = isDirty(d);
            const isSaving = saving === d.department_id;
            const isChild = !!d.parent_id;
            const allConsumable = CONSUMABLE_VALUES.every(v => cats.has(v));
            const anyConsumable = CONSUMABLE_VALUES.some(v => cats.has(v));
            const allEquipment = EQUIPMENT_VALUES.every(v => cats.has(v));
            const anyEquipment = EQUIPMENT_VALUES.some(v => cats.has(v));
            const allAll = ALL_CAT_VALUES.every(v => cats.has(v));

            return (
              <div key={d.department_id} className={`card ${dirty ? 'border-amber-300 bg-amber-50/30' : ''}`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-32">
                    <p className={`font-semibold text-sm ${isChild ? 'text-slate-600 pl-3' : 'text-slate-900'}`}>
                      {isChild && <span className="text-slate-300 mr-1">└</span>}
                      {d.department_name}
                    </p>
                    <div className="flex gap-2 mt-1">
                      <label className="flex items-center gap-1 text-xs text-slate-400 cursor-pointer">
                        <input type="checkbox" checked={allAll} onChange={e => setAll(d.department_id, e.target.checked)} className="accent-teal-500" />
                        전체
                      </label>
                    </div>
                  </div>

                  <div className="flex-1 space-y-2">
                    {/* 소모품 그룹 */}
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <label className="flex items-center gap-1 text-xs font-semibold text-blue-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={allConsumable}
                            ref={el => { if (el) el.indeterminate = anyConsumable && !allConsumable; }}
                            onChange={() => toggleGroup(d.department_id, CONSUMABLE_VALUES, allConsumable)}
                            className="accent-blue-500"
                          />
                          소모품 전체
                        </label>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {CONSUMABLE_CATEGORIES.map(c => (
                          <label key={c.value} className="flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs cursor-pointer transition-colors"
                            style={{
                              background: cats.has(c.value) ? '#dbeafe' : 'white',
                              borderColor: cats.has(c.value) ? '#3b82f6' : '#e5e7eb',
                              color: cats.has(c.value) ? '#1d4ed8' : '#6b7280',
                            }}
                          >
                            <input type="checkbox" checked={cats.has(c.value)} onChange={() => toggle(d.department_id, c.value)} className="hidden" />
                            {c.label}
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* 비품 그룹 */}
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <label className="flex items-center gap-1 text-xs font-semibold text-purple-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={allEquipment}
                            ref={el => { if (el) el.indeterminate = anyEquipment && !allEquipment; }}
                            onChange={() => toggleGroup(d.department_id, EQUIPMENT_VALUES, allEquipment)}
                            className="accent-purple-500"
                          />
                          비품 전체
                        </label>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {EQUIPMENT_CATEGORIES.map(c => (
                          <label key={c.value} className="flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs cursor-pointer transition-colors"
                            style={{
                              background: cats.has(c.value) ? '#ede9fe' : 'white',
                              borderColor: cats.has(c.value) ? '#8b5cf6' : '#e5e7eb',
                              color: cats.has(c.value) ? '#6d28d9' : '#6b7280',
                            }}
                          >
                            <input type="checkbox" checked={cats.has(c.value)} onChange={() => toggle(d.department_id, c.value)} className="hidden" />
                            {c.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => save(d.department_id)}
                    disabled={isSaving || !dirty}
                    className="flex-shrink-0 text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                    style={{
                      background: dirty ? '#14b8a6' : '#e5e7eb',
                      color: dirty ? 'white' : '#9ca3af',
                      cursor: dirty ? 'pointer' : 'default',
                    }}
                  >
                    {isSaving ? '저장중' : dirty ? '저장' : '저장됨'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 text-xs text-slate-400">
        * 체크 항목이 없으면 모든 카테고리 신청 허용 (기본값). 하나 이상 체크하면 체크된 카테고리만 신청 가능.
      </p>
    </div>
  );
}
