import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { api } from '../utils/api';
import { useToast } from '../components/Toast';
import { useAuth } from '../hooks/useAuth';
import { getCategoryLabel, getMajor, MAJOR_GROUP_LABEL, ALL_CATEGORIES, type MajorGroup } from '@shared/types';
import { ceilToPurchaseQty, normalizePackSize } from '@shared/units';
import { PageHeader, FilterBar, DataTable, Modal, EmptyState, FilterChips, Pagination, DateRangeFilter, inDateRange } from '../components/ui';
import type { Column, FilterChip, DateRange } from '../components/ui';
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
  Plus,
  X,
  Search,
  Trash2,
  Pencil,
  Save,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import ForecastCard, { type ForecastLine } from '../components/Approval/ForecastCard';
import PatientPanel, { type PatientItem } from '../components/Approval/PatientPanel';
import PivotView from '../components/Approval/PivotView';
import PeriodAggregateCards from '../components/Approval/PeriodAggregateCards';
import GroupedListView from '../components/Approval/GroupedListView';
import RequestMatrixView from '../components/Approval/RequestMatrixView';

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
  { v: 'CONSUMABLE_MEDICAL', l: '의료소모품' },
  { v: 'CONSUMABLE_REGULAR', l: '일반소모품' },
  { v: 'CONSUMABLE_OFFICE', l: '사무용품' },
  { v: 'DIAPER', l: '기저귀' },
  { v: 'NIGHT_SNACK', l: '야간간식' },
  { v: 'ADHOC', l: '비정기' },
  { v: 'EQUIPMENT', l: '비품' },
] as const;

const REQ_TYPE_LABEL: Record<string, string> = {
  CONSUMABLE_MEDICAL: '의료소모품',
  CONSUMABLE_REGULAR: '일반소모품',
  CONSUMABLE_OFFICE: '사무용품',
  DIAPER: '기저귀',
  NIGHT_SNACK: '야간간식',
  ADHOC: '비정기',
  EQUIPMENT: '비품',
  CONSUMABLE: '소모품',
};

interface ApprovalItem {
  id?: string;                 // WardRequestItem.id (원 신청 라인 ID) — 승인자 추가분은 undefined
  row_key?: string;            // 클라이언트 측 row 식별자 (원라인/추가라인 공용)
  added_by_approver?: boolean; // 승인자가 추가한 품목 여부 (클라이언트 전용 플래그)
  item_id: string;
  item_name?: string;
  item_code?: string;
  custom_name?: string;
  custom_spec?: string;
  is_custom?: boolean;
  uom?: string;
  purchase_uom?: string;
  issue_uom?: string;
  pack_size?: number;
  category?: string;
  requested_qty: number;
  baseline_qty: number;
  diff_pct: number;
  policy_flags: string[];
  note: string;
  latest_price?: number;
  price_up?: boolean;
  on_hand_qty?: number;
  default_vendor_id?: string | null;
  default_vendor_name?: string | null;
  // 자체 추론 (총무부 화면 전용 — 병동에는 안 보임)
  inference?: {
    recommended: number;
    min: number;
    max: number;
    patients: number;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    cold_start: boolean;
  } | null;
  variance_pct?: number;
  line_cost?: number;
  auto_reason?: {
    code: 'NORMAL' | 'UNDER_USAGE' | 'ANOMALY' | 'COLD_START' | 'NO_INFERENCE';
    label: string;
    detail: string;
  } | null;
}

interface ApprovalHistoryEntry {
  id: string;
  action: 'APPROVE' | 'ADJUST' | 'REJECT' | string;
  reason: string;
  approver_name?: string;
  created_at: string;
  items?: Array<{
    item_name?: string;
    custom_name?: string;
    approved_qty: number;
  }>;
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
  approval_history?: ApprovalHistoryEntry[];
}

interface DedupedReq extends ApprovalDetail {
  dupCount: number;
  allIds: string[];
}

interface TypeItemTotal {
  item_name: string;
  item_code?: string;
  total_approved_qty: number;
}

