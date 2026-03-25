import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import { PageHeader, FilterBar, DataTable, Modal, EmptyState, FilterChips, Pagination } from '../components/ui';
import type { Column, FilterChip } from '../components/ui';
import type { GoodsReceipt, Item, InventoryLocation, PendingReceiptFollowUp, PurchaseOrder } from '@shared/types';
import { PackageCheck, Plus, Search, Eye, RotateCcw, CheckCircle, XCircle, Trash2, Save } from 'lucide-react';

type ReceiptTabKey = 'REGISTER' | 'PENDING' | 'CONFIRMED' | 'DIFF_CONFIRMED' | 'REVERSED' | 'FOLLOW_UP' | 'ALL_LIST';

type CreateLine = {
  item_id: string;
  item_name: string;
  uom: string;
  received_qty: number;
  unit_price: number;
  location_id: string;
};

function toNumber(input: string | number | null | undefined): number {
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0;
  const cleaned = String(input ?? '').replace(/[^\d.-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fmt(n: number): string {
  return new Intl.NumberFormat('ko-KR').format(n || 0);
}

function toMonthLabel(dateLike: string | Date | null | undefined): string {
  const d = dateLike ? new Date(dateLike) : null;
  if (!d || Number.isNaN(d.getTime())) return '기간 미지정';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}

function formatShortDate(dateLike: string | Date | null | undefined): string {
  const d = dateLike ? new Date(dateLike) : null;
  if (!d || Number.isNaN(d.getTime())) return '-';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function sourceTypeLabel(sourceType?: string): string {
  switch (sourceType) {
    case 'CONSUMABLE_REGULAR':
      return '정기소모품';
    case 'DIAPER':
      return '기저귀';
    case 'NIGHT_SNACK':
      return '야간당직간식';
    case 'ADHOC':
      return '비정기';
    case 'EQUIPMENT':
      return '비품';
    case 'MANUAL':
    default:
      return '수동발주';
  }
}

type ReceiptTabDef = { key: ReceiptTabKey; label: string; count?: number };

const SOURCE_TYPE_ORDER: Record<string, number> = {
  CONSUMABLE_REGULAR: 0,
  DIAPER: 1,
  NIGHT_SNACK: 2,
  ADHOC: 3,
  EQUIPMENT: 4,
  MANUAL: 5,
};

export default function ReceiptsPage() {
  const [activeTab, setActiveTab] = useState<ReceiptTabKey>('PENDING');
  const [loading, setLoading] = useState(true);

  const [receipts, setReceipts] = useState<GoodsReceipt[]>([]);
  const [followUps, setFollowUps] = useState<PendingReceiptFollowUp[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [poPeriodMeta, setPoPeriodMeta] = useState<Record<string, { label: string; start: string }>>({});
  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);

  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [modal, setModal] = useState<'create' | 'verify' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);

  const [verifyDetail, setVerifyDetail] = useState<GoodsReceipt | null>(null);
  const [qtyInputByItemId, setQtyInputByItemId] = useState<Record<string, string>>({});
  const [noteInputByItemId, setNoteInputByItemId] = useState<Record<string, string>>({});

  const [rcptPage, setRcptPage] = useState(1);
  const [rcptPageSize, setRcptPageSize] = useState(20);

  const [form, setForm] = useState({ purchase_order_id: '', note: '' });
  const [grItems, setGrItems] = useState<CreateLine[]>([]);
  const [itemSearch, setItemSearch] = useState('');

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3000);
  };

  const loadReceipts = useCallback(async () => {
    const rows = await api('/receipts');
    setReceipts(Array.isArray(rows) ? rows : []);
  }, []);

  const loadFollowUps = useCallback(async () => {
    const rows = await api('/receipts/follow-ups?status=OPEN');
    setFollowUps(Array.isArray(rows) ? rows : []);
  }, []);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    try {
      const [receiptRows, orderRows, itemRows, locRows, followRows] = await Promise.all([
        api('/receipts'),
        api('/purchase-orders'),
        api('/items?is_active=true'),
        api('/inventory/locations'),
        api('/receipts/follow-ups?status=OPEN'),
      ]);

      const allReceipts = Array.isArray(receiptRows) ? receiptRows : [];
      const allOrders = Array.isArray(orderRows) ? orderRows : [];
      setReceipts(allReceipts);
      setOrders(allOrders.filter(o => ['DRAFT', 'SENT', 'PARTIAL_RECEIVED'].includes(o.status)));
      setItems(Array.isArray(itemRows) ? itemRows : []);
      setLocations(Array.isArray(locRows) ? locRows : []);
      setFollowUps(Array.isArray(followRows) ? followRows : []);

      const nextMeta: Record<string, { label: string; start: string }> = {};
      for (const po of allOrders) {
        if (!po?.id) continue;
        nextMeta[po.id] = {
          label: po.schedule_period_label || toMonthLabel(po.schedule_period_start || po.ordered_at),
          start: String(po.schedule_period_start || po.ordered_at || ''),
        };
      }
      setPoPeriodMeta(nextMeta);
    } catch (e) {
      console.error(e);
      showMsg('err', '데이터 조회 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (activeTab === 'REGISTER') {
      setModal('create');
    }
    setRcptPage(1);
  }, [activeTab]);

  const closeCreateModal = useCallback(() => {
    setModal(null);
    if (activeTab === 'REGISTER') {
      setActiveTab('PENDING');
    }
  }, [activeTab]);

  const pendingReceipts = useMemo(() => receipts.filter(r => r.status === 'PENDING'), [receipts]);
  const confirmedReceipts = useMemo(() => receipts.filter(r => r.status === 'CONFIRMED'), [receipts]);
  const diffConfirmedReceipts = useMemo(() => receipts.filter(r => r.status === 'DIFF_CONFIRMED'), [receipts]);
  const reversedReceipts = useMemo(() => receipts.filter(r => r.status === 'REVERSED'), [receipts]);

  const availableOrders = useMemo(() => {
    const receiptPoIds = new Set(
      receipts
        .map((r: any) => r?.purchase_order_id)
        .filter((id: any) => typeof id === 'string' && id.length > 0),
    );
    return orders.filter((o) => !receiptPoIds.has(o.id));
  }, [orders, receipts]);

  const groupedOrderOptions = useMemo(() => {
    const groupMap = new Map<string, { label: string; start: number; orders: PurchaseOrder[] }>();
    for (const o of availableOrders) {
      const periodLabel = o.schedule_period_label || toMonthLabel(o.schedule_period_start || o.ordered_at);
      const startDate = new Date(o.schedule_period_start || o.ordered_at || 0).getTime();
      const key = periodLabel;
      if (!groupMap.has(key)) {
        groupMap.set(key, { label: periodLabel, start: startDate, orders: [] });
      } else {
        const existing = groupMap.get(key)!;
        if (startDate > existing.start) existing.start = startDate;
      }
      groupMap.get(key)!.orders.push(o);
    }

    return Array.from(groupMap.values())
      .sort((a, b) => b.start - a.start)
      .map(g => ({
        ...g,
        orders: g.orders.sort((a, b) => {
          const aOrder = SOURCE_TYPE_ORDER[a.source_type || 'MANUAL'] ?? 999;
          const bOrder = SOURCE_TYPE_ORDER[b.source_type || 'MANUAL'] ?? 999;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return new Date(b.ordered_at).getTime() - new Date(a.ordered_at).getTime();
        }),
      }));
  }, [availableOrders]);

  const selectedOrder = useMemo(
    () => availableOrders.find(o => o.id === form.purchase_order_id) || null,
    [availableOrders, form.purchase_order_id],
  );

  const filteredItems = useMemo(() => {
    const q = itemSearch.trim();
    if (!q) return [];
    return items.filter(i => i.name.includes(q) || i.item_code.includes(q)).slice(0, 15);
  }, [itemSearch, items]);

  const addItem = (item: Item) => {
    if (grItems.find(g => g.item_id === item.id)) return;
    setGrItems(prev => [
      ...prev,
      {
        item_id: item.id,
        item_name: item.name,
        uom: item.uom,
        received_qty: 1,
        unit_price: item.latest_price || 0,
        location_id: locations[0]?.id || '',
      },
    ]);
    setItemSearch('');
  };

  const loadPOItems = async (poId: string) => {
    if (!poId) {
      setGrItems([]);
      return;
    }
    try {
      const po = await api(`/purchase-orders/${poId}`);
      const poItems = Array.isArray(po?.items) ? po.items : [];
      setGrItems(
        poItems.map((line: any) => ({
          item_id: line.item_id,
          item_name: line.item_name,
          uom: line.uom,
          received_qty: Number(line.ordered_qty || 0),
          unit_price: Number(line.unit_price || 0),
          location_id: locations[0]?.id || '',
        })),
      );
    } catch (e: any) {
      showMsg('err', e.message || '발주 품목을 불러오지 못했습니다.');
    }
  };

  const createReceipt = async () => {
    if (grItems.length === 0) {
      showMsg('err', '품목을 1개 이상 추가하세요.');
      return;
    }
    if (grItems.some(g => !g.location_id)) {
      showMsg('err', '모든 품목의 입고 위치를 선택하세요.');
      return;
    }

    setSubmitting(true);
    try {
      await api('/receipts', {
        method: 'POST',
        body: JSON.stringify({
          purchase_order_id: form.purchase_order_id || null,
          note: form.note,
          items: grItems.map(g => ({
            item_id: g.item_id,
            received_qty: g.received_qty,
            unit_price: g.unit_price,
            location_id: g.location_id,
          })),
        }),
      });
      showMsg('ok', '입고가 검수 대기로 등록되었습니다.');
      setModal(null);
      setForm({ purchase_order_id: '', note: '' });
      setGrItems([]);
      setActiveTab('PENDING');
      await loadReceipts();
    } catch (e: any) {
      showMsg('err', e.message || '입고 등록에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  const openVerifyModal = async (receiptId: string) => {
    setVerifyLoading(true);
    setModal('verify');
    try {
      const detail = await api(`/receipts/${receiptId}/verify`);
      setVerifyDetail(detail);
      const qtyMap: Record<string, string> = {};
      const noteMap: Record<string, string> = {};
      for (const line of detail?.items || []) {
        qtyMap[line.item_id] = fmt(Number(line.confirmed_qty ?? line.received_qty ?? 0));
        noteMap[line.item_id] = String(line.diff_note ?? '');
      }
      setQtyInputByItemId(qtyMap);
      setNoteInputByItemId(noteMap);
    } catch (e: any) {
      setModal(null);
      showMsg('err', e.message || '검수 상세를 불러오지 못했습니다.');
    } finally {
      setVerifyLoading(false);
    }
  };

  const saveVerifyLine = async (itemId: string) => {
    if (!verifyDetail) return;
    const qty = toNumber(qtyInputByItemId[itemId]);
    const diffNote = String(noteInputByItemId[itemId] || '');
    try {
      await api(`/receipts/${verifyDetail.id}/verify/lines/${itemId}`, {
        method: 'POST',
        body: JSON.stringify({ confirmed_qty: qty, diff_note: diffNote }),
      });
      const refreshed = await api(`/receipts/${verifyDetail.id}/verify`);
      setVerifyDetail(refreshed);
      showMsg('ok', '검수 라인을 저장했습니다.');
    } catch (e: any) {
      showMsg('err', e.message || '라인 저장에 실패했습니다.');
    }
  };

  const confirmVerify = async () => {
    if (!verifyDetail) return;
    if (!confirm('검수 확정 시 재고가 반영됩니다. 계속하시겠습니까?')) return;
    setSubmitting(true);
    try {
      await api(`/receipts/${verifyDetail.id}/verify/confirm`, { method: 'POST' });
      showMsg('ok', '검수확정이 완료되었습니다.');
      setModal(null);
      setVerifyDetail(null);
      await Promise.all([loadReceipts(), loadFollowUps()]);
    } catch (e: any) {
      showMsg('err', e.message || '검수확정에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  const reverseReceipt = async (id: string) => {
    const reason = prompt('역전(취소) 사유를 입력하세요.');
    if (!reason || !reason.trim()) return;
    try {
      await api(`/receipts/${id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      showMsg('ok', '역전 처리되었습니다.');
      await Promise.all([loadReceipts(), loadFollowUps()]);
    } catch (e: any) {
      showMsg('err', e.message || '역전 처리에 실패했습니다.');
    }
  };

  const resolveFollowUp = async (id: string) => {
    try {
      await api(`/receipts/follow-ups/${id}/resolve`, { method: 'POST', body: JSON.stringify({}) });
      showMsg('ok', '미입고 대기건을 해결 처리했습니다.');
      await loadFollowUps();
    } catch (e: any) {
      showMsg('err', e.message || '처리에 실패했습니다.');
    }
  };

  const cancelFollowUp = async (id: string) => {
    try {
      await api(`/receipts/follow-ups/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
      showMsg('ok', '미입고 대기건을 취소 처리했습니다.');
      await loadFollowUps();
    } catch (e: any) {
      showMsg('err', e.message || '처리에 실패했습니다.');
    }
  };

  const statusBadge = (status: string) => {
    if (status === 'PENDING') return <span className="badge-yellow">검수 대기</span>;
    if (status === 'CONFIRMED') return <span className="badge-green">확정</span>;
    if (status === 'DIFF_CONFIRMED') return <span className="badge-orange">차이 확정</span>;
    if (status === 'REVERSED') return <span className="badge-red">역전</span>;
    return <span className="badge-gray">{status}</span>;
  };

  const receiptsForTab = useMemo(() => {
    if (activeTab === 'PENDING') return pendingReceipts;
    if (activeTab === 'CONFIRMED') return confirmedReceipts;
    if (activeTab === 'DIFF_CONFIRMED') return diffConfirmedReceipts;
    if (activeTab === 'REVERSED') return reversedReceipts;
    return [];
  }, [activeTab, pendingReceipts, confirmedReceipts, diffConfirmedReceipts, reversedReceipts]);

  const tabDefs = useMemo<ReceiptTabDef[]>(
    () => [
      { key: 'REGISTER', label: '입고등록' },
      { key: 'PENDING', label: '검수대기', count: pendingReceipts.length },
      { key: 'CONFIRMED', label: '확정완료', count: confirmedReceipts.length },
      { key: 'DIFF_CONFIRMED', label: '차이확정', count: diffConfirmedReceipts.length },
      { key: 'REVERSED', label: '역전', count: reversedReceipts.length },
      { key: 'FOLLOW_UP', label: '미입고대기', count: followUps.length },
      { key: 'ALL_LIST', label: '입고등록리스트', count: receipts.length },
    ],
    [pendingReceipts.length, confirmedReceipts.length, diffConfirmedReceipts.length, reversedReceipts.length, followUps.length, receipts.length],
  );

  const periodGroups = useMemo(() => {
    const groups = new Map<string, { label: string; start: string; rows: GoodsReceipt[] }>();
    for (const r of receiptsForTab) {
      const poMeta = r.purchase_order_id ? poPeriodMeta[r.purchase_order_id] : undefined;
      const label = poMeta?.label || toMonthLabel(r.received_at);
      const start = poMeta?.start || String(r.received_at);
      const key = `${label}__${start}`;
      if (!groups.has(key)) groups.set(key, { label, start, rows: [] });
      groups.get(key)!.rows.push(r);
    }

    return Array.from(groups.values())
      .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
      .map(g => ({ ...g, rows: g.rows.sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime()) }));
  }, [receiptsForTab, poPeriodMeta]);

  const allPeriodGroups = useMemo(() => {
    const groups = new Map<string, {
      label: string;
      start: string;
      byStatus: Record<'PENDING' | 'CONFIRMED' | 'DIFF_CONFIRMED' | 'REVERSED', GoodsReceipt[]>;
    }>();

    for (const r of receipts) {
      const poMeta = r.purchase_order_id ? poPeriodMeta[r.purchase_order_id] : undefined;
      const label = poMeta?.label || toMonthLabel(r.received_at);
      const start = poMeta?.start || String(r.received_at);
      const key = label;
      if (!groups.has(key)) {
        groups.set(key, {
          label,
          start,
          byStatus: { PENDING: [], CONFIRMED: [], DIFF_CONFIRMED: [], REVERSED: [] },
        });
      }
      const group = groups.get(key)!;
      if (new Date(start).getTime() > new Date(group.start).getTime()) group.start = start;
      if (r.status === 'PENDING' || r.status === 'CONFIRMED' || r.status === 'DIFF_CONFIRMED' || r.status === 'REVERSED') {
        group.byStatus[r.status].push(r);
      }
    }

    return Array.from(groups.values())
      .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
      .map((g) => ({
        ...g,
        byStatus: {
          PENDING: g.byStatus.PENDING.sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime()),
          CONFIRMED: g.byStatus.CONFIRMED.sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime()),
          DIFF_CONFIRMED: g.byStatus.DIFF_CONFIRMED.sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime()),
          REVERSED: g.byStatus.REVERSED.sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime()),
        },
      }));
  }, [receipts, poPeriodMeta]);

  const statusSectionLabel: Record<'PENDING' | 'CONFIRMED' | 'DIFF_CONFIRMED' | 'REVERSED', string> = {
    PENDING: '검수대기',
    CONFIRMED: '확정완료',
    DIFF_CONFIRMED: '차이확정',
    REVERSED: '역전',
  };

  /* DataTable columns for the receipt list per period group */
  const receiptColumns: Column<GoodsReceipt>[] = useMemo(() => [
    {
      key: 'gr_no',
      header: '입고번호',
      cardPosition: 'title' as const,
      sortable: true,
      sortValue: (r: GoodsReceipt) => r.gr_no,
      render: (r: GoodsReceipt) => <span className="font-medium text-accent-600">{r.gr_no}</span>,
    },
    {
      key: 'po_no',
      header: '발주번호',
      cardPosition: 'subtitle' as const,
      render: (r: GoodsReceipt) => <span className="text-xs">{r.po_no || '-'}</span>,
    },
    {
      key: 'item_count',
      header: '품목수',
      cardPosition: 'body' as const,
      render: (r: GoodsReceipt) => <>{r.items?.length || 0}건</>,
    },
    {
      key: 'received_at',
      header: '등록일',
      cardPosition: 'body' as const,
      sortable: true,
      sortValue: (r: GoodsReceipt) => new Date(r.received_at).getTime(),
      render: (r: GoodsReceipt) => <span className="text-xs text-gray-500">{new Date(r.received_at).toLocaleDateString('ko-KR')}</span>,
    },
    {
      key: 'status',
      header: '상태',
      cardPosition: 'badge' as const,
      render: (r: GoodsReceipt) => statusBadge(r.status),
    },
    {
      key: 'diff_count',
      header: '차이건수',
      cardPosition: 'body' as const,
      render: (r: GoodsReceipt) => <>{fmt(Number(r.diff_count || 0))}</>,
    },
    {
      key: 'actions',
      header: '',
      cardPosition: 'hidden' as const,
      render: (r: GoodsReceipt) => (
        <div className="flex gap-2">
          {r.status === 'PENDING' ? (
            <button className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1" onClick={(e) => { e.stopPropagation(); openVerifyModal(r.id); }}>
              <CheckCircle className="w-3.5 h-3.5" /> 검수
            </button>
          ) : (
            <button className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1" onClick={(e) => { e.stopPropagation(); openVerifyModal(r.id); }}>
              <Eye className="w-3.5 h-3.5" /> 상세
            </button>
          )}
          {r.status !== 'REVERSED' && (
            <button className="text-xs text-red-500 hover:underline inline-flex items-center gap-1" onClick={(e) => { e.stopPropagation(); reverseReceipt(r.id); }}>
              <RotateCcw className="w-3.5 h-3.5" /> 역전
            </button>
          )}
        </div>
      ),
    },
  ], [activeTab]);

  /* DataTable columns for follow-ups */
  const followUpColumns: Column<PendingReceiptFollowUp>[] = useMemo(() => [
    {
      key: 'po_no',
      header: '발주번호',
      cardPosition: 'title' as const,
      render: (row: PendingReceiptFollowUp) => <span className="text-xs">{row.po_no || '-'}</span>,
    },
    {
      key: 'vendor_name',
      header: '업체',
      cardPosition: 'subtitle' as const,
      render: (row: PendingReceiptFollowUp) => <>{row.vendor_name || '-'}</>,
    },
    {
      key: 'item_name',
      header: '품목',
      cardPosition: 'body' as const,
      render: (row: PendingReceiptFollowUp) => <>{row.item_name}</>,
    },
    {
      key: 'missing_qty',
      header: '미입고수량',
      className: 'text-right',
      cardPosition: 'badge' as const,
      render: (row: PendingReceiptFollowUp) => <span className="font-medium">{fmt(Number(row.missing_qty || 0))}</span>,
    },
    {
      key: 'created_at',
      header: '생성일',
      cardPosition: 'body' as const,
      render: (row: PendingReceiptFollowUp) => <span className="text-xs">{new Date(row.created_at).toLocaleDateString('ko-KR')}</span>,
    },
    {
      key: 'status',
      header: '상태',
      cardPosition: 'body' as const,
      render: (row: PendingReceiptFollowUp) => <>{row.status}</>,
    },
    {
      key: 'actions',
      header: '',
      cardPosition: 'hidden' as const,
      render: (row: PendingReceiptFollowUp) => (
        <div className="flex gap-2">
          <button className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1" onClick={(e) => { e.stopPropagation(); resolveFollowUp(row.id); }}>
            <CheckCircle className="w-3.5 h-3.5" /> 해결완료
          </button>
          <button className="text-xs text-red-500 hover:underline inline-flex items-center gap-1" onClick={(e) => { e.stopPropagation(); cancelFollowUp(row.id); }}>
            <XCircle className="w-3.5 h-3.5" /> 취소
          </button>
        </div>
      ),
    },
  ], []);

  return (
    <div>
      <PageHeader
        icon={PackageCheck}
        title="입고 처리"
        description="발주 물품의 입고를 처리합니다"
        actions={
          <button onClick={() => setActiveTab('REGISTER')} className="btn-primary w-full sm:w-auto justify-center inline-flex items-center gap-1.5">
            <Plus className="w-4 h-4" />
            입고 등록
          </button>
        }
      />

      {msg && <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}

      <div className="flex gap-2 mb-3 overflow-x-auto pb-1 whitespace-nowrap">
        {tabDefs.map((t) => {
          const active = activeTab === t.key;
          const showCount = t.key === 'PENDING' || t.key === 'FOLLOW_UP';
          return (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-semibold border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${
                active
                  ? 'bg-[#0f9e93] text-white border-[#0f9e93] focus-visible:ring-[#6fd3cb]'
                  : 'bg-[#f3f4f6] text-[#334155] border-[#e5e7eb] hover:bg-[#eceff3] focus-visible:ring-[#cbd5e1]'
              }`}
            >
              <span>{t.label}</span>
              {showCount ? (
                <span
                  className={`inline-flex min-w-5 h-5 px-1.5 items-center justify-center rounded-full text-xs font-bold ${
                    active ? 'bg-white/30 text-white' : 'bg-[#e2e8f0] text-[#475569]'
                  }`}
                >
                  {fmt(t.count || 0)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {(() => {
        const rcptChips: FilterChip[] = [];
        const activeTabLabel = tabDefs.find(t => t.key === activeTab)?.label;
        if (activeTab !== 'PENDING' && activeTabLabel) {
          rcptChips.push({ key: 'tab', label: '탭', value: activeTabLabel, onRemove: () => { setActiveTab('PENDING'); setRcptPage(1); } });
        }
        const currentCount =
          activeTab === 'FOLLOW_UP' ? followUps.length :
          activeTab === 'ALL_LIST' ? receipts.length :
          activeTab === 'REGISTER' ? 0 :
          receiptsForTab.length;
        return <FilterChips chips={rcptChips} totalCount={currentCount} onResetAll={() => { setActiveTab('PENDING'); setRcptPage(1); }} />;
      })()}

      {loading ? (
        <div className="card p-0 overflow-hidden">
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm">로딩 중...</div>
        </div>
      ) : activeTab === 'REGISTER' ? (
        <div className="card p-0 overflow-hidden">
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm">입고등록 창을 여는 중...</div>
        </div>
      ) : activeTab === 'FOLLOW_UP' ? (
        <>
          <DataTable<PendingReceiptFollowUp>
            columns={followUpColumns}
            data={followUps.slice((rcptPage - 1) * rcptPageSize, rcptPage * rcptPageSize)}
            keyField="id"
            emptyMessage="미입고 대기건이 없습니다."
          />
          <Pagination
            currentPage={rcptPage}
            totalItems={followUps.length}
            pageSize={rcptPageSize}
            onPageChange={setRcptPage}
            onPageSizeChange={setRcptPageSize}
          />
        </>
      ) : activeTab === 'ALL_LIST' ? (
        allPeriodGroups.length === 0 ? (
          <EmptyState message="입고 내역이 없습니다." />
        ) : (
          <div className="space-y-4">
            {allPeriodGroups.map((group) => (
              <div key={`${group.label}-${group.start}`} className="rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
                  <span className="text-sm font-semibold text-navy-800">{group.label}</span>
                  <span className="text-xs text-gray-500">기간 라벨</span>
                </div>
                {(['PENDING', 'CONFIRMED', 'DIFF_CONFIRMED', 'REVERSED'] as const).map((statusKey) => {
                  const rows = group.byStatus[statusKey];
                  if (!rows.length) return null;
                  return (
                    <div key={statusKey} className="border-t border-gray-100">
                      <div className="px-3 py-2 bg-white text-xs font-semibold text-gray-600">{statusSectionLabel[statusKey]}</div>
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>입고번호</th>
                            <th>발주번호</th>
                            <th>품목수</th>
                            <th>등록일</th>
                            <th>상태</th>
                            <th>차이건수</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={r.id}>
                              <td className="font-medium text-accent-600">{r.gr_no}</td>
                              <td className="text-xs">{r.po_no || '-'}</td>
                              <td>{r.items?.length || 0}건</td>
                              <td className="text-xs text-gray-500">{new Date(r.received_at).toLocaleDateString('ko-KR')}</td>
                              <td>{statusBadge(r.status)}</td>
                              <td>{fmt(Number(r.diff_count || 0))}</td>
                              <td>
                                <div className="flex gap-2">
                                  {statusKey === 'PENDING' ? (
                                    <button className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1" onClick={() => openVerifyModal(r.id)}>
                                      <CheckCircle className="w-3.5 h-3.5" /> 검수
                                    </button>
                                  ) : (
                                    <button className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1" onClick={() => openVerifyModal(r.id)}>
                                      <Eye className="w-3.5 h-3.5" /> 상세
                                    </button>
                                  )}
                                  {statusKey !== 'REVERSED' && (
                                    <button className="text-xs text-red-500 hover:underline inline-flex items-center gap-1" onClick={() => reverseReceipt(r.id)}>
                                      <RotateCcw className="w-3.5 h-3.5" /> 역전
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )
      ) : periodGroups.length === 0 ? (
        <EmptyState message="해당 상태의 입고 내역이 없습니다." />
      ) : (
        <>
          <div className="space-y-4">
            {periodGroups.map(group => {
              const paginatedRows = group.rows.slice((rcptPage - 1) * rcptPageSize, rcptPage * rcptPageSize);
              return (
                <div key={`${group.label}-${group.start}`} className="rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
                    <span className="text-sm font-semibold text-navy-800">{group.label}</span>
                    <span className="text-xs text-gray-500">기간 라벨</span>
                  </div>
                  <DataTable<GoodsReceipt>
                    columns={receiptColumns}
                    data={paginatedRows}
                    keyField="id"
                    onRowClick={(r) => openVerifyModal(r.id)}
                    emptyMessage="입고 내역이 없습니다."
                  />
                </div>
              );
            })}
          </div>
          <Pagination
            currentPage={rcptPage}
            totalItems={receiptsForTab.length}
            pageSize={rcptPageSize}
            onPageChange={setRcptPage}
            onPageSizeChange={setRcptPageSize}
          />
        </>
      )}

      {/* 입고 등록 모달 */}
      <Modal open={modal === 'create'} onClose={closeCreateModal} title="입고 등록" size="xl"
        footer={
          <>
            <button className="btn-secondary" onClick={closeCreateModal}>취소</button>
            <button className="btn-primary inline-flex items-center gap-1.5" onClick={createReceipt} disabled={submitting || grItems.length === 0}>
              <PackageCheck className="w-4 h-4" />
              {submitting ? '처리 중...' : '입고 등록(검수 대기)'}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
          <div>
            <label className="label">연결 발주서(선택)</label>
            <select
              value={form.purchase_order_id}
              onChange={e => { setForm(f => ({ ...f, purchase_order_id: e.target.value })); loadPOItems(e.target.value); }}
              className="input"
            >
              <option value="">발주서 없음 (직접 입력)</option>
              {groupedOrderOptions.map(group => (
                <optgroup key={`${group.label}-${group.start}`} label={group.label}>
                  {group.orders.map(o => (
                    <option key={o.id} value={o.id}>
                      {`${o.po_no} · [${sourceTypeLabel(o.source_type)}] ${o.vendor_name || '-'} · 예정 ${formatShortDate(o.expected_at)}`}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {availableOrders.length === 0 && (
              <p className="mt-1 text-xs text-gray-500">등록 가능한 발주서가 없습니다. (이미 등록됨)</p>
            )}
          </div>
          <div>
            <label className="label">비고</label>
            <input className="input" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
          </div>
        </div>

        {selectedOrder && (
          <div className="mb-4 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 flex flex-wrap gap-y-1">
            <span className="mr-3">기간라벨: <b>{selectedOrder.schedule_period_label || toMonthLabel(selectedOrder.schedule_period_start || selectedOrder.ordered_at)}</b></span>
            <span className="mr-3">유형: <b>{sourceTypeLabel(selectedOrder.source_type)}</b></span>
            <span className="mr-3">업체: <b>{selectedOrder.vendor_name || '-'}</b></span>
            <span className="mr-3">예정입고일: <b>{formatShortDate(selectedOrder.expected_at)}</b></span>
            <span>발주상태: <b>{selectedOrder.status}</b></span>
          </div>
        )}

        <div className="section-title">입고 품목</div>
        {!form.purchase_order_id && (
          <div className="relative mb-3">
            <input type="text" value={itemSearch} onChange={e => setItemSearch(e.target.value)} className="input" placeholder="품목 추가 검색..." />
            {filteredItems.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                {filteredItems.map(item => (
                  <button key={item.id} onClick={() => addItem(item)} className="w-full text-left px-4 py-2 hover:bg-gray-50 text-sm border-b border-gray-50 last:border-0">
                    <span className="font-medium">{item.name}</span>
                    <span className="text-gray-400 ml-2 text-xs">{item.item_code}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {grItems.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="tbl">
              <thead>
                <tr>
                  <th>품목</th>
                  <th className="text-right">수량</th>
                  <th className="text-right">단가</th>
                  <th>입고 위치</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {grItems.map(g => (
                  <tr key={g.item_id}>
                    <td>{g.item_name} <span className="text-xs text-gray-400">{g.uom}</span></td>
                    <td>
                      <input
                        className="input w-20 sm:w-24 text-right"
                        value={fmt(g.received_qty)}
                        onChange={e => {
                          const next = toNumber(e.target.value);
                          setGrItems(prev => prev.map(i => i.item_id === g.item_id ? { ...i, received_qty: next } : i));
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="input w-24 sm:w-28 text-right"
                        value={fmt(g.unit_price)}
                        onChange={e => {
                          const next = toNumber(e.target.value);
                          setGrItems(prev => prev.map(i => i.item_id === g.item_id ? { ...i, unit_price: next } : i));
                        }}
                      />
                    </td>
                    <td>
                      <select
                        className="input"
                        value={g.location_id}
                        onChange={e => setGrItems(prev => prev.map(i => i.item_id === g.item_id ? { ...i, location_id: e.target.value } : i))}
                      >
                        <option value="">위치 선택</option>
                        {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <button className="text-xs text-red-500 hover:underline inline-flex items-center gap-1" onClick={() => setGrItems(prev => prev.filter(i => i.item_id !== g.item_id))}>
                        <Trash2 className="w-3.5 h-3.5" /> 삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      {/* 검수 상세 모달 */}
      <Modal
        open={modal === 'verify'}
        onClose={() => setModal(null)}
        title={verifyDetail?.gr_no || '검수 상세'}
        size="xl"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setModal(null)}>닫기</button>
            {verifyDetail?.status === 'PENDING' && (
              <button className="btn-primary inline-flex items-center gap-1.5" onClick={confirmVerify} disabled={submitting}>
                <CheckCircle className="w-4 h-4" />
                {submitting ? '처리 중...' : '검수확정'}
              </button>
            )}
          </>
        }
      >
        {verifyLoading || !verifyDetail ? (
          <div className="py-10 text-center text-sm text-gray-400">불러오는 중...</div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4 text-sm">
              <div><span className="label">발주번호</span><p>{verifyDetail.po_no || '-'}</p></div>
              <div><span className="label">등록일</span><p>{new Date(verifyDetail.received_at).toLocaleDateString('ko-KR')}</p></div>
              <div><span className="label">상태</span><div>{statusBadge(verifyDetail.status)}</div></div>
              <div><span className="label">차이건수</span><p>{fmt(Number(verifyDetail.diff_count || 0))}</p></div>
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>품목</th>
                    <th className="text-right">기대수량</th>
                    <th className="text-right">실입고확정수량</th>
                    <th className="text-right">차이</th>
                    <th>사유</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(verifyDetail.items || []).map(line => {
                    const expected = Number(line.expected_qty ?? line.received_qty ?? 0);
                    const confirmed = toNumber(qtyInputByItemId[line.item_id] ?? line.confirmed_qty ?? line.received_qty ?? 0);
                    const diff = confirmed - expected;
                    return (
                      <tr key={line.id || line.item_id}>
                        <td>{line.item_name} <span className="text-xs text-gray-400">{line.uom}</span></td>
                        <td className="text-right">{fmt(expected)}</td>
                        <td>
                          <input
                            className="input w-24 sm:w-28 text-right"
                            value={qtyInputByItemId[line.item_id] ?? fmt(Number(line.confirmed_qty ?? line.received_qty ?? 0))}
                            onChange={e => setQtyInputByItemId(prev => ({ ...prev, [line.item_id]: e.target.value }))}
                            onBlur={e => {
                              const n = toNumber(e.target.value);
                              setQtyInputByItemId(prev => ({ ...prev, [line.item_id]: fmt(n) }));
                            }}
                            disabled={verifyDetail.status !== 'PENDING'}
                          />
                        </td>
                        <td className={`text-right ${diff === 0 ? '' : 'text-red-600 font-semibold'}`}>{fmt(diff)}</td>
                        <td>
                          <input
                            className="input"
                            value={noteInputByItemId[line.item_id] ?? line.diff_note ?? ''}
                            onChange={e => setNoteInputByItemId(prev => ({ ...prev, [line.item_id]: e.target.value }))}
                            disabled={verifyDetail.status !== 'PENDING'}
                            placeholder={diff !== 0 ? '차이 사유 입력' : ''}
                          />
                        </td>
                        <td>
                          {verifyDetail.status === 'PENDING' && (
                            <button className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1" onClick={() => saveVerifyLine(line.item_id)}>
                              <Save className="w-3.5 h-3.5" /> 임시저장
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
