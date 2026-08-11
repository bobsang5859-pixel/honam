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
  Search,
  Minus,
  LayoutGrid,
  Table2,
  ShoppingCart,
  Info,
  BarChart2,
  Users,
} from 'lucide-react';
import PatientPicker from '../components/Patients/PatientPicker';
import type { WardRequest, Item, RequestRecommendationItem } from '@shared/types';
import { CONSUMABLE_CATEGORIES, CATEGORY_HIERARCHY, MID_CATEGORIES, getMidCategory, getCategoryLabel } from '@shared/types';

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
  { value: 'CONSUMABLE_OFFICE',  label: '사무용품 신청',   scheduled: true },
  { value: 'DIAPER',             label: '기저귀 신청',     scheduled: true },
  { value: 'NIGHT_SNACK',        label: '야간간식 신청',     scheduled: true },
  { value: 'ADHOC',              label: '비정기 신청',     scheduled: false },
] as const;

type ReqType = typeof REQUEST_TYPES[number]['value'];

const REQ_TYPE_LABEL: Record<string, string> = Object.fromEntries(REQUEST_TYPES.map(t => [t.value, t.label]));

// 소모품 카테고리 계층 — CATEGORY_HIERARCHY (shared/types) 로부터 드릴다운용 형태로 변환
// { label (대분류), subs: [{ label (중분류), value (mid code) }] }
const CONSUMABLE_HIERARCHY = CATEGORY_HIERARCHY.map(major => ({
  label: major.major_label,
  major: major.major,
  subs: major.mids.map(m => ({ label: m.label, value: m.value })),
}));

