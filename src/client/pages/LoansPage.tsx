import { useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, Save, RotateCcw, Search, XCircle, ImageIcon, List, Plus } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { PageHeader, EmptyState } from '../components/ui';
import type { DepartmentLoan, Item } from '@shared/types';
import { CATEGORY_HIERARCHY, CONSUMABLE_CATEGORIES } from '@shared/types';

const fmt = (n: number | null | undefined) => new Intl.NumberFormat('ko-KR').format(Number(n ?? 0));
const today = () => new Date().toISOString().slice(0, 10);

const HIERARCHY = CATEGORY_HIERARCHY.map(major => ({
  label: major.major_label,
  major: major.major,
  subs: major.mids.map(m => ({ label: m.label, value: m.value })),
}));

interface DeptLite { id: string; name: string }

export default function LoansPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<'register' | 'history'>('register');

  // 공통
  const [items, setItems] = useState<Item[]>([]);
  const [stocks, setStocks] = useState<Record<string, number>>({}); // 내 부서 보유
  const [depts, setDepts] = useState<DeptLite[]>([]);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // 등록 탭
  const [toDeptId, setToDeptId] = useState('');
  const [counts, setCounts] = useState<Record<string, string>>({}); // 카드별 빌려줄 수량
  const [itemSearch, setItemSearch] = useState('');
  const [majorCat, setMajorCat] = useState<string | null>(null);
  const [subCat, setSubCat] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 이력 탭
  const [rows, setRows] = useState<DepartmentLoan[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [histLoading, setHistLoading] = useState(true);
  const [histSearch, setHistSearch] = useState('');

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4000);
  };

  // 데이터 로드
  const loadAll = () => {
    api('/items?is_active=true').then(setItems).catch(() => {});
    api('/inventory/snapshot').then((r: any) => setStocks(r?.stocks ?? {})).catch(() => setStocks({}));
    api('/departments').then((d: any[]) => setDepts(Array.isArray(d) ? d : [])).catch(() => setDepts([]));
    loadHistory();
  };
  const loadHistory = () => {
    setHistLoading(true);
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    api(`/loans${params.toString() ? `?${params}` : ''}`)
      .then(setRows)
      .catch(() => showMsg('err', '이력 조회 실패'))
      .finally(() => setHistLoading(false));
  };
  useEffect(() => { loadAll(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { loadHistory(); /* eslint-disable-next-line */ }, [statusFilter]);

  // 보유 품목만 (소모품 카테고리, 재고 > 0)
  const consumableValues = useMemo(() => new Set<string>(CONSUMABLE_CATEGORIES.map(c => c.value)), []);
  const myItems = useMemo(
    () => items.filter(i => consumableValues.has(i.category ?? '') && (stocks[i.id] ?? 0) > 0),
    [items, consumableValues, stocks],
  );

  const searchQuery = itemSearch.trim().toLowerCase();
  const hasSearch = searchQuery.length > 0;
  const matchesSearch = (item: Item) => !hasSearch
    || item.name.toLowerCase().includes(searchQuery)
    || (item.item_code ?? '').toLowerCase().includes(searchQuery);

  const visibleItems = useMemo(() => {
    let pool = myItems;
    if (hasSearch) pool = pool.filter(matchesSearch);
    else if (subCat) pool = pool.filter(i => i.category === subCat);
    return [...pool].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [myItems, hasSearch, subCat, searchQuery]);

  const currentSubs = HIERARCHY.find(g => g.label === majorCat)?.subs ?? [];
  const clickMajor = (label: string) => { setMajorCat(prev => prev === label ? null : label); setSubCat(null); };
  const clickSub = (value: string) => { setSubCat(prev => prev === value ? null : value); };

  // pending: 입력값 있고 0보다 크고 보유재고 이하인 것
  const pending = useMemo(() => {
    const list: Array<{ item_id: string; item_name: string; qty: number; stock: number; over: boolean }> = [];
    for (const [itemId, v] of Object.entries(counts)) {
      if (v === '' || v === undefined) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      const stock = stocks[itemId] ?? 0;
      const item = items.find(i => i.id === itemId);
      list.push({ item_id: itemId, item_name: item?.name ?? '', qty: n, stock, over: n > stock });
    }
    return list;
  }, [counts, stocks, items]);

  const overItems = pending.filter(p => p.over);
  const targetDept = depts.find(d => d.id === toDeptId);

  const setQtyFor = (itemId: string, value: string) => {
    setCounts(prev => ({ ...prev, [itemId]: value }));
  };

  const resetAll = () => {
    if (pending.length === 0) return;
    if (!confirm(`입력 ${pending.length}건을 모두 초기화하시겠습니까?`)) return;
    setCounts({});
  };

  const saveAll = async () => {
    if (!toDeptId) return showMsg('err', '빌려줄 부서를 선택하세요.');
    if (toDeptId === user?.department_id) return showMsg('err', '자기 부서에 대여할 수 없습니다.');
    if (pending.length === 0) return showMsg('err', '대여할 품목이 없습니다.');
    if (overItems.length > 0) return showMsg('err', `재고를 초과한 품목 ${overItems.length}건이 있습니다. 수량을 확인하세요.`);
    if (!confirm(`${targetDept?.name}에 ${pending.length}개 품목을 대여 등록합니다. 계속할까요?`)) return;
    setSaving(true);
    try {
      const result = await api('/loans/batch', {
        method: 'POST',
        body: JSON.stringify({
          from_department_id: user?.department_id,
          to_department_id: toDeptId,
          loaned_at: today(),
          items: pending.map(p => ({ item_id: p.item_id, qty: p.qty })),
        }),
      });
      showMsg('ok', `${result.created}건 대여 등록${result.errors?.length ? ` (오류 ${result.errors.length})` : ''}`);
      setCounts({});
      setToDeptId('');
      loadAll();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setSaving(false);
    }
  };

  const reverseLoan = async (id: string) => {
    if (!confirm('이 대여를 역전(반납)하시겠습니까? 재고가 원래 부서로 돌아갑니다.')) return;
    try {
      await api(`/loans/${id}/reverse`, { method: 'POST', body: JSON.stringify({}) });
      showMsg('ok', '역전되었습니다.');
      loadAll();
    } catch (e: any) {
      showMsg('err', e.message);
    }
  };

  const visibleHistory = useMemo(() => {
    const q = histSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      (r.item_name ?? '').toLowerCase().includes(q) ||
      (r.item_code ?? '').toLowerCase().includes(q) ||
      (r.from_department_name ?? '').toLowerCase().includes(q) ||
      (r.to_department_name ?? '').toLowerCase().includes(q) ||
      (r.note ?? '').toLowerCase().includes(q)
    );
  }, [rows, histSearch]);

  return (
    <div>
      <PageHeader
        icon={ArrowLeftRight}
        title="부서간 대여"
        description="내 부서가 보유한 품목을 다른 부서에 빌려줄 때 한 번에 등록합니다."
      />

      {/* 탭 */}
      <div className="flex border-b border-gray-200 mb-4">
        <button
          onClick={() => setTab('register')}
          className={`inline-flex items-center gap-1.5 px-6 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === 'register' ? 'border-teal-500 text-teal-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          <Plus className="w-4 h-4" />대여 등록
        </button>
        <button
          onClick={() => setTab('history')}
          className={`inline-flex items-center gap-1.5 px-6 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === 'history' ? 'border-teal-500 text-teal-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          <List className="w-4 h-4" />대여 이력
        </button>
      </div>

      {msg && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {tab === 'register' && (
        <div className="space-y-3">
          {/* 상단: 빌려줄 부서 + 검색 */}
          <div className="card p-3 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-sm font-semibold text-slate-600 whitespace-nowrap">빌려줄 부서</span>
              <select
                className="input text-sm w-44"
                value={toDeptId}
                onChange={e => setToDeptId(e.target.value)}
              >
                <option value="">— 선택 —</option>
                {depts.filter(d => d.id !== user?.department_id).map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={itemSearch}
                onChange={e => setItemSearch(e.target.value)}
                placeholder="품목명 또는 코드 검색"
                className="input w-full pl-9 pr-24 text-sm"
              />
              {itemSearch && (
                <button onClick={() => setItemSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600 inline-flex items-center gap-0.5">
                  <XCircle className="w-3.5 h-3.5" />지우기
                </button>
              )}
            </div>
            <span className="text-xs text-slate-500 whitespace-nowrap shrink-0">보유 {myItems.length}개</span>
          </div>

          {/* 사이드바 + 카드 그리드 */}
          <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-3 items-start">
            {!hasSearch && (
              <aside className="card p-3 space-y-2 md:sticky md:top-4 md:max-h-[calc(100vh-100px)] md:overflow-y-auto">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">카테고리</p>
                {HIERARCHY.map(g => {
                  const totalCount = g.subs.reduce((acc, s) => acc + myItems.filter(i => i.category === s.value).length, 0);
                  const isActive = majorCat === g.label;
                  if (totalCount === 0) return null;
                  return (
                    <div key={g.label}>
                      <button
                        onClick={() => clickMajor(g.label)}
                        className={`w-full text-left px-2.5 py-1.5 rounded-md text-sm font-medium transition-colors ${isActive ? 'bg-teal-50 text-teal-700' : 'text-slate-700 hover:bg-slate-50'}`}
                      >
                        {g.label}
                        <span className="ml-1 text-[10px] text-slate-400">({totalCount})</span>
                      </button>
                      {g.subs.length > 0 && (
                        <div className="mt-1 ml-2 space-y-0.5">
                          {g.subs.map(s => {
                            const cnt = myItems.filter(i => i.category === s.value).length;
                            if (cnt === 0) return null;
                            const isSub = subCat === s.value;
                            return (
                              <button
                                key={s.value}
                                onClick={() => clickSub(s.value)}
                                className={`w-full text-left px-2 py-1 rounded text-xs transition-colors ${isSub ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                              >
                                {s.label}
                                <span className={`ml-1 text-[10px] ${isSub ? 'text-teal-100' : 'text-slate-400'}`}>({cnt})</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {(majorCat || subCat) && (
                  <button onClick={() => { setMajorCat(null); setSubCat(null); }} className="w-full text-left px-2 py-1 rounded text-xs text-slate-400 hover:text-slate-600 mt-2 border-t border-gray-100 pt-2">
                    ↺ 전체 보기
                  </button>
                )}
              </aside>
            )}

            <div className="card p-3 min-h-[200px]" style={hasSearch ? { gridColumn: '1 / -1' } : undefined}>
              {visibleItems.length === 0 ? (
                <EmptyState message={hasSearch ? '검색 결과가 없습니다' : '보유 중인 품목이 없습니다.'} />
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                  {visibleItems.map(item => (
                    <LendCard
                      key={item.id}
                      item={item}
                      stock={stocks[item.id] ?? 0}
                      value={counts[item.id] ?? ''}
                      onChange={v => setQtyFor(item.id, v)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 하단 sticky 저장 바 */}
          <div className="sticky bottom-0 z-20 shadow-[0_-4px_12px_-4px_rgba(0,0,0,0.08)] flex flex-wrap items-center justify-between gap-3 p-4 bg-white rounded-xl border border-gray-200">
            <span className="text-sm text-gray-500 inline-flex items-center gap-2 flex-wrap">
              <ArrowLeftRight className="w-4 h-4 text-teal-500" />
              {targetDept ? <span className="text-slate-700"><b>{targetDept.name}</b> 에 </span> : <span className="text-amber-600">빌려줄 부서를 먼저 선택하세요</span>}
              <span className="font-semibold text-teal-600">{pending.length}개 품목</span>
              {overItems.length > 0 && <span className="text-xs text-red-600">⚠ 재고 초과 {overItems.length}건</span>}
              {pending.length > 0 && (
                <button onClick={resetAll} className="ml-3 text-xs text-gray-400 hover:text-red-500 underline inline-flex items-center gap-0.5">
                  <RotateCcw className="w-3 h-3" />초기화
                </button>
              )}
            </span>
            <button
              onClick={saveAll}
              disabled={saving || !toDeptId || pending.length === 0 || overItems.length > 0}
              className="btn-primary inline-flex items-center gap-1.5"
            >
              <Save className="w-4 h-4" />{saving ? '저장 중...' : `대여 등록 (${pending.length}건)`}
            </button>
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div>
          <div className="card p-3 mb-4 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                className="input w-full pl-9 text-sm"
                placeholder="품목/부서/사유 검색"
                value={histSearch}
                onChange={e => setHistSearch(e.target.value)}
              />
            </div>
            <select className="input text-sm w-32 shrink-0" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">전체 상태</option>
              <option value="ACTIVE">진행</option>
              <option value="REVERSED">역전</option>
            </select>
          </div>

          <div className="card p-0 overflow-auto">
            {histLoading ? (
              <div className="py-12 text-center text-sm text-slate-400">불러오는 중...</div>
            ) : visibleHistory.length === 0 ? (
              <EmptyState message="등록 내역이 없습니다." />
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>대여일</th>
                    <th>빌려준 부서</th>
                    <th>빌린 부서</th>
                    <th>품목</th>
                    <th className="text-right">수량</th>
                    <th>상태</th>
                    <th>사유</th>
                    <th>등록자</th>
                    <th className="w-16">처리</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleHistory.map(r => (
                    <tr key={r.id}>
                      <td className="text-xs text-slate-500">{String(r.loaned_at).slice(0, 10)}</td>
                      <td className="text-xs">{r.from_department_name || r.from_department_id}</td>
                      <td className="text-xs font-semibold">{r.to_department_name || r.to_department_id}</td>
                      <td>
                        <div className="text-sm font-medium text-slate-800">{r.item_name ?? '(품목)'}</div>
                        <div className="text-[10px] text-slate-400 font-mono">{r.item_code ?? ''}</div>
                      </td>
                      <td className="text-right text-sm font-semibold text-slate-800">{fmt(r.qty)}</td>
                      <td>{r.status === 'ACTIVE' ? <span className="badge-green">진행</span> : <span className="badge-gray">역전</span>}</td>
                      <td className="text-xs text-slate-500 max-w-[200px] truncate">{r.note || '-'}</td>
                      <td className="text-xs text-slate-400">{(r as any).creator_name ?? '-'}</td>
                      <td>
                        {r.status === 'ACTIVE' && (
                          <button onClick={() => reverseLoan(r.id)} className="btn-ghost text-xs text-red-500 hover:bg-red-50 inline-flex items-center gap-0.5 px-2 py-1">
                            <RotateCcw className="w-3.5 h-3.5" />역전
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 카드 컴포넌트 ─────────────────────────────────────────────────────────
function LendCard({ item, stock, value, onChange }: {
  item: Item;
  stock: number;
  value: string;
  onChange: (v: string) => void;
}) {
  const qty = value === '' ? null : Number(value);
  const valid = qty != null && Number.isFinite(qty) && qty > 0;
  const over = valid && qty > stock;
  const has = valid && qty > 0;

  return (
    <div className={`border rounded-xl p-2.5 flex flex-col gap-2 transition-colors ${over ? 'border-red-400 bg-red-50/40' : has ? 'border-teal-400 bg-teal-50/40' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
      {/* 이미지 */}
      <div className="aspect-square w-full bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-center overflow-hidden">
        {item.image_url ? (
          <img src={item.image_url} alt={item.name} loading="lazy" className="w-full h-full object-contain" />
        ) : (
          <div className="flex flex-col items-center text-slate-300">
            <ImageIcon className="w-8 h-8" />
            <span className="text-[9px] mt-1">이미지 준비 중</span>
          </div>
        )}
      </div>
      {/* 이름 + 코드 */}
      <div className="min-h-[2.5rem]">
        <p className="text-[11px] text-slate-400 font-mono truncate">{item.item_code}</p>
        <p className="text-xs font-medium text-slate-800 line-clamp-2 leading-tight">{item.name}</p>
      </div>
      {/* 보유 재고 */}
      <div className="text-[10px] text-slate-500 flex items-center justify-between">
        <span>보유 <b className="text-slate-700">{new Intl.NumberFormat('ko-KR').format(stock)}</b>{item.uom && <span className="text-slate-300 ml-1">{item.uom}</span>}</span>
        {over && <span className="text-[10px] text-red-600 font-semibold">초과!</span>}
      </div>
      {/* 빌려줄 수량 */}
      <div className="mt-auto">
        <input
          type="number"
          min="0"
          max={stock}
          value={value}
          placeholder={`빌려줄 ${item.uom ?? 'EA'}`}
          onChange={e => onChange(e.target.value)}
          className="input w-full text-center text-base font-bold h-10"
          style={over ? { borderColor: '#ef4444', background: '#fef2f2' } : has ? { borderColor: '#14b8a6', background: '#f0fdfa' } : {}}
        />
      </div>
    </div>
  );
}
