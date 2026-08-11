import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import { getMajor, type MajorGroup } from '@shared/types';

// 대분류 정렬 우선순위
const MAJOR_ORDER: Record<MajorGroup, number> = {
  MEDICAL: 1, GENERAL: 2, DIAPER: 3, OFFICE: 4, EQUIPMENT: 5,
};
import { useToast } from '../components/Toast';
import { PageHeader, FilterBar, DataTable, Modal, EmptyState, FilterChips, Pagination, DateRangeFilter, inDateRange } from '../components/ui';
import type { Column, FilterChip, DateRange } from '../components/ui';
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
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

const WB_TYPE_LABEL: Record<string, string> = {
  CONSUMABLE_MEDICAL: '의료소모품',
  CONSUMABLE_REGULAR: '일반소모품',
  CONSUMABLE_OFFICE: '사무용품',
  DIAPER: '기저귀',
  NIGHT_SNACK: '야간간식',
  ADHOC: '비정기',
  EQUIPMENT: '비품',
};
// 부서 펼쳤을 때 유형 표시 순서 — 의료소모품 → 사무용품 → 일반소모품 순으로 고정. 목록에 없는 유형은 그 뒤에 가나다순.
const WB_TYPE_ORDER = ['CONSUMABLE_MEDICAL', 'CONSUMABLE_OFFICE', 'CONSUMABLE_REGULAR'];
const WB_TYPE_COLOR: Record<string, string> = {
  CONSUMABLE_MEDICAL: 'bg-rose-100 text-rose-700',
  CONSUMABLE_REGULAR: 'bg-blue-100 text-blue-700',
  CONSUMABLE_OFFICE: 'bg-indigo-100 text-indigo-700',
  DIAPER: 'bg-purple-100 text-purple-700',
  NIGHT_SNACK: 'bg-cyan-100 text-cyan-700',
  ADHOC: 'bg-orange-100 text-orange-700',
  EQUIPMENT: 'bg-amber-100 text-amber-700',
};
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
  close_remainder?: boolean; // 줄여서 불출 후 잔여 마감(승인량 = 기불출+이번불출)
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
  { value: 'CONSUMABLE_MEDICAL', label: '의료소모품' },
  { value: 'CONSUMABLE_REGULAR', label: '일반소모품' },
  { value: 'CONSUMABLE_OFFICE', label: '사무용품' },
  { value: 'DIAPER', label: '기저귀' },
  { value: 'NIGHT_SNACK', label: '야간간식' },
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

function normalizeSearchText(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ko-KR');
}

