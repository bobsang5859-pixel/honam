import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import { useToast } from '../components/Toast';
import { PageHeader, FilterBar, DataTable, Modal, EmptyState, FilterChips, Pagination } from '../components/ui';
import type { Column, FilterChip } from '../components/ui';
import {
  PackageOpen,
  Plus,
  Printer,
  CheckCircle2,
  RotateCcw,
  Eye,
  ClipboardCheck,
  Trash2,
  Search,
} from 'lucide-react';
import type {
  Item,
  InventoryLocation,
  StockOut,
  StockOutFollowUp,
  StockOutReceiptConfirmResponse,
  StockOutReceiptDetail,
  StockOutWorkboardResponse,
} from '@shared/types';

type PageTab = 'workboard' | 'receipt' | 'followup' | 'history';
type FollowUpStatusFilter = 'OPEN' | 'RESOLVED' | 'CANCELLED' | 'ALL';

type ManualIssueItem = {
  item_id: string;
  item_name: string;
  uom: string;
  issued_qty_text: string;
  location_id: string;
  on_hand_qty: number;
};

type IssueDraft = {
  issue_qty_text: string;
  location_id: string;
};

const STATUS_LABEL: Record<string, string> = {
  RECEIPT_PENDING: '수령검수 대기',
  RECEIPT_CONFIRMED: '수령확정',
  RECEIPT_DIFF: '차이확정',
  REVERSED: '역전',
  POSTED: '불출완료',
};

const STATUS_CLS: Record<string, string> = {
  RECEIPT_PENDING: 'badge-blue',
  RECEIPT_CONFIRMED: 'badge-green',
  RECEIPT_DIFF: 'badge-yellow',
  REVERSED: 'badge-red',
  POSTED: 'badge-gray',
};

const REQUEST_TYPE_OPTIONS = [
  { value: '', label: '전체 유형' },
  { value: 'CONSUMABLE_REGULAR', label: '정기소모품' },
  { value: 'DIAPER', label: '기저귀' },
  { value: 'NIGHT_SNACK', label: '야간당직간식' },
  { value: 'ADHOC', label: '비정기' },
  { value: 'EQUIPMENT', label: '비품' },
];

const FOLLOW_UP_STATUS_OPTIONS: Array<{ value: FollowUpStatusFilter; label: string }> = [
  { value: 'OPEN', label: '열림' },
  { value: 'RESOLVED', label: '완료' },
  { value: 'CANCELLED', label: '취소' },
  { value: 'ALL', label: '전체' },
];

const FOLLOW_UP_STATUS_CLS: Record<string, string> = {
  OPEN: 'badge-orange',
  RESOLVED: 'badge-green',
  CANCELLED: 'badge-gray',
};

const FOLLOW_UP_ACTION_LABEL: Record<string, string> = {
  ISSUE_ADD: '추가불출',
  COLLECT_BACK: '회수',
};

function fmt(value: number): string {
  return new Intl.NumberFormat('ko-KR').format(value);
}

function parseNumericInput(value: string): number {
  const onlyDigits = String(value ?? '').replace(/[^\d]/g, '');
  if (!onlyDigits) return 0;
  const n = Number(onlyDigits);
  return Number.isFinite(n) ? n : 0;
}

function lineKey(wardRequestId: string, itemId: string): string {
  return `${wardRequestId}::${itemId}`;
}

