import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import { useToast } from '../components/Toast';
import { getCategoryLabel } from '@shared/types';
import { PageHeader, FilterBar, DataTable, Modal, EmptyState, FilterChips, Pagination } from '../components/ui';
import type { Column, FilterChip } from '../components/ui';
import {
  CheckCircle2,
  ClipboardList,
  AlertTriangle,
  FileText,
  Loader2,
  Layers,
  Building2,
  Send,
  Tag,
  ExternalLink,
} from 'lucide-react';

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: '제출',
  APPROVED: '승인',
  PARTIAL_APPROVED: '부분승인',
  REJECTED: '반려',
  CANCELLED: '취소',
};

const STATUS_CLS: Record<string, string> = {
  SUBMITTED: 'badge-blue',
  APPROVED: 'badge-green',
  PARTIAL_APPROVED: 'badge-yellow',
  REJECTED: 'badge-red',
  CANCELLED: 'badge-gray',
};

const REQ_TYPE_TABS = [
  { v: '', l: '전체' },
  { v: 'CONSUMABLE_REGULAR', l: '정기소모품' },
  { v: 'DIAPER', l: '기저귀' },
  { v: 'NIGHT_SNACK', l: '야간당직간식' },
  { v: 'ADHOC', l: '비정기' },
  { v: 'EQUIPMENT', l: '비품' },
] as const;

const REQ_TYPE_LABEL: Record<string, string> = {
  CONSUMABLE_REGULAR: '정기소모품',
  DIAPER: '기저귀',
  NIGHT_SNACK: '야간당직간식',
  ADHOC: '비정기',
  EQUIPMENT: '비품',
  CONSUMABLE: '소모품',
};

const AUTO_PO_TYPES = ['CONSUMABLE_REGULAR', 'DIAPER', 'NIGHT_SNACK', 'CONSUMABLE'];

interface ApprovalItem {
  id?: string;
  item_id: string;
  item_name?: string;
  item_code?: string;
  custom_name?: string;
  custom_spec?: string;
  is_custom?: boolean;
  uom?: string;
  category?: string;
  requested_qty: number;
  baseline_qty: number;
  diff_pct: number;
  policy_flags: string[];
  note: string;
  latest_price?: number;
  price_up?: boolean;
  on_hand_qty?: number;
}

interface ApprovalDetail {
  id: string;
  request_no: string;
  department_id?: string;
  department_name?: string;
  requester_name?: string;
  period_start?: string;
  period_end?: string;
  status: string;
  is_emergency: boolean;
  request_type?: string;
  submitted_at?: string;
  items: ApprovalItem[];
}

interface DedupedReq extends ApprovalDetail {
  dupCount: number;
  allIds: string[];
}