function compactSearchText(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, '');
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

  // 워크보드 계층 그룹 — period → dept → type → lines + 주차별 품목합계
  const wbHierarchy = useMemo(() => {
    const periodMap = new Map<string, Map<string, Map<string, any[]>>>();
    for (const row of workboardRows as any[]) {
      const period = (row.period_label && row.period_label.trim()) || '미지정';
      const deptId = String(row.department_id ?? '_unknown');
      const type = String(row.request_type ?? '기타');
      let dMap = periodMap.get(period);
      if (!dMap) { dMap = new Map(); periodMap.set(period, dMap); }
      let tMap = dMap.get(deptId);
      if (!tMap) { tMap = new Map(); dMap.set(deptId, tMap); }
      const arr = tMap.get(type) ?? [];
      arr.push(row);
      tMap.set(type, arr);
    }
    return Array.from(periodMap.entries()).map(([period, dMap]) => {
      const depts = Array.from(dMap.entries()).map(([deptId, tMap]) => {
        const types = Array.from(tMap.entries()).map(([type, lines]) => {
          // 라인 내 정렬: 대분류 → item_code 오름차순
          const sortedLines = [...lines].sort((a: any, b: any) => {
            const oa = MAJOR_ORDER[getMajor(a.category ?? '')] ?? 99;
            const ob = MAJOR_ORDER[getMajor(b.category ?? '')] ?? 99;
            if (oa !== ob) return oa - ob;
            return String(a.item_code ?? '').localeCompare(String(b.item_code ?? ''), 'ko', { numeric: true });
          });
          const totalRemaining = sortedLines.reduce((s, l) => s + Number(l.remaining_qty || 0), 0);
          return { type, lines: sortedLines, totalRemaining };
        }).sort((a, b) => {
          const oa = WB_TYPE_ORDER.indexOf(a.type);
          const ob = WB_TYPE_ORDER.indexOf(b.type);
          if (oa !== -1 || ob !== -1) return (oa === -1 ? 99 : oa) - (ob === -1 ? 99 : ob);
          return (WB_TYPE_LABEL[a.type] ?? a.type).localeCompare(WB_TYPE_LABEL[b.type] ?? b.type, 'ko');
        });
        const firstRow = types[0]?.lines[0] ?? {};
        const deptName = String(firstRow.department_name ?? '미지정');
        const totalReqs = new Set(types.flatMap(t => t.lines.map((l: any) => l.ward_request_id))).size;
        const totalRemaining = types.reduce((s, t) => s + t.totalRemaining, 0);
        return { dept_id: deptId, dept_name: deptName, types, totalReqs, totalRemaining };
      }).sort((a, b) => a.dept_name.localeCompare(b.dept_name, 'ko'));
      const totalReqs = depts.reduce((s, d) => s + d.totalReqs, 0);
      const totalRemaining = depts.reduce((s, d) => s + d.totalRemaining, 0);

      // 이 주차의 품목합계 — 부서별 분포 포함
      // {item_id, item_code, item_name, uom, depts: [{dept_id, dept_name, qty}], total_qty}
      const itemMap = new Map<string, any>();
      for (const d of depts) {
        for (const t of d.types) {
          for (const ln of t.lines) {
            const k = String(ln.item_id);
            let entry = itemMap.get(k);
            if (!entry) {
              entry = {
                item_id: k,
                item_code: ln.item_code ?? '',
                item_name: ln.item_name ?? '',
                category: ln.category ?? '',
                uom: ln.uom ?? '',
                pack_size: Number(ln.pack_size ?? 1),
                deptDist: new Map<string, { dept_id: string; dept_name: string; qty: number }>(),
                total_qty: 0,
              };
              itemMap.set(k, entry);
            }
            const dn = String(ln.department_name ?? '');
            const did = String(ln.department_id ?? '');
            const dEntry = entry.deptDist.get(did) ?? { dept_id: did, dept_name: dn, qty: 0 };
            dEntry.qty += Number(ln.remaining_qty || 0);
            entry.deptDist.set(did, dEntry);
            entry.total_qty += Number(ln.remaining_qty || 0);
          }
        }
      }
      const itemTotals = Array.from(itemMap.values())
        .map(it => ({
          ...it,
          deptDist: Array.from(it.deptDist.values()).sort((a: any, b: any) => a.dept_name.localeCompare(b.dept_name, 'ko')),
        }))
        .filter(it => it.total_qty > 0)
        .sort((a, b) => {
          // 1차: 대분류 (의료 → 일반 → 기저귀 → 사무 → 비품)
          const oa = MAJOR_ORDER[getMajor(a.category ?? '')] ?? 99;
          const ob = MAJOR_ORDER[getMajor(b.category ?? '')] ?? 99;
          if (oa !== ob) return oa - ob;
          // 2차: 품목코드 오름차순 (numeric 인식)
          return String(a.item_code ?? '').localeCompare(String(b.item_code ?? ''), 'ko', { numeric: true });
        });

      return { period, depts, totalReqs, totalRemaining, itemTotals };
    }).sort((a, b) => b.period.localeCompare(a.period));
  }, [workboardRows]);

  const allWbKeys = useMemo(() => {
    const keys: string[] = [];
    for (const p of wbHierarchy) {
      const pKey = `p::${p.period}`;
      keys.push(pKey);
      for (const d of p.depts) keys.push(`${pKey}::${d.dept_id}`);
    }
    return keys;
  }, [wbHierarchy]);

  const [expandedWbKeys, setExpandedWbKeys] = useState<Set<string>>(new Set());
  const toggleWbKey = useCallback((k: string) => {
    setExpandedWbKeys(prev => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  }, []);
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
      // 정책: 위치는 항상 서버가 보내준 총무구매 창고 고정 (prev/locations[0] fallback 사용 금지)
      nextDrafts[key] = {
        issue_qty_text: prev?.issue_qty_text ?? fmt(Number(row.remaining_qty || 0)),
        location_id: row.recommended_location_id || '',
      };
      nextSelected[key] = selectedLineKeys[key] ?? false;
    }
    setIssueDrafts(nextDrafts);
    setSelectedLineKeys(nextSelected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workboardRows, locations]);

  const filteredManualItems = useMemo(() => {
    const q = normalizeSearchText(manualItemSearch);
    const qCompact = compactSearchText(manualItemSearch);
    if (!q) return [];
    return items
      .filter((it) => {
        const name = normalizeSearchText(it.name);
        const code = normalizeSearchText(it.item_code);
        const nameCompact = compactSearchText(it.name);
        const codeCompact = compactSearchText(it.item_code);
        return name.includes(q) || code.includes(q) || nameCompact.includes(qCompact) || codeCompact.includes(qCompact);
      })
      .slice(0, 15);
  }, [items, manualItemSearch]);

  // 수기불출 '불출 부서' = 보관함(부서 재고위치)이 있는 부서만. 중앙창고('총무구매 창고')는 불출 출처라 제외.
  const manualDepts = useMemo(() => {
    const ids = new Set(
      (locations as any[])
        .filter((l) => l && l.department_id && l.name !== '총무구매 창고')
        .map((l) => String(l.department_id)),
    );
    return depts.filter((d: any) => ids.has(String(d.id)));
  }, [depts, locations]);

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

  // 정책: 불출은 무조건 "총무구매 창고" — 클라이언트 측 location 자동 결정
  const centralLocation = locations.find((l) => l.name === '총무구매 창고') ?? locations[0];

  const addManualIssueItem = (item: Item) => {
    if (manualIssueItems.some((row) => row.item_id === item.id)) return;
    setManualIssueItems((prev) => [
      ...prev,
      {
        item_id: item.id,
        item_name: item.name,
        uom: item.uom,
        issued_qty_text: '1',
        location_id: centralLocation?.id || '',
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

    // 재고 부족 라인 — 사용자 confirm 받고 진행 (음수 재고 허용 정책)
    const shortageLines = manualIssueItems
      .map((row) => ({ name: row.item_name, on_hand: Number(row.on_hand_qty || 0), input: parseNumericInput(row.issued_qty_text) }))
      .filter((l) => l.input > l.on_hand);
    if (shortageLines.length > 0) {
      const detail = shortageLines.map(l => `· ${l.name}: 재고 ${l.on_hand} → ${l.input} 불출 (부족 ${l.input - l.on_hand})`).join('\n');
      const ok = window.confirm(
        `다음 ${shortageLines.length}개 품목이 재고 부족입니다.\n\n${detail}\n\n` +
        `불출은 진행되며, 부족분만큼 재고가 음수(-)로 표시됩니다.\n입고가 들어오면 자동으로 상쇄됩니다.\n\n진행할까요?`,
      );
      if (!ok) return;
    }

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

  const [followUpDateRange, setFollowUpDateRange] = useState<DateRange>({ from: '', to: '' });

  // 후속작업 — 부서별 그룹화 (기간 필터: 생성일 기준)
  const followUpHierarchy = useMemo(() => {
    const deptMap = new Map<string, any[]>();
    for (const f of followUps as any[]) {
      if (!inDateRange(f.created_at, followUpDateRange)) continue;
      const k = String(f.department_id ?? '_unknown');
      const arr = deptMap.get(k) ?? [];
      arr.push(f);
      deptMap.set(k, arr);
    }
    return Array.from(deptMap.entries()).map(([deptId, rows]) => {
      const breakdown: Record<string, number> = {};
      for (const r of rows) {
        const cat = String(r.category ?? '');
        let major = 'GENERAL';
        if (cat.startsWith('EQUIP_')) major = 'EQUIPMENT';
        else if (cat.startsWith('OFF_')) major = 'OFFICE';
        else if (cat.startsWith('MED_') || cat.startsWith('INFECT_')) major = 'MEDICAL';
        else if (cat.startsWith('DIAPER')) major = 'DIAPER';
        breakdown[major] = (breakdown[major] ?? 0) + 1;
      }
      const statusCount: Record<string, number> = { OPEN: 0, RESOLVED: 0, CANCELLED: 0 };
      for (const r of rows) statusCount[r.status] = (statusCount[r.status] ?? 0) + 1;
      return {
        dept_id: deptId,
        dept_name: String(rows[0]?.department_name ?? '미지정'),
        rows: rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
        breakdown,
        statusCount,
      };
    }).sort((a, b) => a.dept_name.localeCompare(b.dept_name, 'ko'));
  }, [followUps, followUpDateRange]);

  const [expandedFollowKeys, setExpandedFollowKeys] = useState<Set<string>>(new Set());
  const toggleFollowKey = useCallback((k: string) => {
    setExpandedFollowKeys(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  }, []);

  const [dateRange, setDateRange] = useState<DateRange>({ from: '', to: '' });

  // 내역 — 주차 → 부서 → SO 계층 (수령검수와 동일 로직)
  const historyHierarchy = useMemo(() => {
    const periodMap = new Map<string, Map<string, any[]>>();
    for (const r of stockOuts as any[]) {
      if (!inDateRange(r.issued_at, dateRange)) continue;
      const period = (r.period_label && String(r.period_label).trim()) || '기간 미지정';
      const deptId = String(r.department_id ?? '_unknown');
      let dMap = periodMap.get(period);
      if (!dMap) { dMap = new Map(); periodMap.set(period, dMap); }
      const arr = dMap.get(deptId) ?? [];
      arr.push(r);
      dMap.set(deptId, arr);
    }
    return Array.from(periodMap.entries()).map(([period, dMap]) => {
      const depts = Array.from(dMap.entries()).map(([deptId, sos]) => {
        const sortedSos = [...sos].sort((a, b) => new Date(b.issued_at).getTime() - new Date(a.issued_at).getTime());
        const breakdown: Record<string, number> = {};
        for (const so of sortedSos) {
          const bd = so.category_breakdown ?? {};
          for (const [k, v] of Object.entries(bd)) breakdown[k] = (breakdown[k] ?? 0) + Number(v ?? 0);
        }
        return {
          dept_id: deptId,
          dept_name: String(sortedSos[0]?.department_name ?? '미지정'),
          sos: sortedSos,
          breakdown,
        };
      }).sort((a, b) => a.dept_name.localeCompare(b.dept_name, 'ko'));
      const totalSo = depts.reduce((s, d) => s + d.sos.length, 0);
      const totalBreakdown: Record<string, number> = {};
      for (const d of depts) for (const [k, v] of Object.entries(d.breakdown)) totalBreakdown[k] = (totalBreakdown[k] ?? 0) + Number(v ?? 0);
      return { period, depts, totalSo, totalBreakdown };
    }).sort((a, b) => b.period.localeCompare(a.period));
  }, [stockOuts, dateRange]);

  const [expandedHistoryKeys, setExpandedHistoryKeys] = useState<Set<string>>(new Set());
  const toggleHistoryKey = useCallback((k: string) => {
    setExpandedHistoryKeys(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  }, []);

  // SO 의 주차 라벨 수동 변경 (그룹화 이동) — 관리자 전용
  // 「대신 확정」 모달 — 부서 수령검수 없이 총무구매가 강제 확정. 사유는 프리셋 선택 + 「기타」 선택 시 자유입력.
  const FORCE_CONFIRM_REASONS = [
    '부서 미응답',
    '직접 전달 확인 완료',
    '긴급 처리',
    '부서 인수자 부재',
    '월말 마감 처리',
    '기타 (직접 입력)',
  ] as const;
  // forceTarget: 단건 = ids 1개 / 일괄 = ids N개. label = 단건이면 SO 번호, 일괄이면 주차명.
  // hasDiff: 차이확정 건이 포함된 경우 모달에 추가 경고 표시
  const [forceTarget, setForceTarget] = useState<{ ids: string[]; label: string; bulk: boolean; hasDiff: boolean } | null>(null);
  const [forceReasonPreset, setForceReasonPreset] = useState<string>(FORCE_CONFIRM_REASONS[0]);
  const [forceReasonCustom, setForceReasonCustom] = useState('');
  const [forceSubmitting, setForceSubmitting] = useState(false);

  const forceConfirmSO = (soId: string, soNo: string, status?: string) => {
    setForceReasonPreset(FORCE_CONFIRM_REASONS[0]);
    setForceReasonCustom('');
    setForceTarget({ ids: [soId], label: soNo, bulk: false, hasDiff: status === 'RECEIPT_DIFF' });
  };

  // 주차 헤더 「주차 전체 대신 확정」 — 그 주차의 PENDING + DIFF SO 모두 한 번에
  const forceConfirmPeriod = (period: string, sos: any[]) => {
    const targets = sos.filter((so) => so.status === 'RECEIPT_PENDING' || so.status === 'RECEIPT_DIFF');
    if (targets.length === 0) { showMsg('err', '이 주차에는 마감 대기 건이 없습니다.'); return; }
    const hasDiff = targets.some((so) => so.status === 'RECEIPT_DIFF');
    setForceReasonPreset(FORCE_CONFIRM_REASONS[0]);
    setForceReasonCustom('');
    setForceTarget({ ids: targets.map((so) => so.id), label: period, bulk: true, hasDiff });
  };

  const submitForceConfirm = async () => {
    if (!forceTarget) return;
    const reason = forceReasonPreset === '기타 (직접 입력)'
      ? forceReasonCustom.trim()
      : forceReasonPreset;
    setForceSubmitting(true);
    let ok = 0, fail = 0;
    for (const id of forceTarget.ids) {
      try {
        await api(`/stock-out/${id}/force-confirm`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        ok++;
      } catch {
        fail++;
      }
    }
    setForceSubmitting(false);
    showMsg(
      fail === 0 ? 'ok' : 'err',
      forceTarget.bulk
        ? `${forceTarget.label} 일괄 대신 확정 — 성공 ${ok}건${fail > 0 ? ` · 실패 ${fail}건` : ''}`
        : `${forceTarget.label} 대신 확정 ${fail === 0 ? '완료' : '실패'}`,
    );
    setForceTarget(null);
    await loadReceipts();
    await loadHistory();
  };

  const changeSoPeriodLabel = async (soId: string, soNo: string, currentLabel: string | null | undefined) => {
    const input = window.prompt(
      `${soNo} 의 주차 라벨을 입력하세요.\n예: 2026년 5월 1주차\n비워두면 원래 분류(ward_request 기준)로 복귀합니다.`,
      currentLabel ?? '',
    );
    if (input === null) return; // 취소
    try {
      await api(`/stock-out/${soId}/period-label`, {
        method: 'PATCH',
        body: JSON.stringify({ period_label: input.trim() || null }),
      });
      showMsg('ok', input.trim() ? `${soNo} → "${input.trim()}" 으로 이동` : `${soNo} 주차 라벨 제거`);
      await loadReceipts();
    } catch (e: any) {
      showMsg('err', e?.message ?? '주차 라벨 변경 실패');
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
    const grouped = new Map<string, Array<{ item_id: string; issue_qty: number; location_id: string; close_remainder?: boolean }>>();
    // 잔여 초과 / 재고 부족 라인 모음 — 사용자 confirm 받기 위해
    const exceededLines: { name: string; remaining: number; input: number }[] = [];
    const shortageLines: { name: string; on_hand: number; input: number }[] = [];
    for (const row of selectedWorkboardRows) {
      const key = lineKey(row.ward_request_id, row.item_id);
      const draft = issueDrafts[key];
      const issueQty = parseNumericInput(draft?.issue_qty_text ?? '');
      const locationId = String(draft?.location_id ?? '');
      // 0 불출도 허용 (잔여 마감 전용 케이스). 다만 0 + 마감 안 체크면 의미 없음.
      if (issueQty < 0) return showMsg('err', `${row.item_name} 수량을 확인해주세요.`);
      if (issueQty === 0 && !draft?.close_remainder) {
        return showMsg('err', `${row.item_name}: 0 불출은 "잔여 마감" 체크해야 의미가 있습니다.`);
      }
      if (issueQty > 0 && !locationId) return showMsg('err', `${row.item_name} 위치를 선택해주세요.`);
      const remaining = Number(row.remaining_qty || 0);
      if (issueQty > remaining) {
        exceededLines.push({ name: row.item_name, remaining, input: issueQty });
      }
      const onHand = Number(row.on_hand_qty || 0);
      if (issueQty > onHand) {
        shortageLines.push({ name: row.item_name, on_hand: onHand, input: issueQty });
      }
      if (!grouped.has(row.ward_request_id)) grouped.set(row.ward_request_id, []);
      // 잔여보다 적게 입력 + 마감 체크 시에만 close_remainder=true 전송 (그 외엔 잔여 유지)
      const closeRemainder = !!draft?.close_remainder && issueQty < remaining;
      // issue_qty=0 인 라인도 close_remainder 처리 위해 전송 (서버가 0 라인은 불출 안 만들고 마감만)
      grouped.get(row.ward_request_id)!.push({ item_id: row.item_id, issue_qty: issueQty, location_id: locationId || row.recommended_location_id || '', close_remainder: closeRemainder });
    }
    // 잔여 초과 라인이 있으면 사용자에게 명시적 확인 — 자동 amend 가 결재 우회 효과를 가지므로 의식적 동의 필요
    if (exceededLines.length > 0) {
      const detail = exceededLines.map(l => `· ${l.name}: 잔여 ${l.remaining} → ${l.input} 보냄 (승인량 자동 조정)`).join('\n');
      const ok = window.confirm(
        `다음 ${exceededLines.length}개 라인이 승인 잔여를 초과합니다.\n\n${detail}\n\n` +
        `자동으로 승인 수량을 늘려서 처리합니다. (감사로그에 ADJUST 기록)\n진행할까요?`,
      );
      if (!ok) return;
    }
    // 재고 부족 라인 — 음수 재고 허용 정책에 따라 confirm 후 진행
    if (shortageLines.length > 0) {
      const detail = shortageLines.map(l => `· ${l.name}: 재고 ${l.on_hand} → ${l.input} 불출 (부족 ${l.input - l.on_hand})`).join('\n');
      const ok = window.confirm(
        `다음 ${shortageLines.length}개 품목이 재고 부족입니다.\n\n${detail}\n\n` +
        `불출은 진행되며, 부족분만큼 재고가 음수(-)로 표시됩니다.\n입고가 들어오면 자동으로 상쇄됩니다.\n\n진행할까요?`,
      );
      if (!ok) return;
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

  // disposition 기반 결정 처리.
  //  NOT_ISSUED    추가불출 안 함 → 부족분 비용을 실수령 기준으로 정정
  //  COLLECTED     회수 실행 → 창고 재고/비용 환입
  //  NOT_COLLECTED 회수 안 함 → 변동 없음 종결
  const decideFollowUp = async (id: string, disposition: string, confirmText: string) => {
    if (!confirm(confirmText)) return;
    try {
      const r: any = await api(`/stock-out/follow-ups/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ disposition }),
      });
      showMsg('ok', r?.message || '처리 완료');
      loadFollowUps(followUpStatusFilter);
      loadWorkboard();
      loadReceipts();
      loadHistory();
    } catch (e: any) {
      showMsg('err', e.message || '후속작업 처리 실패');
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
  // 수령검수 — 주차 → 부서 → SO 계층 그룹화
  const receiptHierarchy = useMemo(() => {
    const periodMap = new Map<string, Map<string, any[]>>();
    for (const r of receipts) {
      const period = (r.period_label && String(r.period_label).trim()) || '기간 미지정';
      const deptId = String(r.department_id ?? '_unknown');
      let dMap = periodMap.get(period);
      if (!dMap) { dMap = new Map(); periodMap.set(period, dMap); }
      const arr = dMap.get(deptId) ?? [];
      arr.push(r);
      dMap.set(deptId, arr);
    }
    return Array.from(periodMap.entries()).map(([period, dMap]) => {
      const depts = Array.from(dMap.entries()).map(([deptId, sos]) => {
        const sortedSos = [...sos].sort((a, b) => new Date(b.issued_at).getTime() - new Date(a.issued_at).getTime());
        const breakdown: Record<string, number> = {};
        for (const so of sortedSos) {
          const bd = so.category_breakdown ?? {};
          for (const [k, v] of Object.entries(bd)) breakdown[k] = (breakdown[k] ?? 0) + Number(v ?? 0);
        }
        const deptName = String(sortedSos[0]?.department_name ?? '미지정');
        const diffCount = sortedSos.reduce((s, so) => s + Number(so.receipt_diff_count ?? 0), 0);
        return { dept_id: deptId, dept_name: deptName, sos: sortedSos, breakdown, diffCount };
      }).sort((a, b) => a.dept_name.localeCompare(b.dept_name, 'ko'));
      const totalSo = depts.reduce((s, d) => s + d.sos.length, 0);
      const totalBreakdown: Record<string, number> = {};
      for (const d of depts) for (const [k, v] of Object.entries(d.breakdown)) totalBreakdown[k] = (totalBreakdown[k] ?? 0) + Number(v ?? 0);
      return { period, depts, totalSo, totalBreakdown };
    }).sort((a, b) => b.period.localeCompare(a.period));
  }, [receipts]);

  const [expandedReceiptKeys, setExpandedReceiptKeys] = useState<Set<string>>(new Set());
  const toggleReceiptKey = useCallback((k: string) => {
    setExpandedReceiptKeys(prev => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  }, []);

  // 분류 라벨 색상
  const MAJOR_LABEL_KO: Record<string, string> = { MEDICAL: '의료', GENERAL: '일반', DIAPER: '기저귀', OFFICE: '사무', EQUIPMENT: '비품' };
  const MAJOR_BG: Record<string, string> = {
    MEDICAL: 'bg-rose-100 text-rose-700',
    GENERAL: 'bg-sky-100 text-sky-700',
    DIAPER: 'bg-amber-100 text-amber-700',
    OFFICE: 'bg-indigo-100 text-indigo-700',
    EQUIPMENT: 'bg-emerald-100 text-emerald-700',
  };

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
            <>
              <button className="btn-ghost text-xs py-1 px-2 text-accent-600" onClick={() => createIssueFromFollowUp(row.id)}>
                <Plus className="w-3.5 h-3.5 inline mr-0.5" />추가불출
              </button>
              <button className="btn-ghost text-xs py-1 px-2 text-slate-500" onClick={() => decideFollowUp(row.id, 'NOT_ISSUED_RETURNED', '추가불출 안 함 — 부족분이 총무구매 창고에 그대로 있습니다.\n창고 재고/lot 복원 + 부서 비용을 실수령 기준으로 정정합니다. 진행할까요?')}>
                안함·창고
              </button>
              <button className="btn-ghost text-xs py-1 px-2 text-slate-500" onClick={() => decideFollowUp(row.id, 'NOT_ISSUED_LOST', '추가불출 안 함 — 부족분이 분실/파손되었습니다.\n부서 비용만 실수령 기준으로 정정합니다(창고 복원 없음). 진행할까요?')}>
                안함·분실
              </button>
            </>
          )}
          {row.status === 'OPEN' && row.action_type === 'COLLECT_BACK' && (
            <>
              <button className="btn-ghost text-xs py-1 px-2 text-green-600" onClick={() => decideFollowUp(row.id, 'COLLECTED', '초과분을 회수 처리합니다.\n창고 재고 환입 + 그 부서 불출 비용을 원가만큼 차감합니다. 진행할까요?')}>
                <CheckCircle2 className="w-3.5 h-3.5 inline mr-0.5" />회수
              </button>
              <button className="btn-ghost text-xs py-1 px-2 text-slate-500" onClick={() => decideFollowUp(row.id, 'NOT_COLLECTED', '회수 안 함으로 종결합니다. 부서가 그대로 사용하며 재고·비용 변동이 없습니다. 진행할까요?')}>
                회수 안 함
              </button>
            </>
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
          return (
            <button
              key={tabItem.key}
              onClick={() => setTab(tabItem.key)}
              className={`rounded-full px-4 py-2 text-sm font-semibold border transition-colors ${
                active ? 'bg-teal-600 text-white border-teal-600' : 'bg-gray-100 text-slate-700 border-gray-200 hover:border-slate-300'
              }`}
            >
              {tabItem.label}
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

          {/* 계층 그룹: 신청주기 → 부서 → 유형 → 신청서 → 라인 */}
          <div className="card p-0 overflow-hidden">
            <div className="px-4 py-3 text-sm font-semibold text-navy-700 flex items-center justify-between">
              <span>주기별·부서별·유형별 피킹리스트</span>
              <div className="text-xs text-blue-600 inline-flex items-center gap-2">
                <button onClick={() => setExpandedWbKeys(new Set(allWbKeys))} className="hover:underline">모두 펼치기</button>
                <span className="text-slate-300">·</span>
                <button onClick={() => setExpandedWbKeys(new Set())} className="hover:underline">모두 접기</button>
              </div>
            </div>
            {loadingWorkboard ? (
              <EmptyState message="로딩 중..." />
            ) : workboardRows.length === 0 ? (
              <EmptyState message="처리할 데이터가 없습니다." />
            ) : (
              <div className="px-4 pb-4 space-y-2">
                {wbHierarchy.map((p) => {
                  const pKey = `p::${p.period}`;
                  const pOpen = expandedWbKeys.has(pKey);
                  return (
                    <div key={pKey} className="border border-slate-200 rounded-xl overflow-hidden">
                      <button onClick={() => toggleWbKey(pKey)} className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-50">
                        <div className="flex items-center gap-2">
                          {pOpen ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                          <span className="font-semibold text-navy-800">{p.period}</span>
                          <span className="text-xs text-slate-500">{p.totalReqs}건 · {p.depts.length}개 부서 · 잔여 {fmt(p.totalRemaining)}</span>
                        </div>
                      </button>
                      {pOpen && (
                        <div className="border-t border-slate-100 bg-slate-50/30">
                          {p.depts.map((d) => {
                            const dKey = `${pKey}::${d.dept_id}`;
                            const dOpen = expandedWbKeys.has(dKey);
                            return (
                              <div key={dKey} className="border-b border-slate-100 last:border-b-0">
                                <button onClick={() => toggleWbKey(dKey)} className="w-full flex items-center justify-between px-6 py-2 hover:bg-slate-100/70">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    {dOpen ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                                    <span className="font-medium text-slate-700 text-sm">{d.dept_name}</span>
                                    <span className="text-xs text-slate-500">{d.totalReqs}건 · 잔여 {fmt(d.totalRemaining)}</span>
                                    <div className="flex gap-1 ml-2">
                                      {d.types.map((t) => (
                                        <span key={t.type} className={`text-[10px] px-1.5 py-0.5 rounded ${WB_TYPE_COLOR[t.type] ?? 'bg-slate-100 text-slate-600'}`}>
                                          {WB_TYPE_LABEL[t.type] ?? t.type} {t.lines.length}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                </button>
                                {dOpen && (
                                  <div className="bg-white">
                                    {d.types.map((t) => (
                                      <div key={`${dKey}::${t.type}`} className="border-t border-slate-100">
                                        <div className={`px-8 py-1.5 text-xs font-medium ${WB_TYPE_COLOR[t.type] ?? 'bg-slate-50 text-slate-600'}`}>
                                          {WB_TYPE_LABEL[t.type] ?? t.type} ({t.lines.length}라인 · 잔여 {fmt(t.totalRemaining)})
                                        </div>
                                        {/* 데스크톱/태블릿 — 표 (가로 스크롤) */}
                                        <div className="hidden sm:block overflow-x-auto">
                                        <table className="tbl min-w-[640px]">
                                          <thead><tr>
                                            <th className="w-8"></th>
                                            <th>품목명</th>
                                            <th>단위</th>
                                            <th className="text-right text-xs text-slate-500">승인/기불출</th>
                                            <th className="text-right">잔여</th>
                                            <th className="text-right">재고</th>
                                            <th className="text-right">불출</th>
                                          </tr></thead>
                                          <tbody>
                                            {t.lines.map((row: any) => {
                                              const key = lineKey(row.ward_request_id, row.item_id);
                                              const draft = issueDrafts[key] ?? { issue_qty_text: fmt(Number(row.remaining_qty || 0)), location_id: row.recommended_location_id || '', close_remainder: false };
                                              const packSize = Number(row.pack_size || 1);
                                              const purchaseUom = row.purchase_uom || row.uom || 'ea';
                                              const issueUom = row.issue_uom || row.uom || 'ea';
                                              const remaining = Number(row.remaining_qty || 0);
                                              const recBox = Number(row.recommended_box_qty || 0);
                                              const inputQty = parseNumericInput(draft.issue_qty_text ?? '');
                                              // 잔여보다 적은 모든 케이스(0 포함)에서 마감 옵션 노출
                                              const isReduced = remaining > 0 && inputQty < remaining;
                                              return (
                                                <tr key={key}>
                                                  <td><input type="checkbox" checked={selectedLineKeys[key] ?? false} onChange={(e) => setSelectedLineKeys((prev) => ({ ...prev, [key]: e.target.checked }))} /></td>
                                                  <td><div className="font-medium text-sm">{row.item_name}</div><div className="text-xs text-slate-400">{row.item_code} · {row.request_no}</div></td>
                                                  <td className="text-xs">
                                                    <div className="font-medium">{issueUom}</div>
                                                    {packSize > 1 && purchaseUom !== issueUom &&
                                                      <div className="text-[10px] text-blue-500 whitespace-nowrap">1{purchaseUom}={packSize}{issueUom}</div>}
                                                  </td>
                                                  <td className="text-right text-xs text-slate-500">
                                                    {fmt(Number(row.approved_qty || 0))} / {fmt(Number(row.issued_qty_sum || 0))}
                                                  </td>
                                                  <td className="text-right">
                                                    <div className="font-semibold">{fmt(remaining)}</div>
                                                    {packSize > 1 && recBox > 0 && <div className="text-[10px] text-slate-400">≈{fmt(recBox)}{purchaseUom}</div>}
                                                  </td>
                                                  <td className="text-right">{fmt(Number(row.on_hand_qty || 0))}</td>
                                                  <td className="text-right">
                                                    <div className="inline-flex flex-col items-end gap-0.5">
                                                      <input
                                                        type="text" inputMode="numeric"
                                                        className="input w-24 text-right"
                                                        value={draft.issue_qty_text}
                                                        onFocus={() => setIssueDraftQty(key, draft.issue_qty_text)}
                                                        onChange={(e) => setIssueDraftQty(key, e.target.value)}
                                                        onBlur={() => setIssueDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? draft), issue_qty_text: fmt(parseNumericInput(prev[key]?.issue_qty_text ?? '')) } }))}
                                                      />
                                                      {isReduced && (
                                                        <label className="text-[11px] text-amber-700 inline-flex items-center gap-1 cursor-pointer" title="잔여를 0으로 마감 (다음 불출 안 함)">
                                                          <input
                                                            type="checkbox"
                                                            checked={!!draft.close_remainder}
                                                            onChange={(e) => setIssueDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? draft), close_remainder: e.target.checked } }))}
                                                          />
                                                          잔여 마감
                                                        </label>
                                                      )}
                                                    </div>
                                                  </td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                        </div>

                                        {/* 모바일(세로) — 카드형: 가로 스크롤 없이 그 자리에서 체크+수량입력 */}
                                        <div className="sm:hidden divide-y divide-slate-100">
                                          {t.lines.map((row: any) => {
                                            const key = lineKey(row.ward_request_id, row.item_id);
                                            const draft = issueDrafts[key] ?? { issue_qty_text: fmt(Number(row.remaining_qty || 0)), location_id: row.recommended_location_id || '', close_remainder: false };
                                            const packSize = Number(row.pack_size || 1);
                                            const purchaseUom = row.purchase_uom || row.uom || 'ea';
                                            const issueUom = row.issue_uom || row.uom || 'ea';
                                            const remaining = Number(row.remaining_qty || 0);
                                            const recBox = Number(row.recommended_box_qty || 0);
                                            const inputQty = parseNumericInput(draft.issue_qty_text ?? '');
                                            const isReduced = remaining > 0 && inputQty < remaining;
                                            return (
                                              <div key={key} className="flex gap-3 px-3 py-3">
                                                <input
                                                  type="checkbox"
                                                  className="mt-1 w-5 h-5 shrink-0"
                                                  checked={selectedLineKeys[key] ?? false}
                                                  onChange={(e) => setSelectedLineKeys((prev) => ({ ...prev, [key]: e.target.checked }))}
                                                />
                                                <div className="flex-1 min-w-0 space-y-2">
                                                  <div>
                                                    <div className="font-medium text-sm">{row.item_name}</div>
                                                    <div className="text-xs text-slate-400">{row.item_code} · {row.request_no}</div>
                                                  </div>
                                                  <div className="grid grid-cols-3 gap-2 text-xs">
                                                    <div>
                                                      <div className="text-slate-400">단위</div>
                                                      <div className="font-medium">{issueUom}</div>
                                                      {packSize > 1 && purchaseUom !== issueUom &&
                                                        <div className="text-[10px] text-blue-500">1{purchaseUom}={packSize}{issueUom}</div>}
                                                    </div>
                                                    <div>
                                                      <div className="text-slate-400">잔여</div>
                                                      <div className="font-semibold">{fmt(remaining)}</div>
                                                      {packSize > 1 && recBox > 0 && <div className="text-[10px] text-slate-400">≈{fmt(recBox)}{purchaseUom}</div>}
                                                    </div>
                                                    <div>
                                                      <div className="text-slate-400">재고</div>
                                                      <div className="font-medium">{fmt(Number(row.on_hand_qty || 0))}</div>
                                                    </div>
                                                  </div>
                                                  <div className="text-xs text-slate-500">
                                                    승인/기불출 {fmt(Number(row.approved_qty || 0))} / {fmt(Number(row.issued_qty_sum || 0))}
                                                  </div>
                                                  <div className="flex items-center gap-2">
                                                    <span className="text-xs text-slate-500 shrink-0">불출</span>
                                                    <input
                                                      type="text" inputMode="numeric"
                                                      className="input flex-1 text-right"
                                                      value={draft.issue_qty_text}
                                                      onFocus={() => setIssueDraftQty(key, draft.issue_qty_text)}
                                                      onChange={(e) => setIssueDraftQty(key, e.target.value)}
                                                      onBlur={() => setIssueDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? draft), issue_qty_text: fmt(parseNumericInput(prev[key]?.issue_qty_text ?? '')) } }))}
                                                    />
                                                  </div>
                                                  {isReduced && (
                                                    <label className="text-[11px] text-amber-700 inline-flex items-center gap-1 cursor-pointer" title="잔여를 0으로 마감 (다음 불출 안 함)">
                                                      <input
                                                        type="checkbox"
                                                        checked={!!draft.close_remainder}
                                                        onChange={(e) => setIssueDrafts((prev) => ({ ...prev, [key]: { ...(prev[key] ?? draft), close_remainder: e.target.checked } }))}
                                                      />
                                                      잔여 마감
                                                    </label>
                                                  )}
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}

                          {/* 주차별 품목합계 — 부서 분포 표시 */}
                          {p.itemTotals.length > 0 && (
                            <div className="mt-3 mx-4 mb-4 rounded-lg border border-slate-200 overflow-hidden">
                              <div className="px-3 py-1.5 bg-slate-100 text-xs font-medium text-slate-700">
                                {p.period} 품목합계 (부서별 분포) — {p.itemTotals.length}품목
                              </div>
                              <div className="overflow-x-auto">
                              <table className="tbl min-w-[560px]">
                                <colgroup>
                                  <col className="w-64" />
                                  <col className="w-16" />
                                  <col className="w-24" />
                                  <col />
                                </colgroup>
                                <thead>
                                  <tr>
                                    <th>품목</th>
                                    <th>단위</th>
                                    <th className="text-right">잔여 합계</th>
                                    <th>부서별 분포</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {p.itemTotals.map((it: any) => (
                                    <tr key={it.item_id}>
                                      <td>
                                        <div className="font-medium text-sm">{it.item_name}</div>
                                        <div className="text-xs text-slate-400">{it.item_code}</div>
                                      </td>
                                      <td className="text-xs">{it.uom || '-'}</td>
                                      <td className="text-right font-semibold text-blue-700">{fmt(it.total_qty)}</td>
                                      <td>
                                        <div className="flex flex-wrap gap-1">
                                          {it.deptDist.map((d: any) => (
                                            <span key={d.dept_id} className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                                              {d.dept_name} <strong className="text-slate-900">{fmt(d.qty)}</strong>
                                            </span>
                                          ))}
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 수령검수 탭 (주차·부서 계층) ── */}
      {tab === 'receipt' && (
        loadingReceipts ? (
          <div className="card p-0"><EmptyState message="로딩 중..." /></div>
        ) : receiptHierarchy.length === 0 ? (
          <div className="card p-0"><EmptyState message="검수 대기/차이 건이 없습니다." /></div>
        ) : (
          <div className="card p-0">
            <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-700">주차별 · 부서별 검수 대기</div>
              <div className="flex gap-2 text-xs">
                <button className="text-blue-600 hover:underline" onClick={() => {
                  const all = new Set<string>();
                  for (const p of receiptHierarchy) {
                    all.add(`rp::${p.period}`);
                    for (const d of p.depts) all.add(`rp::${p.period}::${d.dept_id}`);
                  }
                  setExpandedReceiptKeys(all);
                }}>모두 펼치기</button>
                <span className="text-slate-300">·</span>
                <button className="text-blue-600 hover:underline" onClick={() => setExpandedReceiptKeys(new Set())}>모두 접기</button>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {receiptHierarchy.map((p) => {
                const pKey = `rp::${p.period}`;
                const pOpen = expandedReceiptKeys.has(pKey);
                const pPendingSos = p.depts.flatMap((d) => d.sos.filter((so: any) => so.status === 'RECEIPT_PENDING' || so.status === 'RECEIPT_DIFF'));
                return (
                  <div key={pKey}>
                    <div className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-slate-50">
                    <button onClick={() => toggleReceiptKey(pKey)} className="flex items-center gap-2 text-left flex-1">
                      <span className="text-slate-400">{pOpen ? '▼' : '▶'}</span>
                      <span className="font-semibold text-sm text-slate-800">{p.period}</span>
                      <span className="text-xs text-slate-500">{p.totalSo}건 · {p.depts.length}개 부서</span>
                      <div className="flex flex-wrap gap-1 ml-2">
                        {Object.entries(p.totalBreakdown).map(([k, v]) => (
                          <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded ${MAJOR_BG[k] ?? 'bg-slate-100 text-slate-600'}`}>
                            {MAJOR_LABEL_KO[k] ?? k} {v}
                          </span>
                        ))}
                      </div>
                    </button>
                    {pPendingSos.length > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); forceConfirmPeriod(p.period, p.depts.flatMap((d) => d.sos)); }}
                        className="text-xs px-2 py-1 text-indigo-600 hover:bg-indigo-50 rounded border border-indigo-200 inline-flex items-center gap-1"
                        title={`이 주차의 마감 대기 ${pPendingSos.length}건(검수대기 + 차이확정)을 한 번에 대신 확정`}
                      >
                        주차 전체 대신 확정 {pPendingSos.length}
                      </button>
                    )}
                    </div>
                    {pOpen && (
                      <div className="bg-white">
                        {p.depts.map((d) => {
                          const dKey = `${pKey}::${d.dept_id}`;
                          const dOpen = expandedReceiptKeys.has(dKey);
                          return (
                            <div key={dKey} className="border-t border-slate-100">
                              <button onClick={() => toggleReceiptKey(dKey)} className="w-full px-8 py-2 flex items-center gap-2 hover:bg-slate-50 text-left">
                                <span className="text-slate-400 text-xs">{dOpen ? '▼' : '▶'}</span>
                                <span className="font-medium text-sm text-slate-700">{d.dept_name}</span>
                                <span className="text-xs text-slate-500">{d.sos.length}건</span>
                                {d.diffCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">차이 {d.diffCount}</span>}
                                <div className="flex flex-wrap gap-1 ml-2">
                                  {Object.entries(d.breakdown).map(([k, v]) => (
                                    <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded ${MAJOR_BG[k] ?? 'bg-slate-100 text-slate-600'}`}>
                                      {MAJOR_LABEL_KO[k] ?? k} {v}
                                    </span>
                                  ))}
                                </div>
                              </button>
                              {dOpen && (
                                <table className="tbl">
                                  <thead><tr>
                                    <th>분류</th>
                                    <th>불출일</th>
                                    <th>상태</th>
                                    <th className="text-right">품목수</th>
                                    <th>불출번호</th>
                                    <th></th>
                                  </tr></thead>
                                  <tbody>
                                    {d.sos.map((so) => (
                                      <tr key={so.id}>
                                        <td>
                                          <div className="flex flex-wrap gap-1">
                                            {Object.entries(so.category_breakdown ?? {}).map(([k, v]: any) => (
                                              <span key={k} className={`text-[11px] px-1.5 py-0.5 rounded ${MAJOR_BG[k] ?? 'bg-slate-100 text-slate-600'}`}>
                                                {MAJOR_LABEL_KO[k] ?? k} {v}
                                              </span>
                                            ))}
                                          </div>
                                        </td>
                                        <td className="text-xs text-slate-500">{new Date(so.issued_at).toLocaleDateString('ko-KR')}</td>
                                        <td>
                                          <span className={STATUS_CLS[so.status] || 'badge-gray'}>{STATUS_LABEL[so.status] || so.status}</span>
                                          {so.receipt_diff_count > 0 && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">차이 {so.receipt_diff_count}</span>}
                                          {(so as any).confirmed_by_purchaser && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">대신확정</span>}
                                        </td>
                                        <td className="text-right">{fmt(Number(so.item_count || 0))}</td>
                                        <td className="text-xs text-slate-400 font-mono">{so.so_no}</td>
                                        <td>
                                          <div className="inline-flex items-center gap-1">
                                            <button className="btn-ghost text-xs py-1 px-2 text-accent-600" onClick={() => openReceiptDetail(so.id)}>
                                              <ClipboardCheck className="w-3.5 h-3.5 inline mr-0.5" />검수
                                            </button>
                                            {(so.status === 'RECEIPT_PENDING' || so.status === 'RECEIPT_DIFF') && (
                                              <button
                                                className="text-xs px-2 py-1 text-indigo-600 hover:bg-indigo-50 rounded border border-indigo-200"
                                                title={so.status === 'RECEIPT_DIFF'
                                                  ? '차이가 있어도 그대로 마감 (총무구매 강제 처리)'
                                                  : '부서 수령검수 없이 총무구매가 강제로 확정 처리'}
                                                onClick={() => forceConfirmSO(so.id, so.so_no, so.status)}
                                              >
                                                대신 확정
                                              </button>
                                            )}
                                            <button
                                              className="text-xs px-1.5 py-1 text-slate-500 hover:text-blue-600"
                                              title="주차 라벨 변경"
                                              onClick={() => changeSoPeriodLabel(so.id, so.so_no, so.period_label)}
                                            >
                                              주차
                                            </button>
                                          </div>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )
      )}

      {/* ── 후속작업 탭 ── */}
      {tab === 'followup' && (
        <div className="space-y-3">
          <DateRangeFilter value={followUpDateRange} onChange={setFollowUpDateRange} label="생성일" />
          <div className="flex items-center gap-1">
            {FOLLOW_UP_STATUS_OPTIONS.map((option) => {
              const active = followUpStatusFilter === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => { setFollowUpStatusFilter(option.value); setFollowUpPage(1); }}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    active
                      ? 'bg-teal-600 text-white border-teal-600'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          {loadingFollowUps ? (
            <div className="card p-0"><EmptyState message="로딩 중..." /></div>
          ) : followUpHierarchy.length === 0 ? (
            <div className="card p-0"><EmptyState message="후속작업이 없습니다." /></div>
          ) : (
            <div className="card p-0">
              <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-700">부서별 후속작업</div>
                <div className="flex gap-2 text-xs">
                  <button className="text-blue-600 hover:underline" onClick={() => setExpandedFollowKeys(new Set(followUpHierarchy.map(d => `fu::${d.dept_id}`)))}>모두 펼치기</button>
                  <span className="text-slate-300">·</span>
                  <button className="text-blue-600 hover:underline" onClick={() => setExpandedFollowKeys(new Set())}>모두 접기</button>
                </div>
              </div>
              <div className="divide-y divide-slate-100">
                {followUpHierarchy.map((d) => {
                  const dKey = `fu::${d.dept_id}`;
                  const open = expandedFollowKeys.has(dKey);
                  return (
                    <div key={dKey}>
                      <button onClick={() => toggleFollowKey(dKey)} className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-slate-50 text-left">
                        <span className="text-slate-400">{open ? '▼' : '▶'}</span>
                        <span className="font-semibold text-sm text-slate-800">{d.dept_name}</span>
                        {d.statusCount.OPEN > 0 && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">대기 {d.statusCount.OPEN}</span>
                        )}
                        {(d.statusCount.RESOLVED + d.statusCount.CANCELLED) > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">처리됨 {d.statusCount.RESOLVED + d.statusCount.CANCELLED}</span>
                        )}
                        <div className="flex flex-wrap gap-1 ml-2">
                          {Object.entries(d.breakdown).map(([k, v]) => (
                            <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded ${MAJOR_BG[k] ?? 'bg-slate-100 text-slate-600'}`}>
                              {MAJOR_LABEL_KO[k] ?? k} {v}
                            </span>
                          ))}
                        </div>
                      </button>
                      {open && (
                        <table className="tbl">
                          <thead><tr>
                            <th>품목</th>
                            <th>유형·차이</th>
                            <th>상태</th>
                            <th>생성일</th>
                            <th>불출번호</th>
                            <th></th>
                          </tr></thead>
                          <tbody>
                            {d.rows.map((row: any) => {
                              const cat = String(row.category ?? '');
                              let major = 'GENERAL';
                              if (cat.startsWith('EQUIP_')) major = 'EQUIPMENT';
                              else if (cat.startsWith('OFF_')) major = 'OFFICE';
                              else if (cat.startsWith('MED_') || cat.startsWith('INFECT_')) major = 'MEDICAL';
                              else if (cat.startsWith('DIAPER')) major = 'DIAPER';
                              const diff = Number(row.diff_qty || 0);
                              const sign = row.action_type === 'ISSUE_ADD' ? '+' : (row.action_type === 'COLLECT_BACK' ? '−' : '');
                              return (
                                <tr key={row.id}>
                                  <td>
                                    <div className="flex items-center gap-1.5">
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${MAJOR_BG[major] ?? 'bg-slate-100 text-slate-600'}`}>{MAJOR_LABEL_KO[major] ?? major}</span>
                                      <div>
                                        <div className="font-medium text-sm">{row.item_name || row.item_id}</div>
                                        <div className="text-xs text-slate-400">{row.item_code || ''}</div>
                                        {row.note && <div className="text-[11px] text-slate-500 mt-0.5">📝 {row.note}</div>}
                                      </div>
                                    </div>
                                  </td>
                                  <td className="text-xs whitespace-nowrap">
                                    <span className="font-medium text-slate-700">{FOLLOW_UP_ACTION_LABEL[row.action_type] || row.action_type}</span>
                                    <span className={`ml-1.5 font-semibold ${row.action_type === 'ISSUE_ADD' ? 'text-rose-600' : 'text-blue-600'}`}>{sign}{fmt(Math.abs(diff))}</span>
                                  </td>
                                  <td><span className={FOLLOW_UP_STATUS_CLS[row.status] || 'badge-gray'}>{row.status}</span></td>
                                  <td className="text-xs text-slate-500">{new Date(row.created_at).toLocaleDateString('ko-KR')}</td>
                                  <td className="text-xs text-slate-400 font-mono">{row.so_no || '-'}</td>
                                  <td>
                                    <div className="text-right whitespace-nowrap flex items-center justify-end gap-1">
                                      {row.status === 'OPEN' && row.action_type === 'ISSUE_ADD' && (
                                        <>
                                          <button className="btn-ghost text-xs py-1 px-2 text-accent-600" onClick={() => createIssueFromFollowUp(row.id)} title="부족분만큼 추가로 불출 처리">
                                            <Plus className="w-3.5 h-3.5 inline mr-0.5" />추가 불출
                                          </button>
                                          <button className="btn-ghost text-xs py-1 px-2 text-slate-600" onClick={() => decideFollowUp(row.id, 'NOT_ISSUED_RETURNED', '추가불출 안 함 — 부족분이 총무구매 창고에 그대로 있습니다.\n창고 재고/lot 복원 + 부서 비용을 실수령 기준으로 정정합니다. 진행할까요?')} title="부족분이 창고에 남아있음 → 창고 재고 복원 + 부서 비용 정정">
                                            창고 환입
                                          </button>
                                          <button className="btn-ghost text-xs py-1 px-2 text-slate-600" onClick={() => decideFollowUp(row.id, 'NOT_ISSUED_LOST', '추가불출 안 함 — 부족분이 분실/파손되었습니다.\n부서 비용만 실수령 기준으로 정정합니다(창고 복원 없음). 진행할까요?')} title="부족분이 분실/파손 → 부서 비용만 정정">
                                            분실 처리
                                          </button>
                                        </>
                                      )}
                                      {row.status === 'OPEN' && row.action_type === 'COLLECT_BACK' && (
                                        <>
                                          <button className="btn-ghost text-xs py-1 px-2 text-green-600" onClick={() => decideFollowUp(row.id, 'COLLECTED', '초과분을 회수 처리합니다.\n창고 재고 환입 + 그 부서 불출 비용을 원가만큼 차감합니다. 진행할까요?')}>
                                            <CheckCircle2 className="w-3.5 h-3.5 inline mr-0.5" />회수
                                          </button>
                                          <button className="btn-ghost text-xs py-1 px-2 text-slate-600" onClick={() => decideFollowUp(row.id, 'NOT_COLLECTED', '회수 안 함으로 종결합니다. 부서가 그대로 사용하며 재고·비용 변동이 없습니다. 진행할까요?')}>
                                            회수 안 함
                                          </button>
                                        </>
                                      )}
                                      {row.status === 'OPEN' && (
                                        <button className="btn-ghost text-xs py-1 px-2 text-red-500" onClick={() => cancelFollowUp(row.id)} title="이 후속작업 자체를 취소 (재고/비용 변동 없음)">
                                          <Trash2 className="w-3.5 h-3.5 inline mr-0.5" />작업 취소
                                        </button>
                                      )}
                                      {row.status !== 'OPEN' && (
                                        <span className="text-[11px] text-slate-400">처리완료</span>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 내역 탭 (주차·부서 계층) ── */}
      {tab === 'history' && (
        <>
        <div className="mb-3">
          <DateRangeFilter value={dateRange} onChange={setDateRange} label="불출일" />
        </div>
        {loadingHistory ? (
          <div className="card p-0"><EmptyState message="로딩 중..." /></div>
        ) : historyHierarchy.length === 0 ? (
          <div className="card p-0"><EmptyState message="불출 내역이 없습니다." /></div>
        ) : (
          <div className="card p-0">
            <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-700">주차별 · 부서별 불출 내역</div>
              <div className="flex gap-2 text-xs">
                <button className="text-blue-600 hover:underline" onClick={() => {
                  const all = new Set<string>();
                  for (const p of historyHierarchy) {
                    all.add(`hp::${p.period}`);
                    for (const d of p.depts) all.add(`hp::${p.period}::${d.dept_id}`);
                  }
                  setExpandedHistoryKeys(all);
                }}>모두 펼치기</button>
                <span className="text-slate-300">·</span>
                <button className="text-blue-600 hover:underline" onClick={() => setExpandedHistoryKeys(new Set())}>모두 접기</button>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {historyHierarchy.map((p) => {
                const pKey = `hp::${p.period}`;
                const pOpen = expandedHistoryKeys.has(pKey);
                return (
                  <div key={pKey}>
                    <button onClick={() => toggleHistoryKey(pKey)} className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-slate-50 text-left">
                      <span className="text-slate-400">{pOpen ? '▼' : '▶'}</span>
                      <span className="font-semibold text-sm text-slate-800">{p.period}</span>
                      <span className="text-xs text-slate-500">{p.totalSo}건 · {p.depts.length}개 부서</span>
                      <div className="flex flex-wrap gap-1 ml-2">
                        {Object.entries(p.totalBreakdown).map(([k, v]) => (
                          <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded ${MAJOR_BG[k] ?? 'bg-slate-100 text-slate-600'}`}>
                            {MAJOR_LABEL_KO[k] ?? k} {v}
                          </span>
                        ))}
                      </div>
                    </button>
                    {pOpen && (
                      <div className="bg-white">
                        {p.depts.map((d) => {
                          const dKey = `${pKey}::${d.dept_id}`;
                          const dOpen = expandedHistoryKeys.has(dKey);
                          return (
                            <div key={dKey} className="border-t border-slate-100">
                              <button onClick={() => toggleHistoryKey(dKey)} className="w-full px-8 py-2 flex items-center gap-2 hover:bg-slate-50 text-left">
                                <span className="text-slate-400 text-xs">{dOpen ? '▼' : '▶'}</span>
                                <span className="font-medium text-sm text-slate-700">{d.dept_name}</span>
                                <span className="text-xs text-slate-500">{d.sos.length}건</span>
                                <div className="flex flex-wrap gap-1 ml-2">
                                  {Object.entries(d.breakdown).map(([k, v]) => (
                                    <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded ${MAJOR_BG[k] ?? 'bg-slate-100 text-slate-600'}`}>
                                      {MAJOR_LABEL_KO[k] ?? k} {v}
                                    </span>
                                  ))}
                                </div>
                              </button>
                              {dOpen && (
                                <table className="tbl">
                                  <thead><tr>
                                    <th>분류</th>
                                    <th>불출일</th>
                                    <th>상태</th>
                                    <th className="text-right">품목수</th>
                                    <th>불출번호</th>
                                    <th></th>
                                  </tr></thead>
                                  <tbody>
                                    {d.sos.map((so: any) => (
                                      <tr key={so.id}>
                                        <td>
                                          <div className="flex flex-wrap gap-1">
                                            {Object.entries(so.category_breakdown ?? {}).map(([k, v]: any) => (
                                              <span key={k} className={`text-[11px] px-1.5 py-0.5 rounded ${MAJOR_BG[k] ?? 'bg-slate-100 text-slate-600'}`}>
                                                {MAJOR_LABEL_KO[k] ?? k} {v}
                                              </span>
                                            ))}
                                          </div>
                                        </td>
                                        <td className="text-xs text-slate-500">{new Date(so.issued_at).toLocaleDateString('ko-KR')}</td>
                                        <td>
                                          <span className={STATUS_CLS[so.status] || 'badge-gray'}>{STATUS_LABEL[so.status] || so.status}</span>
                                          {so.receipt_diff_count > 0 && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">차이 {so.receipt_diff_count}</span>}
                                          {so.confirmed_by_purchaser && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">대신확정</span>}
                                        </td>
                                        <td className="text-right">{fmt(Number(so.item_count || 0))}</td>
                                        <td className="text-xs text-slate-400 font-mono">{so.so_no}</td>
                                        <td>
                                          <div className="inline-flex items-center gap-1">
                                            <button className="btn-ghost text-xs py-1 px-2 text-accent-600" onClick={() => openReceiptDetail(so.id)}>
                                              <Eye className="w-3.5 h-3.5 inline mr-0.5" />보기
                                            </button>
                                            <button
                                              className="text-xs px-1.5 py-1 text-slate-500 hover:text-blue-600"
                                              title="주차 라벨 변경"
                                              onClick={() => changeSoPeriodLabel(so.id, so.so_no, so.period_label)}
                                            >
                                              주차
                                            </button>
                                          </div>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        </>
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
        <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
          ⚠ 수기불출은 <strong>수령검수 단계 없이 즉시 확정</strong>됩니다 (총무구매가 직접 물품을 전달했다는 전제).
          작업보드 불출은 그대로 부서 수령검수를 거칩니다.
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
          <div>
            <label className="label">불출 부서 * <span className="text-[10px] text-slate-400 font-normal">(보관함 있는 부서만)</span></label>
            <select className="input" value={manualIssueForm.department_id} onChange={(e) => setManualIssueForm((prev) => ({ ...prev, department_id: e.target.value }))}>
              <option value="">부서 선택</option>
              {manualDepts.map((dept: any) => <option key={dept.id} value={dept.id}>{dept.name}</option>)}
            </select>
            {manualDepts.length === 0 && <p className="text-[11px] text-amber-600 mt-1">보관함이 설정된 부서가 없습니다. (재고현황에서 부서 보관함 먼저 등록 필요)</p>}
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
                      <span className="text-xs text-slate-700" title="불출 위치는 정책상 총무구매 창고 고정">
                        {centralLocation?.name || '총무구매 창고'}
                      </span>
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

      {/* ── 「대신 확정」 모달 — 부서 수령검수 없이 총무구매가 강제 확정 ── */}
      <Modal
        open={!!forceTarget}
        onClose={() => !forceSubmitting && setForceTarget(null)}
        title={forceTarget?.bulk
          ? `「${forceTarget.label}」 일괄 대신 확정 (${forceTarget.ids.length}건)`
          : `대신 확정 — ${forceTarget?.label ?? ''}`}
        size="md"
        footer={
          <>
            <button onClick={() => setForceTarget(null)} disabled={forceSubmitting} className="btn-secondary">취소</button>
            <button
              onClick={submitForceConfirm}
              disabled={forceSubmitting || (forceReasonPreset === '기타 (직접 입력)' && !forceReasonCustom.trim())}
              className="btn-primary"
            >
              {forceSubmitting
                ? '처리 중...'
                : forceTarget?.bulk
                  ? `${forceTarget.ids.length}건 모두 대신 확정`
                  : '대신 확정'}
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            ⚠ {forceTarget?.bulk
              ? <>이 주차의 <strong>마감 대기 {forceTarget.ids.length}건</strong>이 한 번에 <strong>RECEIPT_CONFIRMED</strong> 로 변경됩니다.</>
              : <>부서 수령검수 없이 즉시 <strong>RECEIPT_CONFIRMED</strong> 로 변경됩니다.</>}
            <br/>수령수량이 미입력된 라인은 출고수량과 동일하게 자동 채워집니다(차이 없음 가정).
          </div>
          {forceTarget?.hasDiff && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              ⚠ <strong>차이확정(RECEIPT_DIFF) 건 포함</strong> — 수령수량과 출고수량 차이가 있는 상태 그대로 마감됩니다.
              차이 데이터는 보존되지만 후속작업(부족분 발주·회수)으로는 자동 이관되지 않습니다. 필요하면 별도로 처리해주세요.
            </div>
          )}
          <div>
            <label className="label">사유 <span className="text-[10px] text-slate-400 font-normal">(감사 로그에 기록)</span></label>
            <select
              value={forceReasonPreset}
              onChange={(e) => setForceReasonPreset(e.target.value)}
              className="input w-full"
            >
              {FORCE_CONFIRM_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {forceReasonPreset === '기타 (직접 입력)' && (
            <div>
              <label className="label">사유 입력</label>
              <input
                type="text"
                value={forceReasonCustom}
                onChange={(e) => setForceReasonCustom(e.target.value)}
                placeholder="예: 부서 담당자 휴가 — 본인 확인 후 처리"
                autoFocus
                className="input w-full"
              />
            </div>
          )}
        </div>
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
                    const allocs = (line as any).fifo_allocations as any[] | undefined;
                    const avgCost = Number((line as any).fifo_avg_unit_cost ?? 0);
                    const totalAmt = Number((line as any).fifo_total_amount ?? 0);
                    const isMulti = !!(line as any).fifo_is_multi_lot;
                    const hasFallback = !!(line as any).fifo_has_fallback;
                    return (
                      <React.Fragment key={line.item_id}>
                      <tr className={diff !== 0 ? 'bg-yellow-50/60' : ''}>
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
                      {/* FIFO 비용 분할 — 어느 lot 단가가 적용됐는지 사용자가 직접 확인 */}
                      {allocs && allocs.length > 0 && (
                        <tr className="bg-slate-50/60">
                          <td colSpan={5} className="text-xs text-slate-600 px-3 py-1.5">
                            <span className="font-semibold text-slate-700">FIFO 비용:</span>{' '}
                            <span>총 ₩{fmt(Math.round(totalAmt))}</span>
                            <span className="ml-1 text-slate-500">· 평균 단가 ₩{fmt(Math.round(avgCost))}/{line.uom ?? ''}</span>
                            {isMulti && (
                              <span className="ml-2 inline-block text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">여러 lot 분할</span>
                            )}
                            {hasFallback && (
                              <span className="ml-1 inline-block text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">재고부족 fallback</span>
                            )}
                            <div className="mt-1 pl-2 text-[11px] text-slate-500 space-y-0.5">
                              {allocs.map((a, i) => (
                                <div key={i}>
                                  · {a.lot_id ? (
                                      <>
                                        {a.received_at ? new Date(a.received_at).toLocaleDateString('ko-KR') : '날짜?'} 입고분
                                        {a.is_base && <span className="ml-1 text-[10px] px-1 py-0 rounded bg-slate-200 text-slate-600">기초재고</span>}
                                      </>
                                    ) : <span className="text-red-600">재고부족(추정단가)</span>
                                  }
                                  &nbsp;<strong>{fmt(Number(a.issued_qty))}</strong>{line.uom ?? ''} × ₩{fmt(Math.round(Number(a.unit_cost)))} = ₩{fmt(Math.round(Number(a.line_amount)))}
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
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