export default function StockOutPage() {
  const { showToast } = useToast();
  const [tab, setTab] = useState<PageTab>('workboard');

  const [stockOuts, setStockOuts] = useState<StockOut[]>([]);
  const [receipts, setReceipts] = useState<any[]>([]);
  const [followUps, setFollowUps] = useState<StockOutFollowUp[]>([]);
  const [workboard, setWorkboard] = useState<StockOutWorkboardResponse | null>(null);

  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [depts, setDepts] = useState<any[]>([]);

  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingReceipts, setLoadingReceipts] = useState(true);
  const [loadingFollowUps, setLoadingFollowUps] = useState(true);
  const [loadingWorkboard, setLoadingWorkboard] = useState(true);

  const [modal, setModal] = useState<'create' | 'detail' | null>(null);
  const [detail, setDetail] = useState<StockOut | null>(null);

  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [receiptDetail, setReceiptDetail] = useState<StockOutReceiptDetail | null>(null);
  const [receiptQtyDrafts, setReceiptQtyDrafts] = useState<Record<string, string>>({});
  const [receiptNoteDrafts, setReceiptNoteDrafts] = useState<Record<string, string>>({});
  const [confirmingReceipt, setConfirmingReceipt] = useState(false);

  const [submittingManualIssue, setSubmittingManualIssue] = useState(false);
  const [submittingWorkboardIssue, setSubmittingWorkboardIssue] = useState(false);

  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [manualIssueForm, setManualIssueForm] = useState({ department_id: '', note: '' });
  const [manualIssueItems, setManualIssueItems] = useState<ManualIssueItem[]>([]);
  const [manualItemSearch, setManualItemSearch] = useState('');

  const [followUpStatusFilter, setFollowUpStatusFilter] = useState<FollowUpStatusFilter>('OPEN');
  const [filters, setFilters] = useState({
    request_type: '',
    period_label: '',
    department_id: '',
    only_emergency: false,
  });

  const [selectedLineKeys, setSelectedLineKeys] = useState<Record<string, boolean>>({});
  const [issueDrafts, setIssueDrafts] = useState<Record<string, IssueDraft>>({});

  // Pagination states per tab
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(20);
  const [receiptPage, setReceiptPage] = useState(1);
  const [receiptPageSize, setReceiptPageSize] = useState(20);
  const [followUpPage, setFollowUpPage] = useState(1);
  const [followUpPageSize, setFollowUpPageSize] = useState(20);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3500);
  };

  const loadHistory = useCallback(() => {
    setLoadingHistory(true);
    api('/stock-out')
      .then((rows) => setStockOuts(rows || []))
      .catch(() => { setStockOuts([]); showToast('불출 이력을 불러오지 못했습니다.', 'error'); })
      .finally(() => setLoadingHistory(false));
  }, [showToast]);

  const loadReceipts = useCallback(() => {
    setLoadingReceipts(true);
    api('/stock-out/receipts')
      .then((rows) => setReceipts(rows || []))
      .catch(() => { setReceipts([]); showToast('수령검수 목록을 불러오지 못했습니다.', 'error'); })
      .finally(() => setLoadingReceipts(false));
  }, [showToast]);

  const loadFollowUps = useCallback((status: FollowUpStatusFilter) => {
    setLoadingFollowUps(true);
    const q = status === 'ALL' ? '?status=ALL' : `?status=${status}`;
    api(`/stock-out/follow-ups${q}`)
      .then((rows) => setFollowUps(rows || []))
      .catch(() => { setFollowUps([]); showToast('후속조치 목록을 불러오지 못했습니다.', 'error'); })
      .finally(() => setLoadingFollowUps(false));
  }, [showToast]);

  const loadWorkboard = useCallback(() => {
    setLoadingWorkboard(true);
    const params = new URLSearchParams();
    if (filters.request_type) params.set('request_type', filters.request_type);
    if (filters.period_label) params.set('period_label', filters.period_label);
    if (filters.department_id) params.set('department_id', filters.department_id);
    if (filters.only_emergency) params.set('only_emergency', 'true');
    const query = params.toString();
    api(`/stock-out/workboard${query ? `?${query}` : ''}`)
      .then((data) => setWorkboard(data))
      .catch(() =>
        setWorkboard({
          summary: {
            department_count: 0,
            request_count: 0,
            line_count: 0,
            total_approved_qty: 0,
            total_issued_qty: 0,
            total_remaining_qty: 0,
          },
          department_groups: [],
          item_totals: [],
          rows: [],
        })
      )
      .finally(() => setLoadingWorkboard(false));
  }, [filters.department_id, filters.only_emergency, filters.period_label, filters.request_type]);

  useEffect(() => {
    loadWorkboard();
    loadReceipts();
    loadFollowUps(followUpStatusFilter);
    loadHistory();
  }, [followUpStatusFilter, loadFollowUps, loadHistory, loadReceipts, loadWorkboard]);

  useEffect(() => {
    api('/items?is_active=true').then((rows) => setItems(rows || [])).catch(() => setItems([]));
    api('/inventory/locations').then((rows) => setLocations(rows || [])).catch(() => setLocations([]));
    api('/departments').then((rows) => setDepts(rows || [])).catch(() => setDepts([]));
  }, []);

  const workboardRows = useMemo(() => workboard?.rows ?? [], [workboard]);
  const periodLabelOptions = useMemo(() => {
    const labels = Array.from(new Set(workboardRows.map((r) => r.period_label).filter(Boolean)));
    return labels.sort((a, b) => a.localeCompare(b, 'ko'));
  }, [workboardRows]);

  useEffect(() => {
    const nextDrafts: Record<string, IssueDraft> = {};
    const nextSelected: Record<string, boolean> = {};
    for (const row of workboardRows) {
      const key = lineKey(row.ward_request_id, row.item_id);
      const prev = issueDrafts[key];
      nextDrafts[key] = {
        issue_qty_text: prev?.issue_qty_text ?? fmt(Number(row.remaining_qty || 0)),
        location_id: prev?.location_id || row.recommended_location_id || locations[0]?.id || '',
      };
      nextSelected[key] = selectedLineKeys[key] ?? false;
    }
    setIssueDrafts(nextDrafts);
    setSelectedLineKeys(nextSelected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workboardRows, locations]);

  const filteredManualItems = useMemo(() => {
    const q = manualItemSearch.trim();
    if (!q) return [];
    return items.filter((it) => it.name.includes(q) || it.item_code.includes(q)).slice(0, 15);
  }, [items, manualItemSearch]);

  const selectedWorkboardRows = useMemo(
    () => workboardRows.filter((row) => selectedLineKeys[lineKey(row.ward_request_id, row.item_id)]),
    [selectedLineKeys, workboardRows]
  );

  const followUpCounts = useMemo(() => {
    const result = { OPEN: 0, RESOLVED: 0, CANCELLED: 0, ALL: followUps.length };
    for (const row of followUps) {
      if (row.status === 'OPEN') result.OPEN += 1;
      if (row.status === 'RESOLVED') result.RESOLVED += 1;
      if (row.status === 'CANCELLED') result.CANCELLED += 1;
    }
    return result;
  }, [followUps]);

  const addManualIssueItem = (item: Item) => {
    if (manualIssueItems.some((row) => row.item_id === item.id)) return;
    setManualIssueItems((prev) => [
      ...prev,
      {
        item_id: item.id,
        item_name: item.name,
        uom: item.uom,
        issued_qty_text: '1',
        location_id: locations[0]?.id || '',
        on_hand_qty: Number(item.on_hand_qty ?? 0),
      },
    ]);
    setManualItemSearch('');
  };

  const setIssueDraftQty = (key: string, raw: string) => {
    const digits = raw.replace(/[^\d]/g, '');
    setIssueDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { issue_qty_text: '', location_id: '' }), issue_qty_text: digits } }));
  };

  const toggleSelectAllVisible = () => {
    const allSelected = workboardRows.length > 0 && workboardRows.every((row) => selectedLineKeys[lineKey(row.ward_request_id, row.item_id)]);
    const next: Record<string, boolean> = {};
    for (const row of workboardRows) next[lineKey(row.ward_request_id, row.item_id)] = !allSelected;
    setSelectedLineKeys(next);
  };

  const createManualIssue = async () => {
    if (!manualIssueForm.department_id) return showMsg('err', '불출 부서를 선택해주세요.');
    if (manualIssueItems.length === 0) return showMsg('err', '불출 품목을 추가해주세요.');
    if (manualIssueItems.some((row) => !row.location_id)) return showMsg('err', '위치를 선택해주세요.');
    const lines = manualIssueItems.map((row) => ({
      item_id: row.item_id,
      issued_qty: parseNumericInput(row.issued_qty_text),
      location_id: row.location_id,
    }));
    if (lines.some((line) => line.issued_qty <= 0)) return showMsg('err', '불출수량은 1 이상이어야 합니다.');

    setSubmittingManualIssue(true);
    try {
      await api('/stock-out', {
        method: 'POST',
        body: JSON.stringify({
          department_id: manualIssueForm.department_id,
          note: manualIssueForm.note,
          items: lines,
        }),
      });
      showMsg('ok', '불출 등록 완료.');
      setModal(null);
      setManualIssueForm({ department_id: '', note: '' });
      setManualIssueItems([]);
      loadHistory();
      loadReceipts();
      loadWorkboard();
    } catch (e: any) {
      showMsg('err', e.message || '불출 등록 실패');
    } finally {
      setSubmittingManualIssue(false);
    }
  };

  const openIssueDetail = async (id: string) => {
    try {
      const row: StockOut = await api(`/stock-out/${id}`);
      setDetail(row);
      setModal('detail');
    } catch (e: any) {
      showMsg('err', e.message || '상세 조회 실패');
    }
  };

  const reverseIssue = async (id: string) => {
    if (!confirm('불출을 역전 처리하시겠습니까?')) return;
    const reason = prompt('역전 사유를 입력해주세요.');
    if (!reason?.trim()) return showMsg('err', '역전 사유를 입력해주세요.');
    try {
      await api(`/stock-out/${id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      showMsg('ok', '역전 처리 완료');
      loadHistory();
      loadReceipts();
      loadWorkboard();
    } catch (e: any) {
      showMsg('err', e.message || '역전 실패');
    }
  };

  const openReceiptDetail = async (id: string) => {
    try {
      const data: StockOutReceiptDetail = await api(`/stock-out/${id}/receipt`);
      const qty: Record<string, string> = {};
      const note: Record<string, string> = {};
      for (const it of data.items) {
        qty[it.item_id] = it.received_qty == null ? '' : fmt(Number(it.received_qty));
        note[it.item_id] = it.receipt_note ?? '';
      }
      setReceiptQtyDrafts(qty);
      setReceiptNoteDrafts(note);
      setReceiptDetail(data);
      setReceiptModalOpen(true);
    } catch (e: any) {
      showMsg('err', e.message || '검수 상세 조회 실패');
    }
  };

  const fillReceiptQtyAsIssued = () => {
    if (!receiptDetail) return;
    const qty: Record<string, string> = {};
    for (const it of receiptDetail.items) qty[it.item_id] = fmt(Number(it.issued_qty || 0));
    setReceiptQtyDrafts(qty);
  };

  const saveReceiptDraft = async () => {
    if (!receiptDetail) return;
    for (const it of receiptDetail.items) {
      const raw = receiptQtyDrafts[it.item_id] ?? '';
      if (!raw.trim()) return showMsg('err', `실수령수량 입력 필요 (${it.item_name ?? it.item_id})`);
      await api(`/stock-out/${receiptDetail.id}/receipt/lines/${it.item_id}`, {
        method: 'POST',
        body: JSON.stringify({
          received_qty: parseNumericInput(raw),
          receipt_note: String(receiptNoteDrafts[it.item_id] ?? '').trim(),
        }),
      });
    }
    const refreshed: StockOutReceiptDetail = await api(`/stock-out/${receiptDetail.id}/receipt`);
    setReceiptDetail(refreshed);
    loadReceipts();
    loadHistory();
    showMsg('ok', '검수 임시저장 완료');
  };

  const confirmReceipt = async () => {
    if (!receiptDetail) return;
    setConfirmingReceipt(true);
    try {
      await saveReceiptDraft();
      const result: StockOutReceiptConfirmResponse = await api(`/stock-out/${receiptDetail.id}/receipt/confirm`, { method: 'POST' });
      const refreshed: StockOutReceiptDetail = await api(`/stock-out/${receiptDetail.id}/receipt`);
      setReceiptDetail(refreshed);
      setFollowUpStatusFilter('OPEN');
      loadFollowUps('OPEN');
      loadWorkboard();
      showMsg('ok', result.follow_up_count > 0 ? `검수 확정 완료 (후속작업 ${fmt(result.follow_up_count)}건 생성)` : '검수 확정 완료');
    } catch (e: any) {
      showMsg('err', e.message || '검수 확정 실패');
    } finally {
      setConfirmingReceipt(false);
    }
  };

  const confirmWorkboardIssue = async () => {
    if (selectedWorkboardRows.length === 0) return showMsg('err', '선택된 라인이 없습니다.');
    const grouped = new Map<string, Array<{ item_id: string; issue_qty: number; location_id: string }>>();
    for (const row of selectedWorkboardRows) {
      const key = lineKey(row.ward_request_id, row.item_id);
      const draft = issueDrafts[key];
      const issueQty = parseNumericInput(draft?.issue_qty_text ?? '');
      const locationId = String(draft?.location_id ?? '');
      if (issueQty <= 0) return showMsg('err', `${row.item_name} 수량을 확인해주세요.`);
      if (issueQty > Number(row.remaining_qty || 0)) return showMsg('err', `${row.item_name} 잔여수량을 초과했습니다.`);
      if (!locationId) return showMsg('err', `${row.item_name} 위치를 선택해주세요.`);
      if (!grouped.has(row.ward_request_id)) grouped.set(row.ward_request_id, []);
      grouped.get(row.ward_request_id)!.push({ item_id: row.item_id, issue_qty: issueQty, location_id: locationId });
    }
    setSubmittingWorkboardIssue(true);
    try {
      for (const [wardRequestId, lines] of grouped.entries()) {
        await api(`/stock-out/workboard/${wardRequestId}/issue`, {
          method: 'POST',
          body: JSON.stringify({ lines, note: '[WORKBOARD] 선택 불출 확정' }),
        });
      }
      showMsg('ok', `${fmt(grouped.size)}건 신청 불출 확정 완료`);
      setSelectedLineKeys({});
      loadWorkboard();
      loadReceipts();
      loadHistory();
      setTab('receipt');
    } catch (e: any) {
      showMsg('err', e.message || '불출 확정 실패');
    } finally {
      setSubmittingWorkboardIssue(false);
    }
  };

  const printPickingSheet = () => {
    if (selectedWorkboardRows.length === 0) return showMsg('err', '선택된 라인이 없습니다.');
    const rows = selectedWorkboardRows.map((row) => {
      const key = lineKey(row.ward_request_id, row.item_id);
      return { ...row, issue_qty: parseNumericInput(issueDrafts[key]?.issue_qty_text ?? '') };
    });
    const popup = window.open('', '_blank', 'width=1024,height=860');
    if (!popup) return showMsg('err', '팝업 차단으로 출력할 수 없습니다.');
    popup.document.write(`
      <html><head><title>피킹시트</title><style>
      body{font-family:'Noto Sans KR',sans-serif;padding:20px;color:#0f172a}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th,td{border:1px solid #cbd5e1;padding:6px 8px} th{background:#f8fafc;text-align:left}
      </style></head><body>
      <h2>부서 피킹시트</h2>
      <table><thead><tr><th>부서</th><th>신청번호</th><th>품목</th><th>잔여</th><th>불출예정</th><th>위치</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${r.department_name}</td><td>${r.request_no}</td><td>${r.item_name}</td><td style="text-align:right;">${fmt(Number(r.remaining_qty || 0))}</td><td style="text-align:right;">${fmt(Number(r.issue_qty || 0))}</td><td>${r.recommended_location_name || '-'}</td></tr>`).join('')}
      </tbody></table></body></html>`);
    popup.document.close();
    popup.focus();
    popup.print();
  };

  const resolveFollowUp = async (id: string) => {
    if (!confirm('후속작업을 완료 처리하시겠습니까?')) return;
    try {
      await api(`/stock-out/follow-ups/${id}/resolve`, { method: 'POST', body: JSON.stringify({}) });
      showMsg('ok', '후속작업 완료 처리됨');
      loadFollowUps(followUpStatusFilter);
    } catch (e: any) {
      showMsg('err', e.message || '후속작업 완료 처리 실패');
    }
  };

  const cancelFollowUp = async (id: string) => {
    if (!confirm('후속작업을 취소하시겠습니까?')) return;
    try {
      await api(`/stock-out/follow-ups/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
      showMsg('ok', '후속작업 취소됨');
      loadFollowUps(followUpStatusFilter);
    } catch (e: any) {
      showMsg('err', e.message || '후속작업 취소 실패');
    }
  };

  const createIssueFromFollowUp = async (id: string) => {
    if (!confirm('추가불출을 생성하시겠습니까?')) return;
    try {
      await api(`/stock-out/follow-ups/${id}/create-issue`, { method: 'POST', body: JSON.stringify({}) });
      showMsg('ok', '추가불출 생성 완료');
      loadFollowUps(followUpStatusFilter);
      loadWorkboard();
      loadReceipts();
      loadHistory();
    } catch (e: any) {
      showMsg('err', e.message || '추가불출 생성 실패');
    }
  };

  /* ── History DataTable columns ── */
  const historyColumns: Column<StockOut>[] = [
    {
      key: 'so_no', header: '불출번호', cardPosition: 'title',
      render: (row) => <span className="font-medium text-accent-600">{row.so_no}</span>,
      sortable: true, sortValue: (row) => row.so_no,
    },
    {
      key: 'dept', header: '부서', cardPosition: 'subtitle',
      render: (row) => row.department_name,
      sortable: true, sortValue: (row) => row.department_name ?? '',
    },
    {
      key: 'item_count', header: '품목수', className: 'text-right', cardPosition: 'body',
      render: (row) => fmt(Number(row.items?.length || 0)),
    },
    {
      key: 'issued_at', header: '불출일', cardPosition: 'body',
      render: (row) => <span className="text-xs text-slate-500">{new Date(row.issued_at).toLocaleDateString('ko-KR')}</span>,
      sortable: true, sortValue: (row) => new Date(row.issued_at).getTime(),
    },
    {
      key: 'status', header: '상태', cardPosition: 'badge',
      render: (row) => <span className={STATUS_CLS[row.status] || 'badge-gray'}>{STATUS_LABEL[row.status] || row.status}</span>,
    },
    {
      key: 'diff', header: '차이건수', className: 'text-right', cardPosition: 'body',
      render: (row) => fmt(Number(row.receipt_diff_count || 0)),
    },
    {
      key: 'issuer', header: '담당자', cardPosition: 'hidden',
      render: (row) => <span className="text-xs text-slate-500">{row.issuer_name || '-'}</span>,
    },
    {
      key: 'actions', header: '',
      render: (row) => (
        <div className="text-right whitespace-nowrap flex items-center justify-end gap-1">
          <button className="btn-ghost text-xs py-1 px-2 text-accent-600" onClick={(e) => { e.stopPropagation(); openIssueDetail(row.id); }}>
            <Eye className="w-3.5 h-3.5 inline mr-0.5" />보기
          </button>
          {row.status !== 'REVERSED' && (
            <button className="btn-ghost text-xs py-1 px-2 text-red-500" onClick={(e) => { e.stopPropagation(); reverseIssue(row.id); }}>
              <RotateCcw className="w-3.5 h-3.5 inline mr-0.5" />역전
            </button>
          )}
        </div>
      ),
    },
  ];

  /* ── Receipt DataTable columns ── */
  const receiptColumns: Column<any>[] = [
    {
      key: 'so_no', header: '불출번호', cardPosition: 'title',
      render: (row) => <span className="font-medium text-accent-600">{row.so_no}</span>,
    },
    {
      key: 'dept', header: '부서', cardPosition: 'subtitle',
      render: (row) => row.department_name,
    },
    {
      key: 'issued_at', header: '불출일', cardPosition: 'body',
      render: (row) => <span className="text-xs text-slate-500">{new Date(row.issued_at).toLocaleDateString('ko-KR')}</span>,
    },
    {
      key: 'status', header: '상태', cardPosition: 'badge',
      render: (row) => <span className={STATUS_CLS[row.status] || 'badge-gray'}>{STATUS_LABEL[row.status] || row.status}</span>,
    },
    {
      key: 'diff_count', header: '차이건수', className: 'text-right', cardPosition: 'body',
      render: (row) => fmt(Number(row.receipt_diff_count || 0)),
    },
    {
      key: 'item_count', header: '품목수', className: 'text-right', cardPosition: 'body',
      render: (row) => fmt(Number(row.item_count || 0)),
    },
    {
      key: 'actions', header: '',
      render: (row) => (
        <button className="btn-ghost text-xs py-1 px-2 text-accent-600" onClick={() => openReceiptDetail(row.id)}>
          <ClipboardCheck className="w-3.5 h-3.5 inline mr-0.5" />검수
        </button>
      ),
    },
  ];

  /* ── FollowUp DataTable columns ── */
  const followUpColumns: Column<StockOutFollowUp>[] = [
    {
      key: 'so_no', header: '불출번호', cardPosition: 'title',
      render: (row) => <span className="text-xs font-medium text-accent-600">{row.so_no || '-'}</span>,
    },
    {
      key: 'dept', header: '부서', cardPosition: 'subtitle',
      render: (row) => row.department_name || '-',
    },
    {
      key: 'item', header: '품목', cardPosition: 'body',
      render: (row) => (
        <div>
          <div className="font-medium text-sm">{row.item_name || row.item_id}</div>
          <div className="text-xs text-slate-400">{row.item_code || ''}</div>
        </div>
      ),
    },
    {
      key: 'action_type', header: '유형', cardPosition: 'body',
      render: (row) => FOLLOW_UP_ACTION_LABEL[row.action_type] || row.action_type,
    },
    {
      key: 'diff_qty', header: '차이수량', className: 'text-right', cardPosition: 'body',
      render: (row) => fmt(Number(row.diff_qty || 0)),
    },
    {
      key: 'status', header: '상태', cardPosition: 'badge',
      render: (row) => <span className={FOLLOW_UP_STATUS_CLS[row.status] || 'badge-gray'}>{row.status}</span>,
    },
    {
      key: 'created_at', header: '생성일', cardPosition: 'hidden',
      render: (row) => <span className="text-xs text-slate-500">{new Date(row.created_at).toLocaleDateString('ko-KR')}</span>,
    },
    {
      key: 'note', header: '비고', cardPosition: 'hidden',
      render: (row) => <span className="text-xs text-slate-500">{row.note || '-'}</span>,
    },
    {
      key: 'actions', header: '',
      render: (row) => (
        <div className="text-right whitespace-nowrap flex items-center justify-end gap-1">
          {row.status === 'OPEN' && row.action_type === 'ISSUE_ADD' && (
            <button className="btn-ghost text-xs py-1 px-2 text-accent-600" onClick={() => createIssueFromFollowUp(row.id)}>
              <Plus className="w-3.5 h-3.5 inline mr-0.5" />불출
            </button>
          )}
          {row.status === 'OPEN' && (
            <button className="btn-ghost text-xs py-1 px-2 text-green-600" onClick={() => resolveFollowUp(row.id)}>
              <CheckCircle2 className="w-3.5 h-3.5 inline mr-0.5" />{row.action_type === 'COLLECT_BACK' ? '회수' : '완료'}
            </button>
          )}
          {row.status === 'OPEN' && (
            <button className="btn-ghost text-xs py-1 px-2 text-red-500" onClick={() => cancelFollowUp(row.id)}>
              <Trash2 className="w-3.5 h-3.5 inline mr-0.5" />취소
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={PackageOpen}
        title="불출 처리"
        description="부서별 물품 불출을 관리합니다"
        actions={
          <button className="btn-primary inline-flex items-center gap-1.5" onClick={() => setModal('create')}>
            <Plus className="w-4 h-4" />수기 불출 등록
          </button>
        }
      />

      {/* 탭 바 */}
      <div className="flex flex-wrap gap-2 mb-4">
        {([
          { key: 'workboard' as PageTab, label: '작업보드' },
          { key: 'receipt' as PageTab, label: '수령검수' },
          { key: 'followup' as PageTab, label: '후속작업' },
          { key: 'history' as PageTab, label: '내역' },
        ]).map((tabItem) => {
          const active = tab === tabItem.key;
          const count = tabItem.key === 'receipt' ? receipts.length : tabItem.key === 'followup' ? followUpCounts.OPEN : 0;
          return (
            <button
              key={tabItem.key}
              onClick={() => setTab(tabItem.key)}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold border transition-colors ${
                active ? 'bg-teal-600 text-white border-teal-600' : 'bg-gray-100 text-slate-700 border-gray-200 hover:border-slate-300'
              }`}
            >
              {tabItem.label}
              {(tabItem.key === 'receipt' || tabItem.key === 'followup') && (
                <span className={`inline-flex min-w-5 h-5 px-1 items-center justify-center rounded-full text-xs ${active ? 'bg-white/30 text-white' : 'bg-slate-200 text-slate-600'}`}>
                  {fmt(count)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {msg && <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}

      {/* ── 작업보드 탭 ── */}
      {tab === 'workboard' && (
        <div className="space-y-4">
          <FilterBar
            filters={[
              {
                key: 'request_type', label: '전체 유형',
                options: REQUEST_TYPE_OPTIONS.filter(o => o.value !== '').map(o => ({ value: o.value, label: o.label })),
                value: filters.request_type,
                onChange: (v) => setFilters((prev) => ({ ...prev, request_type: v })),
              },
              {
                key: 'period_label', label: '전체 기간',
                options: periodLabelOptions.map(l => ({ value: l, label: l })),
                value: filters.period_label,
                onChange: (v) => setFilters((prev) => ({ ...prev, period_label: v })),
              },
              {
                key: 'department_id', label: '전체 부서',
                options: depts.map((d: any) => ({ value: d.id, label: d.name })),
                value: filters.department_id,
                onChange: (v) => setFilters((prev) => ({ ...prev, department_id: v })),
              },
            ]}
            onReset={() => setFilters({ request_type: '', period_label: '', department_id: '', only_emergency: false })}
          >
            <label className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={filters.only_emergency} onChange={(e) => setFilters((prev) => ({ ...prev, only_emergency: e.target.checked }))} className="rounded" />
              긴급건만
            </label>
          </FilterBar>

          {(() => {
            const wbChips: FilterChip[] = [];
            if (filters.request_type) wbChips.push({ key: 'request_type', label: '유형', value: REQUEST_TYPE_OPTIONS.find(o => o.value === filters.request_type)?.label || filters.request_type, onRemove: () => setFilters(prev => ({ ...prev, request_type: '' })) });
            if (filters.period_label) wbChips.push({ key: 'period_label', label: '기간', value: filters.period_label, onRemove: () => setFilters(prev => ({ ...prev, period_label: '' })) });
            if (filters.department_id) wbChips.push({ key: 'department_id', label: '부서', value: depts.find((d: any) => d.id === filters.department_id)?.name || filters.department_id, onRemove: () => setFilters(prev => ({ ...prev, department_id: '' })) });
            if (filters.only_emergency) wbChips.push({ key: 'only_emergency', label: '긴급', value: '긴급건만', onRemove: () => setFilters(prev => ({ ...prev, only_emergency: false })) });
            return <FilterChips chips={wbChips} totalCount={workboardRows.length} onResetAll={() => setFilters({ request_type: '', period_label: '', department_id: '', only_emergency: false })} />;
          })()}

          {/* 요약 카드 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card p-4"><p className="text-xs text-slate-500 mb-1">부서 준비건</p><p className="text-xl font-bold text-navy-800">{fmt(Number(workboard?.summary.department_count ?? 0))}</p></div>
            <div className="card p-4"><p className="text-xs text-slate-500 mb-1">신청건수</p><p className="text-xl font-bold text-navy-800">{fmt(Number(workboard?.summary.request_count ?? 0))}</p></div>
            <div className="card p-4"><p className="text-xs text-slate-500 mb-1">피킹 품목수</p><p className="text-xl font-bold text-navy-800">{fmt(Number(workboard?.summary.line_count ?? 0))}</p></div>
            <div className="card p-4"><p className="text-xs text-slate-500 mb-1">총 잔여수량</p><p className="text-xl font-bold text-navy-800">{fmt(Number(workboard?.summary.total_remaining_qty ?? 0))}</p></div>
          </div>

          {/* 액션 바 */}
          <div className="card flex flex-wrap gap-2 justify-between items-center">
            <div className="text-sm text-slate-600">선택 라인 {fmt(selectedWorkboardRows.length)}건</div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary inline-flex items-center gap-1" onClick={toggleSelectAllVisible}>
                <CheckCircle2 className="w-3.5 h-3.5" />전체 선택/해제
              </button>
              <button className="btn-secondary inline-flex items-center gap-1" onClick={printPickingSheet}>
                <Printer className="w-3.5 h-3.5" />피킹시트 출력
              </button>
              <button className="btn-secondary inline-flex items-center gap-1" onClick={() => setModal('create')}>
                <Plus className="w-3.5 h-3.5" />수기 불출
              </button>
              <button className="btn-primary inline-flex items-center gap-1" disabled={submittingWorkboardIssue || selectedWorkboardRows.length === 0} onClick={confirmWorkboardIssue}>
                <PackageOpen className="w-3.5 h-3.5" />{submittingWorkboardIssue ? '처리 중...' : '선택 불출 확정'}
              </button>
            </div>
          </div>

          {/* 부서별 피킹리스트 */}
          <div className="card p-0 overflow-hidden overflow-x-auto">
            <div className="px-4 py-3 text-sm font-semibold text-navy-700">부서별 피킹리스트</div>
            {loadingWorkboard ? (
              <EmptyState message="로딩 중..." />
            ) : workboardRows.length === 0 ? (
              <EmptyState message="처리할 데이터가 없습니다." />
            ) : (
              <div className="space-y-4 pb-4">
                {(workboard?.department_groups ?? []).map((group) => (
                  <div key={group.department_id} className="mx-4 border border-gray-200 rounded-xl overflow-hidden">
                    <div className="flex justify-between gap-2 px-3 py-2 bg-slate-50 border-b border-gray-200 text-xs text-slate-600">
                      <span className="font-semibold text-slate-700">{group.department_name}</span>
                      <span>신청 {fmt(group.request_count)}건 · 품목 {fmt(group.item_count)}건 · 잔여 {fmt(Number(group.total_remaining_qty || 0))}</span>
                    </div>
                    <table className="tbl">
                      <thead><tr><th></th><th>품목명</th><th>단위</th><th className="text-right">포장</th><th className="text-right">승인</th><th className="text-right">기불출</th><th className="text-right">잔여</th><th className="text-right">재고</th><th className="text-right">박스</th><th className="text-right">불출예정</th><th>위치</th></tr></thead>
                      <tbody>
                        {group.lines.map((row) => {
                          const key = lineKey(row.ward_request_id, row.item_id);
                          const draft = issueDrafts[key] ?? { issue_qty_text: fmt(Number(row.remaining_qty || 0)), location_id: row.recommended_location_id || '' };
                          return (
                            <tr key={key}>
                              <td><input type="checkbox" checked={selectedLineKeys[key] ?? false} onChange={(e) => setSelectedLineKeys((prev) => ({ ...prev, [key]: e.target.checked }))} /></td>
                              <td><div className="font-medium text-sm">{row.item_name}</div><div className="text-xs text-slate-400">{row.item_code} · {row.request_no}</div></td>
                              <td>{row.uom || '-'}</td>
                              <td className="text-right">{fmt(Number(row.pack_size || 1))}</td>
                              <td className="text-right">{fmt(Number(row.approved_qty || 0))}</td>
                              <td className="text-right">{fmt(Number(row.issued_qty_sum || 0))}</td>
                              <td className="text-right font-semibold">{fmt(Number(row.remaining_qty || 0))}</td>
                              <td className="text-right">{fmt(Number(row.on_hand_qty || 0))}</td>
                              <td className="text-right">{fmt(Number(row.recommended_box_qty || 0))}</td>
                              <td className="text-right"><input type="text" inputMode="numeric" className="input w-24 text-right inline-block" value={draft.issue_qty_text} onFocus={() => setIssueDraftQty(key, draft.issue_qty_text)} onChange={(e) => setIssueDraftQty(key, e.target.value)} onBlur={() => setIssueDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? draft), issue_qty_text: fmt(parseNumericInput(prev[key]?.issue_qty_text ?? '')) } }))} /></td>
                              <td><select className="input min-w-[120px]" value={draft.location_id} onChange={(e) => setIssueDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? draft), location_id: e.target.value } }))}><option value="">위치 선택</option>{locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}</select></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 품목합계표 */}
          <div className="card p-0 overflow-hidden overflow-x-auto">
            <div className="px-4 py-3 text-sm font-semibold text-navy-700">품목합계표</div>
            <table className="tbl">
              <thead><tr><th>품목명</th><th>단위</th><th className="text-right">포장</th><th className="text-right">승인합계</th><th className="text-right">기불출합계</th><th className="text-right">잔여합계</th><th className="text-right">재고</th><th className="text-right">권장박스</th><th>권장위치</th></tr></thead>
              <tbody>
                {(workboard?.item_totals ?? []).map((row) => (
                  <tr key={row.item_id}>
                    <td><div className="font-medium text-sm">{row.item_name}</div><div className="text-xs text-slate-400">{row.item_code}</div></td>
                    <td>{row.uom || '-'}</td>
                    <td className="text-right">{fmt(Number(row.pack_size || 1))}</td>
                    <td className="text-right">{fmt(Number(row.total_approved_qty || 0))}</td>
                    <td className="text-right">{fmt(Number(row.total_issued_qty || 0))}</td>
                    <td className="text-right font-semibold">{fmt(Number(row.total_remaining_qty || 0))}</td>
                    <td className="text-right">{fmt(Number(row.on_hand_qty || 0))}</td>
                    <td className="text-right">{fmt(Number(row.recommended_box_qty || 0))}</td>
                    <td className="text-xs">{row.recommended_location_name || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── 수령검수 탭 ── */}
      {tab === 'receipt' && (
        loadingReceipts ? (
          <div className="card p-0"><EmptyState message="로딩 중..." /></div>
        ) : (
          <>
            <DataTable
              columns={receiptColumns}
              data={receipts.slice((receiptPage - 1) * receiptPageSize, receiptPage * receiptPageSize)}
              keyField="id"
              emptyMessage="검수 대기/차이 건이 없습니다."
            />
            <Pagination
              currentPage={receiptPage}
              totalItems={receipts.length}
              pageSize={receiptPageSize}
              onPageChange={setReceiptPage}
              onPageSizeChange={setReceiptPageSize}
            />
          </>
        )
      )}

      {/* ── 후속작업 탭 ── */}
      {tab === 'followup' && (
        <div className="space-y-4">
          <div className="card">
            <div className="flex flex-wrap gap-2">
              {FOLLOW_UP_STATUS_OPTIONS.map((option) => {
                const active = followUpStatusFilter === option.value;
                return (
                  <button key={option.value} onClick={() => { setFollowUpStatusFilter(option.value); setFollowUpPage(1); }} className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold border transition-colors ${active ? 'bg-teal-600 text-white border-teal-600' : 'bg-gray-100 text-slate-700 border-gray-200 hover:border-slate-300'}`}>
                    {option.label}
                    <span className={`inline-flex min-w-5 h-5 px-1 items-center justify-center rounded-full text-xs ${active ? 'bg-white/30 text-white' : 'bg-slate-200 text-slate-600'}`}>{fmt(followUpCounts[option.value])}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {loadingFollowUps ? (
            <div className="card p-0"><EmptyState message="로딩 중..." /></div>
          ) : (
            <>
              <DataTable
                columns={followUpColumns}
                data={followUps.slice((followUpPage - 1) * followUpPageSize, followUpPage * followUpPageSize)}
                keyField="id"
                emptyMessage="후속작업이 없습니다."
              />
              <Pagination
                currentPage={followUpPage}
                totalItems={followUps.length}
                pageSize={followUpPageSize}
                onPageChange={setFollowUpPage}
                onPageSizeChange={setFollowUpPageSize}
              />
            </>
          )}
        </div>
      )}

      {/* ── 내역 탭 ── */}
      {tab === 'history' && (
        loadingHistory ? (
          <div className="card p-0"><EmptyState message="로딩 중..." /></div>
        ) : (
          <>
            <DataTable
              columns={historyColumns}
              data={stockOuts.slice((historyPage - 1) * historyPageSize, historyPage * historyPageSize)}
              keyField="id"
              emptyMessage="불출 내역이 없습니다."
            />
            <Pagination
              currentPage={historyPage}
              totalItems={stockOuts.length}
              pageSize={historyPageSize}
              onPageChange={setHistoryPage}
              onPageSizeChange={setHistoryPageSize}
            />
          </>
        )
      )}

      {/* ── 수기 불출 등록 모달 ── */}
      <Modal
        open={modal === 'create'}
        onClose={() => setModal(null)}
        title="수기 불출 등록"
        size="lg"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setModal(null)}>취소</button>
            <button className="btn-primary inline-flex items-center gap-1" disabled={submittingManualIssue || manualIssueItems.length === 0} onClick={createManualIssue}>
              <PackageOpen className="w-4 h-4" />{submittingManualIssue ? '처리 중...' : '불출 확정'}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
          <div>
            <label className="label">불출 부서 *</label>
            <select className="input" value={manualIssueForm.department_id} onChange={(e) => setManualIssueForm((prev) => ({ ...prev, department_id: e.target.value }))}>
              <option value="">부서 선택</option>
              {depts.map((dept: any) => <option key={dept.id} value={dept.id}>{dept.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">비고</label>
            <input className="input" value={manualIssueForm.note} onChange={(e) => setManualIssueForm((prev) => ({ ...prev, note: e.target.value }))} />
          </div>
        </div>

        <div className="section-title">불출 품목</div>
        <div className="relative mb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input className="input pl-9" placeholder="품목 검색" value={manualItemSearch} onChange={(e) => setManualItemSearch(e.target.value)} />
          </div>
          {filteredManualItems.length > 0 && (
            <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
              {filteredManualItems.map((item) => (
                <button key={item.id} className="w-full text-left px-4 py-2 hover:bg-gray-50 text-sm border-b border-gray-50 last:border-b-0" onClick={() => addManualIssueItem(item)}>
                  <span className="font-medium">{item.name}</span>
                  <span className="text-xs text-slate-400 ml-2">{item.item_code}</span>
                  <span className="text-xs text-slate-400 ml-2">재고 {fmt(Number(item.on_hand_qty || 0))}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {manualIssueItems.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="tbl">
              <thead><tr><th>품목</th><th className="text-right">재고</th><th className="text-right">불출수량</th><th>위치</th><th></th></tr></thead>
              <tbody>
                {manualIssueItems.map((row) => (
                  <tr key={row.item_id}>
                    <td>
                      <div className="font-medium text-sm">{row.item_name}</div>
                      <div className="text-xs text-slate-400">{row.uom}</div>
                    </td>
                    <td className="text-right">{fmt(Number(row.on_hand_qty || 0))}</td>
                    <td className="text-right">
                      <input
                        type="text"
                        inputMode="numeric"
                        className="input w-24 text-right inline-block"
                        value={row.issued_qty_text}
                        onFocus={() => setManualIssueItems((prev) => prev.map((it) => it.item_id === row.item_id ? { ...it, issued_qty_text: String(parseNumericInput(it.issued_qty_text)) } : it))}
                        onChange={(e) => setManualIssueItems((prev) => prev.map((it) => it.item_id === row.item_id ? { ...it, issued_qty_text: e.target.value.replace(/[^\d]/g, '') } : it))}
                        onBlur={() => setManualIssueItems((prev) => prev.map((it) => it.item_id === row.item_id ? { ...it, issued_qty_text: fmt(parseNumericInput(it.issued_qty_text)) } : it))}
                      />
                    </td>
                    <td>
                      <select className="input" value={row.location_id} onChange={(e) => setManualIssueItems((prev) => prev.map((it) => it.item_id === row.item_id ? { ...it, location_id: e.target.value } : it))}>
                        <option value="">위치 선택</option>
                        {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <button className="btn-ghost text-xs py-1 px-2 text-red-500" onClick={() => setManualIssueItems((prev) => prev.filter((it) => it.item_id !== row.item_id))}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      {/* ── 불출 상세 모달 ── */}
      <Modal
        open={modal === 'detail' && detail !== null}
        onClose={() => setModal(null)}
        title={detail?.so_no ?? '상세'}
        size="lg"
        footer={<button className="btn-secondary" onClick={() => setModal(null)}>닫기</button>}
      >
        {detail && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4 text-sm">
              <div><span className="label">부서</span><p>{detail.department_name}</p></div>
              <div><span className="label">불출일</span><p>{new Date(detail.issued_at).toLocaleDateString('ko-KR')}</p></div>
              <div><span className="label">상태</span><span className={STATUS_CLS[detail.status] || 'badge-gray'}>{STATUS_LABEL[detail.status] || detail.status}</span></div>
              <div><span className="label">차이건수</span><p>{fmt(Number(detail.receipt_diff_count || 0))}</p></div>
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="tbl">
                <thead><tr><th>품목</th><th className="text-right">불출수량</th><th>위치</th></tr></thead>
                <tbody>
                  {(detail.items || []).map((line) => (
                    <tr key={line.id || line.item_id}>
                      <td>
                        <div className="font-medium text-sm">{line.item_name}</div>
                        <div className="text-xs text-slate-400">{line.item_code} · {line.uom}</div>
                      </td>
                      <td className="text-right">{fmt(Number(line.issued_qty || 0))}</td>
                      <td className="text-xs">{line.location_name || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Modal>

      {/* ── 수령검수 모달 ── */}
      <Modal
        open={receiptModalOpen && receiptDetail !== null}
        onClose={() => setReceiptModalOpen(false)}
        title={`수령검수 - ${receiptDetail?.so_no ?? ''}`}
        size="xl"
        footer={
          <>
            <button className="btn-secondary" onClick={saveReceiptDraft}>검수 임시저장</button>
            <button className="btn-primary" disabled={confirmingReceipt} onClick={confirmReceipt}>{confirmingReceipt ? '확정 중...' : '검수 확정'}</button>
            <button className="btn-secondary" onClick={() => setReceiptModalOpen(false)}>닫기</button>
          </>
        }
      >
        {receiptDetail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div><span className="label">부서</span><p>{receiptDetail.department_name}</p></div>
              <div><span className="label">불출일</span><p>{new Date(receiptDetail.issued_at).toLocaleDateString('ko-KR')}</p></div>
              <div><span className="label">상태</span><span className={STATUS_CLS[receiptDetail.status] || 'badge-gray'}>{STATUS_LABEL[receiptDetail.status] || receiptDetail.status}</span></div>
              <div><span className="label">차이건수</span><p>{fmt(Number(receiptDetail.receipt_diff_count || 0))}</p></div>
            </div>

            <div className="flex justify-end">
              <button className="btn-secondary inline-flex items-center gap-1" onClick={fillReceiptQtyAsIssued}>
                <CheckCircle2 className="w-3.5 h-3.5" />일괄 동일수량
              </button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="tbl">
                <thead><tr><th>품목</th><th className="text-right">불출수량</th><th className="text-right">실수령수량</th><th className="text-right">차이</th><th>차이 사유</th></tr></thead>
                <tbody>
                  {receiptDetail.items.map((line) => {
                    const raw = receiptQtyDrafts[line.item_id] ?? '';
                    const issuedQty = Number(line.issued_qty || 0);
                    const receivedQty = raw.trim() === '' ? Number(line.received_qty ?? 0) : parseNumericInput(raw);
                    const diff = receivedQty - issuedQty;
                    return (
                      <tr key={line.item_id} className={diff !== 0 ? 'bg-yellow-50/60' : ''}>
                        <td>
                          <div className="font-medium text-sm">{line.item_name}</div>
                          <div className="text-xs text-slate-400">{line.item_code} · {line.uom}</div>
                        </td>
                        <td className="text-right">{fmt(issuedQty)}</td>
                        <td className="text-right">
                          <input
                            type="text"
                            inputMode="numeric"
                            className="input w-28 text-right inline-block"
                            value={raw}
                            onFocus={() => setReceiptQtyDrafts((prev) => ({ ...prev, [line.item_id]: String(parseNumericInput(prev[line.item_id] ?? '')) }))}
                            onChange={(e) => setReceiptQtyDrafts((prev) => ({ ...prev, [line.item_id]: e.target.value.replace(/[^\d]/g, '') }))}
                            onBlur={() => setReceiptQtyDrafts((prev) => ({ ...prev, [line.item_id]: fmt(parseNumericInput(prev[line.item_id] ?? '')) }))}
                          />
                        </td>
                        <td className={`text-right font-semibold ${diff === 0 ? 'text-slate-700' : diff > 0 ? 'text-blue-700' : 'text-red-600'}`}>
                          {diff > 0 ? '+' : ''}{fmt(diff)}
                        </td>
                        <td>
                          <input
                            className="input"
                            placeholder="차이가 있을 때 사유 입력"
                            value={receiptNoteDrafts[line.item_id] ?? ''}
                            onChange={(e) => setReceiptNoteDrafts((prev) => ({ ...prev, [line.item_id]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
