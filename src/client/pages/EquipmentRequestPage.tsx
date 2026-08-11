import { useEffect, useMemo, useState, useCallback } from 'react';
import { Monitor, Plus, Trash2, XCircle, Search, Send, RotateCcw, Camera, ImageIcon, ClipboardList, List, Eye } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { PageHeader, EmptyState, Modal, FilterBar } from '../components/ui';
import type { Item, WardRequest } from '@shared/types';
import { EQUIPMENT_CATEGORIES } from '@shared/types';

// 비품 카테고리 계층 (대분류 → 중분류)
const EQUIPMENT_HIERARCHY = [
  { label: '의료장비', major: 'MED', subs: [
    { label: '의료기기',         value: 'EQUIP_MEDICAL' },
    { label: '의료기기 부속품',  value: 'EQUIP_ACCESSORY' },
    { label: '의료보조장비',     value: 'EQUIP_AID' },
  ]},
  { label: '일반비품', major: 'GEN', subs: [
    { label: '사무용가구', value: 'EQUIP_FURNITURE' },
    { label: '가전제품',   value: 'EQUIP_APPLIANCE' },
    { label: '생활',       value: 'EQUIP_LIVING' },
  ]},
  { label: 'IT·안전', major: 'IT', subs: [
    { label: '전산·IT장비',   value: 'EQUIP_IT' },
    { label: '안전·위생장비', value: 'EQUIP_SAFETY' },
  ]},
];

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (n: number | null | undefined) => new Intl.NumberFormat('ko-KR').format(Number(n ?? 0));

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '임시저장', SUBMITTED: '제출됨', APPROVED: '승인됨',
  PARTIAL_APPROVED: '일부승인', REJECTED: '반려됨', CANCELLED: '취소됨',
};
const STATUS_CLS: Record<string, string> = {
  DRAFT: 'badge-gray', SUBMITTED: 'badge-blue', APPROVED: 'badge-green',
  PARTIAL_APPROVED: 'badge-yellow', REJECTED: 'badge-red', CANCELLED: 'badge-gray',
};