export default function ApprovalPage() {
  const { showToast } = useToast();
  const { hasPerm } = useAuth();
  const canDelete = hasPerm('PURCHASE_MANAGE') || hasPerm('SYSTEM_ADMIN');
  const [selectedReqTypes, setSelectedReqTypes] = useState<string[]>([]); // 빈 배열 = 전체
  const [pageTab, setPageTab] = useState<'requests' | 'history' | 'custom'>('requests');
  const [dateRange, setDateRange] = useState<DateRange>({ from: '', to: '' });
  const [regularity, setRegularity] = useState<'regular' | 'adhoc'>('regular'); // 정기 / 비정기
  const [viewMode, setViewMode] = useState<'period' | 'dept'>('period');        // 통합 / 부서별
  const [orderSummaryOpen, setOrderSummaryOpen] = useState(false);              // 발주 요약 한 줄 펼침
  // 주기별 통합 카드용 데이터 — 모든 탭 상단에 노출 (의료/일반/사무 SUBMITTED)
  const [periodAggData, setPeriodAggData] = useState<ApprovalDetail[]>([]);
  const [periodAggLoading, setPeriodAggLoading] = useState(false);
  const [pivotType, setPivotType] = useState<'CONSUMABLE_MEDICAL' | 'CONSUMABLE_REGULAR' | 'CONSUMABLE_OFFICE'>('CONSUMABLE_MEDICAL');
  const [pivotPeriod, setPivotPeriod] = useState<string>('');  // 빈값 = 전체. 'YYYY-MM' 형식 (period_start 기준)
  const [pivotData, setPivotData] = useState<ApprovalDetail[]>([]);
  const [pivotLoading, setPivotLoading] = useState(false);
  const [pivotShowApproved, setPivotShowApproved] = useState(true);  // false=요청수량, true=승인수량 (기본 = 승인수량)
  const [selectedDeptIds, setSelectedDeptIds] = useState<string[]>([]);   // 빈 배열 = 전체
  const [deptFilterOpen, setDeptFilterOpen] = useState(false);
  const deptFilterRef = useRef<HTMLDivElement>(null);

  const [submittedDetails, setSubmittedDetails] = useState<ApprovalDetail[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);

  // 직접입력 → 품목등록 모달 (자유라인을 정상 품목으로 한 큐에 교체)
  const [regModal, setRegModal] = useState<{ open: boolean; src: any | null }>({ open: false, src: null });
  const [regForm, setRegForm] = useState({ name: '', category: '', vendor_id: '', unit_price: 0, pack_size: 1, uom: 'EA' });
  const [regImageFile, setRegImageFile] = useState<File | null>(null);
  const [regSubmitting, setRegSubmitting] = useState(false);
  const [vendorOptions, setVendorOptions] = useState<{ id: string; name: string }[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<{ code: string; name: string; major_label?: string }[]>([]);

  useEffect(() => {
    api('/vendors').then((r: any) => setVendorOptions(Array.isArray(r) ? r : [])).catch(() => {});
    api('/item-categories').then((r: any[]) => {
      const list = (Array.isArray(r) ? r : [])
        .filter(x => x.is_active !== false && x.is_active !== 0)
        .map(x => ({ code: String(x.code), name: String(x.name), major_label: String(x.major_label ?? '') }));
      setCategoryOptions(list);
    }).catch(() => {});
  }, []);

  // 신청유형 → 기본 분류 추천
  const REQ_TYPE_TO_CAT: Record<string, string> = {
    CONSUMABLE_MEDICAL: 'MED_GEN', CONSUMABLE_REGULAR: 'GEN', CONSUMABLE_OFFICE: 'OFF',
    DIAPER: 'DIAPER', NIGHT_SNACK: 'NIGHT_SNACK', ADHOC: 'GEN', EQUIPMENT: 'EQUIP_GEN',
  };

  // 빌트인 + 사용자 추가 중분류 통합 옵션 (드롭다운 표시용)
  const mergedCategoryOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { code: string; name: string; major_label: string }[] = [];
    for (const c of ALL_CATEGORIES) {
      if (seen.has(c.value)) continue;
      seen.add(c.value);
      const m = getMajor(c.value);
      out.push({ code: c.value, name: c.label, major_label: MAJOR_GROUP_LABEL[m] ?? (c as any).group ?? '' });
    }
    for (const c of categoryOptions) {
      if (seen.has(c.code)) continue;
      seen.add(c.code);
      out.push({ code: c.code, name: c.name, major_label: c.major_label ?? '' });
    }
    return out.sort((a, b) => (a.major_label || '').localeCompare(b.major_label || '', 'ko') || a.name.localeCompare(b.name, 'ko'));
  }, [categoryOptions]);

  const openRegModal = (src: any) => {
    const defaultCat = REQ_TYPE_TO_CAT[src.requestType] ?? '';
    const exists = mergedCategoryOptions.some(c => c.code === defaultCat);
    setRegForm({ name: src.name ?? '', category: exists ? defaultCat : '', vendor_id: '', unit_price: 0, pack_size: 1, uom: 'EA' });
    setRegImageFile(null);
    setRegModal({ open: true, src });
  };

  const submitReg = async () => {
    const src = regModal.src;
    if (!src) return;
    const cleanName = regForm.name.trim();
    if (!cleanName) { showMsg('err', '품목명을 입력해주세요.'); return; }
    if (!regForm.category) { showMsg('err', '분류를 선택해주세요.'); return; }
    if (!src.wrItemId) { showMsg('err', '원 자유라인 식별 실패'); return; }
    setRegSubmitting(true);
    try {
      const newItem: any = await api('/items', {
        method: 'POST',
        body: JSON.stringify({
          name: cleanName,
          sub_category: src.spec || '',
          category: regForm.category,
          default_vendor_id: regForm.vendor_id || null,
          pack_size: Number(regForm.pack_size) || 1,
          uom: regForm.uom || 'EA',
          purchase_uom: regForm.uom || 'EA',
          issue_uom: regForm.uom || 'EA',
        }),
      });
      if (regForm.vendor_id && Number(regForm.unit_price) > 0) {
        await api(`/items/${newItem.id}/price`, {
          method: 'POST',
          body: JSON.stringify({
            vendor_id: regForm.vendor_id,
            price: Number(regForm.unit_price),
            source: '직접입력 등록',
          }),
        });
      }
      if (regImageFile) {
        try {
          const fd = new FormData();
          fd.append('image', regImageFile);
          await api(`/items/${newItem.id}/image`, { method: 'POST', body: fd });
        } catch (e: any) {
          // 이미지 실패해도 품목 등록·교체는 계속 진행 (사용자에게만 알림)
          showMsg('err', `사진 업로드 실패: ${e?.message ?? '서버 오류'} (품목 등록은 완료됨)`);
        }
      }
      // 원래 자유입력 라인의 item_id 를 새로 등록한 품목으로 그대로 교체(같은 줄 유지) —
      // 삭제+새 라인 추가 방식은 그 라인이 ward_request_items 에서 사라져서 나중에 불출 화면에
      // 안 뜨는 문제가 있었음(같은 wr_item_id 를 유지해야 불출 워크보드가 정상적으로 찾음).
      await api(`/approvals/${src.reqId}/items/${src.wrItemId}/relink`, {
        method: 'POST',
        body: JSON.stringify({ item_id: newItem.id }),
      });
      showMsg('ok', `「${newItem.name}」 등록 완료 (${newItem.item_code}) — 자유라인 자동 교체됨`);
      setRegModal({ open: false, src: null });
      loadSubmitted();
      loadList();
    } catch (e: any) {
      showMsg('err', e?.message ?? '품목등록 실패');
    } finally {
      setRegSubmitting(false);
    }
  };

  const [bulkQtys, setBulkQtys] = useState<Record<string, Record<string, number>>>({});
  const [bulkReasons, setBulkReasons] = useState<Record<string, string>>({});
  const [bulkInputDrafts, setBulkInputDrafts] = useState<Record<string, string>>({});
  const [catFilter, setCatFilter] = useState('');
  const [majorFilter, setMajorFilter] = useState<MajorGroup | ''>(''); // 대분류 그룹 필터 (단일 선택)
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
  const [approvedQtys, setApprovedQtys] = useState<Record<string, number>>({});       // key = row_key
  const [approvedInputDrafts, setApprovedInputDrafts] = useState<Record<string, string>>({});
  const [approverNotes, setApproverNotes] = useState<Record<string, string>>({});     // key = row_key, 승인자 라인별 메모
  const [addedRows, setAddedRows] = useState<ApprovalItem[]>([]);                     // 승인자가 추가한 품목
  const [removedRowKeys, setRemovedRowKeys] = useState<Set<string>>(new Set());       // 삭제 토글된 원 라인 row_key
  const [adhocMethod, setAdhocMethod] = useState<'PO' | 'STOCK_OUT'>('PO');
  const [submitting, setSubmitting] = useState(false);
  // 검토 중 임시저장
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftBaseline, setDraftBaseline] = useState('');  // openDetail 시점 스냅샷 (변경 감지용)
  const [hasDraft, setHasDraft] = useState(false);          // 서버에 저장된 임시저장이 있었는지
  // 승인 후 수정 모드: APPROVED / PARTIAL_APPROVED 인 detail 에서 켤 수 있음
  // 켜지면 fieldset 활성화 + 하단 버튼이 "수정 저장" 으로 바뀜
  const [amendMode, setAmendMode] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  // 품목별 불출 이력 (최근 3개월)
  const [itemTrends, setItemTrends] = useState<Record<string, number[]>>({});
  // 부서×품목별 사용 환자 명단 — { [department_id]: { [item_id]: [{ id, name, room_no, bed_no }, ...] } }
  const [patientUsage, setPatientUsage] = useState<Record<string, Record<string, Array<{ id: string; name: string; room_no: string; bed_no: number | null }>>>>({});
  // 상세 모달의 우측 사이드 패널에 표시할 선택된 라인 (환자 명단)
  const [selectedItemForPanel, setSelectedItemForPanel] = useState<{ item_id: string; item_name?: string; item_code?: string } | null>(null);
  const approvalDetailCacheRef = useRef<Map<string, ApprovalDetail>>(new Map());

  // 품목 추가 picker 상태
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerResults, setPickerResults] = useState<any[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

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
  const rowKeyOf = (it: ApprovalItem) => it.row_key ?? it.id ?? it.item_id;

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

      // 부서별·품목별 사용 환자 데이터 로드 (hover 툴팁용)
      try {
        const deptIds = [...new Set(details.map(d => d.department_id).filter(Boolean))].join(',');
        if (deptIds) {
          const usage = await api(`/approvals/patient-usage?department_ids=${encodeURIComponent(deptIds)}`);
          setPatientUsage(usage as any);
        }
      } catch { /* 사용 환자 로드 실패는 무시 */ }
    } catch (e) {
      console.error(e);
    } finally {
      setDetailsLoading(false);
    }
  }, []);

  const loadList = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams();
    // listStatus 'APPROVED' = APPROVED + PARTIAL_APPROVED 통합 (사용자에겐 부분승인 구분 안 보임)
    // 서버는 단일 상태만 받으니 ALL 받아서 클라이언트에서 필터.
    if (listStatus === 'APPROVED') p.set('status', 'ALL');
    else if (listStatus) p.set('status', listStatus);
    // 타입 다중선택이 1개면 서버필터링, 그 외(0개=전체, 2개+)는 클라이언트 필터링
    if (selectedReqTypes.length === 1) p.set('request_type', selectedReqTypes[0]);
    api(`/approvals?${p}`)
      .then((data: any) => {
        if (listStatus === 'APPROVED') {
          setList((data as any[]).filter(r => r.status === 'APPROVED' || r.status === 'PARTIAL_APPROVED'));
        } else {
          setList(data);
        }
      })
      .catch(() => showToast('승인 목록을 불러오지 못했습니다.', 'error'))
      .finally(() => setLoading(false));
  }, [listStatus, selectedReqTypes]);

  const loadHistoryTypeItemTotals = useCallback(async (requestIds: string[]): Promise<TypeItemTotal[]> => {
    const uniqIds = Array.from(new Set((requestIds ?? []).filter(Boolean)));
    if (uniqIds.length === 0) return [];

    const details = await Promise.all(
      uniqIds.map(async (id) => {
        const cached = approvalDetailCacheRef.current.get(id);
        if (cached) return cached;
        const d = await api(`/approvals/${id}`) as ApprovalDetail;
        approvalDetailCacheRef.current.set(id, d);
        return d;
      }),
    );

    const sumMap = new Map<string, { item_name: string; item_code?: string; total_approved_qty: number }>();
    for (const d of details) {
      const latest = (d.approval_history ?? [])[0];
      const codeByName = new Map<string, string>();
      for (const it of d.items ?? []) {
        const name = String(it.item_name ?? '').trim();
        const code = String(it.item_code ?? '').trim();
        if (name && code && !codeByName.has(name)) codeByName.set(name, code);
      }

      for (const ln of latest?.items ?? []) {
        const name = String(ln.item_name ?? ln.custom_name ?? '').trim();
        const qty = Number(ln.approved_qty ?? 0);
        if (!name || qty <= 0) continue;
        const code = codeByName.get(name) ?? '';
        const key = code ? `${code}::${name}` : `::${name}`;
        const cur = sumMap.get(key) ?? {
          item_name: name,
          item_code: code || undefined,
          total_approved_qty: 0,
        };
        cur.total_approved_qty += qty;
        sumMap.set(key, cur);
      }
    }

    return Array.from(sumMap.values()).sort((a, b) =>
      b.total_approved_qty - a.total_approved_qty
      || String(a.item_name ?? '').localeCompare(String(b.item_name ?? ''), 'ko'),
    );
  }, []);

  // 탭에 따라 조회 상태 동기화 — 신청 내역=제출(대기), 승인 내역=처리됨(기본 승인)
  useEffect(() => {
    setListStatus(pageTab === 'history' ? 'APPROVED' : 'SUBMITTED');
    setListPage(1);
  }, [pageTab]);

  useEffect(() => {
    loadSubmitted();
  }, [loadSubmitted]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // 피벗 탭 진입 시 모든 상태(ALL) 의 신청 + 품목 로드
  const loadPivot = useCallback(async () => {
    setPivotLoading(true);
    try {
      const list: any[] = await api(`/approvals?status=ALL&request_type=${pivotType}`);
      const detailed: ApprovalDetail[] = await Promise.all(
        list.map((r: any) => api(`/approvals/${r.id}`)),
      );
      setPivotData(detailed);
    } catch (e) {
      console.error('[loadPivot]', e);
    } finally {
      setPivotLoading(false);
    }
  }, [pivotType]);

  // (품목 통합/피벗 탭 제거됨 — loadPivot 미사용)

  // 수량 조절 탭 상단 주기별 통합 카드 — 의료/일반/사무 SUBMITTED 만 로드 (수량 조절 대상)
  const loadPeriodAggregate = useCallback(async () => {
    setPeriodAggLoading(true);
    try {
      const types = ['CONSUMABLE_MEDICAL', 'CONSUMABLE_REGULAR', 'CONSUMABLE_OFFICE', 'DIAPER'];
      const allLists = await Promise.all(
        types.map(t => api(`/approvals?status=SUBMITTED&request_type=${t}`)),
      );
      const merged = ([] as any[]).concat(...allLists);
      const detailed: ApprovalDetail[] = await Promise.all(
        merged.map((r: any) => api(`/approvals/${r.id}`)),
      );
      setPeriodAggData(detailed);
    } catch (e) {
      console.error('[loadPeriodAggregate]', e);
    } finally {
      setPeriodAggLoading(false);
    }
  }, []);

  // 모든 탭에서 PeriodAggregateCards 가 위에 보이므로 항상 로드
  useEffect(() => {
    loadPeriodAggregate();
  }, [loadPeriodAggregate]);

  // 기간 필터 적용된 신청 상세 — 모든 탭(매트릭스/직접입력)이 공통으로 사용
  const filteredSubmittedDetails = useMemo(
    () => submittedDetails.filter(d => inDateRange((d as any).period_start, dateRange)),
    [submittedDetails, dateRange],
  );

  useEffect(() => {
    setCatFilter('');
    setBulkInputDrafts({});
  }, [selectedReqTypes]);

  // URL 의 ?detail=<id> 가 있으면 자동으로 검토 모달 오픈
  // (Ctrl+클릭으로 새 탭으로 열린 신청번호 링크가 자동으로 모달까지 띄우게 됨)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const detailId = params.get('detail');
    if (detailId) {
      openDetail(detailId, params.get('item') || undefined);
      // URL 정리 — 모달 닫고 다시 열어도 자동오픈 무한루프 방지
      window.history.replaceState({}, '', window.location.pathname);
    }
    // 라우트 진입 시 1회만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 부서 필터 팝오버 외부 클릭 닫기
  useEffect(() => {
    if (!deptFilterOpen) return;
    const onClick = (e: MouseEvent) => {
      if (deptFilterRef.current && !deptFilterRef.current.contains(e.target as Node)) {
        setDeptFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [deptFilterOpen]);

  const filteredReqs = useMemo(
    () => (selectedReqTypes.length === 0
      ? submittedDetails
      : submittedDetails.filter((r) => selectedReqTypes.includes(r.request_type ?? ''))),
    [submittedDetails, selectedReqTypes]
  );

  const dedupedReqs = useMemo((): DedupedReq[] => {
    // 같은 (부서 + 신청유형) 의 신청을 하나로 합침 — 서버 중복 룰(dept+type+period)과 일치.
    // 다른 유형(의료소모품 vs 기저귀 등) 은 별도 행으로 유지 (잘못된 합산 방지).
    // 대표는 최신, items 는 모든 신청에서 합쳐서 가져옴 — 같은 item_id 중복 시 수량 합산.
    const grouped = new Map<string, ApprovalDetail[]>();
    filteredReqs.forEach((req) => {
      const key = `${deptKeyOf(req)}::${req.request_type ?? ''}`;
      const arr = grouped.get(key) ?? [];
      arr.push(req);
      grouped.set(key, arr);
    });

    const result: DedupedReq[] = [];
    for (const [, reqs] of grouped) {
      // 최신 정렬
      reqs.sort((a, b) => {
        const ad = a.submitted_at ? new Date(a.submitted_at).getTime() : 0;
        const bd = b.submitted_at ? new Date(b.submitted_at).getTime() : 0;
        return bd - ad;
      });
      const latest = reqs[0];
      // 모든 신청에서 items 병합 — 같은 item_id 면 qty 합산, 최신 신청의 ID 우선 유지
      const itemMap = new Map<string, ApprovalItem>();
      for (const r of reqs) {
        for (const it of r.items) {
          const key = it.item_id || `custom::${it.custom_name ?? ''}`;
          const existing = itemMap.get(key);
          if (!existing) {
            itemMap.set(key, { ...it });
          } else {
            // 수량 합산 (같은 품목 두 신청에서 모두 신청한 경우)
            existing.requested_qty = Number(existing.requested_qty) + Number(it.requested_qty);
            // baseline_qty 도 합산 (대표값 부재 방지)
            existing.baseline_qty = Number(existing.baseline_qty) + Number(it.baseline_qty);
          }
        }
      }
      result.push({
        ...latest,
        items: Array.from(itemMap.values()),
        dupCount: reqs.length,
        allIds: reqs.map(r => r.id),
      });
    }
    return result;
  }, [filteredReqs]);

  const deptOptions = useMemo(
    () => {
      // 부서 탭/필터는 부서 단위 (유형 무관) — 한 부서에 여러 유형 신청이 있어도 한 옵션
      const seen = new Set<string>();
      const opts: { id: string; name: string }[] = [];
      for (const r of dedupedReqs) {
        const id = deptKeyOf(r);
        if (seen.has(id)) continue;
        seen.add(id);
        opts.push({ id, name: r.department_name ?? r.department_id ?? '미지정 부서' });
      }
      return opts;
    },
    [dedupedReqs]
  );

  // 선택된 부서 중 현재 옵션에 없는 것 정리
  useEffect(() => {
    if (selectedDeptIds.length === 0) return;
    const validIds = new Set(deptOptions.map((d) => d.id));
    const next = selectedDeptIds.filter((id) => validIds.has(id));
    if (next.length !== selectedDeptIds.length) setSelectedDeptIds(next);
  }, [deptOptions, selectedDeptIds]);

  const visibleDedupedReqs = useMemo(() => {
    if (selectedDeptIds.length === 0) return dedupedReqs;
    return dedupedReqs.filter((r) => selectedDeptIds.includes(deptKeyOf(r)));
  }, [selectedDeptIds, dedupedReqs]);

  const allPivotItems = useMemo(() => {
    const map = new Map<string, ApprovalItem>();
    const srcReqs = selectedDeptIds.length > 0
      ? filteredReqs.filter((r) => selectedDeptIds.includes(deptKeyOf(r)))
      : filteredReqs;
    srcReqs.forEach((req) => req.items.forEach((it) => (!map.has(it.item_id) ? map.set(it.item_id, it) : null)));
    return [...map.values()];
  }, [filteredReqs, selectedDeptIds]);

  const filteredItems = useMemo(
    () => allPivotItems
      .filter((i) => {
        if (catFilter && i.category !== catFilter) return false;
        if (majorFilter && getMajor(i.category ?? '') !== majorFilter) return false;
        return true;
      })
      // 정렬: 1차 카테고리 코드 / 2차 품목명 가나다순 (자유입력 라인은 마지막)
      .sort((a, b) => {
        if (a.is_custom && !b.is_custom) return 1;
        if (!a.is_custom && b.is_custom) return -1;
        const c = (a.category ?? '').localeCompare(b.category ?? '', 'ko');
        if (c !== 0) return c;
        const an = a.item_name ?? a.custom_name ?? '';
        const bn = b.item_name ?? b.custom_name ?? '';
        return an.localeCompare(bn, 'ko');
      }),
    [allPivotItems, catFilter, majorFilter]
  );

  // 매트릭스 컬럼: 카테고리 필터 적용 시 — 그 필터에 매칭되는 품목이 1건이라도 있는 (부서+유형) 그룹만.
  // 정렬: 부서명 가나다순. 같은 부서 안에서는 신청 유형 가나다순.
  const matrixDedupedReqs = useMemo(() => {
    const visibleItemIds = new Set(filteredItems.map(i => i.item_id));
    const filtered = (catFilter || majorFilter)
      ? visibleDedupedReqs.filter(req => req.items.some(it => visibleItemIds.has(it.item_id)))
      : visibleDedupedReqs;
    return [...filtered].sort((a, b) => {
      const an = a.department_name ?? '';
      const bn = b.department_name ?? '';
      const c = an.localeCompare(bn, 'ko');
      if (c !== 0) return c;
      return (a.request_type ?? '').localeCompare(b.request_type ?? '', 'ko');
    });
  }, [visibleDedupedReqs, filteredItems, catFilter, majorFilter]);

  // ─── 예상 발주 요약(ForecastCard) 용 라인 합산 ────────────
  // 모든 SUBMITTED 신청의 라인을 도는데, 현재 모달이 열려있는 신청은 사용자가 편집 중인
  // approvedQtys 로 오버라이드. 그 외 신청은 bulkQtys → 없으면 requested_qty.
  // 비품 폐기/수리 신청과 자유입력 라인은 발주 대상이 아니라 제외.
  const forecastLines = useMemo<ForecastLine[]>(() => {
    const lines: ForecastLine[] = [];
    for (const req of submittedDetails) {
      const ert = (req as any).equipment_request_type;
      if (req.request_type === 'EQUIPMENT' && (ert === 'DISPOSAL' || ert === 'REPAIR')) continue;
      for (const it of req.items) {
        if (!it.item_id) continue; // 자유입력 라인 스킵
        let qty = it.requested_qty;
        if (detail?.id === req.id) {
          const rk = rowKeyOf(it);
          qty = approvedQtys[rk] ?? it.requested_qty;
        } else if (bulkQtys[req.id]?.[it.item_id] !== undefined) {
          qty = bulkQtys[req.id][it.item_id];
        }
        lines.push({
          ward_request_id: req.id,
          item_id: it.item_id,
          item_name: it.item_name ?? '',
          qty,
          pack_size: it.pack_size ?? 1,
          unit_price: it.latest_price ?? 0,
          default_vendor_id: it.default_vendor_id ?? null,
          default_vendor_name: it.default_vendor_name ?? null,
        });
      }
      // 승인자가 모달에서 추가한 라인도 현재 신청이면 포함
      if (detail?.id === req.id) {
        for (const r of addedRows) {
          if (!r.item_id) continue;
          const rk = r.row_key!;
          lines.push({
            ward_request_id: req.id,
            item_id: r.item_id,
            item_name: r.item_name ?? '',
            qty: approvedQtys[rk] ?? 0,
            pack_size: r.pack_size ?? 1,
            unit_price: r.latest_price ?? 0,
            default_vendor_id: r.default_vendor_id ?? null,
            default_vendor_name: r.default_vendor_name ?? null,
          });
        }
      }
    }
    return lines;
  }, [submittedDetails, detail, approvedQtys, bulkQtys, addedRows]);

  // 발주 요약 한 줄용 — ForecastCard 와 동일 환산식(박스환산 × 박스단가)
  const forecastSummary = useMemo(() => {
    let total = 0;
    const vendorKeys = new Set<string>();
    for (const ln of forecastLines) {
      total += ceilToPurchaseQty(ln.qty, ln.pack_size ?? 1) * ln.unit_price;
      vendorKeys.add(ln.default_vendor_id ?? '__UNASSIGNED__');
    }
    return { totalText: `₩${Math.round(total).toLocaleString('ko-KR')}`, vendorCount: vendorKeys.size };
  }, [forecastLines]);

  // 직접입력(자유입력) 신청 라인 — 매트릭스/목록에 안 잡혀 별도 탭으로 노출
  // 검토자가 임시저장으로 삭제 표시한 라인(review_draft.removed)은 즉시 숨김 (확정 전이라도)
  const customLines = useMemo(() => {
    const out: {
      reqId: string; request_no: string; dept: string; name: string; spec: string; link: string;
      qty: number; status: string; wrItemId: string; requestType: string;
    }[] = [];
    for (const d of filteredSubmittedDetails) {
      const removedSet = new Set(((d as any).review_draft?.removed ?? []).map(String));
      for (const it of (d.items ?? [])) {
        if (!it.is_custom && it.item_id) continue;
        if (it.id && removedSet.has(String(it.id))) continue; // 검토 모달에서 삭제 표시한 자유라인
        out.push({
          reqId: d.id,
          request_no: d.request_no,
          dept: d.department_name ?? '-',
          name: it.custom_name ?? it.item_name ?? '(이름없음)',
          spec: it.custom_spec ?? '',
          link: (it as any).custom_link ?? '',
          qty: Number(it.requested_qty ?? 0),
          status: d.status,
          wrItemId: String(it.id ?? ''),
          requestType: String((d as any).request_type ?? ''),
        });
      }
    }
    return out.sort((a, b) => a.dept.localeCompare(b.dept, 'ko') || a.name.localeCompare(b.name, 'ko'));
  }, [filteredSubmittedDetails]);

  // 각 대분류별 품목 개수 (배지 표시용)
  const majorCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const it of allPivotItems) {
      const m = getMajor(it.category ?? '');
      counts[m] = (counts[m] ?? 0) + 1;
    }
    return counts;
  }, [allPivotItems]);

  const distinctCats = useMemo(
    () => [...new Set(allPivotItems.map((i) => i.category).filter(Boolean))] as string[],
    [allPivotItems]
  );

  const handleBulkApprove = async () => {
    const targets = selectedDeptIds.length > 0
      ? filteredReqs.filter((r) => visibleDedupedReqs.some((v) => v.allIds.includes(r.id)))
      : filteredReqs;
    setBulkSubmitting(true);
    let ok = 0;
    let fail = 0;
    for (const req of targets) {
      try {
        const reqQtys = bulkQtys[req.id] ?? {};
        const items = req.items.map((it) => ({
          wr_item_id: it.id,
          item_id: it.item_id,
          custom_name: it.custom_name ?? '',
          approved_qty: reqQtys[it.item_id] ?? it.requested_qty,
          approver_note: '',
        }));
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

  // 신청 삭제 — 총무구매(PURCHASE_MANAGE) 또는 시스템 관리자.
  // 활성 발주/불출 이 있으면 서버가 409로 거부.
  const deleteRequest = async (req: { id: string; request_no: string; department_name?: string; status: string }) => {
    if (!confirm(`다음 신청을 삭제합니다. 되돌릴 수 없습니다.\n\n${req.request_no} | ${req.department_name ?? ''} | ${STATUS_LABEL[req.status] ?? req.status}\n\n계속하시겠습니까?`)) return;
    try {
      await api(`/ward-requests/${req.id}`, { method: 'DELETE' });
      showMsg('ok', `${req.request_no} 신청이 삭제되었습니다.`);
      loadSubmitted();
      loadList();
    } catch (e: any) {
      showMsg('err', e?.message ?? '삭제에 실패했습니다.');
    }
  };

  const openDetail = async (id: string, focusItemId?: string) => {
    try {
      const d = await api(`/approvals/${id}`);
      setDetail(d);
      // 특정 품목으로 들어온 경우 — 그 품목을 바로 선택·하이라이트하고 화면에 스크롤
      if (focusItemId) {
        const fit = (d.items || []).find((x: ApprovalItem) => x.item_id === focusItemId);
        if (fit) {
          setSelectedItemForPanel({ item_id: fit.item_id, item_name: fit.item_name ?? fit.custom_name, item_code: fit.item_code });
          setTimeout(() => {
            document.querySelector(`[data-item-row="${focusItemId}"]`)
              ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 250);
        }
      }
      // 이미 승인된 신청은 last_approved_qty 가 서버에서 채워져 있음 → "수정" 모드 prefill 에 사용
      const isProcessed = d.status === 'APPROVED' || d.status === 'PARTIAL_APPROVED';
      // 검토 중 임시저장(draft) — SUBMITTED 상태면 저장해둔 조정수량으로 prefill
      const draftByWrItem = new Map<string, { approved_qty: number; approver_note: string }>();
      if (d.status === 'SUBMITTED' && d.review_draft?.items) {
        for (const di of d.review_draft.items) {
          draftByWrItem.set(String(di.wr_item_id), {
            approved_qty: Number(di.approved_qty ?? 0),
            approver_note: String(di.approver_note ?? ''),
          });
        }
      }
      const initQty: Record<string, number> = {};
      const initNote: Record<string, string> = {};
      d.items?.forEach((it: ApprovalItem) => {
        const rk = rowKeyOf(it);
        const dft = it.id ? draftByWrItem.get(String(it.id)) : undefined;
        if (dft) {
          initQty[rk] = dft.approved_qty;
          initNote[rk] = dft.approver_note;
        } else if (isProcessed && (it as any).last_approved_qty !== null && (it as any).last_approved_qty !== undefined) {
          initQty[rk] = Number((it as any).last_approved_qty);
          initNote[rk] = String((it as any).last_approver_note ?? '');
        } else {
          initQty[rk] = it.requested_qty;
          initNote[rk] = '';
        }
      });
      // 임시저장에 담긴 "검토자 추가 품목" 복원
      const draftAdded: ApprovalItem[] = [];
      if (d.status === 'SUBMITTED' && Array.isArray(d.review_draft?.added)) {
        for (const a of d.review_draft.added) {
          const rk = uuidv4();
          draftAdded.push({
            row_key: rk, added_by_approver: true,
            item_id: a.item_id, item_name: a.item_name, item_code: a.item_code,
            uom: a.uom, category: a.category,
            requested_qty: 0, baseline_qty: 0, diff_pct: 0, policy_flags: [], note: '',
            latest_price: Number(a.latest_price ?? 0),
          });
          initQty[rk] = Number(a.approved_qty ?? 0);
          initNote[rk] = String(a.approver_note ?? '');
        }
      }
      // 임시저장에 담긴 "검토자 삭제 라인" 복원 (원 라인 rowKey = wr_item_id)
      const draftRemoved: string[] = (d.status === 'SUBMITTED' && Array.isArray(d.review_draft?.removed))
        ? d.review_draft.removed.map((x: any) => String(x)) : [];
      setApprovedQtys(initQty);
      setApprovedInputDrafts({});
      setApproverNotes(initNote);
      // 닫을 때 변경 여부 판단용 기준 스냅샷
      setDraftBaseline(JSON.stringify({ q: initQty, n: initNote }));
      setHasDraft(draftByWrItem.size > 0 || draftAdded.length > 0 || draftRemoved.length > 0);
      setAddedRows(draftAdded);
      setRemovedRowKeys(new Set(draftRemoved));
      setAction('APPROVE');
      setReason('');
      setAdhocMethod('PO');
      setAmendMode(false);

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

  const toggleRemoveRow = (rowKey: string) => {
    setRemovedRowKeys((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  const removeAddedRow = (rowKey: string) => {
    setAddedRows((prev) => prev.filter((r) => r.row_key !== rowKey));
    setApprovedQtys((prev) => { const n = { ...prev }; delete n[rowKey]; return n; });
    setApproverNotes((prev) => { const n = { ...prev }; delete n[rowKey]; return n; });
    setApprovedInputDrafts((prev) => { const n = { ...prev }; delete n[rowKey]; return n; });
  };

  // 품목 picker
  const runPickerSearch = useCallback(async (q: string) => {
    setPickerLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('search', q.trim());
      const res = await api(`/items?${params}`);
      setPickerResults(Array.isArray(res) ? res.slice(0, 50) : []);
    } catch {
      setPickerResults([]);
    } finally {
      setPickerLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!pickerOpen) return;
    const t = setTimeout(() => runPickerSearch(pickerQuery), 200);
    return () => clearTimeout(t);
  }, [pickerOpen, pickerQuery, runPickerSearch]);

  const addItemFromPicker = (item: any) => {
    if (!detail) return;
    // 이미 원 신청 또는 추가목록에 있는 품목이면 중복 방지
    const existingInOriginal = detail.items.some((it) => it.item_id === item.id);
    const existingInAdded = addedRows.some((r) => r.item_id === item.id);
    if (existingInOriginal || existingInAdded) {
      showMsg('err', '이미 포함된 품목입니다.');
      return;
    }
    const rowKey = uuidv4();
    const newRow: ApprovalItem = {
      row_key: rowKey,
      added_by_approver: true,
      item_id: item.id,
      item_name: item.name,
      item_code: item.item_code,
      uom: item.uom,
      category: item.category,
      requested_qty: 0,
      baseline_qty: 0,
      diff_pct: 0,
      policy_flags: [],
      note: '',
      latest_price: item.latest_price,
      on_hand_qty: item.on_hand_qty,
    };
    setAddedRows((prev) => [...prev, newRow]);
    setApprovedQtys((prev) => ({ ...prev, [rowKey]: 1 }));
    setApproverNotes((prev) => ({ ...prev, [rowKey]: '' }));
  };

  const reopenDecision = async () => {
    if (!detail) return;
    if (!confirm(`이 신청의 ${STATUS_LABEL[detail.status] ?? detail.status} 처리를 취소하고 다시 검토 대기 상태로 되돌리시겠습니까?\n(기존 처리 기록은 감사용으로 보존됩니다)`)) return;
    setSubmitting(true);
    try {
      await api(`/approvals/${detail.id}/reopen`, { method: 'POST' });
      showMsg('ok', '승인이 취소되었습니다. 다시 검토 대기 상태로 돌아갔습니다.');
      setDetail(null);
      setSelectedItemForPanel(null);
      loadSubmitted();
      loadList();
      loadPeriodAggregate();  // 다시 검토 대기 → 주기별 통합에 재포함
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  // 승인 후 수정 저장 — /amend 호출. SUBMITTED 로 되돌리지 않고 그대로 ADJUST 액션 추가.
  const saveAmend = async () => {
    if (!detail) return;
    const hasStructural = addedRows.length > 0 || removedRowKeys.size > 0;
    if (hasStructural && reason.trim().length < 5) {
      showMsg('err', '품목 추가/삭제 시 5자 이상의 사유가 필요합니다.');
      return;
    }
    setSubmitting(true);
    try {
      const originalKept = detail.items
        .filter((it) => !removedRowKeys.has(rowKeyOf(it)))
        .map((it) => {
          const rk = rowKeyOf(it);
          return {
            wr_item_id: it.id,
            item_id: it.item_id,
            custom_name: it.custom_name ?? '',
            approved_qty: approvedQtys[rk] ?? it.requested_qty,
            approver_note: approverNotes[rk] ?? '',
          };
        });
      const addedPayload = addedRows.map((r) => {
        const rk = r.row_key!;
        return {
          item_id: r.item_id,
          custom_name: r.custom_name ?? '',
          approved_qty: approvedQtys[rk] ?? 0,
          approver_note: approverNotes[rk] ?? '',
        };
      });
      await api(`/approvals/${detail.id}/amend`, {
        method: 'POST',
        body: JSON.stringify({ reason, items: [...originalKept, ...addedPayload] }),
      });
      showMsg('ok', '수정이 저장되었습니다.');
      setDetail(null);
      setAmendMode(false);
      loadSubmitted();
      loadList();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  // 현재 화면 상태(승인수량/메모)를 baseline 과 비교하기 위한 스냅샷
  const currentReviewSnapshot = (): string => {
    if (!detail) return '';
    const q: Record<string, number> = {};
    const n: Record<string, string> = {};
    detail.items.forEach((it) => {
      const rk = rowKeyOf(it);
      q[rk] = approvedQtys[rk] ?? it.requested_qty;
      n[rk] = approverNotes[rk] ?? '';
    });
    return JSON.stringify({ q, n });
  };

  const saveDraft = async (): Promise<boolean> => {
    if (!detail || detail.status !== 'SUBMITTED') return false;
    setSavingDraft(true);
    try {
      const items = detail.items
        .filter((it) => it.id && !removedRowKeys.has(rowKeyOf(it)))
        .map((it) => {
          const rk = rowKeyOf(it);
          return {
            wr_item_id: it.id,
            approved_qty: approvedQtys[rk] ?? it.requested_qty,
            approver_note: approverNotes[rk] ?? '',
          };
        });
      // 검토자가 삭제한 원 신청 라인
      const removed = detail.items
        .filter((it) => it.id && removedRowKeys.has(rowKeyOf(it)))
        .map((it) => it.id);
      // 검토자가 추가한 품목 (다시 열 때 복원용 정보 포함)
      const added = addedRows.map((r) => {
        const rk = r.row_key!;
        return {
          item_id: r.item_id,
          item_name: r.item_name ?? '',
          item_code: r.item_code ?? '',
          uom: r.uom ?? '',
          category: r.category ?? '',
          latest_price: r.latest_price ?? 0,
          approved_qty: approvedQtys[rk] ?? 0,
          approver_note: approverNotes[rk] ?? '',
        };
      });
      await api(`/approvals/${detail.id}/draft`, { method: 'POST', body: JSON.stringify({ items, removed, added }) });
      setDraftBaseline(currentReviewSnapshot());
      setHasDraft(true);
      showMsg('ok', '검토 내용을 임시저장했습니다. 다시 열면 이어서 검토할 수 있습니다.');
      // 부서별→통합 보기 전환 시 새로고침 없이 바로 반영되도록 상세/목록도 함께 재로드
      loadSubmitted();
      loadList();
      loadPeriodAggregate();  // 주기별 통합 합계에 조정수량 즉시 반영
      return true;
    } catch (e: any) {
      showMsg('err', e.message ?? '임시저장 실패');
      return false;
    } finally {
      setSavingDraft(false);
    }
  };

  // 모달 닫기 — SUBMITTED 에서 조정값이 바뀌었으면 임시저장할지 확인
  const closeDetail = async () => {
    if (detail && detail.status === 'SUBMITTED' && currentReviewSnapshot() !== draftBaseline) {
      if (confirm('조정한 승인수량을 임시저장할까요?\n\n[확인] 저장하고 닫기   ·   [취소] 변경 버리고 닫기')) {
        const ok = await saveDraft();
        if (!ok) return; // 저장 실패 시 모달 유지 — 데이터 보호
      }
    }
    setDetail(null);
    setSelectedItemForPanel(null);
  };

  const decide = async () => {
    if (!detail) return;
    if (action !== 'APPROVE' && !reason.trim()) {
      showMsg('err', '처리 사유를 입력해주세요.');
      return;
    }
    const hasStructural = addedRows.length > 0 || removedRowKeys.size > 0;
    if (hasStructural && reason.trim().length < 5) {
      showMsg('err', '품목 추가/삭제 시 5자 이상의 사유가 필요합니다.');
      return;
    }
    setSubmitting(true);
    try {
      // incoming items[] 구성: 원 신청 라인 중 삭제되지 않은 것 + 승인자 추가분
      const originalKept = detail.items
        .filter((it) => !removedRowKeys.has(rowKeyOf(it)))
        .map((it) => {
          const rk = rowKeyOf(it);
          return {
            wr_item_id: it.id,
            item_id: it.item_id,
            custom_name: it.custom_name ?? '',
            approved_qty: action === 'REJECT' ? 0 : (approvedQtys[rk] ?? it.requested_qty),
            approver_note: approverNotes[rk] ?? '',
          };
        });
      const addedPayload = addedRows.map((r) => {
        const rk = r.row_key!;
        return {
          item_id: r.item_id,
          custom_name: r.custom_name ?? '',
          approved_qty: action === 'REJECT' ? 0 : (approvedQtys[rk] ?? 0),
          approver_note: approverNotes[rk] ?? '',
        };
      });
      const body: any = {
        action,
        reason,
        items: [...originalKept, ...addedPayload],
      };
      const isEquipAdd = detail.request_type === 'EQUIPMENT' && (detail as any).equipment_request_type === 'ADDITION';
      if ((action === 'APPROVE' || action === 'ADJUST') && (detail.request_type === 'ADHOC' || isEquipAdd)) {
        body.approval_method = adhocMethod;
      }
      await api(`/approvals/${detail.id}/decide`, { method: 'POST', body: JSON.stringify(body) });
      showMsg('ok', `${action === 'APPROVE' ? '승인' : action === 'REJECT' ? '반려' : '조정승인'} 처리 완료`);
      setDetail(null);
      loadSubmitted();
      loadList();
      loadPeriodAggregate();  // 처리 완료분은 주기별 통합에서 빠지도록 갱신
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
      // 진짜 링크로 만들어 Ctrl+클릭 / 우클릭으로 새 탭에서 열기 가능
      render: (r) => (
        <a
          href={`/approvals?detail=${r.id}`}
          onClick={(e) => {
            // 일반 클릭은 기존 동작(같은 창에서 모달) — 새 탭은 Ctrl/Cmd/middle-click 으로
            if (e.ctrlKey || e.metaKey || e.button === 1) return;
            e.preventDefault();
            e.stopPropagation();
            openDetail(r.id);
          }}
          className="font-medium text-teal-600 hover:text-teal-800 hover:underline"
        >
          {r.request_no}
        </a>
      ),
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
        <div className="inline-flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); openDetail(r.id); }}
            className="text-xs text-teal-600 hover:text-teal-800 font-medium hover:underline"
          >
            검토
          </button>
          {canDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); deleteRequest(r); }}
              className="text-xs text-red-500 hover:text-red-700 inline-flex items-center gap-0.5"
              title="신청 삭제 (활성 발주·불출 있으면 거부)"
            >
              <Trash2 className="w-3.5 h-3.5" />삭제
            </button>
          )}
        </div>
      ),
      cardPosition: 'hidden' as const,
    },
  ], [list, canDelete]);

  return (
    <div>
      {/* 페이지 헤더 */}
      <PageHeader
        icon={CheckCircle2}
        title="승인 처리"
        description="부서 물품 신청을 검토하고 승인합니다"
      />

      {/* 페이지 탭 — 신청 내역(기본) / 승인 내역 */}
      <div className="flex border-b border-slate-200 mb-4">
        {([
          { key: 'requests' as const, label: '신청 내역', count: submittedDetails.length },
          { key: 'history' as const,  label: '승인 내역', count: undefined as number | undefined },
          { key: 'custom' as const,   label: '직접입력', count: customLines.length },
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
            {tab.label}
            {tab.count != null && tab.count > 0 && (
              <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600">{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* 기간 필터 — 모든 탭 공통 (직접입력 포함). 신청주기(period_start) 기준 */}
      <div className="mb-3">
        <DateRangeFilter value={dateRange} onChange={setDateRange} label="신청주기" />
      </div>

      {/* 공통 컨트롤 — 정기/비정기 · 통합/부서별 (+ 승인 내역: 상태) · 직접입력 탭에선 숨김 */}
      {pageTab !== 'custom' && (
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-sm">
          {([['regular', '정기'], ['adhoc', '비정기']] as const).map(([v, l]) => (
            <button key={v} onClick={() => setRegularity(v)}
              className={`px-4 py-1.5 ${regularity === v ? 'bg-teal-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-sm">
          {([['period', '통합 보기'], ['dept', '부서별 보기']] as const).map(([v, l]) => (
            <button key={v} onClick={() => setViewMode(v)}
              className={`px-4 py-1.5 ${viewMode === v ? 'bg-teal-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
              {l}
            </button>
          ))}
        </div>
        {pageTab === 'history' && (
          <select
            value={listStatus}
            onChange={(e) => { setListStatus(e.target.value); setListPage(1); }}
            className="input w-auto text-sm"
          >
            <option value="APPROVED">승인됨</option>
            <option value="REJECTED">반려</option>
            <option value="CANCELLED">취소</option>
            <option value="ALL">전체</option>
          </select>
        )}
        <span className="text-xs text-slate-400 ml-auto">
          {regularity === 'regular' ? '신청주기에 맞춰 신청된 건' : '임시·비품 등 비정기 신청'}
          {' · '}{viewMode === 'period' ? '주기별로 부서 합쳐서' : '부서별로'}
        </span>
      </div>
      )}

      {/* 발주 요약 한 줄 — 신청 내역에서만. 펼치면 거래처별 상세 */}
      {pageTab === 'requests' && (
        <div className="mb-4">
          <button
            onClick={() => setOrderSummaryOpen(o => !o)}
            className="w-full flex items-center justify-between px-4 py-2.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-sm"
          >
            <span className="inline-flex items-center gap-2 text-slate-600">
              {orderSummaryOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              발주 요약
            </span>
            <span className="text-slate-700">
              승인 대기 <b className="text-teal-700">{forecastSummary.totalText}</b>
              <span className="text-slate-400 ml-2">· {forecastSummary.vendorCount}개 거래처</span>
            </span>
          </button>
          {orderSummaryOpen && (
            <div className="mt-2">
              <ForecastCard
                lines={forecastLines}
                loading={detailsLoading}
                currentRequestId={detail?.id}
                onRefresh={loadSubmitted}
              />
            </div>
          )}
        </div>
      )}

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


      {/* ===== 신청/승인 내역 — 정기·비정기 + 통합/부서별 ===== */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 text-sm gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> 로딩 중...
        </div>
      ) : (
        (() => {
          // 직접입력(자유입력) 전용 탭 — 보기 + [검토] 모달
          if (pageTab === 'custom') {
            return (
              <div className="card p-0 overflow-hidden">
                {customLines.length === 0 ? (
                  <div className="py-12 text-center text-sm text-slate-400">처리할 직접입력 신청이 없습니다.</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-50 text-[11px] text-slate-500">
                        <th className="px-3 py-2 text-left font-medium">부서</th>
                        <th className="px-3 py-2 text-left font-medium">품명</th>
                        <th className="px-3 py-2 text-left font-medium">규격</th>
                        <th className="px-3 py-2 text-right font-medium" style={{ width: 72 }}>수량</th>
                        <th className="px-3 py-2 text-center font-medium" style={{ width: 56 }}>링크</th>
                        <th className="px-3 py-2 text-center font-medium" style={{ width: 72 }}>상태</th>
                        <th className="px-3 py-2 text-right font-medium" style={{ width: 64 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {customLines.map((c, i) => (
                        <tr key={`${c.reqId}-${i}`} className="border-t border-slate-100 hover:bg-slate-50/50">
                          <td className="px-3 py-1.5 text-slate-700">{c.dept}</td>
                          <td className="px-3 py-1.5 font-medium text-slate-800">
                            <span className="text-amber-500 text-xs mr-1">[직접입력]</span>{c.name}
                          </td>
                          <td className="px-3 py-1.5 text-slate-500 text-xs">{c.spec || '-'}</td>
                          <td className="px-3 py-1.5 text-right">{c.qty}</td>
                          <td className="px-3 py-1.5 text-center">
                            {c.link
                              ? <a href={c.link} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline text-xs">열기</a>
                              : <span className="text-slate-300">-</span>}
                          </td>
                          <td className="px-3 py-1.5 text-center">
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">{STATUS_LABEL[c.status] ?? c.status}</span>
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <div className="inline-flex items-center gap-2">
                              <button onClick={() => openRegModal(c)} className="text-xs text-blue-600 hover:underline" title="이 자유입력을 정상 품목으로 등록하고 자동 교체">품목등록</button>
                              <button onClick={() => openDetail(c.reqId)} className="text-xs text-teal-600 hover:underline">검토</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          }
          const REGULAR_TYPES = ['CONSUMABLE_MEDICAL', 'CONSUMABLE_REGULAR', 'CONSUMABLE_OFFICE', 'DIAPER', 'NIGHT_SNACK'];
          const isRegular = (t: string) => REGULAR_TYPES.includes(String(t));
          // 통합 보기 + 신청 내역 + 정기 → 편집 가능한 품목×부서 매트릭스(임시저장)
          if (viewMode === 'period' && pageTab === 'requests' && regularity === 'regular') {
            return (
              <RequestMatrixView
                // 정기 탭이지만 filteredSubmittedDetails 자체엔 비정기 신청도 섞여있음(날짜만 필터됨) —
                // 매트릭스에 넘기기 전에 반드시 정기 신청으로만 걸러야 함. 안 그러면 비정기 신청 품목이
                // 같은 대분류 섹션에 표시 구분 없이 섞여 들어가서, "이 분류 전체 승인"/"전체 저장" 시
                // 검토자가 모르는 사이에 비정기 신청까지 함께 승인/저장됨.
                data={(filteredSubmittedDetails as any[]).filter(d => isRegular(d.request_type))}
                patientUsage={patientUsage}
                onOpenDetail={openDetail}
                onSaved={() => { loadSubmitted(); loadList(); }}
              />
            );
          }
          // 그 외(부서별 보기 · 비정기 · 승인 내역) → 그룹 목록
          const displayList = (list as any[]).filter((r) =>
            (regularity === 'regular' ? isRegular(r.request_type) : !isRegular(r.request_type))
            && inDateRange(r.period_start, dateRange));
          return (
            <GroupedListView
              data={displayList}
              groupBy={viewMode}
              onOpenDetail={openDetail}
              onDelete={deleteRequest}
              canDelete={canDelete}
              loadTypeItemTotals={pageTab === 'history' ? loadHistoryTypeItemTotals : undefined}
            />
          );
        })()
      )}

      {/* ===== 상세 검토 모달 ===== */}
      <Modal
        open={!!detail}
        onClose={closeDetail}
        title={`${detail?.request_no ?? ''} 검토${hasDraft && detail?.status === 'SUBMITTED' ? ' · 임시저장 불러옴' : ''}`}
        size="full"
        footer={
          <>
            <button onClick={closeDetail} className="btn-secondary">닫기</button>
            {detail?.status === 'SUBMITTED' ? (
              <>
                <button
                  onClick={saveDraft}
                  disabled={savingDraft || submitting}
                  className="btn-secondary inline-flex items-center gap-1.5"
                  title="조정한 승인수량을 저장만 합니다 — 승인은 되지 않고 검토 대기 상태가 유지됩니다"
                >
                  {savingDraft ? <><Loader2 className="w-4 h-4 animate-spin" /> 저장 중...</> : <><Save className="w-4 h-4" /> 임시저장</>}
                </button>
                <button onClick={decide} disabled={submitting || savingDraft} className="btn-primary inline-flex items-center gap-1.5">
                  {submitting ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> 처리 중...</>
                  ) : (
                    <><CheckCircle2 className="w-4 h-4" /> 승인 처리</>
                  )}
                </button>
              </>
            ) : amendMode ? (
              <>
                <button
                  onClick={() => setAmendMode(false)}
                  disabled={submitting}
                  className="btn-secondary inline-flex items-center gap-1.5"
                  title="수정을 취소합니다"
                >
                  <X className="w-4 h-4" /> 수정 취소
                </button>
                <button
                  onClick={saveAmend}
                  disabled={submitting}
                  className="btn-primary inline-flex items-center gap-1.5"
                  title="변경사항을 저장합니다 — 상태는 그대로 유지됩니다"
                >
                  {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> 저장 중...</> : <><CheckCircle2 className="w-4 h-4" /> 수정 저장</>}
                </button>
              </>
            ) : (
              <>
                {(detail?.status === 'APPROVED' || detail?.status === 'PARTIAL_APPROVED') && (
                  <button
                    onClick={() => setAmendMode(true)}
                    disabled={submitting}
                    className="btn-primary inline-flex items-center gap-1.5"
                    title="수량/품목을 수정합니다 (재승인 없이)"
                  >
                    <Pencil className="w-4 h-4" /> 수정
                  </button>
                )}
                <button
                  onClick={reopenDecision}
                  disabled={submitting}
                  className="btn-secondary inline-flex items-center gap-1.5"
                  style={{ borderColor: '#dc2626', color: '#dc2626' }}
                  title="이 신청의 처리를 취소하고 다시 검토 대기 상태로 되돌립니다"
                >
                  {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> 처리 중...</> : <><X className="w-4 h-4" /> 승인 취소(되돌리기)</>}
                </button>
              </>
            )}
          </>
        }
      >
        {detail && (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
            <div className="space-y-4 min-w-0">
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

            {/* 이미 처리된 신청 안내 카드 */}
            {detail.status !== 'SUBMITTED' && (() => {
              const lastAction = detail.approval_history?.[0];
              const actionLabel = lastAction?.action === 'APPROVE' ? '승인'
                : lastAction?.action === 'ADJUST' ? '조정승인'
                : lastAction?.action === 'REJECT' ? '반려'
                : STATUS_LABEL[detail.status] ?? detail.status;
              const statusBg =
                detail.status === 'APPROVED' ? 'bg-green-50 border-green-200 text-green-800'
                : detail.status === 'PARTIAL_APPROVED' ? 'bg-yellow-50 border-yellow-200 text-yellow-800'
                : 'bg-red-50 border-red-200 text-red-800';
              return (
                <div className={`rounded-xl border p-3 ${statusBg}`}>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <CheckCircle2 className="w-4 h-4" />
                    이 신청은 이미 처리되었습니다 — <strong>{actionLabel}</strong>
                  </div>
                  {lastAction && (
                    <div className="mt-1 text-xs">
                      처리자: {lastAction.approver_name ?? '—'} · 처리일시: {new Date(lastAction.created_at).toLocaleString('ko-KR')}
                      {lastAction.reason ? <> · 사유: {lastAction.reason}</> : null}
                    </div>
                  )}
                  <div className="mt-2 text-xs">
                    {amendMode ? (
                      <><strong>수정 모드</strong> — 수량/메모/품목 추가삭제가 가능합니다. 변경 후 하단의 <strong>"수정 저장"</strong> 을 누르세요. 상태는 현재대로 유지됩니다.</>
                    ) : (
                      <>아래 정보는 <strong>참조용</strong>입니다. 수량을 바꾸려면 하단의 <strong>"수정"</strong>, 처음부터 다시 검토하려면 <strong>"승인 취소(되돌리기)"</strong>.</>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* 품목 테이블 — 처리된 신청은 fieldset disabled, 단 수정 모드면 활성화 */}
            <fieldset disabled={detail.status !== 'SUBMITTED' && !amendMode} className="contents">
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>품목</th>
                    <th className="text-right">요청</th>
                    <th className="text-right">기준/편차</th>
                    <th className="text-right">재고</th>
                    <th className="text-right">사용환자</th>
                    <th className="text-right text-xs text-slate-400">최근6개월</th>
                    <th className="text-right">승인수량</th>
                    <th>승인자 메모</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {[...detail.items]
                    .sort((a, b) => {
                      // 품목 코드순 (자연 정렬). 코드 없는 자유입력 항목은 뒤로.
                      const ca = a.item_code ?? '', cb = b.item_code ?? '';
                      if (!ca && !cb) return 0;
                      if (!ca) return 1;
                      if (!cb) return -1;
                      return ca.localeCompare(cb, 'ko', { numeric: true });
                    })
                    .map((it, idx) => {
                    const rk = rowKeyOf(it);
                    const removed = removedRowKeys.has(rk);
                    const diffPct = Number(it.diff_pct ?? 0);
                    const onHand = Number(it.on_hand_qty ?? 0);
                    const requested = Number(it.requested_qty ?? 0);
                    const overBaseline = diffPct > 15;
                    const stockSufficient = requested > 0 && onHand >= requested * 0.3;
                    const noVendor = !it.default_vendor_id;
                    const linePatients: PatientItem[] = (detail.department_id ? patientUsage[detail.department_id]?.[it.item_id] : undefined) ?? [];
                    const isSelectedForPanel = selectedItemForPanel?.item_id === it.item_id;
                    const rowCls = [
                      removed ? 'opacity-40 line-through' : '',
                      overBaseline ? 'bg-red-50/60' : stockSufficient ? 'bg-orange-50/40' : '',
                      isSelectedForPanel ? 'ring-2 ring-blue-300' : '',
                      'cursor-pointer',
                    ].filter(Boolean).join(' ');
                    return (
                      <tr
                        key={it.item_id || `custom-${idx}`}
                        data-item-row={it.item_id}
                        className={rowCls}
                        onClick={() => setSelectedItemForPanel({ item_id: it.item_id, item_name: it.item_name ?? it.custom_name, item_code: it.item_code })}
                      >
                        <td>
                          {it.is_custom && <span className="text-amber-500 text-xs mr-1">[직접입력]</span>}
                          {it.item_name || it.custom_name}
                          {!it.is_custom && <span className="text-xs text-slate-400 ml-1">{it.item_code}</span>}
                          {it.is_custom && it.custom_spec && <span className="text-xs text-slate-400 ml-1">({it.custom_spec})</span>}
                          {(it as any).custom_link && (
                            <a href={(it as any).custom_link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-xs text-blue-500 hover:underline ml-1" onClick={e => e.stopPropagation()}>
                              <ExternalLink className="w-3 h-3" /> 링크
                            </a>
                          )}
                          {(() => {
                            const iu = it.issue_uom ?? it.uom ?? '';
                            const pu = it.purchase_uom ?? '';
                            const ps = Number(it.pack_size ?? 1);
                            if (!iu) return null;
                            return (
                              <span className="text-xs text-slate-400 ml-1">
                                [{iu}
                                {ps > 1 && pu && pu !== iu && <span className="text-blue-500"> · 1{pu}={ps}{iu}</span>}
                                ]
                              </span>
                            );
                          })()}
                          <div className="text-xs mt-0.5">
                            {it.default_vendor_name ? (
                              <span className="text-slate-500">{it.default_vendor_name}</span>
                            ) : (
                              <span className="text-red-600 inline-flex items-center gap-0.5">
                                <AlertTriangle className="w-3 h-3" /> 거래처 미지정
                              </span>
                            )}
                            {it.latest_price ? (
                              <span className="text-slate-400 ml-2">@{Number(it.latest_price).toLocaleString('ko-KR')}원</span>
                            ) : null}
                            {it.line_cost ? (
                              <span className="text-slate-500 ml-2">= {Number(it.line_cost).toLocaleString('ko-KR')}원</span>
                            ) : null}
                          </div>
                          {it.inference && it.auto_reason && (
                            <div className="text-xs mt-0.5 inline-flex items-center gap-1.5">
                              <span className={
                                it.auto_reason.code === 'ANOMALY' ? 'px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200' :
                                it.auto_reason.code === 'UNDER_USAGE' ? 'px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200' :
                                it.auto_reason.code === 'NORMAL' ? 'px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200' :
                                it.auto_reason.code === 'COLD_START' ? 'px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200' :
                                'px-1.5 py-0.5 rounded bg-slate-50 text-slate-500 border border-slate-200'
                              } title={it.auto_reason.detail}>
                                {it.auto_reason.label}
                              </span>
                              {it.inference.recommended > 0 && (
                                <span className="text-slate-400">
                                  권장 {it.inference.recommended}
                                  {typeof it.variance_pct === 'number' && it.variance_pct !== 0 && (
                                    <span className={it.variance_pct > 50 ? 'text-red-500 ml-1' : it.variance_pct < -50 ? 'text-amber-500 ml-1' : 'text-slate-400 ml-1'}>
                                      ({it.variance_pct > 0 ? '+' : ''}{it.variance_pct}%)
                                    </span>
                                  )}
                                </span>
                              )}
                              {it.inference.patients > 0 && (
                                <span className="text-slate-400">· 환자 {it.inference.patients}명</span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="text-right">{fmt(it.requested_qty)}</td>
                        <td className="text-right">
                          {Number(it.baseline_qty ?? 0) > 0 ? (
                            <div className="flex flex-col items-end">
                              <span className="text-sm text-slate-600">{fmt(it.baseline_qty)}</span>
                              <span className={`text-xs ${overBaseline ? 'text-red-600 font-semibold' : diffPct < -15 ? 'text-blue-600' : 'text-slate-400'}`}>
                                {diffPct > 0 ? '+' : ''}{diffPct.toFixed(0)}%
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-300">-</span>
                          )}
                        </td>
                        <td className={`text-right text-sm font-medium ${onHand === 0 ? 'text-red-500' : stockSufficient ? 'text-orange-600' : 'text-slate-600'}`}>
                          {onHand}
                        </td>
                        <td className="text-right">
                          {linePatients.length > 0 ? (
                            <span className="text-sm text-blue-600 font-medium">{linePatients.length}명</span>
                          ) : (
                            <span className="text-xs text-slate-300">-</span>
                          )}
                        </td>
                        <td className="text-right">
                          {itemTrends[it.item_id] ? (
                            <div className="flex items-center gap-0.5 justify-end" title={`최근 6개월 불출: ${itemTrends[it.item_id].join(', ')}`}>
                              {itemTrends[it.item_id].map((q, idx2) => (
                                <span key={idx2} className={`text-[10px] px-1 py-0.5 rounded ${
                                  idx2 === itemTrends[it.item_id].length - 1 ? 'bg-teal-100 text-teal-700 font-medium' : 'text-slate-400'
                                }`}>{q}</span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-slate-300">-</span>
                          )}
                        </td>
                        <td className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <input
                              type="text"
                              inputMode="numeric"
                              disabled={removed}
                              value={approvedInputDrafts[rk] ?? fmt(approvedQtys[rk] ?? it.requested_qty)}
                              onFocus={() => {
                                setApprovedInputDrafts((prev) => ({
                                  ...prev,
                                  [rk]: String(approvedQtys[rk] ?? it.requested_qty),
                                }));
                              }}
                              onChange={(e) => {
                                const raw = toRawNumericText(e.target.value);
                                setApprovedInputDrafts((prev) => ({ ...prev, [rk]: raw }));
                              }}
                              onBlur={() => {
                                const raw = approvedInputDrafts[rk] ?? String(approvedQtys[rk] ?? it.requested_qty);
                                const v = Math.max(0, parseNumericInput(raw));
                                setApprovedQtys((prev) => ({ ...prev, [rk]: v }));
                                setApprovedInputDrafts((prev) => {
                                  const next = { ...prev };
                                  delete next[rk];
                                  return next;
                                });
                              }}
                              className="input w-20 text-right inline-block"
                            />
                            <span className="text-xs text-slate-500 whitespace-nowrap">{it.issue_uom ?? it.uom ?? ''}</span>
                          </div>
                        </td>
                        <td>
                          <input
                            type="text"
                            disabled={removed}
                            value={approverNotes[rk] ?? ''}
                            onChange={(e) => setApproverNotes((prev) => ({ ...prev, [rk]: e.target.value }))}
                            placeholder="메모(선택)"
                            className="input text-sm"
                          />
                        </td>
                        <td className="text-center">
                          <button
                            type="button"
                            onClick={() => toggleRemoveRow(rk)}
                            title={removed ? '삭제 취소' : '이 품목 제외'}
                            className="text-slate-400 hover:text-red-600"
                          >
                            {removed ? <Plus className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {/* 승인자 추가 행 */}
                  {addedRows.map((r) => {
                    const rk = r.row_key!;
                    const onHand = Number(r.on_hand_qty ?? 0);
                    return (
                      <tr key={rk} className="bg-blue-50/40">
                        <td>
                          <span className="text-blue-600 text-xs mr-1">[승인자 추가]</span>
                          {r.item_name}
                          <span className="text-xs text-slate-400 ml-1">{r.item_code}</span>
                          <div className="text-xs mt-0.5">
                            {r.default_vendor_name ? (
                              <span className="text-slate-500">{r.default_vendor_name}</span>
                            ) : (
                              <span className="text-red-600 inline-flex items-center gap-0.5">
                                <AlertTriangle className="w-3 h-3" /> 거래처 미지정
                              </span>
                            )}
                            {r.latest_price ? (
                              <span className="text-slate-400 ml-2">@{Number(r.latest_price).toLocaleString('ko-KR')}원</span>
                            ) : null}
                          </div>
                        </td>
                        <td className="text-right text-xs text-slate-400">-</td>
                        <td className="text-right text-xs text-slate-300">-</td>
                        <td className={`text-right text-sm font-medium ${onHand === 0 ? 'text-red-500' : 'text-slate-600'}`}>
                          {onHand}
                        </td>
                        <td className="text-right text-xs text-slate-300">-</td>
                        <td className="text-right text-xs text-slate-300">-</td>
                        <td className="text-right">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={approvedInputDrafts[rk] ?? fmt(approvedQtys[rk] ?? 0)}
                            onFocus={() => {
                              setApprovedInputDrafts((prev) => ({ ...prev, [rk]: String(approvedQtys[rk] ?? 0) }));
                            }}
                            onChange={(e) => {
                              const raw = toRawNumericText(e.target.value);
                              setApprovedInputDrafts((prev) => ({ ...prev, [rk]: raw }));
                            }}
                            onBlur={() => {
                              const raw = approvedInputDrafts[rk] ?? String(approvedQtys[rk] ?? 0);
                              const v = Math.max(0, parseNumericInput(raw));
                              setApprovedQtys((prev) => ({ ...prev, [rk]: v }));
                              setApprovedInputDrafts((prev) => {
                                const next = { ...prev };
                                delete next[rk];
                                return next;
                              });
                            }}
                            className="input w-24 text-right inline-block"
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={approverNotes[rk] ?? ''}
                            onChange={(e) => setApproverNotes((prev) => ({ ...prev, [rk]: e.target.value }))}
                            placeholder="메모(선택)"
                            className="input text-sm"
                          />
                        </td>
                        <td className="text-center">
                          <button
                            type="button"
                            onClick={() => removeAddedRow(rk)}
                            title="추가 취소"
                            className="text-slate-400 hover:text-red-600"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </fieldset>

            {/* 품목 추가 버튼 — SUBMITTED 또는 수정 모드 */}
            {(detail.status === 'SUBMITTED' || amendMode) && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => { setPickerOpen(true); setPickerQuery(''); }}
                  className="inline-flex items-center gap-1.5 text-sm text-teal-700 hover:text-teal-900 hover:bg-teal-50 px-3 py-1.5 rounded border border-teal-200"
                >
                  <Plus className="w-4 h-4" /> 품목 추가
                </button>
              </div>
            )}

            {/* 처리 방식 / 방법 — SUBMITTED 일 때만 */}
            {detail.status === 'SUBMITTED' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">처리 방식</label>
                <select value={action} onChange={(e) => setAction(e.target.value as any)} className="input">
                  <option value="APPROVE">승인</option>
                  <option value="ADJUST">수량조정 승인</option>
                  <option value="REJECT">반려</option>
                </select>
              </div>
              {((detail.request_type === 'ADHOC') || (detail.request_type === 'EQUIPMENT' && (detail as any).equipment_request_type === 'ADDITION')) && (action === 'APPROVE' || action === 'ADJUST') && (
                <div>
                  <label className="label">처리 방법</label>
                  <select value={adhocMethod} onChange={(e) => setAdhocMethod(e.target.value as any)} className="input">
                    <option value="PO">승인만 (발주는 별도)</option>
                    <option value="STOCK_OUT">즉시 불출</option>
                  </select>
                  {adhocMethod === 'STOCK_OUT' && detail.items.some(it => (it.on_hand_qty ?? 0) < (approvedQtys[rowKeyOf(it)] ?? it.requested_qty)) && (
                    <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" /> 재고 부족 품목이 있습니다. 즉시 불출은 재고 한도 내에서만 처리됩니다.
                    </p>
                  )}
                </div>
              )}
            </div>
            )}

            {/* 처리 사유 — SUBMITTED 일 때만 */}
            {detail.status === 'SUBMITTED' && (
              <div>
                <label className="label">처리 사유</label>
                <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className="input" placeholder="수량조정/반려 시 필수" />
              </div>
            )}
            </div>
            {/* 우측: 사용 환자 명단 사이드 패널 */}
            <aside className="lg:sticky lg:top-0 self-start">
              <PatientPanel
                itemName={selectedItemForPanel?.item_name}
                itemCode={selectedItemForPanel?.item_code}
                patients={(detail.department_id && selectedItemForPanel?.item_id && patientUsage[detail.department_id]?.[selectedItemForPanel.item_id]) || []}
                onClose={() => setSelectedItemForPanel(null)}
              />
            </aside>
          </div>
        )}
      </Modal>

      {/* ===== 품목 추가 picker ===== */}
      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="품목 추가"
        size="lg"
        footer={
          <button onClick={() => setPickerOpen(false)} className="btn-secondary">닫기</button>
        }
      >
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="품목명 검색..."
              autoFocus
              className="input pl-9"
            />
          </div>
          <div className="border rounded-lg overflow-hidden" style={{ maxHeight: 420, overflowY: 'auto' }}>
            {pickerLoading ? (
              <div className="py-10 text-center text-slate-400 text-sm"><Loader2 className="w-4 h-4 animate-spin inline mr-1" /> 로딩 중...</div>
            ) : pickerResults.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-sm">검색 결과가 없습니다.</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>품목명</th>
                    <th>코드</th>
                    <th className="text-right">단위</th>
                    <th className="text-right">재고</th>
                    <th className="text-right">최신단가</th>
                    <th className="w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {pickerResults.map((it: any) => (
                    <tr key={it.id}>
                      <td className="font-medium">{it.name}</td>
                      <td className="text-xs text-slate-500">{it.item_code}</td>
                      <td className="text-right text-xs">{it.uom}</td>
                      <td className="text-right text-xs">{fmt(it.on_hand_qty ?? 0)}</td>
                      <td className="text-right text-xs">{it.latest_price ? fmt(it.latest_price) : '-'}</td>
                      <td className="text-center">
                        <button
                          type="button"
                          onClick={() => { addItemFromPicker(it); setPickerOpen(false); }}
                          className="text-xs text-teal-600 hover:text-teal-800 hover:underline"
                        >
                          추가
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Modal>

      {/* ===== 직접입력 → 품목등록 모달 ===== */}
      {regModal.open && regModal.src && (
        <Modal
          open={regModal.open}
          onClose={() => !regSubmitting && setRegModal({ open: false, src: null })}
          title="품목 등록 + 자유라인 자동 교체"
          size="md"
          footer={
            <>
              <button onClick={() => setRegModal({ open: false, src: null })} disabled={regSubmitting} className="btn-secondary">취소</button>
              <button onClick={submitReg} disabled={regSubmitting} className="btn-primary">
                {regSubmitting ? '등록 중...' : '등록 + 교체'}
              </button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">원 자유입력 (참고)</div>
              <div className="text-xs text-slate-600">
                부서: {regModal.src.dept} · 수량: {regModal.src.qty}
                {regModal.src.spec && <> · 규격: {regModal.src.spec}</>}
                {regModal.src.link && <> · <a href={regModal.src.link} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">참고링크</a></>}
              </div>
            </div>

            <div>
              <label className="label">품목명 <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={regForm.name}
                onChange={e => setRegForm(f => ({ ...f, name: e.target.value }))}
                className="input w-full"
                placeholder="예: Gauze 4x4"
              />
            </div>

            <div>
              <label className="label">분류 <span className="text-red-500">*</span></label>
              <select value={regForm.category} onChange={e => setRegForm(f => ({ ...f, category: e.target.value }))} className="input w-full">
                <option value="">선택...</option>
                {mergedCategoryOptions.map(c => (
                  <option key={c.code} value={c.code}>{c.major_label ? `[${c.major_label}] ` : ''}{c.name} ({c.code})</option>
                ))}
              </select>
              <p className="text-[11px] text-slate-400 mt-1">기본 중분류 + 분류관리에서 추가한 중분류 모두 포함 ({mergedCategoryOptions.length}개)</p>
            </div>

            <div>
              <label className="label">사진 (선택)</label>
              <input
                type="file"
                accept="image/*"
                onChange={e => setRegImageFile(e.target.files?.[0] ?? null)}
                className="block w-full text-xs text-slate-600 file:mr-3 file:py-1 file:px-3 file:rounded file:border file:border-slate-300 file:bg-slate-50 file:text-slate-700 hover:file:bg-slate-100"
              />
              {regImageFile && (
                <p className="text-[11px] text-slate-500 mt-1">선택됨: {regImageFile.name} ({Math.round(regImageFile.size / 1024)} KB)</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">거래처 (선택)</label>
                <select value={regForm.vendor_id} onChange={e => setRegForm(f => ({ ...f, vendor_id: e.target.value }))} className="input w-full">
                  <option value="">미지정</option>
                  {vendorOptions.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">단가 (거래처 있을 때만 등록)</label>
                <input type="number" min={0} value={regForm.unit_price} onChange={e => setRegForm(f => ({ ...f, unit_price: Number(e.target.value) || 0 }))} className="input w-full" />
              </div>
              <div>
                <label className="label">팩사이즈 (1개 박스당 수량)</label>
                <input type="number" min={1} value={regForm.pack_size} onChange={e => setRegForm(f => ({ ...f, pack_size: Number(e.target.value) || 1 }))} className="input w-full" />
              </div>
              <div>
                <label className="label">단위</label>
                <input type="text" value={regForm.uom} onChange={e => setRegForm(f => ({ ...f, uom: e.target.value }))} className="input w-full" placeholder="EA" />
              </div>
            </div>

            <p className="text-xs text-slate-500">
              · 품목코드는 분류 접두어로 자동 채번됩니다 (예: MED-0123, GEN-0045).<br/>
              · 거래처·단가는 비워둬도 등록됩니다 — 발주 대기에서 거래처 미지정 섹션으로 떠서 거기서 지정 가능.<br/>
              · 등록 즉시 이 신청의 자유라인이 신규 품목으로 교체되고 (임시저장), 직접입력 탭에서 사라집니다.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
