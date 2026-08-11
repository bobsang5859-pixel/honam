import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import { PageHeader, FilterBar, DataTable, Modal, EmptyState, FilterChips, Pagination, DateRangeFilter, inDateRange } from '../components/ui';
import type { Column, FilterChip, DateRange } from '../components/ui';
import type { GoodsReceipt, Item, InventoryLocation, PendingReceiptFollowUp, PurchaseOrder, Vendor } from '@shared/types';
import { PackageCheck, Plus, Search, Eye, RotateCcw, CheckCircle, XCircle, Trash2, Save } from 'lucide-react';
import { ReceiptHierarchyList } from './components/ReceiptHierarchyList';

type ReceiptTabKey = 'REGISTER' | 'PENDING' | 'COMPLETED' | 'FOLLOW_UP';
type CompletedView = 'all' | 'confirmed' | 'diff' | 'reversed';

type CreateLine = {
  item_id: string;
  item_name: string;
  uom: string;
  issue_uom?: string;
  pack_size?: number;
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
  const [dateRange, setDateRange] = useState<DateRange>({ from: '', to: '' });
  const filteredReceipts = useMemo(
    () => receipts.filter(r => inDateRange((r as any).received_at, dateRange)),
    [receipts, dateRange],
  );
  const [followUps, setFollowUps] = useState<PendingReceiptFollowUp[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [poPeriodMeta, setPoPeriodMeta] = useState<Record<string, { label: string; start: string }>>({});
  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);

  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [modal, setModal] = useState<'create' | 'verify' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);

  const [verifyDetail, setVerifyDetail] = useState<GoodsReceipt | null>(null);
  const [qtyInputByItemId, setQtyInputByItemId] = useState<Record<string, string>>({});
  const [noteInputByItemId, setNoteInputByItemId] = useState<Record<string, string>>({});

  const [rcptPage, setRcptPage] = useState(1);
  const [rcptPageSize, setRcptPageSize] = useState(20);

  const [form, setForm] = useState({ purchase_order_id: '', note: '', adjustment_amount: 0, adjustment_sign: 'MINUS' as 'MINUS' | 'PLUS', adjustment_note: '', received_at: '', vendor_id: '' });
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
      const [receiptRows, orderRows, itemRows, locRows, followRows, vendorRows] = await Promise.all([
        api('/receipts'),
        api('/purchase-orders'),
        api('/items?is_active=true'),
        api('/inventory/locations'),
        api('/receipts/follow-ups?status=OPEN'),
        api('/vendors?is_active=true'),
      ]);

      const allReceipts = Array.isArray(receiptRows) ? receiptRows : [];
      const allOrders = Array.isArray(orderRows) ? orderRows : [];
      setReceipts(allReceipts);
      setOrders(allOrders.filter(o => ['DRAFT', 'SENT', 'PARTIAL_RECEIVED'].includes(o.status)));
      setItems(Array.isArray(itemRows) ? itemRows : []);
      // 입고 위치 정렬 — 「총무구매 창고(CENTRAL)」 를 맨 위로 (기본값으로 잡히도록)
      //   그 외는 기존 code 알파벳 순 유지. 부서 보관함이 첫 번째로 와서 잘못 입고되던 문제 해결.
      const rawLocs = Array.isArray(locRows) ? locRows : [];
      const sortedLocs = [...rawLocs].sort((a: any, b: any) => {
        if (a.code === 'CENTRAL') return -1;
        if (b.code === 'CENTRAL') return 1;
        return 0;
      });
      setLocations(sortedLocs);
      setFollowUps(Array.isArray(followRows) ? followRows : []);
      setVendors(Array.isArray(vendorRows) ? vendorRows : []);

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

  const pendingReceipts = useMemo(() => filteredReceipts.filter(r => r.status === 'PENDING'), [filteredReceipts]);
  const confirmedReceipts = useMemo(() => filteredReceipts.filter(r => r.status === 'CONFIRMED'), [filteredReceipts]);
  const diffConfirmedReceipts = useMemo(() => filteredReceipts.filter(r => r.status === 'DIFF_CONFIRMED'), [filteredReceipts]);
  const reversedReceipts = useMemo(() => filteredReceipts.filter(r => r.status === 'REVERSED'), [filteredReceipts]);

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
        uom: item.purchase_uom ?? item.uom,
        issue_uom: (item as any).issue_uom ?? item.uom,
        pack_size: Number((item as any).pack_size ?? 1),
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
          uom: line.purchase_uom ?? line.uom,
          issue_uom: line.issue_uom ?? line.uom,
          pack_size: Number(line.pack_size ?? 1),
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
    // 라인별 사전 검증 — 어느 라인이 문제인지 명시. 단가 음수 허용 (절사 품목 호환).
    for (let i = 0; i < grItems.length; i++) {
      const g = grItems[i] as any;
      const issues: string[] = [];
      if (!g.item_id) issues.push('품목 마스터 미연결 (자유입력 라인)');
      if (!g.location_id) issues.push('입고 위치 미선택');
      if (Number(g.received_qty ?? 0) < 0) issues.push('수량이 음수');
      if (issues.length > 0) {
        showMsg('err', `${i + 1}번째 라인 (${g.item_name ?? '?'}) — ${issues.join(' / ')}`);
        return;
      }
    }

    setSubmitting(true);
    try {
      await api('/receipts', {
        method: 'POST',
        body: JSON.stringify({
          purchase_order_id: form.purchase_order_id || null,
          note: form.note,
          // 저장식: 최종금액 = 라인합계 - adjustment_amount → 가산(+)은 음수로 저장.
          adjustment_amount: Math.max(0, Number(form.adjustment_amount ?? 0)) * (form.adjustment_sign === 'PLUS' ? -1 : 1),
          adjustment_note: form.adjustment_note,
          received_at: form.received_at || null,
          vendor_id: form.purchase_order_id ? null : (form.vendor_id || null),
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
      setForm({ purchase_order_id: '', note: '', adjustment_amount: 0, adjustment_sign: 'MINUS', adjustment_note: '', received_at: '', vendor_id: '' });
      setGrItems([]);
      setActiveTab('PENDING');
      await loadReceipts();
    } catch (e: any) {
      showMsg('err', e.message || '입고 등록에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  // 입고일자 수정용 — 검수 모달 안에서 인라인 편집
  const [receivedAtEdit, setReceivedAtEdit] = useState('');
  const [savingReceivedAt, setSavingReceivedAt] = useState(false);
  // 거래처 수정용 (발주서 미연결 입고만 편집 가능)
  const [vendorEdit, setVendorEdit] = useState('');
  const [savingVendor, setSavingVendor] = useState(false);

  const toDateInputValue = (iso: any) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  };

  const openVerifyModal = async (receiptId: string) => {
    setVerifyLoading(true);
    setModal('verify');
    try {
      const detail = await api(`/receipts/${receiptId}/verify`);
      setVerifyDetail(detail);
      setReceivedAtEdit(toDateInputValue(detail?.received_at));
      setVendorEdit(String(detail?.manual_vendor_id ?? ''));
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

  const saveReceivedAt = async () => {
    if (!verifyDetail || !receivedAtEdit) return;
    if (toDateInputValue(verifyDetail.received_at) === receivedAtEdit) return;
    setSavingReceivedAt(true);
    try {
      await api(`/receipts/${verifyDetail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ received_at: receivedAtEdit }),
      });
      const refreshed = await api(`/receipts/${verifyDetail.id}/verify`);
      setVerifyDetail(refreshed);
      setReceivedAtEdit(toDateInputValue(refreshed?.received_at));
      showMsg('ok', '입고일자를 수정했습니다.');
      await loadReceipts();
    } catch (e: any) {
      showMsg('err', e.message || '입고일자 수정에 실패했습니다.');
    } finally {
      setSavingReceivedAt(false);
    }
  };

  const saveVendor = async () => {
    if (!verifyDetail) return;
    if (String((verifyDetail as any).manual_vendor_id ?? '') === vendorEdit) return;
    setSavingVendor(true);
    try {
      await api(`/receipts/${verifyDetail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ vendor_id: vendorEdit || null }),
      });
      const refreshed = await api(`/receipts/${verifyDetail.id}/verify`);
      setVerifyDetail(refreshed);
      setVendorEdit(String(refreshed?.manual_vendor_id ?? ''));
      showMsg('ok', '거래처를 수정했습니다.');
      await loadReceipts();
    } catch (e: any) {
      showMsg('err', e.message || '거래처 수정에 실패했습니다.');
    } finally {
      setSavingVendor(false);
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

  const [completedView, setCompletedView] = useState<CompletedView>('all');
  const receiptsForTab = useMemo(() => {
    if (activeTab === 'PENDING') return pendingReceipts;
    if (activeTab === 'COMPLETED') {
      if (completedView === 'confirmed') return confirmedReceipts;
      if (completedView === 'diff') return diffConfirmedReceipts;
      if (completedView === 'reversed') return reversedReceipts;
      // 'all' = 정상확정 + 차이확정 + 역전 (날짜 desc)
      return [...confirmedReceipts, ...diffConfirmedReceipts, ...reversedReceipts]
        .sort((a: any, b: any) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime());
    }
    return [];
  }, [activeTab, completedView, pendingReceipts, confirmedReceipts, diffConfirmedReceipts, reversedReceipts]);

  const completedTotal = confirmedReceipts.length + diffConfirmedReceipts.length + reversedReceipts.length;
  const tabDefs = useMemo<ReceiptTabDef[]>(
    () => [
      { key: 'PENDING',   label: '검수대기',     count: pendingReceipts.length },
      { key: 'COMPLETED', label: '입고완료',     count: completedTotal },
      { key: 'FOLLOW_UP', label: '미입고대기',   count: followUps.length },
    ],
    [pendingReceipts.length, completedTotal, followUps.length],
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

    for (const r of filteredReceipts) {
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
  }, [filteredReceipts, poPeriodMeta]);

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
          return (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`h-10 shrink-0 rounded-full px-4 text-sm font-semibold border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${
                active
                  ? 'bg-[#0f9e93] text-white border-[#0f9e93] focus-visible:ring-[#6fd3cb]'
                  : 'bg-[#f3f4f6] text-[#334155] border-[#e5e7eb] hover:bg-[#eceff3] focus-visible:ring-[#cbd5e1]'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'COMPLETED' && (
        <div className="flex items-center gap-1 mb-3">
          {([
            ['all',       '전체'],
            ['confirmed', '정상확정'],
            ['diff',      '차이있음'],
            ['reversed',  '역전됨'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => { setCompletedView(k); setRcptPage(1); }}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                completedView === k
                  ? 'bg-teal-600 text-white border-teal-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="mb-3">
        <DateRangeFilter value={dateRange} onChange={setDateRange} label="입고일" />
      </div>

      {(() => {
        const rcptChips: FilterChip[] = [];
        const activeTabLabel = tabDefs.find(t => t.key === activeTab)?.label;
        if (activeTab !== 'PENDING' && activeTabLabel) {
          rcptChips.push({ key: 'tab', label: '탭', value: activeTabLabel, onRemove: () => { setActiveTab('PENDING'); setRcptPage(1); } });
        }
        const currentCount =
          activeTab === 'FOLLOW_UP' ? followUps.length :
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
      ) : periodGroups.length === 0 ? (
        <EmptyState message="해당 상태의 입고 내역이 없습니다." />
      ) : (
        <ReceiptHierarchyList
          receipts={receiptsForTab}
          openVerify={openVerifyModal}
          fmt={fmt}
          canReverse
          reverse={reverseReceipt}
          onPeriodChanged={loadReceipts}
        />
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
          <div>
            <label className="label">입고일자</label>
            <input
              type="date"
              className="input"
              value={form.received_at}
              onChange={e => setForm(f => ({ ...f, received_at: e.target.value }))}
            />
            <p className="mt-1 text-xs text-gray-500">비워두면 오늘 날짜로 등록. 과거 입고를 소급 등록할 때 지정.</p>
          </div>
          <div>
            <label className="label">거래처</label>
            {form.purchase_order_id ? (
              <div className="input bg-gray-50 text-gray-600 text-sm flex items-center">
                {selectedOrder?.vendor_name || '-'} <span className="ml-2 text-xs text-gray-400">(발주서에서 자동)</span>
              </div>
            ) : (
              <select
                className="input"
                value={form.vendor_id}
                onChange={e => setForm(f => ({ ...f, vendor_id: e.target.value }))}
              >
                <option value="">선택 안 함 (품목 기본 거래처로 자동)</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            )}
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
                  <th className="text-right">수량 (발주단위)</th>
                  <th className="text-right">단가 (발주단위)</th>
                  <th>입고 위치</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {grItems.map(g => (
                  <tr key={g.item_id}>
                    <td>
                      <div>{g.item_name}</div>
                      <div className="text-xs text-slate-400">
                        {g.uom}
                        {Number(g.pack_size ?? 1) > 1 && g.issue_uom && g.issue_uom !== g.uom &&
                          <span className="text-blue-500 ml-1">(1{g.uom}={g.pack_size}{g.issue_uom})</span>
                        }
                      </div>
                    </td>
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

        {/* 절사·가산 (인라인) */}
        <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <div>
            <label className="text-xs text-slate-500">절사/가산</label>
            <div className="flex gap-1">
              <button
                type="button"
                className={`px-2.5 py-2 rounded-lg text-xs font-semibold border ${form.adjustment_sign === 'MINUS' ? 'bg-red-50 text-red-600 border-red-200' : 'bg-white text-slate-400 border-gray-200'}`}
                onClick={() => setForm(f => ({ ...f, adjustment_sign: 'MINUS' }))}
              >
                − 절사
              </button>
              <button
                type="button"
                className={`px-2.5 py-2 rounded-lg text-xs font-semibold border ${form.adjustment_sign === 'PLUS' ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-white text-slate-400 border-gray-200'}`}
                onClick={() => setForm(f => ({ ...f, adjustment_sign: 'PLUS' }))}
              >
                + 가산
              </button>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-500">금액 (₩)</label>
            <input
              type="number"
              min={0}
              value={form.adjustment_amount || 0}
              onChange={e => setForm(f => ({ ...f, adjustment_amount: Math.max(0, Number(e.target.value || 0)) }))}
              className="input w-28"
            />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="text-xs text-slate-500">사유</label>
            <input
              type="text"
              placeholder={form.adjustment_sign === 'PLUS' ? '배송비, 설치비 등 가산 사유 (선택)' : '원단위 절사 등 (선택)'}
              value={form.adjustment_note}
              onChange={e => setForm(f => ({ ...f, adjustment_note: e.target.value }))}
              className="input"
            />
          </div>
          {grItems.length > 0 && (
            <div className="text-right text-sm">
              <div className="text-xs text-slate-500">최종 총액</div>
              <div className="font-bold text-blue-700">
                ₩{Math.round(
                  grItems.reduce((s, g) => s + Number(g.received_qty || 0) * Number(g.unit_price || 0), 0)
                  + (form.adjustment_sign === 'PLUS' ? 1 : -1) * Number(form.adjustment_amount || 0)
                ).toLocaleString('ko-KR')}
              </div>
            </div>
          )}
        </div>
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
              <div><span className="label">발주번호</span><p>{verifyDetail.po_no || <span className="text-gray-400">수기 등록</span>}</p></div>
              <div>
                <span className="label">거래처</span>
                {verifyDetail.purchase_order_id ? (
                  <p className="text-sm">{verifyDetail.vendor_name || '-'} <span className="text-xs text-gray-400">(발주서)</span></p>
                ) : verifyDetail.status === 'REVERSED' ? (
                  <p className="text-sm">{verifyDetail.vendor_name || '-'}</p>
                ) : (
                  <div className="flex items-center gap-1">
                    <select
                      className="input flex-1 text-sm"
                      value={vendorEdit}
                      onChange={e => setVendorEdit(e.target.value)}
                      disabled={savingVendor}
                    >
                      <option value="">선택 안 함</option>
                      {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                    {vendorEdit !== String(verifyDetail.manual_vendor_id ?? '') && (
                      <button
                        className="btn-primary text-xs px-2 py-1 whitespace-nowrap"
                        onClick={saveVendor}
                        disabled={savingVendor}
                      >
                        {savingVendor ? '저장 중' : '저장'}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div>
                <span className="label">입고일자</span>
                <div className="flex items-center gap-1">
                  <input
                    type="date"
                    className="input flex-1"
                    value={receivedAtEdit}
                    onChange={e => setReceivedAtEdit(e.target.value)}
                    disabled={verifyDetail.status === 'REVERSED' || savingReceivedAt}
                  />
                  {receivedAtEdit && receivedAtEdit !== toDateInputValue(verifyDetail.received_at) && (
                    <button
                      className="btn-primary text-xs px-2 py-1 whitespace-nowrap"
                      onClick={saveReceivedAt}
                      disabled={savingReceivedAt}
                    >
                      {savingReceivedAt ? '저장 중' : '저장'}
                    </button>
                  )}
                </div>
              </div>
              <div><span className="label">상태</span><div>{statusBadge(verifyDetail.status)}</div></div>
              <div><span className="label">차이건수</span><p>{fmt(Number(verifyDetail.diff_count || 0))}</p></div>
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>품목</th>
                    <th className="text-right">기대수량(발주단위)</th>
                    <th className="text-right">확정수량(발주단위)</th>
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
                        <td>
                          <div>{line.item_name}</div>
                          <div className="text-xs text-slate-400">
                            {line.uom}
                            {Number(line.pack_size ?? 1) > 1 && line.issue_uom && line.issue_uom !== line.uom &&
                              <span className="text-blue-500 ml-1">(1{line.uom}={line.pack_size}{line.issue_uom})</span>
                            }
                          </div>
                        </td>
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