// 신청 유형
const REQ_TYPES = [
  { value: 'ADDITION', label: '추가 신청', desc: '신규 비품 도입', color: 'bg-blue-500', light: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-300' },
  { value: 'DISPOSAL', label: '폐기 신청', desc: '보유 비품 폐기', color: 'bg-red-500',  light: 'bg-red-50',  text: 'text-red-700',  border: 'border-red-300' },
] as const;
type ReqType = typeof REQ_TYPES[number]['value'];

const REASON_PRESETS: Record<string, string[]> = {
  DISPOSAL: ['노후 (사용연한 경과)', '파손', '고장수리불가', '분실', '오염/위생문제', '규격·모델 변경', '과다보유 정리'],
  ADDITION: ['신규 필요', '인원 증가', '병상 증가', '폐기 대체', '수량 부족', '시범 도입', '시설 확장'],
};

interface CartItem {
  item_id: string;
  item_name: string;
  item_code: string;
  qty: number;
  reason: string;
  attachments: string[];
}

export default function EquipmentRequestPage() {
  const { user, hasPerm } = useAuth();
  const canCreate  = hasPerm('REQUEST_USE');
  const canViewAll = hasPerm('PURCHASE_MANAGE');

  const [pageTab, setPageTab] = useState<'create' | 'list'>(canCreate ? 'create' : 'list');

  // ── 신청현황 탭 ───────────────────────────────────────────
  const [requests, setRequests]         = useState<WardRequest[]>([]);
  const [loadingList, setLoadingList]   = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [detail, setDetail]             = useState<WardRequest | null>(null);
  const [detailOpen, setDetailOpen]     = useState(false);

  // ── 신청 작성 탭 ──────────────────────────────────────────
  const [reqType, setReqType] = useState<ReqType>('ADDITION');
  const [items, setItems]     = useState<Item[]>([]);
  const [stocks, setStocks]   = useState<Record<string, number>>({});
  const [majorCat, setMajorCat] = useState<string | null>(null);
  const [subCat, setSubCat]     = useState<string | null>(null);
  const [search, setSearch]     = useState('');
  const [cart, setCart]         = useState<CartItem[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const showMsg = (t: 'ok'|'err', m: string) => { setMsg({type:t, text:m}); setTimeout(() => setMsg(null), 3500); };

  // 카드 클릭 → 신청 모달
  const [editCart, setEditCart] = useState<CartItem | null>(null);
  const [editIsNew, setEditIsNew] = useState(false);
  const [uploading, setUploading] = useState(false);

  // ── 데이터 로드 ───────────────────────────────────────────
  const loadList = useCallback(() => {
    setLoadingList(true);
    const p = new URLSearchParams();
    p.set('type', 'EQUIPMENT');
    if (filterStatus) p.set('status', filterStatus);
    api(`/ward-requests?${p}`).then(setRequests).catch(console.error).finally(() => setLoadingList(false));
  }, [filterStatus]);
  useEffect(() => { loadList(); }, [loadList]);

  const loadItemsAndStock = useCallback(() => {
    if (!canCreate) return;
    const equipCatValues = EQUIPMENT_CATEGORIES.map(c => c.value);
    Promise.all([
      api('/items?is_active=true'),
      api('/dept-permissions/my-items').catch(() => ({ item_ids: null })),
      api('/inventory/snapshot').catch(() => ({ stocks: {} })),
    ]).then(([allItems, permData, stockData]) => {
      const item_ids: string[] | null = permData?.item_ids ?? null;
      const equipItems: Item[] = allItems.filter((i: any) => equipCatValues.includes(i.category ?? ''));
      // null = 무제한 허용, 배열 = 그 목록만 (빈 배열도 "0개 보임"의 정상 의미)
      const filtered = item_ids === null
        ? equipItems
        : equipItems.filter(i => item_ids.includes(i.id));
      setItems(filtered);
      setStocks(stockData?.stocks ?? {});
    }).catch(() => {});
  }, [canCreate]);
  useEffect(() => { loadItemsAndStock(); }, [loadItemsAndStock]);

  // ── 모드 변경 시 장바구니 비우기 ──────────────────────────
  const switchType = (t: ReqType) => {
    if (t === reqType) return;
    if (cart.length > 0 && !confirm('장바구니가 초기화됩니다. 계속할까요?')) return;
    setReqType(t);
    setCart([]);
    setMajorCat(null);
    setSubCat(null);
    setSearch('');
  };

  // ── 표시할 품목 필터링 ────────────────────────────────────
  // 추가 모드: 모든 EQUIP_* (마스터)
  // 폐기 모드: 보유한 EQUIP_* (재고 > 0)
  const baseItems = useMemo(() => {
    if (reqType === 'DISPOSAL') return items.filter(i => (stocks[i.id] ?? 0) > 0);
    return items;
  }, [items, stocks, reqType]);

  const searchQuery = search.trim().toLowerCase();
  const hasSearch = searchQuery.length > 0;
  const matchesSearch = (i: Item) => !hasSearch
    || i.name.toLowerCase().includes(searchQuery)
    || (i.item_code ?? '').toLowerCase().includes(searchQuery);

  const visibleItems = useMemo(() => {
    let pool = baseItems;
    if (hasSearch) pool = pool.filter(matchesSearch);
    else if (subCat) pool = pool.filter(i => i.category === subCat);
    return [...pool].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [baseItems, hasSearch, subCat, searchQuery]);

  const currentSubs = EQUIPMENT_HIERARCHY.find(g => g.label === majorCat)?.subs ?? [];

  // ── 카드 클릭 → 모달 열기 ─────────────────────────────────
  const openAddCart = (item: Item) => {
    const existing = cart.find(c => c.item_id === item.id);
    if (existing) {
      setEditCart({ ...existing });
      setEditIsNew(false);
    } else {
      setEditCart({
        item_id: item.id,
        item_name: item.name,
        item_code: item.item_code,
        qty: 1,
        reason: '',
        attachments: [],
      });
      setEditIsNew(true);
    }
  };

  const saveCart = () => {
    if (!editCart) return;
    if (editCart.qty <= 0) return showMsg('err', '수량은 1 이상이어야 합니다.');
    if (reqType === 'DISPOSAL' && editCart.attachments.length === 0) {
      if (!confirm('폐기 신청은 사진 첨부가 권장됩니다. 사진 없이 저장하시겠습니까?')) return;
    }
    setCart(prev => {
      const idx = prev.findIndex(c => c.item_id === editCart.item_id);
      if (idx >= 0) {
        const next = [...prev]; next[idx] = editCart; return next;
      }
      return [...prev, editCart];
    });
    setEditCart(null);
  };

  const removeFromCart = (item_id: string) => {
    setCart(prev => prev.filter(c => c.item_id !== item_id));
  };

  // ── 사진 업로드 (모달 안) ─────────────────────────────────
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!editCart) return;
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const newUrls: string[] = [];
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', file);
        const res = await api('/ward-requests/upload-attachment', { method: 'POST', body: fd });
        newUrls.push(res.url);
      }
      setEditCart(prev => prev ? { ...prev, attachments: [...prev.attachments, ...newUrls] } : prev);
    } catch (err: any) { showMsg('err', err.message || '업로드 실패'); }
    finally { setUploading(false); e.target.value = ''; }
  };

  const removeAttachment = (url: string) => {
    if (!editCart) return;
    setEditCart({ ...editCart, attachments: editCart.attachments.filter(u => u !== url) });
    api('/ward-requests/delete-attachment', { method: 'DELETE', body: JSON.stringify({ url }) }).catch(() => {});
  };

  // ── 제출 ──────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (cart.length === 0) return showMsg('err', '장바구니에 품목이 없습니다.');
    setSubmitting(true);
    try {
      // 모든 사진 url 모음
      const allAttachments = Array.from(new Set(cart.flatMap(c => c.attachments)));
      // 각 item 의 사유와 사진 url을 note 에 JSON 으로 저장
      const itemsToSubmit = cart.map(c => ({
        item_id: c.item_id,
        requested_qty: c.qty,
        note: JSON.stringify({ reason: c.reason, attachments: c.attachments }),
      }));
      const created = await api('/ward-requests', {
        method: 'POST',
        body: JSON.stringify({
          period_type: 'MONTHLY',
          period_start: today(),
          period_end: today(),
          request_type: 'EQUIPMENT',
          equipment_request_type: reqType,
          attachment_urls: allAttachments,
          items: itemsToSubmit,
        }),
      });
      await api(`/ward-requests/${created.id}/submit`, { method: 'POST' });
      showMsg('ok', '비품 신청이 제출되었습니다.');
      setCart([]);
      setMajorCat(null); setSubCat(null); setSearch('');
      setPageTab('list');
      loadList();
      loadItemsAndStock();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── 신청 상세 ─────────────────────────────────────────────
  const openDetail = async (id: string) => {
    try {
      const d = await api(`/ward-requests/${id}`);
      setDetail(d);
      setDetailOpen(true);
    } catch (e: any) { showMsg('err', e.message); }
  };

  const cur = REQ_TYPES.find(t => t.value === reqType)!;

  return (
    <div>
      <PageHeader
        icon={Monitor}
        title="비품 신청"
        description={canViewAll ? '전체 비품 신청 현황 관리' : `${user?.department_name} 비품 신청·이력`}
      />

      {/* 페이지 탭 */}
      <div className="flex border-b border-gray-200 mb-5">
        {canCreate && (
          <button
            onClick={() => setPageTab('create')}
            className={`inline-flex items-center gap-1.5 px-6 py-2.5 text-sm font-medium border-b-2 ${pageTab === 'create' ? 'border-purple-500 text-purple-700' : 'border-transparent text-gray-500'}`}
          >
            <ClipboardList className="w-4 h-4" />비품 신청
          </button>
        )}
        <button
          onClick={() => setPageTab('list')}
          className={`inline-flex items-center gap-1.5 px-6 py-2.5 text-sm font-medium border-b-2 ${pageTab === 'list' ? 'border-purple-500 text-purple-700' : 'border-transparent text-gray-500'}`}
        >
          <List className="w-4 h-4" />신청현황
        </button>
      </div>

      {msg && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {/* ============ 비품 신청 탭 ============ */}
      {pageTab === 'create' && canCreate && (
        <div className="space-y-3">
          {/* 신청 유형 선택 */}
          <div className="card p-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-500 mr-1">신청 유형</span>
            <div className="inline-flex gap-2">
              {REQ_TYPES.map(t => {
                const isActive = reqType === t.value;
                return (
                  <button
                    key={t.value}
                    onClick={() => switchType(t.value)}
                    className={`px-4 py-2 rounded-lg border-2 text-sm font-semibold transition-colors ${isActive ? `${t.color} text-white ${t.border}` : `${t.light} ${t.text} ${t.border}`}`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
            <span className="text-xs text-slate-500 ml-2">{cur.desc}</span>
            <span className="ml-auto text-xs text-slate-500">
              {reqType === 'DISPOSAL' ? '보유 비품' : '신청 가능 품목'} <b>{baseItems.length}</b>개
            </span>
          </div>

          {/* 검색 */}
          <div className="card p-3">
            <div className="relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="비품명 또는 코드 검색"
                className="input w-full pl-9 pr-24 text-sm"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600 inline-flex items-center gap-0.5">
                  <XCircle className="w-3.5 h-3.5" />지우기
                </button>
              )}
            </div>
          </div>

          {/* 사이드바 + 카드 */}
          <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-3 items-start">
            {!hasSearch && (
              <aside className="card p-3 space-y-2 md:sticky md:top-4 md:max-h-[calc(100vh-100px)] md:overflow-y-auto">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">카테고리</p>
                {EQUIPMENT_HIERARCHY.map(g => {
                  const totalCount = g.subs.reduce((acc, s) => acc + baseItems.filter(i => i.category === s.value).length, 0);
                  if (totalCount === 0) return null;
                  const isActive = majorCat === g.label;
                  return (
                    <div key={g.label}>
                      <button
                        onClick={() => { setMajorCat(prev => prev === g.label ? null : g.label); setSubCat(null); }}
                        className={`w-full text-left px-2.5 py-1.5 rounded-md text-sm font-medium transition-colors ${isActive ? 'bg-purple-50 text-purple-700' : 'text-slate-700 hover:bg-slate-50'}`}
                      >
                        {g.label}
                        <span className="ml-1 text-[10px] text-slate-400">({totalCount})</span>
                      </button>
                      <div className="mt-1 ml-2 space-y-0.5">
                        {g.subs.map(s => {
                          const cnt = baseItems.filter(i => i.category === s.value).length;
                          if (cnt === 0) return null;
                          const isSub = subCat === s.value;
                          return (
                            <button
                              key={s.value}
                              onClick={() => setSubCat(prev => prev === s.value ? null : s.value)}
                              className={`w-full text-left px-2 py-1 rounded text-xs ${isSub ? 'bg-purple-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                            >
                              {s.label}
                              <span className={`ml-1 text-[10px] ${isSub ? 'text-purple-100' : 'text-slate-400'}`}>({cnt})</span>
                            </button>
                          );
                        })}
                      </div>
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
                <EmptyState message={
                  hasSearch ? '검색 결과가 없습니다'
                    : reqType === 'DISPOSAL' ? '보유 중인 비품이 없습니다.'
                    : '신청 가능한 비품이 없습니다.'
                } />
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                  {visibleItems.map(item => {
                    const inCart = cart.find(c => c.item_id === item.id);
                    const stock = stocks[item.id] ?? 0;
                    return (
                      <button
                        key={item.id}
                        onClick={() => openAddCart(item)}
                        className={`text-left border-2 rounded-xl p-2.5 flex flex-col gap-2 transition ${inCart ? `${cur.border} ${cur.light}` : 'border-gray-200 bg-white hover:border-gray-400'}`}
                      >
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
                        <div className="min-h-[2.5rem]">
                          <p className="text-[10px] text-slate-400 font-mono truncate">{item.item_code}</p>
                          <p className="text-xs font-medium text-slate-800 line-clamp-2 leading-tight">{item.name}</p>
                        </div>
                        <div className="text-[10px] text-slate-500 flex items-center justify-between">
                          {reqType === 'DISPOSAL' && (
                            <span>보유 <b className="text-slate-700">{fmt(stock)}</b></span>
                          )}
                          {inCart && (
                            <span className={`ml-auto text-[10px] font-semibold ${cur.text}`}>장바구니 {inCart.qty}개</span>
                          )}
                        </div>
                        <div className={`mt-auto text-center py-1 rounded text-xs font-semibold ${inCart ? `${cur.color} text-white` : `${cur.light} ${cur.text}`}`}>
                          {inCart ? '✓ 수정' : `+ ${cur.label.replace(' 신청', '')}`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* 하단 sticky 장바구니 + 제출 */}
          <div className="sticky bottom-0 z-20 shadow-[0_-4px_12px_-4px_rgba(0,0,0,0.08)] flex flex-wrap items-center justify-between gap-3 p-4 bg-white rounded-xl border border-gray-200">
            <div className="flex flex-wrap items-center gap-3 flex-1 min-w-0">
              <span className={`px-2 py-0.5 rounded ${cur.color} text-white text-xs font-semibold`}>{cur.label}</span>
              <span className="text-sm text-gray-500 inline-flex items-center gap-2">
                장바구니 <span className={`font-semibold ${cur.text}`}>{cart.length}건</span>
                {cart.length > 0 && (
                  <button onClick={() => { if (confirm('장바구니를 비우시겠습니까?')) setCart([]); }} className="ml-2 text-xs text-gray-400 hover:text-red-500 underline inline-flex items-center gap-0.5">
                    <RotateCcw className="w-3 h-3" />초기화
                  </button>
                )}
              </span>
              {cart.length > 0 && (
                <div className="flex flex-wrap gap-1 ml-2 max-w-full overflow-x-auto">
                  {cart.map(c => (
                    <span key={c.item_id} className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 rounded text-[11px] text-slate-700">
                      {c.item_name}({c.qty})
                      {c.attachments.length > 0 && <Camera className="w-3 h-3 text-slate-500" />}
                      <button onClick={() => removeFromCart(c.item_id)} className="text-slate-400 hover:text-red-500">×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={handleSubmit}
              disabled={submitting || cart.length === 0}
              className="btn-primary inline-flex items-center gap-1.5"
            >
              <Send className="w-4 h-4" />{submitting ? '제출 중...' : `신청 제출 (${cart.length}건)`}
            </button>
          </div>
        </div>
      )}

      {/* ============ 신청현황 탭 ============ */}
      {pageTab === 'list' && (
        <>
          <FilterBar
            filters={[{
              key: 'status', label: '전체 상태', value: filterStatus, onChange: setFilterStatus,
              options: Object.entries(STATUS_LABEL).map(([k, v]) => ({ value: k, label: v })),
            }]}
            onReset={() => setFilterStatus('')}
          />
          <div className="card p-0 overflow-auto">
            {loadingList ? <EmptyState message="로딩 중..." />
              : requests.length === 0 ? <EmptyState message="신청 내역이 없습니다." />
              : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>신청번호</th>
                    {canViewAll && <th>부서</th>}
                    <th>유형</th>
                    <th>품목수</th>
                    <th>상태</th>
                    <th>제출일</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map(r => (
                    <tr key={r.id}>
                      <td className="font-medium text-purple-600">{r.request_no}</td>
                      {canViewAll && <td className="text-xs">{r.department_name}</td>}
                      <td>
                        {(r as any).equipment_request_type === 'DISPOSAL'
                          ? <span className="badge-red">폐기</span>
                          : (r as any).equipment_request_type === 'ADDITION'
                          ? <span className="badge-blue">추가</span>
                          : <span className="badge-gray">-</span>}
                      </td>
                      <td>{r.items?.length ?? (r as any).item_count ?? 0}건</td>
                      <td><span className={STATUS_CLS[r.status] || 'badge-gray'}>{STATUS_LABEL[r.status] || r.status}</span></td>
                      <td className="text-xs text-gray-400">{r.submitted_at ? new Date(r.submitted_at).toLocaleDateString('ko-KR') : '-'}</td>
                      <td>
                        <button onClick={() => openDetail(r.id)} className="btn-ghost text-xs py-1 px-2 text-purple-600 inline-flex items-center gap-0.5">
                          <Eye className="w-3.5 h-3.5" />상세
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ===== 카드 클릭 시 신청 모달 ===== */}
      <Modal
        open={editCart !== null}
        onClose={() => setEditCart(null)}
        title={editCart ? `${cur.label} — ${editCart.item_name}` : ''}
        size="md"
        footer={editCart && (
          <>
            {!editIsNew && (
              <button onClick={() => { removeFromCart(editCart.item_id); setEditCart(null); }} className="btn-secondary text-red-600 mr-auto inline-flex items-center gap-1">
                <Trash2 className="w-4 h-4" />장바구니에서 제거
              </button>
            )}
            <button onClick={() => setEditCart(null)} className="btn-secondary">취소</button>
            <button onClick={saveCart} className="btn-primary inline-flex items-center gap-1">
              <Plus className="w-4 h-4" />{editIsNew ? '장바구니 담기' : '수정 저장'}
            </button>
          </>
        )}
      >
        {editCart && (
          <div className="space-y-4">
            {/* 수량 (폐기는 1로 고정 가능, 추가는 자유) */}
            {reqType === 'ADDITION' && (
              <div>
                <label className="text-sm font-semibold text-slate-700 mb-1.5 block">신청 수량</label>
                <div className="flex items-center gap-2">
                  <button onClick={() => setEditCart(p => p ? { ...p, qty: Math.max(1, p.qty - 1) } : p)} className="w-8 h-8 rounded-md border border-gray-200">−</button>
                  <input type="number" min="1" value={editCart.qty} onChange={e => setEditCart(p => p ? { ...p, qty: Math.max(1, Number(e.target.value) || 1) } : p)} className="input w-20 text-center" />
                  <button onClick={() => setEditCart(p => p ? { ...p, qty: p.qty + 1 } : p)} className="w-8 h-8 rounded-md border border-gray-200">+</button>
                </div>
              </div>
            )}
            {reqType === 'DISPOSAL' && (
              <div className="bg-slate-50 rounded-lg p-3 text-sm flex items-center justify-between">
                <span className="text-slate-600">보유 수량</span>
                <span className="font-semibold text-slate-800">{fmt(stocks[editCart.item_id])} 개</span>
              </div>
            )}

            {/* 사유 */}
            <div>
              <label className="text-sm font-semibold text-slate-700 mb-1.5 block">사유</label>
              <select
                value={editCart.reason}
                onChange={e => setEditCart(p => p ? { ...p, reason: e.target.value } : p)}
                className="input w-full text-sm mb-2"
              >
                <option value="">— 사유 선택 —</option>
                {(REASON_PRESETS[reqType] ?? []).map(r => <option key={r} value={r}>{r}</option>)}
                <option value="기타 (직접 입력)">기타 (직접 입력)</option>
              </select>
              {editCart.reason === '기타 (직접 입력)' && (
                <input
                  type="text"
                  placeholder="사유를 입력하세요"
                  onChange={e => setEditCart(p => p ? { ...p, reason: e.target.value || '기타 (직접 입력)' } : p)}
                  className="input w-full text-sm"
                />
              )}
            </div>

            {/* 사진 첨부 */}
            <div>
              <label className="text-sm font-semibold text-slate-700 mb-1.5 block">
                사진 첨부 {reqType === 'DISPOSAL' && <span className="text-xs text-red-500">(권장)</span>}
              </label>
              <div className="flex flex-wrap gap-2">
                {editCart.attachments.map(url => (
                  <div key={url} className="relative group w-20 h-20 rounded-lg border border-gray-200 overflow-hidden bg-slate-50">
                    <img src={url} className="w-full h-full object-contain" />
                    <button
                      onClick={() => removeAttachment(url)}
                      className="absolute top-0.5 right-0.5 w-5 h-5 bg-black/60 text-white rounded-full text-xs opacity-0 group-hover:opacity-100 flex items-center justify-center"
                    >×</button>
                  </div>
                ))}
                <label className="w-20 h-20 rounded-lg border-2 border-dashed border-gray-300 flex flex-col items-center justify-center cursor-pointer hover:border-purple-400 hover:bg-purple-50">
                  <Camera className="w-5 h-5 text-gray-400" />
                  <span className="text-[10px] text-gray-500 mt-1">{uploading ? '업로드' : '사진 추가'}</span>
                  <input type="file" accept="image/*" multiple onChange={handleUpload} disabled={uploading} className="hidden" />
                </label>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ===== 상세 보기 모달 ===== */}
      <Modal
        open={detailOpen && detail !== null}
        onClose={() => setDetailOpen(false)}
        title={detail?.request_no ?? '상세'}
        size="lg"
        footer={<button onClick={() => setDetailOpen(false)} className="btn-secondary">닫기</button>}
      >
        {detail && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-3">
              {(detail as any).equipment_request_type === 'DISPOSAL' && <span className="badge-red">폐기</span>}
              {(detail as any).equipment_request_type === 'ADDITION' && <span className="badge-blue">추가</span>}
              <span className={STATUS_CLS[detail.status] || 'badge-gray'}>{STATUS_LABEL[detail.status]}</span>
              <span className="text-xs text-gray-400">{detail.department_name}</span>
            </div>
            <table className="tbl">
              <thead>
                <tr><th>품목</th><th className="text-right">수량</th><th>사유</th><th>사진</th></tr>
              </thead>
              <tbody>
                {detail.items?.map((it: any) => {
                  let parsed: any = {};
                  try { parsed = JSON.parse(it.note ?? '{}'); } catch { parsed = { reason: it.note }; }
                  return (
                    <tr key={it.id || it.item_id}>
                      <td>
                        <div className="font-medium text-sm">{it.item_name}</div>
                        <div className="text-[10px] text-gray-400">{it.item_code}</div>
                      </td>
                      <td className="text-right">{it.requested_qty}</td>
                      <td className="text-xs">{parsed.reason || '-'}</td>
                      <td>
                        {parsed.attachments?.length > 0 ? (
                          <div className="flex gap-1">
                            {parsed.attachments.map((u: string, i: number) => (
                              <img key={i} src={u} className="w-12 h-12 object-cover rounded border border-gray-200" />
                            ))}
                          </div>
                        ) : <span className="text-xs text-gray-300">-</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}
