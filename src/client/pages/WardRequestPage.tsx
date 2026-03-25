import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { PageHeader, FilterBar, Modal, EmptyState, FilterChips, Pagination } from '../components/ui';
import type { FilterChip } from '../components/ui';
import {
  ClipboardList,
  Send,
  List,
  ChevronRight,
  Plus,
  Trash2,
  RotateCcw,
  XCircle,
  Eye,
  Link as LinkIcon,
  ImageIcon,
} from 'lucide-react';
import type { WardRequest, Item } from '@shared/types';
import { CONSUMABLE_CATEGORIES } from '@shared/types';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '임시저장', SUBMITTED: '제출됨', APPROVED: '승인됨',
  PARTIAL_APPROVED: '일부승인', REJECTED: '반려됨', CANCELLED: '취소됨',
};
const STATUS_CLS: Record<string, string> = {
  DRAFT: 'badge-gray', SUBMITTED: 'badge-blue', APPROVED: 'badge-green',
  PARTIAL_APPROVED: 'badge-yellow', REJECTED: 'badge-red', CANCELLED: 'badge-gray',
};

// 신청 유형
const REQUEST_TYPES = [
  { value: 'CONSUMABLE_MEDICAL', label: '의료소모품 신청', scheduled: true },
  { value: 'CONSUMABLE_REGULAR', label: '일반소모품 신청', scheduled: true },
  { value: 'DIAPER',             label: '기저귀 신청',     scheduled: true },
  { value: 'NIGHT_SNACK',        label: '야간당직간식 신청', scheduled: true },
  { value: 'ADHOC',              label: '비정기 신청',     scheduled: false },
] as const;

type ReqType = typeof REQUEST_TYPES[number]['value'];

const REQ_TYPE_LABEL: Record<string, string> = Object.fromEntries(REQUEST_TYPES.map(t => [t.value, t.label]));

// 소모품 카테고리 계층
const CONSUMABLE_HIERARCHY = [
  { label: '의료소모품', subs: [
    { label: '의료소모품(정액)',    value: 'MEDICAL_FIXED' },
    { label: '처치재료(행위)',      value: 'MEDICAL_ACT' },
  ]},
  { label: '일반소모품', subs: [
    { label: '환자용품', value: 'GENERAL_PATIENT' },
    { label: '직원용품', value: 'GENERAL_STAFF' },
    { label: '병원관리', value: 'GENERAL_MGMT' },
    { label: '식음료',   value: 'GENERAL_SERVICE' }
  ]},
  { label: '사무용품', subs: [
    { label: '사무용품',  value: 'OFFICE_SUPPLY' },
    { label: '사무기기',  value: 'OFFICE_SEMI' },
  ]},
];

