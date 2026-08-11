import React, { useEffect, useMemo, useState } from 'react';
import { FolderTree, Save, RefreshCcw } from 'lucide-react';
import { api } from '../utils/api';
import { PageHeader } from '../components/ui';
import { CATEGORY_HIERARCHY, CONSUMABLE_CATEGORIES, EQUIPMENT_CATEGORIES } from '@shared/types';
import type { Item } from '@shared/types';

// "기타" 중분류 값들
const OTHER_CATEGORIES = new Set(['MED_OTHER', 'PAT_OTHER', 'STAFF_OTHER', 'FAC_OTHER', 'OFF_OTHER', 'FOOD_OTHER']);

// 소모품 + 비품 모두 포함
const ALL_CATS = [...CONSUMABLE_CATEGORIES, ...EQUIPMENT_CATEGORIES];
const CATEGORY_LABEL = Object.fromEntries(ALL_CATS.map(c => [c.value, c.label]));
const CATEGORY_GROUP = Object.fromEntries(ALL_CATS.map(c => [c.value, c.group]));

// 비품 가상 hierarchy 항목 (CATEGORY_HIERARCHY 형식과 맞춤)
const EQUIP_HIERARCHY = {
  major: 'EQUIP',
  major_label: '비품',
  mids: EQUIPMENT_CATEGORIES.map(c => ({ value: c.value, label: c.label })),
} as const;
const FULL_HIERARCHY = [...CATEGORY_HIERARCHY, EQUIP_HIERARCHY];

export default function RecategorizePage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [majorFilter, setMajorFilter] = useState<string>('');
  const [onlyOther, setOnlyOther] = useState(true); // 기본: 기타만 보기
  const [edits, setEdits] = useState<Record<string, string>>({}); // item_id → new category
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const load = () => {
    setLoading(true);
    api('/items?is_active=true')
      .then((data: Item[]) => { setItems(data); setEdits({}); })
      .catch(() => showMsg('err', '품목을 불러오지 못했습니다.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(i => {
      const curr = edits[i.id] ?? i.category;
      if (onlyOther && !OTHER_CATEGORIES.has(curr)) return false;
      if (majorFilter) {
        const group = CATEGORY_GROUP[curr];
        const majorMatch = FULL_HIERARCHY.find(m => m.major === majorFilter);
        if (!majorMatch || group !== majorMatch.major_label) return false;
      }
      if (q && !(i.name.toLowerCase().includes(q) || (i.item_code ?? '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [items, edits, search, majorFilter, onlyOther]);

  const dirtyCount = Object.entries(edits).filter(([id, v]) => {
    const orig = items.find(x => x.id === id)?.category;
    return orig && v !== orig;
  }).length;

  const setCategoryFor = (id: string, category: string) => {
    setEdits(prev => {
      const next = { ...prev };
      const orig = items.find(x => x.id === id)?.category;
      if (category === orig) delete next[id];
      else next[id] = category;
      return next;
    });
  };

  const saveAll = async () => {
    const updates = Object.entries(edits)
      .filter(([id, v]) => {
        const orig = items.find(x => x.id === id)?.category;
        return orig && v !== orig;
      })
      .map(([id, category]) => ({ id, category }));
    if (updates.length === 0) return showMsg('err', '변경사항이 없습니다.');
    if (!confirm(`${updates.length}개 품목의 분류를 저장합니다. 계속할까요?`)) return;
    setSaving(true);
    try {
      const result = await api('/items/bulk-categorize', {
        method: 'PATCH',
        body: JSON.stringify({ updates }),
      });
      showMsg('ok', `${result.updated}개 반영됨${result.errors?.length ? ` (오류 ${result.errors.length}건)` : ''}`);
      load();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setSaving(false);
    }
  };

  const resetEdits = () => {
    if (dirtyCount > 0 && !confirm(`변경사항 ${dirtyCount}건을 버리시겠습니까?`)) return;
    setEdits({});
  };

  return (
    <div>
      <PageHeader
        icon={FolderTree}
        title="품목 재분류 보정"
        description="자동 분류에서 '기타'로 빠진 품목, 또는 잘못 분류된 품목의 카테고리를 수정합니다."
      />

      {msg && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      <div className="card p-3 mb-4 flex flex-wrap items-center gap-2">
        <input
          className="input w-64 text-sm"
          placeholder="품목명 또는 코드 검색"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="input w-36 text-sm"
          value={majorFilter}
          onChange={e => setMajorFilter(e.target.value)}
        >
          <option value="">전체 대분류</option>
          {FULL_HIERARCHY.map(m => <option key={m.major} value={m.major}>{m.major_label}</option>)}
        </select>
        <label className="inline-flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer select-none">
          <input type="checkbox" checked={onlyOther} onChange={e => setOnlyOther(e.target.checked)} />
          기타(OTHER) 만 보기
        </label>
        <span className="text-xs text-slate-500 ml-auto">총 {filtered.length}개 표시</span>
        <button onClick={resetEdits} disabled={dirtyCount === 0} className="btn-secondary text-sm inline-flex items-center gap-1">
          <RefreshCcw className="w-3.5 h-3.5" />초기화
        </button>
        <button onClick={saveAll} disabled={saving || dirtyCount === 0} className="btn-primary text-sm inline-flex items-center gap-1">
          <Save className="w-3.5 h-3.5" />
          {saving ? '저장 중...' : `저장 (${dirtyCount}건)`}
        </button>
      </div>

      <div className="card p-0 overflow-auto">
        {loading ? (
          <div className="py-16 text-center text-sm text-slate-400">로딩 중...</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-400">표시할 품목이 없습니다.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th className="w-32">품목코드</th>
                <th>품목명</th>
                <th className="w-44">현재 분류</th>
                <th className="w-72">변경할 분류</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => {
                const curr = edits[item.id] ?? item.category;
                const dirty = edits[item.id] !== undefined && edits[item.id] !== item.category;
                const isOther = OTHER_CATEGORIES.has(item.category);
                return (
                  <tr key={item.id} className={dirty ? 'bg-amber-50/60' : ''}>
                    <td className="font-mono text-xs text-gray-500">{item.item_code}</td>
                    <td className="text-sm">{item.name}</td>
                    <td className="text-xs">
                      <span className={`badge ${isOther ? 'badge-yellow' : 'badge-gray'}`}>
                        {CATEGORY_GROUP[item.category] ?? '?'} / {CATEGORY_LABEL[item.category] ?? item.category}
                      </span>
                    </td>
                    <td>
                      <select
                        className="input w-full text-xs"
                        value={curr}
                        onChange={e => setCategoryFor(item.id, e.target.value)}
                      >
                        {FULL_HIERARCHY.map(major => (
                          <optgroup key={major.major} label={major.major_label}>
                            {major.mids.map(mid => (
                              <option key={mid.value} value={mid.value}>
                                {mid.label}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