export default function WardRequestPage() {
  const { user, hasPerm } = useAuth();
  const { showToast } = useToast();
  const canCreate  = hasPerm('REQUEST_USE');
  const canViewAll = hasPerm('PURCHASE_MANAGE');

  const [pageTab, setPageTab] = useState<'create' | 'list'>(canCreate ? 'create' : 'list');
  // 제출 후 신청기간 내 재편집 — null = 신규 신청, 값 있음 = 그 ward_request 수정 모드 (PUT)
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);

  // 신청현황 state
  const [requests, setRequests]     = useState<WardRequest[]>([]);
  const [loading, setLoading]       = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType, setFilterType] = useState('');
  const [modal, setModal]           = useState<'detail' | null>(null);
  const [detail, setDetail]         = useState<WardRequest | null>(null);

  // 소모품 신청 state
  const [requestType, setRequestType] = useState<ReqType>('CONSUMABLE_MEDICAL');
  const [scheduleInfo, setScheduleInfo] = useState<any | null | 'loading'>(null);
  const [allItems, setAllItems]     = useState<Item[]>([]);
  const [majorCat, setMajorCat]     = useState<string | null>(null);
  const [subCat,   setSubCat]       = useState<string | null>(null);
  const [qtys, setQtys]             = useState<Record<string, number>>({});
  // 정기 소모품 신청 시 품목별 "현재 재고" 입력 (string으로 들고 있어 빈 입력 구분)
  const [stocks, setStocks]         = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg]               = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // 신청 작성 컨텍스트 (시스템 재고 + 환자×품목 자동 매핑)
  type DraftPatient = {
    id: string;
    name: string;
    room_no: string;
    bed_no: number | null;
    diaper_state: string;
    treatments: { treatment_type_id: string; name: string }[];
  };
  type DraftPatientUsage = Record<string, Array<{ id: string; name: string; room_no: string; bed_no: number | null; source: 'TREATMENT' | 'DIAPER' }>>;
  const [draftInventory, setDraftInventory] = useState<Record<string, number>>({});
  const [patientUsage, setPatientUsage] = useState<DraftPatientUsage>({});
  const [draftPatients, setDraftPatients] = useState<DraftPatient[]>([]);
  const [treatableItemIds, setTreatableItemIds] = useState<Set<string>>(new Set());
  const [expandedPatientItem, setExpandedPatientItem] = useState<string | null>(null);
  const [patientPicker, setPatientPicker] = useState<Item | null>(null);

  // 자유 입력 품목 (일반소모품/의료소모품)
  type CustomItem = { key: string; custom_name: string; custom_spec: string; custom_link: string; requested_qty: number };
  const [customItems, setCustomItems] = useState<CustomItem[]>([]);
  const CUSTOM_ITEM_TYPES: ReqType[] = ['CONSUMABLE_REGULAR', 'CONSUMABLE_MEDICAL'];
  const allowCustom = CUSTOM_ITEM_TYPES.includes(requestType);

  // 이미지 hover
  const [hoverImg, setHoverImg]     = useState<{ url: string; x: number; y: number } | null>(null);
  const [enlargeImg, setEnlargeImg] = useState<string | null>(null);

  // 이력 상세 팝업
  const [histDetail, setHistDetail] = useState<{ item: Item; rec: RequestRecommendationItem } | null>(null);

  // 품목 검색
  const [itemSearch, setItemSearch] = useState('');

  // 보기 모드 — 카드(기본) / 테이블
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');

  // 품목 범위 — recommended(기본, 추천만) / all(전체)
  const [viewFilter, setViewFilter] = useState<'recommended' | 'all'>('all');

  // 수량 추천
  const [recommendations, setRecommendations] = useState<Record<string, RequestRecommendationItem>>({});
  const [currentPatientCount, setCurrentPatientCount] = useState<number>(0);
  const [recLoaded, setRecLoaded] = useState(false);

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

  // 수량 변경 헬퍼 — 수량 0→양수 전환 시 매핑 대상 + 환자 0명이면 환자 추가 popup 자동 오픈
  const setQtyWithAutoPopup = (item: Item, v: number) => {
    const old = qtys[item.id] ?? 0;
    setQtys(prev => ({ ...prev, [item.id]: v }));
    if (old === 0 && v > 0 && treatableItemIds.has(item.id)) {
      const count = (patientUsage[item.id] ?? []).length;
      if (count === 0) setPatientPicker(item);
    }
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

  // 신청 작성 컨텍스트 (시스템 재고 + 환자×품목 자동 매핑) — 화면 진입 시 1회 로드
  const loadDraftContext = useCallback(() => {
    if (!canCreate || !user?.department_id) return;
    api(`/ward-requests/draft-context?department_id=${encodeURIComponent(user.department_id)}`)
      .then((r: any) => {
        setDraftInventory(r?.inventory_by_item ?? {});
        setPatientUsage(r?.patient_usage ?? {});
        setDraftPatients(r?.patients ?? []);
        setTreatableItemIds(new Set(r?.treatable_item_ids ?? []));
      })
      .catch(() => {
        setDraftInventory({});
        setPatientUsage({});
        setDraftPatients([]);
        setTreatableItemIds(new Set());
      });
  }, [canCreate, user?.department_id]);
  useEffect(() => { loadDraftContext(); }, [loadDraftContext]);

  // 품목 로드 (관리자 권한 + 활성 품목) + 수량 추천
  useEffect(() => {
    if (!canCreate) return;
    const consumableCatValues = CONSUMABLE_CATEGORIES.map(c => c.value);
    Promise.all([
      api('/items?is_active=true'),
      api('/dept-permissions/my-items').catch(() => ({ item_ids: null })),
      api('/ward-requests/recommendations').catch(() => null),
    ]).then(([fetchedItems, permData, recData]) => {
      const item_ids: string[] | null = permData?.item_ids ?? null;
      const consumableItems = fetchedItems.filter((i: any) => consumableCatValues.includes(i.category ?? ''));
      // null = 무제한 허용, 배열 = 그 목록만 (빈 배열도 "0개 보임"의 정상 의미)
      setAllItems(item_ids === null
        ? consumableItems
        : consumableItems.filter((i: any) => item_ids.includes(i.id)));

      if (recData?.items) {
        const recMap: Record<string, RequestRecommendationItem> = {};
        const initialQtys: Record<string, number> = {};
        for (const r of recData.items as RequestRecommendationItem[]) {
          recMap[r.item_id] = r;
          if (r.recommended_qty > 0) initialQtys[r.item_id] = r.recommended_qty;
        }
        setRecommendations(recMap);
        setCurrentPatientCount(recData.current_patient_count ?? 0);
        setQtys(initialQtys);
        setRecLoaded(true);
      }
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

  // 유형에 따른 표시 품목 필터링 — 신규 분류 (대분류 prefix 기반)
  const MEDICAL_MIDS: string[] = CATEGORY_HIERARCHY.filter(m => m.major === 'MED' || m.major === 'INFECT').flatMap(m => m.mids.map(x => x.value));
  // 일반소모품: GENERAL major (PAT_*, FAC_*) — 사무용품 OFF_*, 기저귀 DIAPER_*, 식음료 FOOD_* 제외
  const GENERAL_MIDS: string[] = CATEGORY_HIERARCHY.filter(m => m.major === 'PAT' || m.major === 'FAC').flatMap(m => m.mids.map(x => x.value));
  const OFFICE_MIDS: string[] = CATEGORY_HIERARCHY.filter(m => m.major === 'OFF').flatMap(m => m.mids.map(x => x.value));
  const FOOD_MIDS: string[] = CATEGORY_HIERARCHY.find(m => m.major === 'FOOD')!.mids.map(x => x.value);
  // 병동 부서인지 — diaper_companion 품목(예: 물티슈) 노출 분기용
  const isWardDept = !!user?.department_name && /\d+병동/.test(user.department_name);

  const items: Item[] = (() => {
    let pool: Item[];
    if (requestType === 'DIAPER') {
      // 기저귀 본 카테고리 + 병동 사용자에 한해 diaper_companion_for_wards 품목 (예: 물티슈)
      pool = allItems.filter(i =>
        i.category === 'DIAPER_MAIN' ||
        (isWardDept && (i as any).diaper_companion_for_wards),
      );
    }
    else if (requestType === 'NIGHT_SNACK') pool = allItems.filter(i => FOOD_MIDS.includes(i.category ?? ''));
    else if (requestType === 'CONSUMABLE_MEDICAL') pool = allItems.filter(i => MEDICAL_MIDS.includes(i.category ?? ''));
    else if (requestType === 'CONSUMABLE_REGULAR') {
      // 일반소모품 — 단, 병동 사용자에겐 diaper_companion 품목 숨김 (기저귀 화면에서만 보이게)
      pool = allItems.filter(i =>
        GENERAL_MIDS.includes(i.category ?? '') &&
        !(isWardDept && (i as any).diaper_companion_for_wards),
      );
    }
    else if (requestType === 'CONSUMABLE_OFFICE') pool = allItems.filter(i => OFFICE_MIDS.includes(i.category ?? ''));
    else pool = allItems; // ADHOC
    // 이름 가나다순 정렬 — 비슷한 품목 자연스럽게 함께 표시
    return [...pool].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  })();

  // DIAPER/NIGHT_SNACK은 단순 목록 (카테고리 드릴다운 불필요)
  const useCategoryDrilldown = requestType === 'CONSUMABLE_MEDICAL' || requestType === 'CONSUMABLE_REGULAR' || requestType === 'CONSUMABLE_OFFICE' || requestType === 'ADHOC';

  const clickMajor = (label: string) => { setMajorCat(prev => prev === label ? null : label); setSubCat(null); setItemPage(1); };
  const clickSub   = (value: string) => { setSubCat(prev => prev === value ? null : value); setItemPage(1); };

  // 신청 유형별 — 새 24 중분류 체계 기반 동적 계층 구성
  // 의료소모품 신청: MEDICAL major 의 8개 중분류
  // 일반소모품 신청: GENERAL + OFFICE major 의 12개 중분류 (8 + 4)
  // 각 중분류 안에는 실제 items 가 있는 소분류만 표시
  const buildHierarchy = (majors: string[]) => MID_CATEGORIES
    .filter(m => majors.includes(m.major))
    .map(m => {
      const subs = m.subs
        .map(subCode => ({ value: subCode, label: getCategoryLabel(subCode) }))
        .filter(s => items.some(i => i.category === s.value));
      return { label: m.label, major: m.value, subs };
    })
    .filter(g => g.subs.length > 0);

  const visibleHierarchy = requestType === 'CONSUMABLE_MEDICAL'
    ? buildHierarchy(['MEDICAL'])
    : requestType === 'CONSUMABLE_REGULAR'
    ? buildHierarchy(['GENERAL'])
    : requestType === 'CONSUMABLE_OFFICE'
    ? buildHierarchy(['OFFICE'])
    : CONSUMABLE_HIERARCHY;

  const currentSubs  = visibleHierarchy.find(g => g.label === majorCat)?.subs ?? [];
  const searchQuery = itemSearch.trim().toLowerCase();
  const hasSearch = searchQuery.length > 0;
  const matchesSearch = (item: Item) => !hasSearch
    || item.name.toLowerCase().includes(searchQuery)
    || (item.item_code ?? '').toLowerCase().includes(searchQuery);

  // 추천 품목 ID 집합 (recommended_qty > 0)
  const recommendedIds = new Set(
    Object.values(recommendations).filter(r => r.recommended_qty > 0).map(r => r.item_id)
  );
  const recCount = recommendedIds.size;

  // 중분류 (majorCat) 가 선택됐을 때 해당 중분류 소속 소분류만 필터
  const matchesMidCategory = (it: Item) => {
    if (!majorCat) return true;
    const mid = MID_CATEGORIES.find(m => m.label === majorCat);
    if (!mid) return true;
    return (mid.subs as readonly string[]).includes(it.category);
  };

  const countItemsInSub = (_groupLabel: string, subValue: string) => {
    return items.filter(i => i.category === subValue).length;
  };

  // "추천만 보기" 에서는 검색/드릴다운 무시하고 추천된 품목만 표시
  const visibleItems = viewFilter === 'recommended'
    ? items.filter(i => recommendedIds.has(i.id)).filter(matchesSearch)
    : hasSearch
      ? items.filter(matchesSearch)
      : useCategoryDrilldown
        ? (subCat
            ? items.filter(i => i.category === subCat)
            : items.filter(matchesMidCategory))
        : items;

  const pendingMasterCount = items.filter(i => (qtys[i.id] ?? 0) > 0).length;
  const pendingCustomCount = customItems.filter(c => c.custom_name.trim() && c.requested_qty > 0).length;
  const pendingCount = pendingMasterCount + pendingCustomCount;

  // 제출 가능 여부
  const typeConfig = REQUEST_TYPES.find(t => t.value === requestType)!;
  const canSubmit = !typeConfig.scheduled || (scheduleInfo !== null && scheduleInfo !== 'loading');

  // 총무부/창고는 신청 시 강제 등록에서 제외 (서버 로직과 동일)
  const isCentralWarehouse = !!user?.department_name && (user.department_name.includes('총무') || user.department_name.includes('창고'));
  // 재고 입력칸 노출 조건 — 부서가 자체 재고 보유 (중앙창고 제외). 모든 신청 유형에서 입력 가능.
  // 단, 강제 검증(requireStock) 은 일반소모품(CONSUMABLE_REGULAR) 만 적용.
  const isStockEditable = !isCentralWarehouse;

  // 제출된 신청을 신청기간 내 재편집 모드로 진입 — 기존 품목/수량을 폼에 prefill 한 뒤 PUT 으로 저장.
  // 신청기간(open window) 안인지는 서버가 PUT 호출 시 검증; 클라이언트는 시도만 함.
  const enterEditMode = (wr: any) => {
    const newQtys: Record<string, number> = {};
    const newStocks: Record<string, string> = {};
    const newCustom: CustomItem[] = [];
    for (const it of (wr.items ?? [])) {
      if (it.item_id) {
        newQtys[it.item_id] = Number(it.requested_qty ?? 0);
        if (it.current_stock_qty != null) newStocks[it.item_id] = String(it.current_stock_qty);
      } else {
        newCustom.push({
          key: `edit-${it.id ?? Date.now()}-${newCustom.length}`,
          custom_name: it.custom_name ?? '',
          custom_spec: it.custom_spec ?? '',
          custom_link: it.custom_link ?? '',
          requested_qty: Number(it.requested_qty ?? 0),
        });
      }
    }
    setRequestType(wr.request_type);
    setQtys(newQtys);
    setStocks(newStocks);
    setCustomItems(newCustom);
    setMajorCat(null);
    setSubCat(null);
    setEditingRequestId(wr.id);
    setModal(null);
    setPageTab('create');
  };

  const cancelEditMode = () => {
    setEditingRequestId(null);
    setQtys({}); setStocks({}); setCustomItems([]); setMajorCat(null); setSubCat(null);
  };

  const handleSubmit = async () => {
    const masterRows = items.filter(i => (qtys[i.id] ?? 0) > 0);
    // 재고 입력은 옵션 — 사용자가 채워넣으면 그 값이 함께 저장됨 (서버·클라 모두 강제 안 함)
    // 사용 환자 등록 검증 — 매핑 대상 + 수량 입력됨 + 환자 0명 라인은 사용자 확인 받기
    const missingPatientItems = masterRows.filter(i =>
      treatableItemIds.has(i.id) && (patientUsage[i.id] ?? []).length === 0,
    );
    if (missingPatientItems.length > 0) {
      const names = missingPatientItems.slice(0, 5).map(i => i.name).join(', ');
      const more = missingPatientItems.length > 5 ? ` 외 ${missingPatientItems.length - 5}건` : '';
      const ok = confirm(
        `다음 품목에 사용 환자가 등록되지 않았습니다:\n\n${names}${more}\n\n` +
        `이 품목들은 환자별 사용 추적이 필요한 품목이에요. 그래도 신청을 제출하시겠습니까?`,
      );
      if (!ok) return;
    }

    const masterToSubmit = masterRows.map(i => {
      // 입력한 재고가 있으면 신청 유형 무관하게 함께 저장 (강제 검증은 requireStock 만)
      const stockRaw = stocks[i.id];
      const hasStock = stockRaw !== undefined && stockRaw !== '' && Number.isFinite(Number(stockRaw));
      return {
        item_id: i.id,
        requested_qty: qtys[i.id],
        ...(hasStock ? { current_stock_qty: Number(stockRaw) } : {}),
        note: '',
      };
    });

    const customToSubmit = customItems
      .filter(c => c.custom_name.trim() && c.requested_qty > 0)
      .map(c => ({ custom_name: c.custom_name.trim(), custom_spec: c.custom_spec.trim(), custom_link: c.custom_link.trim(), requested_qty: c.requested_qty, note: '' }));

    const itemsToSubmit = [...masterToSubmit, ...customToSubmit];

    if (itemsToSubmit.length === 0) { showMsg('err', '1개 이상 품목에 수량을 입력해주세요.'); return; }
    if (!canSubmit) { showMsg('err', '현재 신청 기간이 아닙니다.'); return; }

    // 제출 전 확인 — 카테고리를 옮겨다니며 입력한 모든 품목을 한눈에 보여줌
    // (사용자가 다른 카테고리에서 입력한 게 빠지진 않았는지 시각적으로 확인)
    const lines: string[] = [];
    for (const r of masterRows) {
      const midLabel = MID_CATEGORIES.find(m => (m.subs as readonly string[]).includes(r.category ?? ''))?.label ?? '기타';
      lines.push(`  · [${midLabel}] ${r.name} — ${qtys[r.id]}${(r as any).issue_uom ?? r.uom ?? ''}`);
    }
    for (const c of customItems.filter(c => c.custom_name.trim() && c.requested_qty > 0)) {
      lines.push(`  · [직접입력] ${c.custom_name} — ${c.requested_qty}`);
    }
    const preview = lines.length > 20
      ? lines.slice(0, 20).join('\n') + `\n  ... 외 ${lines.length - 20}건`
      : lines.join('\n');
    const ok = confirm(`다음 ${itemsToSubmit.length}개 품목을 신청합니다.\n빠진 품목이 없는지 확인해 주세요.\n\n${preview}\n\n신청 제출하시겠습니까?`);
    if (!ok) return;

    setSubmitting(true);
    // 수정 모드: 기존 SUBMITTED 신청을 신청기간 내에 직접 PUT 으로 갱신 (status 유지)
    if (editingRequestId) {
      try {
        await api(`/ward-requests/${editingRequestId}`, {
          method: 'PUT',
          body: JSON.stringify({ items: itemsToSubmit }),
        });
        showMsg('ok', '신청이 수정되었습니다.');
        setEditingRequestId(null);
        setQtys({}); setStocks({}); setCustomItems([]); setMajorCat(null); setSubCat(null);
        setPageTab('list'); load();
      } catch (e: any) {
        showMsg('err', e?.message ?? '수정 실패');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    // 신청자에겐 임시저장 개념이 없음 — 제출 실패 시 생성된 DRAFT 가 "임시저장"처럼 남지 않도록 즉시 폐기.
    let createdId: string | null = null;
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
      createdId = created.id;
      await api(`/ward-requests/${created.id}/submit`, { method: 'POST' });
      showMsg('ok', '신청이 제출되었습니다.');
      setQtys({}); setStocks({}); setCustomItems([]); setMajorCat(null); setSubCat(null);
      setPageTab('list'); load();
    } catch (e: any) {
      // 생성은 됐는데 제출에서 실패한 경우 → 잔여 DRAFT 폐기 (best-effort)
      if (createdId) {
        try { await api(`/ward-requests/${createdId}/discard`, { method: 'POST' }); } catch { /* 폐기 실패는 무시 */ }
      }
      showMsg('err', `신청이 접수되지 않았습니다 — ${e.message ?? '알 수 없는 오류'}`);
    } finally {
      setSubmitting(false);
    }
  };

  // 신청서 제출 없이 부서 재고만 단독 등록.
  // CONSUMABLE_REGULAR 화면에서 stocks 입력값 중 빈 값 아닌 항목만 일괄 갱신.
  const handleRegisterStockOnly = async () => {
    const validRows = items
      .map(i => ({
        item_id: i.id,
        name: i.name,
        raw: stocks[i.id],
      }))
      .filter(r => r.raw !== undefined && r.raw !== '' && Number.isFinite(Number(r.raw)) && Number(r.raw) >= 0)
      .map(r => ({ item_id: r.item_id, current_stock_qty: Number(r.raw) }));
    if (validRows.length === 0) {
      showMsg('err', '재고 수량을 1개 이상 입력해 주세요.');
      return;
    }
    if (!confirm(`${validRows.length}개 품목의 재고 수량을 등록합니다. 진행할까요?`)) return;
    setSubmitting(true);
    try {
      await api('/ward-requests/register-stock', {
        method: 'POST',
        body: JSON.stringify({ items: validRows }),
      });
      showMsg('ok', `${validRows.length}개 품목 재고를 등록했습니다.`);
      setStocks({});
      // 화면 진입 컨텍스트 다시 로드 — 갱신된 재고 prefill 위해
      loadDraftContext();
    } catch (e: any) {
      showMsg('err', e.message ?? '재고 등록 중 오류가 발생했습니다.');
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
        <div className="space-y-3">
          {editingRequestId && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 flex items-center gap-2">
              ✏ <strong>제출된 신청 수정 중</strong> — 신청 마감 기한 안이면 「수정 저장」 으로 갱신됩니다. 마감 후엔 서버가 거부합니다.
              <button onClick={cancelEditMode} className="ml-auto text-xs text-amber-700 underline hover:text-amber-900">수정 취소</button>
            </div>
          )}
          {/* 신청 유형 + 스케줄 + 추천 안내 — 한 줄 콤팩트 */}
          <div className="card p-3 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold text-slate-500 mr-1">유형</span>
            <div className="inline-flex border border-gray-200 rounded-lg overflow-hidden flex-wrap">
              {REQUEST_TYPES.map((t, idx) => {
                const isSelected = requestType === t.value;
                return (
                  <button
                    key={t.value}
                    onClick={() => {
                      if (t.value === requestType) return;
                      const hasPending = Object.values(qtys).some(v => v > 0) || customItems.some(c => c.custom_name.trim() && c.requested_qty > 0);
                      if (hasPending && !confirm('입력한 수량이 있습니다. 유형을 바꾸면 모두 초기화됩니다. 계속하시겠습니까?')) return;
                      setRequestType(t.value); setQtys({}); setStocks({}); setCustomItems([]); setMajorCat(null); setSubCat(null); setItemPage(1); setItemSearch('');
                    }}
                    className={`px-3 py-1.5 text-xs font-medium transition-colors ${idx > 0 ? 'border-l border-gray-200' : ''} ${
                      isSelected
                        ? 'bg-teal-50 text-teal-700'
                        : 'bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {t.label.replace(' 신청', '')}
                  </button>
                );
              })}
            </div>

            {/* 스케줄 정보 한 줄 */}
            {typeConfig.scheduled && (
              scheduleInfo === 'loading' ? (
                <span className="text-xs text-gray-400">스케줄 조회 중...</span>
              ) : scheduleInfo ? (
                <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded">
                  <ChevronRight className="w-3 h-3" />
                  {scheduleInfo.period_label && <b className="mr-0.5">{scheduleInfo.period_label}</b>}
                  {fmtDate(scheduleInfo.open_from)}~{fmtDate(scheduleInfo.open_to)}
                </span>
              ) : (
                <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded">현재 신청 기간 아님</span>
              )
            )}

            {/* 추천 안내 한 줄 */}
            {recLoaded && (() => {
              const prefilledCount = Object.values(recommendations).filter(r => r.recommended_qty > 0).length;
              return prefilledCount > 0 ? (
                <span className="inline-flex items-center gap-1 text-xs text-teal-700 bg-teal-50 border border-teal-200 px-2 py-1 rounded ml-auto">
                  ✨ 입원 {currentPatientCount}명 · 추천 {prefilledCount}개 자동입력
                </span>
              ) : null;
            })()}
          </div>

          {/* 품목 범위 토글 — 추천 / 전체 (40~60대 사용자 고려, 크게) */}
          <div className="card p-3 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
            <div className="inline-flex border-2 border-gray-200 rounded-lg overflow-hidden shrink-0 self-start sm:self-auto">
              <button
                onClick={() => { setViewFilter('recommended'); setMajorCat(null); setSubCat(null); setItemSearch(''); }}
                className={`px-4 py-2.5 text-sm font-semibold inline-flex items-center gap-1.5 transition-colors ${viewFilter === 'recommended' ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                ✨ 추천 품목만 <span className={`text-xs px-1.5 py-0.5 rounded ${viewFilter === 'recommended' ? 'bg-white/25' : 'bg-teal-100 text-teal-700'}`}>{recCount}</span>
              </button>
              <button
                onClick={() => setViewFilter('all')}
                className={`px-4 py-2.5 text-sm font-semibold inline-flex items-center gap-1.5 transition-colors border-l-2 border-gray-200 ${viewFilter === 'all' ? 'bg-teal-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                <Plus className="w-4 h-4" />품목 더 추가
              </button>
            </div>
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={itemSearch}
                onChange={e => { setItemSearch(e.target.value); setItemPage(1); }}
                placeholder={viewFilter === 'recommended' ? '추천 품목 중 검색' : '품목명 또는 품목코드 검색'}
                className="input w-full pl-9 pr-24 text-sm"
              />
              {itemSearch && (
                <button
                  onClick={() => setItemSearch('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600 inline-flex items-center gap-0.5"
                >
                  <XCircle className="w-3.5 h-3.5" />지우기
                </button>
              )}
            </div>
            <div className="inline-flex border border-gray-200 rounded-lg overflow-hidden shrink-0 self-start sm:self-auto">
              <button
                onClick={() => setViewMode('card')}
                className={`px-3 py-2 text-xs inline-flex items-center gap-1 transition-colors ${viewMode === 'card' ? 'bg-teal-50 text-teal-700 font-semibold' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />카드
              </button>
              <button
                onClick={() => setViewMode('table')}
                className={`px-3 py-2 text-xs inline-flex items-center gap-1 transition-colors border-l border-gray-200 ${viewMode === 'table' ? 'bg-teal-50 text-teal-700 font-semibold' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              >
                <Table2 className="w-3.5 h-3.5" />테이블
              </button>
            </div>
            {hasSearch && (
              <p className="text-xs text-gray-500 mt-2">
                검색 결과 <span className="font-semibold text-teal-600">{visibleItems.length}건</span>
                {useCategoryDrilldown && <span className="ml-1 text-gray-400">— 카테고리 드릴다운 무시하고 전체에서 검색</span>}
              </p>
            )}
          </div>

          {/* 추천만 보기 — 드릴다운 유형 포함 모든 유형 */}
          {viewMode === 'card' && viewFilter === 'recommended' && (
            <div className="card p-3">
              {visibleItems.length === 0 ? (
                <div className="py-12 text-center">
                  <p className="text-sm text-slate-500 mb-3">
                    {hasSearch ? '검색 결과가 없습니다.' : '추천 품목이 없습니다.'}
                  </p>
                  <button
                    onClick={() => setViewFilter('all')}
                    className="btn-primary inline-flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    필요한 품목 직접 선택하기
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                  {visibleItems.map(item => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      qty={qtys[item.id] ?? 0}
                      rec={recommendations[item.id]}
                      onChangeQty={v => setQtyWithAutoPopup(item, v)}
                      onShowImage={url => setEnlargeImg(url)}
                      onShowHistory={recommendations[item.id] ? () => setHistDetail({ item, rec: recommendations[item.id] }) : undefined}
                      sysStock={draftInventory[item.id] ?? 0 /* fallback 0 — item.on_hand_qty 는 모든 location 합계라 사용 X (총무구매 재고 섞임) */}
                      patientCount={(patientUsage[item.id] ?? []).length}
                      isTreatable={treatableItemIds.has(item.id)}
                      onOpenPatients={() => setPatientPicker(item)}
                      stockEditable={isStockEditable}
                      stockValue={stocks[item.id] ?? ''}
                      onChangeStock={v => setStocks(prev => ({ ...prev, [item.id]: v }))}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* DIAPER / NIGHT_SNACK: 단순 목록 — 카드 뷰 (전체 보기만) */}
          {!useCategoryDrilldown && viewMode === 'card' && viewFilter === 'all' && (
            <div className="card p-3">
              {visibleItems.length === 0 ? (
                <EmptyState message={hasSearch ? '검색 결과가 없습니다.' : (requestType === 'DIAPER' ? '기저귀 품목이 없습니다.' : '식음료 품목이 없습니다.')} />
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                  {visibleItems.map(item => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      qty={qtys[item.id] ?? 0}
                      rec={recommendations[item.id]}
                      onChangeQty={v => setQtyWithAutoPopup(item, v)}
                      onShowImage={url => setEnlargeImg(url)}
                      onShowHistory={recommendations[item.id] ? () => setHistDetail({ item, rec: recommendations[item.id] }) : undefined}
                      sysStock={draftInventory[item.id] ?? 0 /* fallback 0 — item.on_hand_qty 는 모든 location 합계라 사용 X (총무구매 재고 섞임) */}
                      patientCount={(patientUsage[item.id] ?? []).length}
                      isTreatable={treatableItemIds.has(item.id)}
                      onOpenPatients={() => setPatientPicker(item)}
                      stockEditable={isStockEditable}
                      stockValue={stocks[item.id] ?? ''}
                      onChangeStock={v => setStocks(prev => ({ ...prev, [item.id]: v }))}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
          {!useCategoryDrilldown && viewMode === 'table' && (
            <div className="card p-0 overflow-hidden">
              {visibleItems.length === 0 ? (
                <EmptyState message={hasSearch ? '검색 결과가 없습니다.' : (requestType === 'DIAPER' ? '기저귀 품목이 없습니다.' : '식음료 품목이 없습니다.')} />
              ) : (
                <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
                  <table className="tbl">
                    <thead className="sticky top-0 bg-white z-10">
                      <tr>
                        <th>품목코드</th><th>품목명</th><th>단위</th>
                        <th className="text-right">{isStockEditable ? '현재 재고 (입력)' : '현재재고'}</th>
                        <th className="text-center">신청수량</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleItems.map(item => {
                        const qty = qtys[item.id] ?? 0;
                        const rec = recommendations[item.id];
                        const sysStock = draftInventory[item.id] ?? Number(item.on_hand_qty ?? 0);
                        const stockVal = stocks[item.id] ?? '';
                        return (
                          <tr key={item.id} className={qty > 0 ? 'bg-teal-50/60' : ''}>
                            <td className="font-mono text-xs text-gray-400">{item.item_code}</td>
                            <td>
                              <div className="font-medium text-sm">{item.name}</div>
                              {rec && <RecBadge rec={rec} />}
                            </td>
                            <td className="text-xs text-gray-500">{item.uom}</td>
                            <td className="text-right text-sm">
                              {isStockEditable ? (
                                <input
                                  type="number"
                                  min={0}
                                  step="any"
                                  className="input w-20 h-7 text-center text-xs"
                                  placeholder={String(sysStock)}
                                  value={stockVal}
                                  onChange={e => setStocks(prev => ({ ...prev, [item.id]: e.target.value }))}
                                />
                              ) : (
                                <span className={sysStock === 0 ? 'text-red-400' : 'text-gray-600'}>{sysStock}</span>
                              )}
                            </td>
                            <td>
                              <QtyInput
                                value={qty}
                                onChange={v => setQtyWithAutoPopup(item, v)}
                                onEnter={focusNextRowInput}
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

          {/* 카드 뷰 — 사이드바 + 카드 그리드 (드릴다운 유형 + 전체 보기 모드) */}
          {useCategoryDrilldown && viewMode === 'card' && viewFilter === 'all' && (
            <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-3 items-start">
              {/* 좌측 사이드바: 대분류/중분류 트리 — sticky */}
              <aside className="card p-3 space-y-2 md:sticky md:top-4 md:max-h-[calc(100vh-100px)] md:overflow-y-auto">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">카테고리</p>
                {visibleHierarchy.map(g => {
                  const totalCount = g.subs.reduce((acc, s) => acc + countItemsInSub(g.label, s.value), 0);
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
                      {g.subs.length > 0 && requestType !== 'CONSUMABLE_MEDICAL' && (
                        <div className="mt-1 ml-2 space-y-0.5">
                          {g.subs.map(s => {
                            const cnt = countItemsInSub(g.label, s.value);
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
                  <button
                    onClick={() => { setMajorCat(null); setSubCat(null); }}
                    className="w-full text-left px-2 py-1 rounded text-xs text-slate-400 hover:text-slate-600 mt-2 border-t border-gray-100 pt-2"
                  >
                    ↺ 전체 보기
                  </button>
                )}
              </aside>

              {/* 우측 카드 그리드 — 전체 표시, 페이지 스크롤 */}
              <div className="card p-3 min-h-[200px]">
                {visibleItems.length === 0 ? (
                  <EmptyState message={hasSearch ? '검색 결과가 없습니다' : '해당 분류의 품목이 없습니다'} />
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                    {visibleItems.map(item => (
                      <ItemCard
                        key={item.id}
                        item={item}
                        qty={qtys[item.id] ?? 0}
                        rec={recommendations[item.id]}
                        onChangeQty={v => setQtyWithAutoPopup(item, v)}
                        onShowImage={url => setEnlargeImg(url)}
                        onShowHistory={recommendations[item.id] ? () => setHistDetail({ item, rec: recommendations[item.id] }) : undefined}
                        sysStock={draftInventory[item.id] ?? 0 /* fallback 0 — item.on_hand_qty 는 모든 location 합계라 사용 X (총무구매 재고 섞임) */}
                        patientCount={(patientUsage[item.id] ?? []).length}
                        isTreatable={treatableItemIds.has(item.id)}
                        onOpenPatients={() => setPatientPicker(item)}
                        stockEditable={isStockEditable}
                        stockValue={stocks[item.id] ?? ''}
                        onChangeStock={v => setStocks(prev => ({ ...prev, [item.id]: v }))}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* CONSUMABLE_REGULAR / ADHOC: 테이블 뷰 — 기존 드릴다운 + 테이블 */}
          {useCategoryDrilldown && viewMode === 'table' && (
            <>
              {!hasSearch && (
                <div className="card p-5 space-y-3">
                  <div>
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">대분류</p>
                    <div className="flex gap-2 flex-wrap">
                      {visibleHierarchy.map(g => {
                        const totalCount = g.subs.reduce((acc, s) => acc + countItemsInSub(g.label, s.value), 0);
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
                  {majorCat && currentSubs.length > 0 && requestType !== 'CONSUMABLE_MEDICAL' && (
                    <div>
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">중분류</p>
                      <div className="flex gap-2 flex-wrap">
                        {currentSubs.map(s => {
                          const cnt = countItemsInSub(majorCat, s.value);
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
              )}

              <div className="card p-0 overflow-hidden">
                {!hasSearch && !majorCat ? (
                  <EmptyState message="위에서 대분류를 선택하거나 상단 검색창을 이용하세요" />
                ) : !hasSearch && !subCat && requestType !== 'CONSUMABLE_MEDICAL' ? (
                  <EmptyState message="중분류를 선택하면 품목이 표시됩니다" />
                ) : visibleItems.length === 0 ? (
                  <EmptyState message={hasSearch ? '검색 결과가 없습니다' : '해당 분류의 품목이 없습니다'} />
                ) : (
                  <>
                  <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
                    <table className="tbl">
                      <thead className="sticky top-0 bg-white z-10">
                        <tr>
                          <th>품목코드</th><th>품목명</th><th>단위</th>
                          <th className="text-center">{requestType === 'CONSUMABLE_REGULAR' && !isCentralWarehouse ? '현재 재고 (입력)' : '현재재고'}</th>
                          <th className="text-center">신청수량</th>
                          <th className="text-center">사용 환자</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleItems.slice((itemPage - 1) * itemPageSize, itemPage * itemPageSize).map(item => {
                          const qty    = qtys[item.id] ?? 0;
                          const hasQty = qty > 0;
                          const rec    = recommendations[item.id];
                          const isStockEditable = requestType === 'CONSUMABLE_REGULAR' && !isCentralWarehouse;
                          const stockVal = stocks[item.id] ?? '';
                          const stockMissing = isStockEditable && hasQty && stockVal === '';
                          return (
                            <tr key={item.id} className={hasQty ? 'bg-teal-50/60' : ''}>
                              <td className="font-mono text-xs text-gray-400">{item.item_code}</td>
                              <td>
                                <div
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
                                </div>
                                {(() => {
                                  const ps = Number((item as any).pack_size ?? 1);
                                  const pu = (item as any).purchase_uom ?? item.uom ?? '';
                                  const iu = (item as any).issue_uom ?? item.uom ?? '';
                                  if (ps > 1 && pu && iu && pu !== iu) {
                                    return (
                                      <div className="text-[10px] text-blue-600 mt-0.5">📦 1{pu} = {ps}{iu}</div>
                                    );
                                  }
                                  return null;
                                })()}
                                {rec && <RecBadge rec={rec} />}
                              </td>
                              <td className="text-xs text-gray-500">
                                <div>{(item as any).issue_uom ?? item.uom}</div>
                                {(() => {
                                  const ps = Number((item as any).pack_size ?? 1);
                                  const pu = (item as any).purchase_uom ?? '';
                                  const iu = (item as any).issue_uom ?? item.uom ?? '';
                                  if (ps > 1 && pu && pu !== iu) {
                                    return <div className="text-[10px] text-blue-500 whitespace-nowrap">1{pu}={ps}{iu}</div>;
                                  }
                                  return null;
                                })()}
                              </td>
                              <td className="text-center text-sm">
                                {(() => {
                                  const sysStock = draftInventory[item.id] ?? Number(item.on_hand_qty ?? 0);
                                  if (isStockEditable) {
                                    return (
                                      <input
                                        type="number"
                                        min={0}
                                        step="any"
                                        className={`input w-20 h-7 text-center text-xs ${stockMissing ? 'border-red-400 ring-1 ring-red-300' : ''}`}
                                        placeholder={String(sysStock)}
                                        value={stockVal}
                                        onChange={e => setStocks(prev => ({ ...prev, [item.id]: e.target.value }))}
                                      />
                                    );
                                  }
                                  return (
                                    <span className={sysStock === 0 ? 'text-red-400' : 'text-gray-600'}>{sysStock}</span>
                                  );
                                })()}
                              </td>
                              <td>
                                <div className="inline-flex items-center gap-1">
                                  <QtyInput
                                    value={qty}
                                    onChange={v => setQtyWithAutoPopup(item, v)}
                                    onEnter={focusNextRowInput}
                                  />
                                  <span className="text-[11px] text-slate-500 font-medium whitespace-nowrap">
                                    {(item as any).issue_uom ?? item.uom}
                                  </span>
                                </div>
                              </td>
                              <td className="text-center text-xs">
                                {treatableItemIds.has(item.id) ? (() => {
                                  const patients = patientUsage[item.id] ?? [];
                                  const expanded = expandedPatientItem === item.id;
                                  return (
                                    <div className="flex flex-col items-center gap-1">
                                      <button
                                        type="button"
                                        onClick={() => setExpandedPatientItem(expanded ? null : item.id)}
                                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${patients.length > 0 ? 'bg-blue-100 text-blue-700 hover:bg-blue-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                                      >
                                        <Users className="w-3 h-3" /> {patients.length}명
                                      </button>
                                      {expanded && (
                                        <div className="text-left bg-white border border-slate-200 rounded-lg p-2 shadow-sm w-48 max-h-44 overflow-y-auto">
                                          {patients.length === 0 ? (
                                            <p className="text-xs text-gray-400 text-center py-1">사용 환자 없음</p>
                                          ) : (
                                            <ul className="space-y-0.5">
                                              {patients.map(p => (
                                                <li key={p.id} className="text-xs flex items-center gap-1.5">
                                                  <span className="font-mono text-gray-400 w-10 flex-shrink-0">{p.room_no}{p.bed_no != null ? `-${p.bed_no}` : ''}</span>
                                                  <span className="text-slate-700 flex-1 truncate">{p.name}</span>
                                                  {p.source === 'DIAPER' && <span className="text-[9px] px-1 rounded bg-purple-100 text-purple-700">기저귀</span>}
                                                </li>
                                              ))}
                                            </ul>
                                          )}
                                          <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); setPatientPicker(item); }}
                                            className="mt-2 w-full text-center text-xs py-1 rounded border border-blue-200 text-blue-600 hover:bg-blue-50"
                                          >
                                            <Plus className="w-3 h-3 inline mr-0.5" /> 환자 추가
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })() : (
                                  <span className="text-gray-300 text-[10px]">-</span>
                                )}
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

          {/* 하단 요약 + 제출 — 카드 모드에서는 sticky */}
          <div className={`${viewMode === 'card' ? 'sticky bottom-0 z-20 shadow-[0_-4px_12px_-4px_rgba(0,0,0,0.08)]' : ''} flex flex-wrap items-center justify-between gap-3 p-4 bg-white rounded-xl border border-gray-200`}>
            <span className="text-sm text-gray-500 inline-flex items-center gap-2">
              {viewMode === 'card' && <ShoppingCart className="w-4 h-4 text-teal-500" />}
              신청 예정:&nbsp;
              <span className="font-semibold text-teal-600">{pendingCount}건</span>
              {pendingCustomCount > 0 && <span className="ml-1 text-amber-600">(직접입력 {pendingCustomCount}건)</span>}
              {pendingCount > 0 && (
                <button onClick={() => { setQtys({}); setCustomItems([]); }} className="ml-3 text-xs text-gray-400 hover:text-red-500 underline inline-flex items-center gap-0.5">
                  <RotateCcw className="w-3 h-3" />전체 초기화
                </button>
              )}
            </span>
            <div className="inline-flex items-center gap-2">
              {requestType === 'CONSUMABLE_REGULAR' && !isCentralWarehouse && (
                <button
                  onClick={handleRegisterStockOnly}
                  disabled={submitting || Object.values(stocks).every(v => v === undefined || v === '')}
                  className="btn-secondary inline-flex items-center gap-1.5"
                  title="신청서 제출 없이 부서 재고수량만 갱신합니다"
                >
                  재고만 저장
                </button>
              )}
              {editingRequestId && (
                <button onClick={cancelEditMode} className="btn-secondary text-sm" title="수정 모드 취소 (원래 신청은 그대로 유지)">
                  수정 취소
                </button>
              )}
              <button
                onClick={handleSubmit}
                disabled={submitting || pendingCount === 0 || !canSubmit}
                className="btn-primary inline-flex items-center gap-1.5"
              >
                <Send className="w-4 h-4" />{submitting ? '처리 중...' : (editingRequestId ? '수정 저장' : '신청 제출')}
              </button>
            </div>
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
            {canCreate && detail?.status === 'SUBMITTED' && (
              <button
                onClick={() => enterEditMode(detail)}
                className="btn-primary mr-auto inline-flex items-center gap-1"
                title="신청 마감 기한 안이면 수정 가능합니다 (마감 후엔 서버가 거부)"
              >
                수정
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
        <div className="fixed z-50 pointer-events-none rounded-xl shadow-2xl border border-gray-200 overflow-hidden bg-white"
          style={{ left: hoverImg.x, top: hoverImg.y, width: 160, height: 160 }}>
          <img src={hoverImg.url} alt="" loading="lazy" className="w-full h-full object-contain" />
        </div>
      )}
      {enlargeImg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={() => setEnlargeImg(null)}>
          <img src={enlargeImg} alt="" loading="lazy"
            className="max-w-[80vw] max-h-[80vh] rounded-xl shadow-2xl object-contain"
            onClick={e => e.stopPropagation()} />
        </div>
      )}
      {histDetail && (
        <HistoryPopup
          item={histDetail.item}
          rec={histDetail.rec}
          onClose={() => setHistDetail(null)}
        />
      )}
      {patientPicker && (
        <PatientPicker
          item={patientPicker}
          allPatients={draftPatients}
          mappedPatientIds={new Set((patientUsage[patientPicker.id] ?? []).map(p => p.id))}
          onClose={() => setPatientPicker(null)}
          onAdded={() => { loadDraftContext(); }}
          showMsg={showMsg}
        />
      )}
    </div>
  );
}


function HistoryPopup({ item, rec, onClose }: { item: Item; rec: RequestRecommendationItem; onClose: () => void }) {
  const monthly = rec.history_monthly ?? [];
  const maxVal = Math.max(1, ...monthly.map(m => m.total));
  const fmtMonth = (m: string) => {
    const [y, mo] = m.split('-');
    return `${y.slice(2)}.${mo}`;
  };
  const confLabel = rec.confidence === 'HIGH' ? { label: '신뢰도 높음', cls: 'bg-green-100 text-green-700' }
    : rec.confidence === 'MEDIUM' ? { label: '신뢰도 보통', cls: 'bg-blue-100 text-blue-700' }
    : { label: '추정 낮음 (이력 부족)', cls: 'bg-amber-100 text-amber-700' };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-[11px] text-slate-400 font-mono">{item.item_code}</p>
            <h3 className="text-base font-bold text-slate-800">{item.name}</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
            <XCircle className="w-5 h-5" />
          </button>
        </div>
        <div className={`inline-block text-xs px-2 py-1 rounded mb-4 ${confLabel.cls}`}>{confLabel.label}</div>

        {/* 월별 막대 그래프 */}
        <div className="mb-4">
          <p className="text-xs font-semibold text-slate-600 mb-2 inline-flex items-center gap-1">
            <BarChart2 className="w-3.5 h-3.5" />
            지난 3개월 소비량
          </p>
          {monthly.length === 0 ? (
            <p className="text-xs text-slate-400 py-4 text-center bg-slate-50 rounded-lg">이력이 없습니다.</p>
          ) : (
            <div className="flex items-end gap-2 h-32 bg-slate-50 rounded-lg p-3">
              {monthly.map(m => (
                <div key={m.month} className="flex-1 flex flex-col items-center gap-1">
                  <div className="text-[10px] text-slate-600 font-semibold">{m.total}</div>
                  <div
                    className="w-full bg-teal-500 rounded-t transition-all"
                    style={{ height: `${(m.total / maxVal) * 80}%`, minHeight: m.total > 0 ? '4px' : '0' }}
                  />
                  <div className="text-[10px] text-slate-400">{fmtMonth(m.month)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 수치 요약 */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-slate-50 rounded p-2">
            <p className="text-slate-400 text-[10px]">현재 재고</p>
            <p className="font-bold text-slate-700">{rec.on_hand_qty}</p>
          </div>
          <div className="bg-slate-50 rounded p-2">
            <p className="text-slate-400 text-[10px]">기준량 (환자수 × {rec.baseline_per_patient || '-'})</p>
            <p className="font-bold text-slate-700">{rec.baseline_qty}</p>
          </div>
          <div className="bg-slate-50 rounded p-2">
            <p className="text-slate-400 text-[10px]">3개월 평균</p>
            <p className="font-bold text-slate-700">{rec.history_avg_monthly}</p>
          </div>
          <div className="bg-teal-50 rounded p-2">
            <p className="text-teal-500 text-[10px]">최종 추천</p>
            <p className="font-bold text-teal-700">{rec.recommended_qty}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ItemCard({ item, qty, rec, onChangeQty, onShowImage, onShowHistory, sysStock, patientCount, isTreatable, onOpenPatients, stockEditable, stockValue, onChangeStock }: {
  item: Item;
  qty: number;
  rec: RequestRecommendationItem | undefined;
  onChangeQty: (v: number) => void;
  onShowImage: (url: string) => void;
  onShowHistory?: () => void;
  sysStock?: number;
  patientCount?: number;
  isTreatable?: boolean;
  onOpenPatients?: () => void;
  stockEditable?: boolean;
  stockValue?: string;
  onChangeStock?: (v: string) => void;
}) {
  const has = qty > 0;
  const stock = sysStock ?? item.on_hand_qty ?? 0;
  // 사용 환자 등록 필수: 매핑 대상 + 수량 입력됨 + 환자 0명
  const requiresPatient = !!isTreatable && has && (patientCount ?? 0) === 0;
  // 재고 부족 판정: 추천이 있고 재고가 추천의 절반 미만 (또는 재고 0인데 추천됨)
  const stockWarning = rec && rec.recommended_qty > 0 && (stock === 0 || stock < (rec.baseline_qty > 0 ? rec.baseline_qty : rec.recommended_qty) * 0.5);
  return (
    <div className={`border rounded-xl p-2.5 flex flex-col gap-2 transition-colors relative ${
      requiresPatient ? 'border-red-400 bg-red-50/40 ring-2 ring-red-200' :
      has ? 'border-teal-400 bg-teal-50/40' :
      'border-gray-200 bg-white hover:border-gray-300'
    }`}>
      {/* 재고 부족 경고 배지 — 카드 우상단 */}
      {stockWarning && (
        <span className="absolute -top-1.5 -right-1.5 z-10 px-2 py-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full shadow-sm">
          ⚠ 재고 부족
        </span>
      )}
      {/* 이미지 — 실제 이미지가 있으면 표시, 없으면 플레이스홀더 (정사각형 고정) */}
      <div
        className="aspect-square w-full bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-center overflow-hidden cursor-pointer"
        onClick={item.image_url ? () => onShowImage(item.image_url!) : undefined}
      >
        {item.image_url ? (
          <img src={item.image_url} alt={item.name} loading="lazy" className="w-full h-full object-contain" />
        ) : (
          <div className="flex flex-col items-center text-slate-300">
            <ImageIcon className="w-8 h-8" />
            <span className="text-[9px] mt-1">이미지 준비 중</span>
          </div>
        )}
      </div>
      {/* 이름 + 코드 + 이력 버튼 */}
      <div className="min-h-[2.5rem]">
        <div className="flex items-start justify-between gap-1">
          <p className="text-[11px] text-slate-400 font-mono flex-1 truncate">{item.item_code}</p>
          {rec && rec.source !== 'NONE' && onShowHistory && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onShowHistory(); }}
              className="text-slate-300 hover:text-teal-500 shrink-0"
              title="이력 상세 보기"
            >
              <Info className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <p className="text-xs font-medium text-slate-800 line-clamp-2 leading-tight">{item.name}</p>
        {(() => {
          const ps = Number((item as any).pack_size ?? 1);
          const pu = (item as any).purchase_uom ?? item.uom ?? '';
          const iu = (item as any).issue_uom ?? item.uom ?? '';
          if (ps > 1 && pu && iu && pu !== iu) {
            return <p className="text-[10px] text-blue-600 mt-0.5">📦 1{pu} = {ps}{iu}</p>;
          }
          return null;
        })()}
      </div>
      {/* 재고 + 추천 배지 */}
      <div className="text-[10px] text-slate-500 flex items-center justify-between gap-1">
        {stockEditable ? (
          <span className="flex items-center gap-1">
            재고
            <input
              type="number"
              min={0}
              step="any"
              className="input w-14 h-6 px-1 text-center text-[11px]"
              placeholder={String(stock)}
              value={stockValue ?? ''}
              onChange={e => onChangeStock?.(e.target.value)}
              onClick={e => e.stopPropagation()}
            />
            {((item as any).issue_uom ?? item.uom) && <span className="text-slate-300">{(item as any).issue_uom ?? item.uom}</span>}
          </span>
        ) : (
          <span>
            재고 <b className={stockWarning ? 'text-red-600' : stock === 0 ? 'text-red-400' : 'text-slate-700'}>{stock}</b>
            {((item as any).issue_uom ?? item.uom) && <span className="text-slate-300 ml-1">{(item as any).issue_uom ?? item.uom}</span>}
          </span>
        )}
        {rec && rec.recommended_qty > 0 && (
          <span className="text-[10px] text-teal-600 font-medium shrink-0">추천 {rec.recommended_qty}</span>
        )}
      </div>
      {isTreatable && onOpenPatients && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenPatients(); }}
          className={`inline-flex items-center justify-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
            requiresPatient ? 'bg-red-500 text-white hover:bg-red-600 animate-pulse' :
            (patientCount ?? 0) > 0 ? 'bg-blue-100 text-blue-700 hover:bg-blue-200' :
            'bg-gray-100 text-gray-500 hover:bg-gray-200'
          }`}
          title={requiresPatient ? '⚠ 사용 환자 등록 필수 — 클릭해서 추가하세요' : '이 품목을 사용하는 환자 명단 / 환자 추가'}
        >
          <Users className="w-3 h-3" /> {requiresPatient ? '🚨 환자 등록 필수' : `사용 환자 ${patientCount ?? 0}명`}
        </button>
      )}
      {rec && rec.source !== 'NONE' && (
        <>
          <RecBadge rec={rec} />
          {rec.confidence === 'LOW' && (
            <span className="inline-block text-[9px] text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">추정 낮음 (이력 부족)</span>
          )}
        </>
      )}
      {/* 수량 입력 */}
      <div className="mt-auto">
        <div className="flex items-center gap-1">
          <div className="flex-1"><QtyInput value={qty} onChange={onChangeQty} /></div>
          <span className="text-[11px] text-slate-500 font-medium whitespace-nowrap">
            {(item as any).issue_uom ?? item.uom}
          </span>
        </div>
      </div>
    </div>
  );
}

function RecBadge({ rec }: { rec: RequestRecommendationItem }) {
  if (rec.source === 'NONE') return null;
  const trendLabel = rec.history_trend_pct !== 0
    ? `${rec.history_trend_pct > 0 ? '↑' : '↓'}${Math.abs(rec.history_trend_pct).toFixed(0)}%`
    : '';
  if (rec.source === 'HYBRID') {
    return (
      <div className="text-[10px] text-slate-400 mt-0.5">
        <span className="text-teal-500">✨</span> 기준 {rec.baseline_qty}
        {trendLabel && <> · 지난달 <span className={rec.history_trend_pct > 0 ? 'text-amber-600' : 'text-blue-600'}>{trendLabel}</span></>}
        {rec.recommended_qty > 0 && <> · 추천 <b className="text-teal-600">{rec.recommended_qty}</b></>}
      </div>
    );
  }
  if (rec.source === 'BASELINE') {
    return (
      <div className="text-[10px] text-slate-400 mt-0.5">
        기준 {rec.baseline_qty}
        {rec.recommended_qty > 0 && <> · 추천 <b className="text-teal-600">{rec.recommended_qty}</b></>}
        <span className="ml-1 text-gray-300">(이력 부족)</span>
      </div>
    );
  }
  // HISTORY
  return (
    <div className="text-[10px] text-slate-400 mt-0.5">
      지난 3개월 평균 {rec.history_avg_monthly}
      {trendLabel && <> · <span className={rec.history_trend_pct > 0 ? 'text-amber-600' : 'text-blue-600'}>{trendLabel}</span></>}
      {rec.recommended_qty > 0 && <> · 추천 <b className="text-teal-600">{rec.recommended_qty}</b></>}
    </div>
  );
}

function QtyInput({ value, onChange, onEnter }: { value: number; onChange: (v: number) => void; onEnter?: (e: React.KeyboardEvent<HTMLInputElement>) => void }) {
  const has = value > 0;
  return (
    <div className="flex items-center justify-center gap-1">
      <button
        type="button"
        onClick={() => onChange(Math.max(0, value - 1))}
        disabled={value <= 0}
        className="w-8 h-8 rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center"
        aria-label="수량 감소"
      >
        <Minus className="w-3.5 h-3.5" />
      </button>
      <input
        type="number" min="0"
        value={value === 0 ? '' : value}
        placeholder="0"
        onKeyDown={onEnter}
        onChange={e => {
          const v = Number(e.target.value);
          onChange(v < 0 ? 0 : v);
        }}
        className="input w-16 text-center"
        style={has ? { borderColor: '#14b8a6', background: '#f0fdfa' } : {}}
      />
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        className="w-8 h-8 rounded-md border border-teal-300 text-teal-600 hover:bg-teal-50 flex items-center justify-center"
        aria-label="수량 증가"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