export default function WardRequestPage() {
  const { user, hasPerm } = useAuth();
  const { showToast } = useToast();
  const canCreate  = hasPerm('REQUEST_USE');
  const canViewAll = hasPerm('PURCHASE_MANAGE');

  const [pageTab, setPageTab] = useState<'create' | 'list'>(canCreate ? 'create' : 'list');

  // 신청현황 state
  const [requests, setRequests]     = useState<WardRequest[]>([]);
  const [loading, setLoading]       = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType, setFilterType] = useState('');
  const [modal, setModal]           = useState<'detail' | null>(null);
  const [detail, setDetail]         = useState<WardRequest | null>(null);

  // 소모품 신청 state
  const [requestType, setRequestType] = useState<ReqType>('CONSUMABLE_REGULAR');
  const [scheduleInfo, setScheduleInfo] = useState<any | null | 'loading'>(null);
  const [allItems, setAllItems]     = useState<Item[]>([]);
  const [majorCat, setMajorCat]     = useState<string | null>(null);
  const [subCat,   setSubCat]       = useState<string | null>(null);
  const [qtys, setQtys]             = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg]               = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // 자유 입력 품목 (일반소모품/의료소모품)
  type CustomItem = { key: string; custom_name: string; custom_spec: string; custom_link: string; requested_qty: number };
  const [customItems, setCustomItems] = useState<CustomItem[]>([]);
  const CUSTOM_ITEM_TYPES: ReqType[] = ['CONSUMABLE_REGULAR', 'CONSUMABLE_MEDICAL'];
  const allowCustom = CUSTOM_ITEM_TYPES.includes(requestType);

  // 이미지 hover
  const [hoverImg, setHoverImg]     = useState<{ url: string; x: number; y: number } | null>(null);
  const [enlargeImg, setEnlargeImg] = useState<string | null>(null);

  // Pagination
  const [itemPage, setItemPage] = useState(1);
  const [itemPageSize, setItemPageSize] = useState(20);
  const [listPage, setListPage] = useState(1);
  const [listPageSize, setListPageSize] = useState(20);

  const focusNextRowInput = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const td = e.currentTarget.closest('td');
    const tr = e.currentTarget.closest('tr');
    const table = e.currentTarget.closest('table');
    if (!td || !tr || !table) return;
    const col = (td as HTMLTableCellElement).cellIndex;
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const idx = rows.indexOf(tr as HTMLTableRowElement);
    for (let i = idx + 1; i < rows.length; i++) {
      const rowEl = rows[i] as HTMLTableRowElement;
      const next = rowEl.cells[col]?.querySelector('input[type="number"]') as HTMLInputElement | null;
      if (next && !next.disabled) { next.focus(); next.select(); break; }
    }
  };
  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4000);
  };

  // 신청현황 로드
  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams();
    if (filterStatus) p.set('status', filterStatus);
    if (filterType) p.set('type', filterType);
    api(`/ward-requests?${p}`)
      .then(setRequests)
      .catch(() => showToast('신청 목록을 불러오지 못했습니다.', 'error'))
      .finally(() => setLoading(false));
  }, [filterStatus, filterType]);

  useEffect(() => { load(); }, [load]);

  // 품목 로드 (관리자 권한 + 활성 품목)
  useEffect(() => {
    if (!canCreate) return;
    const consumableCatValues = CONSUMABLE_CATEGORIES.map(c => c.value);
    Promise.all([
      api('/items?is_active=true'),
      api('/dept-permissions/my-items').catch(() => ({ item_ids: null })),
    ]).then(([fetchedItems, permData]) => {
      const item_ids: string[] | null = permData?.item_ids ?? null;
      const consumableItems = fetchedItems.filter((i: any) => consumableCatValues.includes(i.category ?? ''));
      setAllItems(item_ids && item_ids.length > 0
        ? consumableItems.filter((i: any) => item_ids.includes(i.id))
        : consumableItems);
    }).catch(() => {});
  }, [canCreate]);

  // 유형 변경 시 스케줄 조회
  useEffect(() => {
    const typeConfig = REQUEST_TYPES.find(t => t.value === requestType);
    if (!typeConfig?.scheduled) { setScheduleInfo(null); return; }
    setScheduleInfo('loading');
    api(`/request-schedules?request_type=${requestType}`)
      .then((list: any[]) => {
        const active = list.find(s => s.is_active);
        setScheduleInfo(active ?? null);
      })
      .catch(() => setScheduleInfo(null));
  }, [requestType]);

  // 유형에 따른 표시 품목 필터링
  const MEDICAL_CATEGORIES = ['MEDICAL_FIXED', 'MEDICAL_ACT'];
  const GENERAL_CATEGORIES = ['GENERAL_PATIENT', 'GENERAL_STAFF', 'GENERAL_MGMT', 'GENERAL_SERVICE', 'OFFICE_SUPPLY', 'OFFICE_SEMI'];
  const items: Item[] = (() => {
    if (requestType === 'DIAPER') return allItems.filter(i => i.stats_bucket === 'DIAPER_CARE');
    if (requestType === 'NIGHT_SNACK') return allItems.filter(i => i.stats_bucket === 'FOOD');
    if (requestType === 'CONSUMABLE_MEDICAL') return allItems.filter(i => MEDICAL_CATEGORIES.includes(i.category ?? ''));
    if (requestType === 'CONSUMABLE_REGULAR') return allItems.filter(i => GENERAL_CATEGORIES.includes(i.category ?? ''));
    return allItems; // ADHOC
  })();

  // DIAPER/NIGHT_SNACK은 단순 목록 (카테고리 드릴다운 불필요)
  const useCategoryDrilldown = requestType === 'CONSUMABLE_MEDICAL' || requestType === 'CONSUMABLE_REGULAR' || requestType === 'ADHOC';

  const clickMajor = (label: string) => { setMajorCat(prev => prev === label ? null : label); setSubCat(null); setItemPage(1); };
  const clickSub   = (value: string) => { setSubCat(prev => prev === value ? null : value); setItemPage(1); };

  // 유형별로 보여줄 카테고리 계층 필터
  const visibleHierarchy = requestType === 'CONSUMABLE_MEDICAL'
    ? CONSUMABLE_HIERARCHY.filter(g => g.label === '의료소모품')
    : requestType === 'CONSUMABLE_REGULAR'
    ? CONSUMABLE_HIERARCHY.filter(g => g.label !== '의료소모품')
    : CONSUMABLE_HIERARCHY;

  const currentSubs  = visibleHierarchy.find(g => g.label === majorCat)?.subs ?? [];
  const visibleItems = useCategoryDrilldown
    ? (subCat ? items.filter(i => i.category === subCat) : [])
    : items;

  const pendingMasterCount = items.filter(i => (qtys[i.id] ?? 0) > 0).length;
  const pendingCustomCount = customItems.filter(c => c.custom_name.trim() && c.requested_qty > 0).length;
  const pendingCount = pendingMasterCount + pendingCustomCount;

  // 제출 가능 여부
  const typeConfig = REQUEST_TYPES.find(t => t.value === requestType)!;
  const canSubmit = !typeConfig.scheduled || (scheduleInfo !== null && scheduleInfo !== 'loading');

  const handleSubmit = async () => {
    const masterToSubmit = items
      .filter(i => (qtys[i.id] ?? 0) > 0)
      .map(i => ({ item_id: i.id, requested_qty: qtys[i.id], note: '' }));

    const customToSubmit = customItems
      .filter(c => c.custom_name.trim() && c.requested_qty > 0)
      .map(c => ({ custom_name: c.custom_name.trim(), custom_spec: c.custom_spec.trim(), custom_link: c.custom_link.trim(), requested_qty: c.requested_qty, note: '' }));

    const itemsToSubmit = [...masterToSubmit, ...customToSubmit];

    if (itemsToSubmit.length === 0) { showMsg('err', '1개 이상 품목에 수량을 입력해주세요.'); return; }
    if (!canSubmit) { showMsg('err', '현재 신청 기간이 아닙니다.'); return; }

    setSubmitting(true);
    try {
      const created = await api('/ward-requests', {
        method: 'POST',
        body: JSON.stringify({
          period_type: 'MONTH',
          period_start: scheduleInfo?.open_from ?? new Date().toISOString(),
          period_end:   scheduleInfo?.open_to   ?? new Date().toISOString(),
          request_type: requestType,
          items: itemsToSubmit,
        }),
      });
      await api(`/ward-requests/${created.id}/submit`, { method: 'POST' });
      showMsg('ok', '신청이 제출되었습니다.');
      setQtys({}); setCustomItems([]); setMajorCat(null); setSubCat(null);
      setPageTab('list'); load();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const openDetail = async (id: string) => {
    try {
      const d = await api(`/ward-requests/${id}`);
      setDetail(d);
      setModal('detail');
    } catch (e: any) { showMsg('err', e.message); }
  };

  const cancelRequest = async (id: string) => {
    if (!confirm('신청을 취소하시겠습니까?')) return;
    try {
      await api(`/ward-requests/${id}/cancel`, { method: 'POST' });
      showMsg('ok', '취소되었습니다.'); setModal(null); load();
    } catch (e: any) { showMsg('err', e.message); }
  };

  const fmt = (n: number) => new Intl.NumberFormat('ko-KR').format(n);
  const fmtDate = (d: string) => new Date(d).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });

  return (
    <div>
      <PageHeader
        icon={ClipboardList}
        title="소모품 신청"
        description={canViewAll ? '전체 소모품 신청 현황' : `${user?.department_name} 소모품 신청 관리`}
      />

      {/* 탭 바 */}
      <div className="flex border-b border-gray-200 mb-5">
        {canCreate && (
          <button
            onClick={() => setPageTab('create')}
            className={`inline-flex items-center gap-1.5 px-6 py-2.5 text-sm font-medium border-b-2 transition-colors ${pageTab === 'create' ? 'border-teal-500 text-teal-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            <Send className="w-4 h-4" />소모품 신청
          </button>
        )}
        <button
          onClick={() => setPageTab('list')}
          className={`inline-flex items-center gap-1.5 px-6 py-2.5 text-sm font-medium border-b-2 transition-colors ${pageTab === 'list' ? 'border-teal-500 text-teal-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
        >
          <List className="w-4 h-4" />신청현황
        </button>
      </div>

      {msg && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {/* ── 소모품 신청 탭 ── */}
      {pageTab === 'create' && canCreate && (
        <div className="space-y-5">
          {/* 신청 유형 선택 */}
          <div className="card p-5">
            <p className="text-sm font-semibold text-gray-700 mb-3">신청 유형 선택</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {REQUEST_TYPES.map(t => {
                const isSelected = requestType === t.value;
                return (
                  <button
                    key={t.value}
                    onClick={() => { setRequestType(t.value); setQtys({}); setCustomItems([]); setMajorCat(null); setSubCat(null); setItemPage(1); }}
                    className={`p-4 rounded-xl border-2 text-left transition-all ${
                      isSelected
                        ? 'border-teal-500 bg-teal-50 text-teal-800'
                        : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    <div className="font-medium text-sm">{t.label}</div>
                    {!t.scheduled && (
                      <div className="text-xs mt-1 opacity-70">항상 신청 가능</div>
                    )}
                    {t.scheduled && (
                      <div className="text-xs mt-1 opacity-70">스케줄 지정</div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 스케줄 정보 표시 */}
            {typeConfig.scheduled && (
              <div className="mt-4">
                {scheduleInfo === 'loading' ? (
                  <div className="text-sm text-gray-400">스케줄 조회 중...</div>
                ) : scheduleInfo ? (
                  <div className="flex items-center gap-2 p-3 bg-green-50 rounded-lg border border-green-200">
                    <ChevronRight className="w-4 h-4 text-green-600 flex-shrink-0" />
                    <span className="text-green-600 text-sm font-medium">신청 가능</span>
                    <span className="text-green-700 text-sm">
                      {scheduleInfo.period_label && <span className="mr-1 font-medium">{scheduleInfo.period_label}</span>}
                      신청기간: {fmtDate(scheduleInfo.open_from)} ~ {fmtDate(scheduleInfo.open_to)}
                    </span>
                  </div>
                ) : (
                  <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
                    <p className="text-amber-700 text-sm font-medium">현재 신청 기간이 아닙니다</p>
                    <p className="text-amber-600 text-xs mt-1">관리자에게 신청 일정을 확인하세요.</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* DIAPER / NIGHT_SNACK: 단순 목록 */}
          {!useCategoryDrilldown && (
            <div className="card p-0 overflow-hidden">
              {items.length === 0 ? (
                <EmptyState message={requestType === 'DIAPER' ? '기저귀 케어 품목이 없습니다.' : '식음료 품목이 없습니다.'} />
              ) : (
                <div className="overflow-x-auto" style={{ maxHeight: '420px', overflowY: 'auto' }}>
                  <table className="tbl">
                    <thead className="sticky top-0 bg-white z-10">
                      <tr>
                        <th>품목코드</th><th>품목명</th><th>단위</th>
                        <th className="text-right">현재재고</th>
                        <th className="text-right">신청수량</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(item => {
                        const qty = qtys[item.id] ?? 0;
                        return (
                          <tr key={item.id} className={qty > 0 ? 'bg-teal-50/60' : ''}>
                            <td className="font-mono text-xs text-gray-400">{item.item_code}</td>
                            <td className="font-medium text-sm">{item.name}</td>
                            <td className="text-xs text-gray-500">{item.uom}</td>
                            <td className="text-right text-sm">
                              <span className={(item.on_hand_qty ?? 0) === 0 ? 'text-red-400' : 'text-gray-600'}>
                                {item.on_hand_qty ?? 0}
                              </span>
                            </td>
                            <td className="text-right">
                              <input
                                type="number" min="0"
                                value={qty === 0 ? '' : qty}
                                placeholder="0"
                                onKeyDown={focusNextRowInput}
                                onChange={e => {
                                  const v = Number(e.target.value);
                                  setQtys(prev => ({ ...prev, [item.id]: v < 0 ? 0 : v }));
                                }}
                                className="input w-20 text-right"
                                style={qty > 0 ? { borderColor: '#14b8a6', background: '#f0fdfa' } : {}}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* CONSUMABLE_REGULAR / ADHOC: 카테고리 드릴다운 */}
          {useCategoryDrilldown && (
            <>
              <div className="card p-5 space-y-3">
                <div>
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">대분류</p>
                  <div className="flex gap-2 flex-wrap">
                    {visibleHierarchy.map(g => {
                      const totalCount = g.subs.reduce((acc, s) => acc + items.filter(i => i.category === s.value).length, 0);
                      const isActive = majorCat === g.label;
                      const isEmpty  = totalCount === 0;
                      return (
                        <button
                          key={g.label}
                          onClick={() => !isEmpty && clickMajor(g.label)}
                          disabled={isEmpty}
                          className="px-5 py-2 rounded-lg text-sm font-medium transition-all"
                          style={{
                            background: isActive ? '#0f2744' : '#f1f5f9',
                            color: isActive ? 'white' : isEmpty ? '#94a3b8' : '#475569',
                            opacity: isEmpty ? 0.4 : 1,
                            cursor: isEmpty ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {g.label}
                          <span className="ml-1.5 text-xs opacity-70">({totalCount})</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {majorCat && currentSubs.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">중분류</p>
                    <div className="flex gap-2 flex-wrap">
                      {currentSubs.map(s => {
                        const cnt = items.filter(i => i.category === s.value).length;
                        const isActive = subCat === s.value;
                        const isEmpty = cnt === 0;
                        return (
                          <button
                            key={s.value}
                            onClick={() => !isEmpty && clickSub(s.value)}
                            disabled={isEmpty}
                            className="px-4 py-1.5 rounded-full text-sm font-medium border transition-all"
                            style={{
                              background: isActive ? '#14b8a6' : 'white',
                              color: isActive ? 'white' : isEmpty ? '#94a3b8' : '#0f766e',
                              borderColor: isActive ? '#14b8a6' : isEmpty ? '#e2e8f0' : '#14b8a6',
                              opacity: isEmpty ? 0.4 : 1,
                              cursor: isEmpty ? 'not-allowed' : 'pointer',
                            }}
                          >
                            {s.label}
                            <span className="ml-1.5 text-xs opacity-75">({cnt})</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="card p-0 overflow-hidden">
                {!majorCat ? (
                  <EmptyState message="위에서 대분류를 선택하세요" />
                ) : !subCat ? (
                  <EmptyState message="중분류를 선택하면 품목이 표시됩니다" />
                ) : visibleItems.length === 0 ? (
                  <EmptyState message="해당 분류의 품목이 없습니다" />
                ) : (
                  <>
                  <div className="overflow-x-auto" style={{ maxHeight: '420px', overflowY: 'auto' }}>
                    <table className="tbl">
                      <thead className="sticky top-0 bg-white z-10">
                        <tr>
                          <th>품목코드</th><th>품목명</th><th>단위</th>
                          <th className="text-right">현재재고</th>
                          <th className="text-right">신청수량</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleItems.slice((itemPage - 1) * itemPageSize, itemPage * itemPageSize).map(item => {
                          const qty    = qtys[item.id] ?? 0;
                          const hasQty = qty > 0;
                          return (
                            <tr key={item.id} className={hasQty ? 'bg-teal-50/60' : ''}>
                              <td className="font-mono text-xs text-gray-400">{item.item_code}</td>
                              <td
                                className="font-medium text-sm"
                                style={item.image_url ? { cursor: 'pointer' } : {}}
                                onMouseEnter={item.image_url ? e => {
                                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                  setHoverImg({ url: item.image_url!, x: rect.right + 10, y: rect.top });
                                } : undefined}
                                onMouseLeave={() => setHoverImg(null)}
                                onClick={item.image_url ? () => { setHoverImg(null); setEnlargeImg(item.image_url!); } : undefined}
                              >
                                {item.image_url && <ImageIcon className="w-3 h-3 text-teal-400 inline mr-1.5 align-middle" />}
                                {item.name}
                              </td>
                              <td className="text-xs text-gray-500">{item.uom}</td>
                              <td className="text-right text-sm">
                                <span className={(item.on_hand_qty ?? 0) === 0 ? 'text-red-400' : 'text-gray-600'}>
                                  {item.on_hand_qty ?? 0}
                                </span>
                              </td>
                              <td className="text-right">
                                <input
                                  type="number" min="0"
                                  value={qty === 0 ? '' : qty}
                                  placeholder="0"
                                  onKeyDown={focusNextRowInput}
                                  onChange={e => {
                                    const v = Number(e.target.value);
                                    setQtys(prev => ({ ...prev, [item.id]: v < 0 ? 0 : v }));
                                  }}
                                  className="input w-20 text-right"
                                  style={hasQty ? { borderColor: '#14b8a6', background: '#f0fdfa' } : {}}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    currentPage={itemPage}
                    totalItems={visibleItems.length}
                    pageSize={itemPageSize}
                    onPageChange={setItemPage}
                    onPageSizeChange={setItemPageSize}
                  />
                  </>
                )}
              </div>
            </>
          )}

          {/* 직접 입력 품목 (일반소모품/의료소모품만) */}
          {allowCustom && (
            <div className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-gray-700">직접 입력 품목</p>
                <button
                  onClick={() => setCustomItems(prev => [...prev, { key: `c-${Date.now()}`, custom_name: '', custom_spec: '', custom_link: '', requested_qty: 0 }])}
                  className="btn-secondary text-xs inline-flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />품목 추가
                </button>
              </div>
              {customItems.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-4">품목 목록에 없는 물품이 필요하면 "품목 추가"를 눌러 직접 입력하세요.</p>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>품목명</th><th>규격/단위</th><th>참고 링크</th><th className="text-right">수량</th><th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {customItems.map((ci, idx) => (
                      <tr key={ci.key} className={ci.custom_name && ci.requested_qty > 0 ? 'bg-amber-50/60' : ''}>
                        <td>
                          <input
                            type="text"
                            value={ci.custom_name}
                            placeholder="품목명 입력"
                            onChange={e => {
                              const v = e.target.value;
                              setCustomItems(prev => prev.map((c, i) => i === idx ? { ...c, custom_name: v } : c));
                            }}
                            className="input w-full text-sm"
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={ci.custom_spec}
                            placeholder="규격 (선택)"
                            onChange={e => {
                              const v = e.target.value;
                              setCustomItems(prev => prev.map((c, i) => i === idx ? { ...c, custom_spec: v } : c));
                            }}
                            className="input w-full text-sm"
                          />
                        </td>
                        <td>
                          <input
                            type="url"
                            value={ci.custom_link}
                            placeholder="URL (선택)"
                            onChange={e => {
                              const v = e.target.value;
                              setCustomItems(prev => prev.map((c, i) => i === idx ? { ...c, custom_link: v } : c));
                            }}
                            className="input w-full text-sm"
                          />
                        </td>
                        <td className="text-right">
                          <input
                            type="number" min="0"
                            value={ci.requested_qty === 0 ? '' : ci.requested_qty}
                            placeholder="0"
                            onChange={e => {
                              const v = Math.max(0, Number(e.target.value));
                              setCustomItems(prev => prev.map((c, i) => i === idx ? { ...c, requested_qty: v } : c));
                            }}
                            className="input w-20 text-right"
                          />
                        </td>
                        <td className="text-center">
                          <button
                            onClick={() => setCustomItems(prev => prev.filter((_, i) => i !== idx))}
                            className="btn-ghost text-gray-400 hover:text-red-500 p-1"
                            title="삭제"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* 하단 요약 + 제출 */}
          <div className="flex items-center justify-between p-4 bg-white rounded-xl border border-gray-200">
            <span className="text-sm text-gray-500">
              신청 예정:&nbsp;
              <span className="font-semibold text-teal-600">{pendingCount}건</span>
              {pendingCustomCount > 0 && <span className="ml-1 text-amber-600">(직접입력 {pendingCustomCount}건)</span>}
              {pendingCount > 0 && (
                <button onClick={() => { setQtys({}); setCustomItems([]); }} className="ml-3 text-xs text-gray-400 hover:text-red-500 underline inline-flex items-center gap-0.5">
                  <RotateCcw className="w-3 h-3" />전체 초기화
                </button>
              )}
            </span>
            <button
              onClick={handleSubmit}
              disabled={submitting || pendingCount === 0 || !canSubmit}
              className="btn-primary inline-flex items-center gap-1.5"
            >
              <Send className="w-4 h-4" />{submitting ? '처리 중...' : '신청 제출'}
            </button>
          </div>
        </div>
      )}

      {/* ── 신청현황 탭 ── */}
      {pageTab === 'list' && (
        <>
          <FilterBar
            filters={[
              {
                key: 'type', label: '전체 유형',
                options: REQUEST_TYPES.map(t => ({ value: t.value, label: t.label })),
                value: filterType,
                onChange: (v) => { setFilterType(v); setListPage(1); },
              },
              {
                key: 'status', label: '전체 상태',
                options: Object.entries(STATUS_LABEL).map(([k, v]) => ({ value: k, label: v })),
                value: filterStatus,
                onChange: (v) => { setFilterStatus(v); setListPage(1); },
              },
            ]}
            onReset={() => { setFilterType(''); setFilterStatus(''); setListPage(1); }}
          />

          {(() => {
            const listChips: FilterChip[] = [];
            if (filterType) listChips.push({ key: 'type', label: '유형', value: REQ_TYPE_LABEL[filterType] || filterType, onRemove: () => { setFilterType(''); setListPage(1); } });
            if (filterStatus) listChips.push({ key: 'status', label: '상태', value: STATUS_LABEL[filterStatus] || filterStatus, onRemove: () => { setFilterStatus(''); setListPage(1); } });
            return <FilterChips chips={listChips} totalCount={requests.length} onResetAll={() => { setFilterType(''); setFilterStatus(''); setListPage(1); }} />;
          })()}

          <div className="card p-0 overflow-hidden overflow-x-auto">
            {loading ? (
              <EmptyState message="로딩 중..." />
            ) : requests.length === 0 ? (
              <EmptyState message="신청 내역이 없습니다." />
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>신청번호</th>
                    {canViewAll && <th>부서</th>}
                    <th>유형</th>
                    <th>기간</th>
                    <th>품목수</th>
                    <th>상태</th>
                    <th>제출일</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.slice((listPage - 1) * listPageSize, listPage * listPageSize).map(r => (
                    <tr key={r.id}>
                      <td className="font-medium text-accent-600">{r.request_no}</td>
                      {canViewAll && <td className="text-xs">{r.department_name}</td>}
                      <td className="text-xs text-gray-600">{REQ_TYPE_LABEL[(r as any).request_type] ?? (r as any).request_type}</td>
                      <td className="text-xs">{r.period_start?.slice(0, 7)}</td>
                      <td>{r.items?.length ?? (r as any).item_count ?? 0}건</td>
                      <td>
                        <span className={STATUS_CLS[r.status] || 'badge-gray'}>{STATUS_LABEL[r.status] || r.status}</span>
                      </td>
                      <td className="text-xs text-gray-400">
                        {r.submitted_at ? new Date(r.submitted_at).toLocaleDateString('ko-KR') : '-'}
                      </td>
                      <td>
                        <button onClick={() => openDetail(r.id)} className="btn-ghost text-xs py-1 px-2 text-accent-600 inline-flex items-center gap-0.5">
                          <Eye className="w-3.5 h-3.5" />상세
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <Pagination
            currentPage={listPage}
            totalItems={requests.length}
            pageSize={listPageSize}
            onPageChange={setListPage}
            onPageSizeChange={setListPageSize}
          />
        </>
      )}

      {/* ── 상세보기 모달 ── */}
      <Modal
        open={modal === 'detail' && detail !== null}
        onClose={() => setModal(null)}
        title={detail?.request_no ?? '상세'}
        size="lg"
        footer={
          <>
            {canCreate && detail?.status === 'DRAFT' && (
              <button onClick={() => cancelRequest(detail!.id)} className="btn-danger mr-auto inline-flex items-center gap-1">
                <XCircle className="w-4 h-4" />취소
              </button>
            )}
            <button onClick={() => setModal(null)} className="btn-secondary">닫기</button>
          </>
        }
      >
        {detail && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <span className="badge-gray">{REQ_TYPE_LABEL[(detail as any).request_type] ?? (detail as any).request_type}</span>
              <span className={STATUS_CLS[detail.status] || 'badge-gray'}>{STATUS_LABEL[detail.status] || detail.status}</span>
              <span className="text-xs text-gray-400">{detail.department_name} · {detail.period_start?.slice(0, 7)}</span>
            </div>

            {detail.last_action && (
              <div className="mb-4 p-3 bg-gray-50 rounded-lg text-sm">
                <span className="font-medium">{detail.last_action.approver_name}</span>
                <span className="text-gray-500 mx-1">·</span>
                <span className="text-gray-600">{detail.last_action.action}</span>
                {detail.last_action.reason && <span className="text-gray-500 ml-2">— {detail.last_action.reason}</span>}
              </div>
            )}
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>품목명</th>
                    <th className="text-right">신청수량</th>
                    <th className="text-right">기준량</th>
                    <th className="text-right">승인수량</th>
                    <th>플래그</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items?.map(item => (
                    <tr key={item.id || item.item_id}>
                      <td>
                        <div className="font-medium text-sm">
                          {(item as any).is_custom && <span className="text-amber-500 text-xs mr-1">[직접입력]</span>}
                          {item.item_name || (item as any).custom_name}
                        </div>
                        <div className="text-xs text-gray-400">
                          {(item as any).is_custom
                            ? ((item as any).custom_spec || '규격 미입력')
                            : `${item.item_code} · ${item.uom}`}
                        </div>
                        {(item as any).custom_link && (
                          <a href={(item as any).custom_link} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline inline-flex items-center gap-0.5">
                            <LinkIcon className="w-3 h-3" />참고 링크
                          </a>
                        )}
                      </td>
                      <td className="text-right font-medium">{item.requested_qty}</td>
                      <td className="text-right text-gray-400">{item.baseline_qty || '-'}</td>
                      <td className="text-right">
                        {item.approved_qty !== undefined && item.approved_qty !== null
                          ? <span className="font-medium text-green-600">{item.approved_qty}</span>
                          : '-'}
                      </td>
                      <td>
                        {item.policy_flags?.map(f => (
                          <span key={f} className={`badge mr-1 ${f === 'OVER_15PCT' ? 'badge-yellow' : 'badge-gray'}`}>
                            {f === 'OVER_15PCT' ? '+15%' : f === 'BASELINE_MISSING' ? '기준없음' : f}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Modal>

      {/* 이미지 hover */}
      {hoverImg && (
        <div className="fixed z-50 pointer-events-none rounded-xl shadow-2xl border border-gray-200 overflow-hidden"
          style={{ left: hoverImg.x, top: hoverImg.y, width: 160, height: 160 }}>
          <img src={hoverImg.url} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
      )}
      {enlargeImg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setEnlargeImg(null)}>
          <img src={enlargeImg} alt="" loading="lazy"
            className="max-w-[80vw] max-h-[80vh] rounded-xl shadow-2xl object-contain"
            onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