export default function ApprovalPage() {
  const { showToast } = useToast();
  const [reqTypeTab, setReqTypeTab] = useState('');
  const [pageTab, setPageTab] = useState<'bulk' | 'list'>('bulk');
  const [adjustScope, setAdjustScope] = useState<'all' | 'dept'>('all');
  const [selectedDeptId, setSelectedDeptId] = useState('');

  const [submittedDetails, setSubmittedDetails] = useState<ApprovalDetail[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [bulkQtys, setBulkQtys] = useState<Record<string, Record<string, number>>>({});
  const [bulkReasons, setBulkReasons] = useState<Record<string, string>>({});
  const [bulkInputDrafts, setBulkInputDrafts] = useState<Record<string, string>>({});
  const [catFilter, setCatFilter] = useState('');
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkMethod, setBulkMethod] = useState<'PO' | 'STOCK_OUT'>('PO');

  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [listStatus, setListStatus] = useState('SUBMITTED');
  const [listPage, setListPage] = useState(1);
  const [listPageSize, setListPageSize] = useState(20);

  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [action, setAction] = useState<'APPROVE' | 'ADJUST' | 'REJECT'>('APPROVE');
  const [reason, setReason] = useState('');
  const [approvedQtys, setApprovedQtys] = useState<Record<string, number>>({});
  const [approvedInputDrafts, setApprovedInputDrafts] = useState<Record<string, string>>({});
  const [adhocMethod, setAdhocMethod] = useState<'PO' | 'STOCK_OUT'>('PO');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  // 품목별 불출 이력 (최근 3개월)
  const [itemTrends, setItemTrends] = useState<Record<string, number[]>>({});

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const fmt = (n: number) => new Intl.NumberFormat('ko-KR').format(n);
  const parseNumericInput = (value: string) => {
    const numeric = value.replace(/[^\d]/g, '');
    if (!numeric) return 0;
    const parsed = Number(numeric);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const toRawNumericText = (value: string) => value.replace(/[^\d]/g, '');
  const deptKeyOf = (req: ApprovalDetail) => (req.department_id ? `id:${req.department_id}` : `name:${req.department_name ?? req.id}`);
  const bulkInputKey = (reqId: string, itemId: string) => `${reqId}::${itemId}`;

  const loadSubmitted = useCallback(async () => {
    setDetailsLoading(true);
    try {
      const submittedList: any[] = await api('/approvals');
      if (submittedList.length === 0) {
        setSubmittedDetails([]);
        setBulkQtys({});
        setBulkReasons({});
        setBulkInputDrafts({});
        return;
      }
      const submittedMap = new Map<string, any>(submittedList.map((r: any) => [String(r.id), r]));
      const rawDetails: ApprovalDetail[] = await Promise.all(submittedList.map((r: any) => api(`/approvals/${r.id}`)));
      const details: ApprovalDetail[] = rawDetails.map((d) => {
        const base = submittedMap.get(String(d.id)) ?? {};
        return {
          ...d,
          department_id: d.department_id ?? base.department_id,
          department_name: d.department_name ?? base.department_name,
          request_type: d.request_type ?? base.request_type,
          submitted_at: d.submitted_at ?? base.submitted_at,
        };
      });
      setSubmittedDetails(details);
      const qtys: Record<string, Record<string, number>> = {};
      const reasons: Record<string, string> = {};
      details.forEach((req) => {
        qtys[req.id] = {};
        reasons[req.id] = '';
        req.items.forEach((it) => {
          qtys[req.id][it.item_id] = it.requested_qty;
        });
      });
      setBulkQtys(qtys);
      setBulkReasons(reasons);
      setBulkInputDrafts({});
    } catch (e) {
      console.error(e);
    } finally {
      setDetailsLoading(false);
    }
  }, []);

  const loadList = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams();
    if (listStatus) p.set('status', listStatus);
    if (reqTypeTab) p.set('request_type', reqTypeTab);
    api(`/approvals?${p}`)
      .then(setList)
      .catch(() => showToast('승인 목록을 불러오지 못했습니다.', 'error'))
      .finally(() => setLoading(false));
  }, [listStatus, reqTypeTab]);

  useEffect(() => {
    loadSubmitted();
  }, [loadSubmitted]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    setCatFilter('');
    setAdjustScope('all');
    setSelectedDeptId('');
    setBulkInputDrafts({});
  }, [reqTypeTab]);

  const filteredReqs = useMemo(
    () => (reqTypeTab ? submittedDetails.filter((r) => r.request_type === reqTypeTab) : submittedDetails),
    [submittedDetails, reqTypeTab]
  );

  const dedupedReqs = useMemo((): DedupedReq[] => {
    const map = new Map<string, DedupedReq>();
    filteredReqs.forEach((req) => {
      const key = deptKeyOf(req);
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...req, dupCount: 1, allIds: [req.id] });
        return;
      }
      const eDate = existing.submitted_at ? new Date(existing.submitted_at) : new Date(0);
      const rDate = req.submitted_at ? new Date(req.submitted_at) : new Date(0);
      if (rDate > eDate) {
        map.set(key, { ...req, dupCount: existing.dupCount + 1, allIds: [...existing.allIds, req.id] });
      } else {
        existing.dupCount++;
        existing.allIds.push(req.id);
      }
    });
    return [...map.values()];
  }, [filteredReqs]);

  const deptOptions = useMemo(
    () =>
      dedupedReqs.map((r) => ({
        id: deptKeyOf(r),
        name: r.department_name ?? r.department_id ?? '미지정 부서',
      })),
    [dedupedReqs]
  );

  useEffect(() => {
    if (adjustScope !== 'dept') return;
    if (!selectedDeptId && deptOptions.length > 0) {
      setSelectedDeptId(deptOptions[0].id);
      return;
    }
    if (selectedDeptId && !deptOptions.some((d) => d.id === selectedDeptId)) {
      setSelectedDeptId(deptOptions[0]?.id ?? '');
    }
  }, [adjustScope, selectedDeptId, deptOptions]);

  const visibleDedupedReqs = useMemo(() => {
    if (adjustScope !== 'dept' || !selectedDeptId) return dedupedReqs;
    return dedupedReqs.filter((r) => deptKeyOf(r) === selectedDeptId);
  }, [adjustScope, selectedDeptId, dedupedReqs]);

  const allPivotItems = useMemo(() => {
    const map = new Map<string, ApprovalItem>();
    filteredReqs.forEach((req) => req.items.forEach((it) => (!map.has(it.item_id) ? map.set(it.item_id, it) : null)));
    return [...map.values()];
  }, [filteredReqs]);

  const filteredItems = useMemo(
    () => (catFilter ? allPivotItems.filter((i) => i.category === catFilter) : allPivotItems),
    [allPivotItems, catFilter]
  );

  const distinctCats = useMemo(
    () => [...new Set(allPivotItems.map((i) => i.category).filter(Boolean))] as string[],
    [allPivotItems]
  );

  const handleBulkApprove = async () => {
    const targets = adjustScope === 'dept'
      ? filteredReqs.filter((r) => visibleDedupedReqs.some((v) => v.allIds.includes(r.id)))
      : filteredReqs;
    setBulkSubmitting(true);
    let ok = 0;
    let fail = 0;
    for (const req of targets) {
      try {
        const reqQtys = bulkQtys[req.id] ?? {};
        const items = req.items.map((it) => ({ item_id: it.item_id, approved_qty: reqQtys[it.item_id] ?? it.requested_qty }));
        const anyChanged = items.some((it) => it.approved_qty !== (req.items.find((i) => i.item_id === it.item_id)?.requested_qty ?? it.approved_qty));
        const allZero = items.every((it) => it.approved_qty === 0);
        const bulkAction = allZero ? 'REJECT' : anyChanged ? 'ADJUST' : 'APPROVE';
        const reasonText = (bulkReasons[req.id] ?? '').trim();
        if ((bulkAction === 'ADJUST' || bulkAction === 'REJECT') && !reasonText) {
          fail++;
          continue;
        }
        const body: any = { action: bulkAction, reason: reasonText, items };
        const isEquipAdd = req.request_type === 'EQUIPMENT' && (req as any).equipment_request_type === 'ADDITION';
        if (bulkAction === 'APPROVE' && (req.request_type === 'ADHOC' || isEquipAdd)) body.approval_method = bulkMethod;
        await api(`/approvals/${req.id}/decide`, { method: 'POST', body: JSON.stringify(body) });
        ok++;
      } catch {
        fail++;
      }
    }
    setBulkSubmitting(false);
    showMsg(fail === 0 ? 'ok' : 'err', `${ok}건 처리 완료${fail > 0 ? `, ${fail}건 실패` : ''}`);
    loadSubmitted();
    loadList();
  };

  const openDetail = async (id: string) => {
    try {
      const d = await api(`/approvals/${id}`);
      setDetail(d);
      const init: Record<string, number> = {};
      d.items?.forEach((it: ApprovalItem) => {
        init[it.item_id] = it.requested_qty;
      });
      setApprovedQtys(init);
      setApprovedInputDrafts({});
      setAction('APPROVE');
      setReason('');
      setAdhocMethod('PO');

      // 품목별 최근 불출 추이 로드
      const trends: Record<string, number[]> = {};
      try {
        await Promise.all(
          (d.items || []).map(async (it: ApprovalItem) => {
            const res = await api(`/supply-analytics/item-trend?item_id=${it.item_id}&department_id=${d.department_id || ''}`);
            if (res?.trend) {
              trends[it.item_id] = res.trend.map((t: any) => t.quantity);
            }
          })
        );
      } catch { /* ignore trend load failure */ }
      setItemTrends(trends);
    } catch (e: any) {
      showMsg('err', e.message);
    }
  };

  const decide = async () => {
    if (!detail) return;
    if (action !== 'APPROVE' && !reason.trim()) {
      showMsg('err', '처리 사유를 입력해주세요.');
      return;
    }
    setSubmitting(true);
    try {
      const body: any = {
        action,
        reason,
        items: detail.items.map((it) => ({
          item_id: it.item_id,
          approved_qty: action === 'REJECT' ? 0 : approvedQtys[it.item_id] ?? it.requested_qty,
        })),
      };
      const isEquipAdd = detail.request_type === 'EQUIPMENT' && (detail as any).equipment_request_type === 'ADDITION';
      if (action === 'APPROVE' && (detail.request_type === 'ADHOC' || isEquipAdd)) body.approval_method = adhocMethod;
      await api(`/approvals/${detail.id}/decide`, { method: 'POST', body: JSON.stringify(body) });
      showMsg('ok', `${action === 'APPROVE' ? '승인' : action === 'REJECT' ? '반려' : '조정승인'} 처리 완료`);
      setDetail(null);
      loadSubmitted();
      loadList();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const filterBtn = (active: boolean, color = '#1d4ed8') => ({
    background: active ? color : 'white',
    color: active ? 'white' : '#475569',
    borderColor: active ? color : '#e2e8f0',
  });

  const TYPE_COLOR: Record<string, string> = {
    CONSUMABLE_REGULAR: '#1d4ed8',
    DIAPER: '#7c3aed',
    NIGHT_SNACK: '#0891b2',
    ADHOC: '#ea580c',
    EQUIPMENT: '#64748b',
  };

  /* ---- 병동별 신청내역 DataTable 컬럼 ---- */
  const listColumns: Column<any>[] = useMemo(() => [
    {
      key: 'request_no',
      header: '신청번호',
      render: (r) => <span className="font-medium text-teal-600">{r.request_no}</span>,
      sortable: true,
      sortValue: (r) => r.request_no ?? '',
      cardPosition: 'title' as const,
    },
    {
      key: 'department',
      header: '부서',
      render: (r) => <span className="text-xs">{r.department_name}</span>,
      sortable: true,
      sortValue: (r) => r.department_name ?? '',
      cardPosition: 'subtitle' as const,
    },
    {
      key: 'requester',
      header: '요청자',
      render: (r) => <span className="text-xs">{r.requester_name}</span>,
      cardPosition: 'body' as const,
    },
    {
      key: 'period',
      header: '기간',
      render: (r) => <span className="text-xs">{r.period_start?.slice(0, 7)}</span>,
      cardPosition: 'body' as const,
    },
    {
      key: 'type',
      header: '유형',
      render: (r) => (
        <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-700">
          {REQ_TYPE_LABEL[r.request_type] ?? r.request_type ?? '-'}
        </span>
      ),
      cardPosition: 'body' as const,
    },
    {
      key: 'item_count',
      header: '품목수',
      render: (r) => <span>{fmt(r.item_count ?? 0)}건</span>,
      sortable: true,
      sortValue: (r) => r.item_count ?? 0,
      cardPosition: 'body' as const,
    },
    {
      key: 'emergency',
      header: '긴급',
      render: (r) => r.is_emergency ? (
        <span className="inline-flex items-center gap-0.5 badge-red">
          <AlertTriangle className="w-3 h-3" />긴급
        </span>
      ) : <span className="text-slate-300">-</span>,
      cardPosition: 'hidden' as const,
    },
    {
      key: 'status',
      header: '상태',
      render: (r) => <span className={STATUS_CLS[r.status] || 'badge-gray'}>{STATUS_LABEL[r.status] || r.status}</span>,
      cardPosition: 'badge' as const,
    },
    {
      key: 'submitted_at',
      header: '제출일',
      render: (r) => <span className="text-xs text-slate-400">{r.submitted_at ? new Date(r.submitted_at).toLocaleDateString('ko-KR') : '-'}</span>,
      sortable: true,
      sortValue: (r) => r.submitted_at ?? '',
      cardPosition: 'body' as const,
    },
    {
      key: 'action',
      header: '',
      render: (r) => (
        <button
          onClick={(e) => { e.stopPropagation(); openDetail(r.id); }}
          className="text-xs text-teal-600 hover:text-teal-800 font-medium hover:underline"
        >
          검토
        </button>
      ),
      cardPosition: 'hidden' as const,
    },
  ], [list]);

  return (
    <div>
      {/* 페이지 헤더 */}
      <PageHeader
        icon={CheckCircle2}
        title="승인 처리"
        description="부서 물품 신청을 검토하고 승인합니다"
      />

      {/* 유형 필터 탭 */}
      <div className="flex gap-1.5 flex-wrap mb-4">
        {REQ_TYPE_TABS.map(({ v, l }) => {
          const count = v ? submittedDetails.filter((r) => r.request_type === v).length : submittedDetails.length;
          const color = v ? TYPE_COLOR[v] : '#1d4ed8';
          return (
            <button key={v} onClick={() => setReqTypeTab(v)} className="px-4 py-1.5 rounded-full text-sm font-medium border transition-all" style={filterBtn(reqTypeTab === v, color)}>
              {l}
              {count > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-xs" style={{ background: reqTypeTab === v ? 'rgba(255,255,255,0.3)' : '#e2e8f0', color: reqTypeTab === v ? 'white' : '#64748b' }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 페이지 탭 */}
      <div className="flex border-b border-slate-200 mb-5">
        {([
          { key: 'bulk' as const, label: '수량 조절', icon: Layers },
          { key: 'list' as const, label: '병동별 신청내역', icon: ClipboardList },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setPageTab(tab.key)}
            className={`inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              pageTab === tab.key
                ? 'border-teal-500 text-teal-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* 알림 메시지 */}
      {msg && (
        <div className={`mb-4 p-3 rounded-lg text-sm flex items-center gap-2 ${
          msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
        }`}>
          {msg.type === 'ok'
            ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
          {msg.text}
        </div>
      )}

      {/* ===== 수량 조절 탭 ===== */}
      {pageTab === 'bulk' && (
        <div className="space-y-4">
          {detailsLoading ? (
            <div className="flex items-center justify-center py-16 text-slate-400 text-sm gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> 로딩 중...
            </div>
          ) : filteredReqs.length === 0 ? (
            <EmptyState
              icon={FileText}
              message={reqTypeTab ? `대기 중인 ${REQ_TYPE_LABEL[reqTypeTab] ?? reqTypeTab} 신청이 없습니다.` : '처리 대기중인 신청이 없습니다.'}
            />
          ) : (
            <>
              {/* 범위 선택 */}
              <div className="card p-3 flex flex-wrap gap-2 items-center">
                <span className="text-sm text-slate-600 mr-1 inline-flex items-center gap-1">
                  <Building2 className="w-4 h-4 text-slate-400" /> 수량조절 범위
                </span>
                <button onClick={() => setAdjustScope('all')} className="px-3 py-1 rounded-full text-sm font-medium border transition-all" style={filterBtn(adjustScope === 'all', '#0ea5e9')}>전체</button>
                <button onClick={() => setAdjustScope('dept')} className="px-3 py-1 rounded-full text-sm font-medium border transition-all" style={filterBtn(adjustScope === 'dept', '#0ea5e9')}>부서별</button>
                {adjustScope === 'dept' && (
                  <div className="flex flex-wrap gap-1.5 ml-2">
                    {deptOptions.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => setSelectedDeptId(d.id)}
                        className="px-3 py-1 rounded-full text-sm font-medium border transition-all"
                        style={filterBtn(selectedDeptId === d.id, '#0ea5e9')}
                      >
                        {d.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 카테고리 필터 */}
              {distinctCats.length > 0 && (
                <div className="card p-3 flex flex-wrap gap-1.5 items-center">
                  <Tag className="w-4 h-4 text-slate-400 mr-1" />
                  <button onClick={() => setCatFilter('')} className="px-3 py-1 rounded-full text-sm font-medium border transition-all" style={filterBtn(!catFilter, '#14b8a6')}>전체 분류</button>
                  {distinctCats.map((cat) => (
                    <button key={cat} onClick={() => setCatFilter(cat)} className="px-3 py-1 rounded-full text-sm font-medium border transition-all" style={filterBtn(catFilter === cat, '#14b8a6')}>
                      {getCategoryLabel(cat)}
                    </button>
                  ))}
                </div>
              )}

              {/* 피벗 테이블 */}
              <div className="card p-0 overflow-hidden">
                <div className="overflow-auto" style={{ maxHeight: '460px' }}>
                  <table className="text-sm border-collapse w-full">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200" style={{ position: 'sticky', top: 0, zIndex: 20 }}>
                        <th className="text-left px-3 py-2.5 font-semibold text-slate-600 bg-slate-50" style={{ position: 'sticky', left: 0, zIndex: 30, minWidth: 200, borderRight: '1px solid #e2e8f0' }}>품목명</th>
                        <th className="px-2 py-2.5 font-semibold text-slate-600 text-center" style={{ minWidth: 50 }}>단위</th>
                        <th className="px-2 py-2.5 font-semibold text-slate-600 text-right" style={{ minWidth: 70 }}>단가</th>
                        {visibleDedupedReqs.map((req) => (
                          <th key={req.id} className="px-2 py-2.5 font-semibold text-center" style={{ minWidth: 100 }}>
                            <div className="text-slate-700">{req.department_name}</div>
                            <div className="flex items-center justify-center gap-1 mt-0.5">
                              {req.is_emergency && (
                                <span className="badge-red text-xs inline-flex items-center gap-0.5">
                                  <AlertTriangle className="w-3 h-3" />긴급
                                </span>
                              )}
                              {req.dupCount > 1 && <span className="text-xs px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">중복 {req.dupCount}건</span>}
                            </div>
                          </th>
                        ))}
                        <th className="px-2 py-2.5 font-semibold text-slate-600 text-right" style={{ minWidth: 60 }}>합계</th>
                        <th className="px-2 py-2.5 font-semibold text-slate-600 text-right" style={{ minWidth: 90 }}>금액</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.map((item) => {
                        const wardData = visibleDedupedReqs.map((req) => {
                          const reqItem = req.items.find((i) => i.item_id === item.item_id);
                          const qty = reqItem ? bulkQtys[req.id]?.[item.item_id] ?? reqItem.requested_qty : null;
                          return { req, reqItem, qty };
                        });
                        const totalQty = wardData.reduce((s, d) => s + (d.qty ?? 0), 0);
                        const totalAmt = totalQty * (item.latest_price ?? 0);
                        return (
                          <tr key={item.item_id} className="border-b border-slate-100 hover:bg-slate-50/50">
                            <td className="px-3 py-2 bg-white" style={{ position: 'sticky', left: 0, zIndex: 10, borderRight: '1px solid #e2e8f0' }}>
                              <div className="font-medium text-sm text-slate-800">
                                {item.is_custom && <span className="text-amber-500 text-xs mr-1">[직접입력]</span>}
                                {item.item_name || item.custom_name}
                              </div>
                              <div className="text-xs text-slate-400">
                                {item.is_custom ? (item.custom_spec || '규격 미입력') : item.item_code}
                              </div>
                              {(item as any).custom_link && (
                                <a href={(item as any).custom_link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-xs text-blue-500 hover:underline">
                                  <ExternalLink className="w-3 h-3" /> 참고 링크
                                </a>
                              )}
                            </td>
                            <td className="px-2 py-2 text-center text-xs text-slate-500">{item.uom}</td>
                            <td className="px-2 py-2 text-right text-xs text-slate-600">{item.latest_price ? fmt(item.latest_price) : '-'}</td>
                            {wardData.map(({ req, reqItem, qty }) => (
                              <td key={req.id} className="px-1.5 py-1.5 text-center">
                                {!reqItem ? (
                                  <span className="text-slate-200 text-xs">-</span>
                                ) : (
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    value={bulkInputDrafts[bulkInputKey(req.id, item.item_id)] ?? fmt(qty ?? 0)}
                                    onFocus={() => {
                                      setBulkInputDrafts((prev) => ({
                                        ...prev,
                                        [bulkInputKey(req.id, item.item_id)]: String(qty ?? 0),
                                      }));
                                    }}
                                    onChange={(e) => {
                                      const raw = toRawNumericText(e.target.value);
                                      setBulkInputDrafts((prev) => ({
                                        ...prev,
                                        [bulkInputKey(req.id, item.item_id)]: raw,
                                      }));
                                    }}
                                    onBlur={() => {
                                      const key = bulkInputKey(req.id, item.item_id);
                                      const raw = bulkInputDrafts[key] ?? String(qty ?? 0);
                                      const v = Math.max(0, parseNumericInput(raw));
                                      setBulkQtys((prev) => ({ ...prev, [req.id]: { ...(prev[req.id] ?? {}), [item.item_id]: v } }));
                                      setBulkInputDrafts((prev) => {
                                        const next = { ...prev };
                                        delete next[key];
                                        return next;
                                      });
                                    }}
                                    className="w-16 text-center text-sm border rounded px-1 py-0.5"
                                    style={qty !== reqItem.requested_qty ? { borderColor: '#f59e0b', background: '#fffbeb' } : { borderColor: '#e2e8f0' }}
                                  />
                                )}
                              </td>
                            ))}
                            <td className="px-2 py-2 text-right font-semibold text-sm text-slate-800">{fmt(totalQty)}</td>
                            <td className="px-2 py-2 text-right font-medium text-blue-700 text-sm">{item.latest_price ? fmt(totalAmt) : '-'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 처리 사유 */}
              <div className="card p-5">
                <div className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-slate-400" />
                  처리 사유 <span className="text-xs text-slate-400 font-normal">(부서별 입력)</span>
                </div>
                <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                  {(adjustScope === 'dept' ? visibleDedupedReqs : filteredReqs).map((req) => (
                    <div key={req.id}>
                      <label className="label">{req.department_name}</label>
                      <textarea rows={2} value={bulkReasons[req.id] ?? ''} onChange={(e) => setBulkReasons((prev) => ({ ...prev, [req.id]: e.target.value }))} className="input text-sm" placeholder="수량조정/반려 시 사유 필수" />
                    </div>
                  ))}
                </div>
              </div>

              {/* 하단 액션 바 */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-500">
                  <span className="font-semibold text-slate-700">{fmt(adjustScope === 'dept' ? visibleDedupedReqs.length : filteredReqs.length)}</span>건
                  {' '}<span className="font-semibold text-slate-700">{fmt(filteredItems.length)}</span>개 품목
                </span>
                <div className="flex items-center gap-3">
                  {filteredReqs.some(r => r.request_type === 'ADHOC' || (r.request_type === 'EQUIPMENT' && (r as any).equipment_request_type === 'ADDITION')) && (
                    <select value={bulkMethod} onChange={(e) => setBulkMethod(e.target.value as any)} className="input text-sm w-36">
                      <option value="PO">발주서 생성</option>
                      <option value="STOCK_OUT">재고 불출</option>
                    </select>
                  )}
                  <button
                    onClick={handleBulkApprove}
                    disabled={bulkSubmitting || (adjustScope === 'dept' ? visibleDedupedReqs.length === 0 : filteredReqs.length === 0)}
                    className="btn-primary inline-flex items-center gap-1.5"
                  >
                    {bulkSubmitting ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> 처리 중...</>
                    ) : (
                      <><Send className="w-4 h-4" /> 일괄 승인 ({fmt(adjustScope === 'dept' ? visibleDedupedReqs.length : filteredReqs.length)}건)</>
                    )}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ===== 병동별 신청내역 탭 ===== */}
      {pageTab === 'list' && (
        <>
          <FilterBar
            filters={[
              {
                key: 'status',
                label: '상태',
                options: [
                  { value: 'SUBMITTED', label: '제출(대기)' },
                  { value: 'APPROVED', label: '승인' },
                  { value: 'PARTIAL_APPROVED', label: '부분승인' },
                  { value: 'REJECTED', label: '반려' },
                  { value: 'CANCELLED', label: '취소' },
                  { value: 'ALL', label: '전체' },
                ],
                value: listStatus,
                onChange: (v) => { setListStatus(v); setListPage(1); },
              },
            ]}
          />
          {(() => {
            const listChips: FilterChip[] = [];
            if (listStatus && listStatus !== 'ALL') listChips.push({ key: 'status', label: '상태', value: STATUS_LABEL[listStatus] || listStatus, onRemove: () => { setListStatus('SUBMITTED'); setListPage(1); } });
            if (reqTypeTab) listChips.push({ key: 'reqType', label: '유형', value: REQ_TYPE_LABEL[reqTypeTab] || reqTypeTab, onRemove: () => { setReqTypeTab(''); setListPage(1); } });
            return <FilterChips chips={listChips} totalCount={list.length} onResetAll={() => { setListStatus('SUBMITTED'); setReqTypeTab(''); setListPage(1); }} />;
          })()}
          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-400 text-sm gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> 로딩 중...
            </div>
          ) : (
            <>
              <DataTable
                columns={listColumns}
                data={list.slice((listPage - 1) * listPageSize, listPage * listPageSize)}
                keyField="id"
                onRowClick={(r) => openDetail(r.id)}
                emptyMessage="신청 내역이 없습니다."
              />
              <Pagination
                currentPage={listPage}
                totalItems={list.length}
                pageSize={listPageSize}
                onPageChange={setListPage}
                onPageSizeChange={setListPageSize}
              />
            </>
          )}
        </>
      )}

      {/* ===== 상세 검토 모달 ===== */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        title={`${detail?.request_no ?? ''} 검토`}
        size="xl"
        footer={
          <>
            <button onClick={() => setDetail(null)} className="btn-secondary">취소</button>
            <button onClick={decide} disabled={submitting} className="btn-primary inline-flex items-center gap-1.5">
              {submitting ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> 처리 중...</>
              ) : (
                <><CheckCircle2 className="w-4 h-4" /> 승인 처리</>
              )}
            </button>
          </>
        }
      >
        {detail && (
          <div className="space-y-4">
            {/* 뱃지 영역 */}
            <div className="flex items-center gap-2 flex-wrap">
              {detail.is_emergency && (
                <span className="badge-red inline-flex items-center gap-0.5">
                  <AlertTriangle className="w-3 h-3" /> 긴급
                </span>
              )}
              {detail.request_type && (
                <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-slate-100 text-slate-700">
                  {REQ_TYPE_LABEL[detail.request_type] ?? detail.request_type}
                </span>
              )}
              {AUTO_PO_TYPES.includes(detail.request_type ?? '') && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium inline-flex items-center gap-0.5">
                  <Send className="w-3 h-3" /> 승인 시 자동 발주
                </span>
              )}
              {(detail as any).equipment_request_type && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  (detail as any).equipment_request_type === 'ADDITION' ? 'bg-blue-100 text-blue-700' :
                  (detail as any).equipment_request_type === 'DISPOSAL' ? 'bg-red-100 text-red-700' :
                  'bg-yellow-100 text-yellow-700'
                }`}>
                  {{ADDITION:'추가', DISPOSAL:'폐기', REPAIR:'수리'}[(detail as any).equipment_request_type as string] ?? (detail as any).equipment_request_type}
                </span>
              )}
            </div>

            {/* 기본 정보 */}
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div><span className="label">부서</span><p>{detail.department_name}</p></div>
              <div><span className="label">요청자</span><p>{detail.requester_name}</p></div>
              <div><span className="label">기간</span><p>{detail.period_start?.slice(0, 7)}</p></div>
            </div>

            {/* 품목 테이블 */}
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>품목</th>
                    <th className="text-right">요청수량</th>
                    <th className="text-right text-xs text-slate-400">최근6개월</th>
                    {(detail.request_type === 'EQUIPMENT' && (detail as any).equipment_request_type === 'ADDITION') && (
                      <th className="text-right">현재재고</th>
                    )}
                    <th className="text-right">승인수량</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((it, idx) => (
                    <tr key={it.item_id || `custom-${idx}`}>
                      <td>
                        {it.is_custom && <span className="text-amber-500 text-xs mr-1">[직접입력]</span>}
                        {it.item_name || it.custom_name}
                        {!it.is_custom && <span className="text-xs text-slate-400 ml-1">{it.item_code}</span>}
                        {it.is_custom && it.custom_spec && <span className="text-xs text-slate-400 ml-1">({it.custom_spec})</span>}
                        {(it as any).custom_link && (
                          <a href={(it as any).custom_link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-xs text-blue-500 hover:underline ml-1">
                            <ExternalLink className="w-3 h-3" /> 링크
                          </a>
                        )}
                      </td>
                      <td className="text-right">{fmt(it.requested_qty)}</td>
                      <td className="text-right">
                        {itemTrends[it.item_id] ? (
                          <div className="flex items-center gap-0.5 justify-end" title={`최근 6개월 불출: ${itemTrends[it.item_id].join(', ')}`}>
                            {itemTrends[it.item_id].map((q, idx) => (
                              <span key={idx} className={`text-[10px] px-1 py-0.5 rounded ${
                                idx === itemTrends[it.item_id].length - 1 ? 'bg-teal-100 text-teal-700 font-medium' : 'text-slate-400'
                              }`}>{q}</span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-300">-</span>
                        )}
                      </td>
                      {(detail.request_type === 'EQUIPMENT' && (detail as any).equipment_request_type === 'ADDITION') && (
                        <td className={`text-right text-sm font-medium ${(it.on_hand_qty ?? 0) === 0 ? 'text-red-500' : 'text-slate-600'}`}>
                          {it.on_hand_qty ?? 0}
                        </td>
                      )}
                      <td className="text-right">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={approvedInputDrafts[it.item_id] ?? fmt(approvedQtys[it.item_id] ?? it.requested_qty)}
                          onFocus={() => {
                            setApprovedInputDrafts((prev) => ({
                              ...prev,
                              [it.item_id]: String(approvedQtys[it.item_id] ?? it.requested_qty),
                            }));
                          }}
                          onChange={(e) => {
                            const raw = toRawNumericText(e.target.value);
                            setApprovedInputDrafts((prev) => ({ ...prev, [it.item_id]: raw }));
                          }}
                          onBlur={() => {
                            const raw = approvedInputDrafts[it.item_id] ?? String(approvedQtys[it.item_id] ?? it.requested_qty);
                            const v = Math.max(0, parseNumericInput(raw));
                            setApprovedQtys((prev) => ({ ...prev, [it.item_id]: v }));
                            setApprovedInputDrafts((prev) => {
                              const next = { ...prev };
                              delete next[it.item_id];
                              return next;
                            });
                          }}
                          className="input w-24 text-right inline-block"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 처리 방식 / 방법 */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">처리 방식</label>
                <select value={action} onChange={(e) => setAction(e.target.value as any)} className="input">
                  <option value="APPROVE">승인</option>
                  <option value="ADJUST">수량조정 승인</option>
                  <option value="REJECT">반려</option>
                </select>
              </div>
              {((detail.request_type === 'ADHOC') || (detail.request_type === 'EQUIPMENT' && (detail as any).equipment_request_type === 'ADDITION')) && action === 'APPROVE' && (
                <div>
                  <label className="label">처리 방법</label>
                  <select value={adhocMethod} onChange={(e) => setAdhocMethod(e.target.value as any)} className="input">
                    <option value="PO">발주서 생성</option>
                    <option value="STOCK_OUT">재고 불출</option>
                  </select>
                  {adhocMethod === 'STOCK_OUT' && detail.items.some(it => (it.on_hand_qty ?? 0) < (approvedQtys[it.item_id] ?? it.requested_qty)) && (
                    <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> 재고 부족 품목이 있습니다. 발주서 생성을 권장합니다.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* 처리 사유 */}
            <div>
              <label className="label">처리 사유</label>
              <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="input" placeholder="수량조정/반려 시 필수" />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
