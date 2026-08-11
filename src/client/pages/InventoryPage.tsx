import React, { useEffect, useState, useCallback, useMemo, memo } from 'react';
import { Boxes, Package, Wrench, AlertTriangle, CheckCircle, MapPin, Calendar, Hash, Tag, ClipboardCheck } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { PageHeader, FilterBar, DataTable, Modal, EmptyState, FilterChips, Pagination } from '../components/ui';
import type { Column, FilterChip } from '../components/ui';

// 재고 표(491행)는 실사 모달 입력마다 부모가 리렌더돼도 props(columns/data)가 참조 불변이면
// 다시 그리지 않도록 memo. 공유 DataTable 은 건드리지 않고 이 페이지에서만 메모화한다.
// (제네릭 시그니처 보존 위해 원본 타입으로 캐스팅 — memo 래퍼는 런타임 동작 동일)
const MemoDataTable = memo(DataTable) as typeof DataTable;
import type { InventoryItem, InventoryLocation, VendorSummaryResponse } from '@shared/types';
import { getMajor, MAJOR_GROUP_LABEL, MID_CATEGORIES, type MajorGroup } from '@shared/types';

// ─── 비품 탭 타입 ─────────────────────────────────────────────────
interface EquipmentUnit {
  id: string;
  serial_no: string;
  item_id: string;
  item_name: string;
  item_code: string;
  category: string;
  department_name: string;
  location: string;
  is_primary: boolean;
  status: 'ACTIVE' | 'IN_REPAIR' | 'DISPOSED';
  notes: string;
  created_at: string;
}

interface EquipmentRepair {
  id: string;
  description: string;
  status: string;
  result_note: string;
  created_at: string;
  requesting_dept?: { name: string };
}

interface EquipmentDetail extends EquipmentUnit {
  repairs: EquipmentRepair[];
}

const EQ_STATUS_LABEL: Record<string, string> = {
  ACTIVE: '정상', IN_REPAIR: '수리중', DISPOSED: '폐기',
};
const EQ_STATUS_CLS: Record<string, string> = {
  ACTIVE: 'inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800',
  IN_REPAIR: 'inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800',
  DISPOSED: 'inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500',
};
const REPAIR_STATUS_LABEL: Record<string, string> = {
  PENDING: '대기중', IN_PROGRESS: '진행중', COMPLETED: '완료', DISPOSED: '폐기처리',
};

const fmt = (n: number) => new Intl.NumberFormat('ko-KR').format(Math.round(n));

// ─── 소모품 탭 ───────────────────────────────────────────────────
function ConsumablesTab() {
  const { hasPerm } = useAuth();
  const { showToast } = useToast();
  const showFinancials = hasPerm('STATS_VIEW');
  const showWarehouseSection = hasPerm('PURCHASE_MANAGE');

  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [majorFilter, setMajorFilter] = useState<MajorGroup | ''>('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [vendorSummary, setVendorSummary] = useState<VendorSummaryResponse | null>(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 실사 등록 모달 상태
  const [stocktakeRow, setStocktakeRow] = useState<InventoryItem | null>(null);
  const [stocktakeReason, setStocktakeReason] = useState('');
  const [stocktakeSubmitting, setStocktakeSubmitting] = useState(false);
  // 단가별 입력 행 (lot_id 있으면 기존 조정, 없으면 신규)
  type LotAdjustRow = { lot_id: string | null; unit_cost: string; actual_qty: string; system_qty?: number; received_at?: string; vendor_id?: string; vendor_name?: string; sort_order?: number };
  const [stocktakeRows, setStocktakeRows] = useState<LotAdjustRow[]>([]);
  // 초기재고 등록(=보유재고, 구매 아님) 여부 + 거래처 목록
  const [stocktakeIsBase, setStocktakeIsBase] = useState(true);
  const [stkVendors, setStkVendors] = useState<any[]>([]);
  // 사용자가 ▲▼ 로 lot 순서를 바꿨는지 — 저장 시 명시 sort_order 박을지 결정
  const [reorderedTouched, setReorderedTouched] = useState(false);
  // 단가 변동 이력 (외부 거래원장 + 시스템 PO 통합)
  type HistoricalEntry = { first_date: string; last_date: string; unit_cost: number; total_qty: number; vendor_name: string; occurrences: number; source?: string };
  const [stocktakeHistorical, setStocktakeHistorical] = useState<HistoricalEntry[]>([]);

  const reloadInventory = useCallback(() => {
    const params = new URLSearchParams();
    if (locationFilter) params.set('location_id', locationFilter);
    if (lowStockOnly) params.set('low_stock', 'true');
    setLoading(true);
    return api(`/inventory?${params}`)
      .then(setInventory)
      .catch(() => showToast('재고 목록을 불러오지 못했습니다.', 'error'))
      .finally(() => setLoading(false));
  }, [locationFilter, lowStockOnly]);

  useEffect(() => { reloadInventory(); }, [reloadInventory]);
  useEffect(() => { api('/vendors').then(v => setStkVendors(Array.isArray(v) ? v : [])).catch(() => {}); }, []);

  const openStocktake = (row: InventoryItem) => {
    setStocktakeRow(row);
    setStocktakeReason('');
    setStocktakeRows([]);
    setStocktakeHistorical([]);
    setStocktakeIsBase(true);
    setReorderedTouched(false);
    // 단가별 입력 행 자동 채움 — 기존 lot 1개당 1행, lot 없으면 빈 신규 행 1개
    api(`/inventory/lots-detail?item_id=${encodeURIComponent(row.item_id)}&location_id=${encodeURIComponent(row.location_id)}`)
      .then((data: any) => {
        const lots = data?.lots ?? [];
        if (lots.length > 0) {
          setStocktakeRows(lots.map((l: any) => ({
            lot_id: l.id,
            unit_cost: String(l.unit_cost),
            actual_qty: String(l.remaining_qty),  // 기본값 = 현재 잔량
            system_qty: Number(l.remaining_qty),
            received_at: l.received_at ? String(l.received_at).slice(0, 10) : '',
            vendor_name: l.vendor_name ?? '',
            sort_order: Number(l.sort_order ?? 0),
          })));
        } else {
          // lot 없음 — 신규 등록용 빈 행 1개
          setStocktakeRows([{ lot_id: null, unit_cost: '', actual_qty: '', received_at: '', vendor_id: '' }]);
        }
        setStocktakeHistorical(Array.isArray(data?.historical) ? data.historical : []);
      })
      .catch(() => setStocktakeRows([{ lot_id: null, unit_cost: '', actual_qty: '', received_at: '', vendor_id: '' }]));
  };

  const addStocktakeRow = () => {
    setStocktakeRows(prev => [...prev, { lot_id: null, unit_cost: '', actual_qty: '', received_at: '', vendor_id: '' }]);
  };

  // 사용자가 ▲▼ 로 lot 순서를 바꾸면, 표시 순서가 곧 출고 우선순위가 됨.
  // reorderedTouched=true 가 되면 저장 시 모든 lot 에 명시 sort_order (1, 2, 3...) 박아 보냄.
  // 안 건드리면 sort_order=0 으로 저장돼 received_at 기반 자동 FIFO 유지.
  const moveStocktakeRow = (idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= stocktakeRows.length) return;
    setStocktakeRows(prev => {
      const next = [...prev];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return next;
    });
    setReorderedTouched(true);
  };
  const removeStocktakeRow = (idx: number) => {
    setStocktakeRows(prev => prev.filter((_, i) => i !== idx));
  };
  const updateStocktakeRow = (idx: number, patch: Partial<LotAdjustRow>) => {
    setStocktakeRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
  };

  const submitStocktake = async () => {
    if (!stocktakeRow) return;
    if (stocktakeRows.length === 0) { showToast('입력 행이 없습니다.', 'error'); return; }

    // 검증
    const lot_adjustments: any[] = [];
    for (let idx = 0; idx < stocktakeRows.length; idx++) {
      const r = stocktakeRows[idx];
      const qty = Number(r.actual_qty);
      const cost = Number(r.unit_cost);
      if (!Number.isFinite(qty) || qty < 0) { showToast('수량은 0 이상의 숫자여야 합니다.', 'error'); return; }
      // 사용자가 ▲▼ 로 순서 바꿨으면 표시 순서를 명시 sort_order 로 박음. 안 건드렸으면 0 (자동 FIFO).
      const sortOrderToSave = reorderedTouched ? (idx + 1) : 0;
      if (!r.lot_id) {
        if (!Number.isFinite(cost) || cost < 0) { showToast('신규 단가는 0 이상의 숫자여야 합니다.', 'error'); return; }
        if (qty === 0 && cost === 0) continue; // 빈 행 무시
        lot_adjustments.push({ lot_id: null, unit_cost: cost, actual_qty: qty, received_at: (r.received_at || '').trim() || null, vendor_id: (r.vendor_id || '').trim() || null, sort_order: sortOrderToSave });
      } else {
        lot_adjustments.push({ lot_id: r.lot_id, actual_qty: qty, unit_cost: cost, sort_order: sortOrderToSave });
      }
    }
    if (lot_adjustments.length === 0) { showToast('유효한 입력이 없습니다.', 'error'); return; }

    setStocktakeSubmitting(true);
    try {
      const result: any = await api('/inventory/adjust-by-lot', {
        method: 'POST',
        body: JSON.stringify({
          item_id: stocktakeRow.item_id,
          location_id: stocktakeRow.location_id,
          reason: stocktakeReason.trim() || '실사 등록',
          is_base: stocktakeIsBase,
          lot_adjustments,
        }),
      });
      showToast('실사 결과를 반영했습니다.', 'success');
      // 자동 새로고침 X — 해당 행만 부분 갱신 (화면 깜빡임/스크롤 잃음 방지)
      setInventory(prev => prev.map(row => {
        if (row.item_id === stocktakeRow.item_id && row.location_id === stocktakeRow.location_id) {
          const newQty = Number(result?.on_hand_qty ?? row.on_hand_qty);
          const newAvg = Number(result?.avg_unit_cost ?? row.avg_unit_cost);
          return {
            ...row,
            on_hand_qty: newQty,
            avg_unit_cost: newAvg,
            total_value: (row as any).location_is_asset_tracked ? newQty * newAvg : 0,
          };
        }
        return row;
      }));
      setStocktakeRow(null);
    } catch (e: any) {
      showToast(e?.message || '실사 보정에 실패했습니다.', 'error');
    } finally {
      setStocktakeSubmitting(false);
    }
  };

  useEffect(() => {
    api('/inventory/locations')
      .then((rows: InventoryLocation[]) => {
        setLocations(rows);
        // 기본 위치: 총무구매 창고 (있으면 자동 선택). 사용자가 명시적으로 다른 위치 선택 시 그대로 유지.
        if (!locationFilter) {
          const central = rows.find(l => l.name === '총무구매 창고');
          if (central) setLocationFilter(central.id);
        }
      })
      .catch(() => showToast('재고 위치 목록을 불러오지 못했습니다.', 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api('/cost/vendor-summary')
      .then((r: VendorSummaryResponse) => setVendorSummary(r))
      .catch(() => { setVendorSummary(null); });
  }, []);

  // 필터/정렬/파생값은 useMemo 로 고정 — 메모이즈 안 하면 매 렌더(검색어 한 글자마다)
  // 491행 필터+정렬+전체 재렌더가 반복돼 입력이 버벅인다. (성능 핵심)
  const filtered = useMemo(() => inventory.filter(i => {
    // 클라이언트 측 위치 필터 — 서버 응답 캐시/race 시 안전망
    if (locationFilter && i.location_id !== locationFilter) return false;
    if (search && !i.item_name.includes(search) && !i.item_code.includes(search)) return false;
    if (majorFilter && getMajor(i.category ?? '') !== majorFilter) return false;
    return true;
  }), [inventory, locationFilter, search, majorFilter]);

  // 정렬: 재고 있는 품목 먼저(qty > 0), 그 다음 재고 없음(qty <= 0). 각 그룹 안에서 품목코드 ASC.
  // 새 배열 참조가 매 렌더 생기면 DataTable 이 변화 없어도 전 행을 다시 그리므로 메모이즈 필수.
  const sortedFiltered = useMemo(() => [...filtered].sort((a, b) => {
    const aHasStock = Number(a.on_hand_qty) > 0 ? 0 : 1;
    const bHasStock = Number(b.on_hand_qty) > 0 ? 0 : 1;
    if (aHasStock !== bHasStock) return aHasStock - bHasStock;
    return String(a.item_code).localeCompare(String(b.item_code));
  }), [filtered]);

  const totalValue = useMemo(() => sortedFiltered.reduce((s, i) => s + i.total_value, 0), [sortedFiltered]);
  // 재고 있음/없음 카운트 (참고 표시용)
  const inStockCount = useMemo(() => sortedFiltered.filter(i => Number(i.on_hand_qty) > 0).length, [sortedFiltered]);
  const outStockCount = sortedFiltered.length - inStockCount;

  // FilterChips
  const chips: FilterChip[] = [];
  if (search) chips.push({ key: 'search', label: '검색', value: search, onRemove: () => { setSearch(''); setPage(1); } });
  if (locationFilter) chips.push({ key: 'location', label: '위치', value: locations.find(l => l.id === locationFilter)?.name || locationFilter, onRemove: () => { setLocationFilter(''); setPage(1); } });
  if (majorFilter) chips.push({ key: 'major', label: '분류', value: MAJOR_GROUP_LABEL[majorFilter], onRemove: () => { setMajorFilter(''); setPage(1); } });
  if (lowStockOnly) chips.push({ key: 'lowStock', label: '부족품목', value: '부족 품목만', onRemove: () => { setLowStockOnly(false); setPage(1); } });

  const columns = useMemo<Column<InventoryItem>[]>(() => {
    const cols: Column<InventoryItem>[] = [
      {
        key: 'item_code',
        header: '품목코드',
        render: (row) => <span className="font-mono text-xs text-gray-500">{row.item_code}</span>,
        sortable: true,
        sortValue: (row) => row.item_code,
        cardPosition: 'subtitle',
      },
      {
        key: 'item_name',
        header: '품목명',
        render: (row) => (
          <div>
            <div className="font-medium text-sm">{row.item_name}</div>
            <div className="text-xs text-gray-400">{row.category}</div>
          </div>
        ),
        sortable: true,
        sortValue: (row) => row.item_name,
        cardPosition: 'title',
      },
      {
        key: 'uom',
        header: '단위',
        render: (row) => {
          const purchase = (row as any).purchase_uom ?? row.uom;
          const issue = (row as any).issue_uom ?? row.uom;
          const pack = Number((row as any).pack_size ?? 1);
          if (pack > 1 && purchase && issue && purchase !== issue) {
            return <span className="text-xs text-gray-500">{issue} <span className="text-gray-400">(1{purchase}={pack}{issue})</span></span>;
          }
          return <span className="text-xs text-gray-500">{issue || purchase}</span>;
        },
        cardPosition: 'body',
      },
      {
        key: 'location',
        header: '위치',
        render: (row) => <span className="text-xs">{row.location_name}</span>,
        cardPosition: 'body',
      },
      {
        key: 'on_hand_qty',
        header: '재고수량',
        className: 'text-right',
        render: (row) => {
          const issue = (row as any).issue_uom ?? row.uom ?? '';
          const purchase = (row as any).purchase_uom ?? row.uom ?? '';
          const pack = Number((row as any).pack_size ?? 1);
          const qty = Number(row.on_hand_qty);
          const showDual = pack > 1 && purchase && issue && purchase !== issue;
          return (
            <span className={`font-semibold ${row.on_hand_qty === 0 ? 'text-red-600' : row.is_low_stock ? 'text-yellow-600' : 'text-navy-800'}`}>
              {qty}
              {showDual && qty > 0 && (
                <span className="ml-1 text-xs font-normal text-gray-400">
                  (≈{Math.floor(qty / pack)}{purchase}{qty % pack ? `+${qty % pack}${issue}` : ''})
                </span>
              )}
            </span>
          );
        },
        sortable: true,
        sortValue: (row) => row.on_hand_qty,
        cardPosition: 'body',
      },
    ];

    if (showFinancials) {
      cols.push(
        {
          key: 'avg_unit_cost',
          header: '평균단가',
          className: 'text-right',
          render: (row) => <span className="text-sm">{fmt(row.avg_unit_cost)}원</span>,
          sortable: true,
          sortValue: (row) => row.avg_unit_cost,
          cardPosition: 'body',
        },
        {
          key: 'total_value',
          header: '재고금액',
          className: 'text-right',
          render: (row) => <span className="font-medium">{fmt(row.total_value)}원</span>,
          sortable: true,
          sortValue: (row) => row.total_value,
          cardPosition: 'body',
        },
      );
    }

    cols.push(
      {
        key: 'status',
        header: '상태',
        render: (row) => row.is_low_stock
          ? <span className="badge-red">부족</span>
          : <span className="badge-green">정상</span>,
        cardPosition: 'badge',
      },
      {
        key: 'updated_at',
        header: '최종갱신',
        render: (row) => <span className="text-xs text-gray-400">{new Date(row.updated_at).toLocaleDateString('ko-KR')}</span>,
        sortable: true,
        sortValue: (row) => new Date(row.updated_at).getTime(),
        cardPosition: 'body',
      },
    );

    if (showWarehouseSection) {
      cols.push({
        key: 'actions',
        header: '실사',
        className: 'text-center',
        render: (row) => (
          <button
            onClick={(e) => { e.stopPropagation(); openStocktake(row); }}
            className="text-blue-600 hover:text-blue-800 inline-flex items-center gap-1 text-xs"
            title="실사 등록 — 실제 수량 보정"
          >
            <ClipboardCheck className="w-3.5 h-3.5" /> 실사
          </button>
        ),
      });
    }

    return cols;
  }, [showFinancials, showWarehouseSection]);

  const vendorColumns = useMemo<Column<{ vendor_id: string; vendor_name: string; inventory_amount_fifo: number; lot_count: number; item_count: number }>[]>(() => [
    { key: 'vendor_name', header: '업체', render: (row) => <span>{row.vendor_name}</span>, cardPosition: 'title' },
    { key: 'inventory_amount_fifo', header: 'FIFO 재고금액', className: 'text-right', render: (row) => <span className="font-medium">{fmt(row.inventory_amount_fifo)}</span>, cardPosition: 'body' },
    { key: 'lot_count', header: 'LOT 수', className: 'text-right', render: (row) => <span>{fmt(row.lot_count)}</span>, cardPosition: 'body' },
    { key: 'item_count', header: '품목 수', className: 'text-right', render: (row) => <span>{fmt(row.item_count)}</span>, cardPosition: 'body' },
  ], []);

  const handleReset = () => {
    setSearch('');
    setLocationFilter('');
    setMajorFilter('');
    setLowStockOnly(false);
    setPage(1);
  };

  return (
    <>
      <FilterBar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="품목명/코드 검색"
        filters={[
          {
            key: 'major',
            label: '전체 분류',
            options: [
              { value: 'MEDICAL', label: '의료소모품' },
              { value: 'GENERAL', label: '일반소모품' },
              { value: 'OFFICE', label: '사무용품' },
              { value: 'DIAPER', label: '기저귀' },
            ],
            value: majorFilter,
            onChange: (v) => { setMajorFilter(v as MajorGroup | ''); setPage(1); },
          },
          {
            key: 'location',
            label: '전체 위치',
            options: locations.map(l => ({ value: l.id, label: l.name })),
            value: locationFilter,
            onChange: (v) => { setLocationFilter(v); setPage(1); },
          },
        ]}
        onReset={handleReset}
      >
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
          <input type="checkbox" checked={lowStockOnly} onChange={e => { setLowStockOnly(e.target.checked); setPage(1); }} className="rounded" />
          부족 품목만
        </label>
      </FilterBar>

      <FilterChips chips={chips} totalCount={filtered.length} onResetAll={handleReset} />

      {showWarehouseSection && (
        <div className="card mb-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-800">업체별 FIFO 재고금액</h3>
            <div className="text-xs text-gray-600">
              총 재고금액: <b>{fmt(Number(vendorSummary?.totals?.inventory_total_fifo ?? 0))}원</b>
            </div>
          </div>
          <DataTable
            columns={vendorColumns}
            data={vendorSummary?.vendor_inventory_amounts ?? []}
            keyField={(row) => `${row.vendor_id}-${row.vendor_name}`}
            emptyMessage="데이터가 없습니다."
          />
        </div>
      )}

      {loading ? (
        <div className="card">
          <EmptyState icon={Boxes} message="로딩 중..." />
        </div>
      ) : (
        <>
          <MemoDataTable
            columns={columns}
            data={sortedFiltered}
            keyField="id"
            emptyMessage="재고 데이터가 없습니다."
          />
        </>
      )}

      <div className="text-xs text-gray-400 mt-2 text-right">
        재고 있음 {inStockCount}종 · 재고 없음 {outStockCount}종{showFinancials ? ` · 총 평가금액 ${fmt(totalValue)}원` : ''}
      </div>

      {/* 실사 등록 모달 */}
      <Modal
        open={stocktakeRow !== null}
        onClose={() => { if (!stocktakeSubmitting) setStocktakeRow(null); }}
        title="실사 재고 등록"
        size="xl"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setStocktakeRow(null)} disabled={stocktakeSubmitting}>취소</button>
            <button className="btn-primary inline-flex items-center gap-1.5" onClick={submitStocktake} disabled={stocktakeSubmitting}>
              <ClipboardCheck className="w-4 h-4" /> {stocktakeSubmitting ? '처리 중...' : '저장'}
            </button>
          </>
        }
      >
        {stocktakeRow && (() => {
          const totalActual = stocktakeRows.reduce((s, r) => {
            const q = Number(r.actual_qty);
            return s + (Number.isFinite(q) ? q : 0);
          }, 0);
          const totalValue = stocktakeRows.reduce((s, r) => {
            const q = Number(r.actual_qty); const c = Number(r.unit_cost);
            return s + (Number.isFinite(q) && Number.isFinite(c) ? q * c : 0);
          }, 0);
          const uom = (stocktakeRow as any).issue_uom ?? stocktakeRow.uom;
          return (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="label">품목</span>
                  <p className="font-medium">{stocktakeRow.item_name}</p>
                  <p className="text-xs text-gray-400 font-mono">{stocktakeRow.item_code}</p>
                </div>
                <div>
                  <span className="label">위치</span>
                  <p className="font-medium">{stocktakeRow.location_name}</p>
                </div>
                <div>
                  <span className="label">시스템 재고</span>
                  <p className="font-medium">{Number(stocktakeRow.on_hand_qty)} {uom}</p>
                </div>
                <div>
                  <span className="label">평균단가</span>
                  <p className="font-medium">{fmt(stocktakeRow.avg_unit_cost)}원</p>
                </div>
              </div>

              {/* 단가별 실재고 입력 — 기존 lot 조정 + 신규 lot 추가 */}
              <div className="border-t border-gray-200 pt-3">
                <label className="flex items-center gap-2 mb-2 text-xs bg-slate-50 border border-slate-200 rounded px-3 py-2 cursor-pointer">
                  <input type="checkbox" checked={stocktakeIsBase} onChange={e => setStocktakeIsBase(e.target.checked)} />
                  <span><b>초기재고 등록</b> (기존 보유재고 — 실제 구매 아님 → 구매금액 통계에서 제외)</span>
                  {!stocktakeIsBase && <span className="text-blue-600 ml-1">→ 실사 입고(실제 구매로 집계, 입고일·거래처 입력 권장)</span>}
                </label>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="label mb-0">단가별 실재고 입력</span>
                  <button type="button" className="btn-ghost text-xs py-1 px-2" onClick={addStocktakeRow}>
                    + 새 단가 추가
                  </button>
                </div>
                <div className="mb-2 text-[11px] text-slate-600 bg-blue-50 border border-blue-200 rounded px-2 py-1.5">
                  💡 <b>출고 우선순위</b> — 「다음 ▶」 으로 표시된 lot 이 다음 불출 때 가장 먼저 소진됩니다(그 lot 단가가 비용으로 잡힘).
                  기본은 입고일 순(FIFO)이지만, 좌측 <b>▲▼</b> 버튼으로 직접 순서 지정 가능 — 유통기한 임박 lot 먼저 빼야 할 때 등.
                  {reorderedTouched && <span className="ml-1 text-amber-700 font-semibold">· 순서 변경됨 (저장 시 반영)</span>}
                </div>
                <div className="border border-gray-200 rounded overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-1 py-1 text-center font-medium text-gray-600 w-16">FIFO 순서</th>
                        <th className="px-2 py-1 text-right font-medium text-gray-600 w-24">단가(원/{(stocktakeRow as any).issue_uom ?? stocktakeRow.uom})</th>
                        <th className="px-2 py-1 text-right font-medium text-gray-600 w-16">시스템</th>
                        <th className="px-2 py-1 text-right font-medium text-gray-600 w-24">실재고({(stocktakeRow as any).issue_uom ?? stocktakeRow.uom}) *</th>
                        <th className="px-2 py-1 text-right font-medium text-gray-600 w-24">금액</th>
                        <th className="px-2 py-1 text-center font-medium text-gray-600 w-32">입고일</th>
                        <th className="px-2 py-1 text-center font-medium text-gray-600 w-36">거래처</th>
                        <th className="w-8"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {stocktakeRows.map((r, idx) => {
                        const q = Number(r.actual_qty);
                        const c = Number(r.unit_cost);
                        const amount = (Number.isFinite(q) && Number.isFinite(c)) ? q * c : 0;
                        const diff = (r.system_qty !== undefined && Number.isFinite(q)) ? q - r.system_qty : null;
                        // 표시 순서 = 출고 우선순위. ▲▼ 로 사용자가 직접 조정 가능.
                        const rank = idx + 1;
                        return (
                          <tr key={idx} className="border-t border-gray-100">
                            <td className="px-1 py-1 text-center">
                              <div className="inline-flex flex-col items-center gap-0">
                                <button
                                  type="button"
                                  onClick={() => moveStocktakeRow(idx, -1)}
                                  disabled={idx === 0}
                                  className="text-[9px] leading-none px-1 py-0 text-slate-400 hover:text-slate-700 disabled:opacity-20 disabled:cursor-not-allowed"
                                  title="위로 (출고 우선순위 올리기)"
                                >▲</button>
                                <span
                                  className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${rank === 1 ? 'bg-rose-100 text-rose-700' : 'text-slate-600'}`}
                                  title={rank === 1 ? '다음 출고 시 가장 먼저 소진' : `출고 우선순위: ${rank}번째`}
                                >
                                  {rank === 1 ? '다음 ▶' : `${rank}번`}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => moveStocktakeRow(idx, +1)}
                                  disabled={idx === stocktakeRows.length - 1}
                                  className="text-[9px] leading-none px-1 py-0 text-slate-400 hover:text-slate-700 disabled:opacity-20 disabled:cursor-not-allowed"
                                  title="아래로 (출고 우선순위 내리기)"
                                >▼</button>
                              </div>
                            </td>
                            <td className="px-1 py-1">
                              <input
                                type="text"
                                inputMode="decimal"
                                className="input text-right text-xs py-1 px-1.5"
                                value={r.unit_cost}
                                placeholder={r.lot_id ? '' : '단가'}
                                onChange={e => updateStocktakeRow(idx, { unit_cost: e.target.value.replace(/[^0-9.]/g, '') })}
                              />
                            </td>
                            <td className="px-2 py-1 text-right text-gray-500">
                              {r.system_qty !== undefined ? fmt(r.system_qty) : '-'}
                            </td>
                            <td className="px-1 py-1">
                              <input
                                type="text"
                                inputMode="numeric"
                                className="input text-right text-xs py-1 px-1.5"
                                value={r.actual_qty}
                                placeholder={r.lot_id ? '' : '수량'}
                                onChange={e => updateStocktakeRow(idx, { actual_qty: e.target.value.replace(/[^0-9.]/g, '') })}
                              />
                              {diff !== null && diff !== 0 && (
                                <span className={`text-[10px] ${diff < 0 ? 'text-red-600' : 'text-blue-600'}`}>
                                  {diff > 0 ? '+' : ''}{diff}
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-1 text-right text-gray-700">{fmt(Math.round(amount))}</td>
                            <td className="px-1 py-1 text-center">
                              {r.lot_id ? <span className="text-gray-300">-</span> : (
                                <input type="date" className="input text-xs py-1 px-1" value={r.received_at ?? ''}
                                  onChange={e => updateStocktakeRow(idx, { received_at: e.target.value })} />
                              )}
                            </td>
                            <td className="px-1 py-1 text-center">
                              {r.lot_id ? <span className="text-gray-300">-</span> : (
                                <select className="input text-xs py-1 px-1" value={r.vendor_id ?? ''}
                                  onChange={e => updateStocktakeRow(idx, { vendor_id: e.target.value })}>
                                  <option value="">{stocktakeIsBase ? '미상' : '거래처 선택'}</option>
                                  {stkVendors.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
                                </select>
                              )}
                            </td>
                            <td className="px-1 py-1">
                              {!r.lot_id && stocktakeRows.length > 1 && (
                                <button type="button" className="text-red-500 hover:text-red-700 text-xs" onClick={() => removeStocktakeRow(idx)}>×</button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-gray-50">
                      <tr className="border-t border-gray-200">
                        <td className="px-2 py-1 font-medium text-gray-700">합계</td>
                        <td className="px-2 py-1 text-right text-gray-500">{fmt(Number(stocktakeRow.on_hand_qty))}</td>
                        <td className="px-2 py-1 text-right font-bold">{fmt(totalActual)}</td>
                        <td className="px-2 py-1 text-right font-medium text-gray-700">{fmt(Math.round(totalValue))}원</td>
                        <td></td>
                        <td></td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  💡 단가는 <b>{(stocktakeRow as any).issue_uom ?? stocktakeRow.uom} 단위</b>로 입력하세요
                  {Number((stocktakeRow as any).pack_size ?? 1) > 1 && (
                    <span> (박스 단가가 아닌 1{(stocktakeRow as any).issue_uom ?? stocktakeRow.uom}당 단가. 박스 단가는 ÷ {(stocktakeRow as any).pack_size}로 환산)</span>
                  )}.
                </p>
              </div>

              {/* 단가 변동 이력 (참고용) — 외부 거래원장 + 시스템 PO 통합 */}
              {stocktakeHistorical.length > 0 && (
                <div className="border-t border-gray-200 pt-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="label mb-0">단가 변동 이력 (참고)</span>
                    <span className="text-xs text-gray-500">거래원장/매출내역 + 시스템 PO</span>
                  </div>
                  <div className="border border-amber-200 bg-amber-50/30 rounded overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-amber-50">
                        <tr>
                          <th className="px-2 py-1 text-left font-medium text-gray-600">거래 기간</th>
                          <th className="px-2 py-1 text-right font-medium text-gray-600">단가(박스)</th>
                          <th className="px-2 py-1 text-right font-medium text-gray-600">거래량</th>
                          <th className="px-2 py-1 text-right font-medium text-gray-600">횟수</th>
                          <th className="px-2 py-1 text-left font-medium text-gray-600">업체</th>
                          <th className="px-2 py-1 text-left font-medium text-gray-600">출처</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stocktakeHistorical.map((h, i) => (
                          <tr key={i} className="border-t border-amber-100">
                            <td className="px-2 py-1 font-mono text-gray-700">
                              {h.first_date === h.last_date ? h.first_date : `${h.first_date} ~ ${h.last_date}`}
                            </td>
                            <td className="px-2 py-1 text-right font-medium">{fmt(h.unit_cost)}원</td>
                            <td className="px-2 py-1 text-right">{fmt(h.total_qty)}</td>
                            <td className="px-2 py-1 text-right">{h.occurrences}회</td>
                            <td className="px-2 py-1 text-gray-600">{h.vendor_name || '-'}</td>
                            <td className="px-2 py-1">
                              {h.source === 'system_po' ? (
                                <span className="text-blue-600 font-medium">시스템 PO</span>
                              ) : (
                                <span className="text-gray-500">거래원장</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    💡 단가 추이 (거래원장 → 시스템 PO). 실재고 입력은 위 lot 영역에서.
                  </p>
                </div>
              )}

            </div>
          );
        })()}
      </Modal>
    </>
  );
}

// ─── 비품 탭 ─────────────────────────────────────────────────────
function EquipmentTab() {
  const [units, setUnits] = useState<EquipmentUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [midCategoryFilter, setMidCategoryFilter] = useState('');

  // 비품 중분류 옵션 (MID_CATEGORIES 의 EQUIPMENT 만)
  const equipMidOptions = useMemo(
    () => MID_CATEGORIES.filter(m => m.major === 'EQUIPMENT').map(m => ({ value: m.value, label: m.label, subs: m.subs as readonly string[] })),
    []
  );
  const subToMid = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of equipMidOptions) for (const sub of m.subs) map[sub] = m.value;
    return map;
  }, [equipMidOptions]);
  const [detail, setDetail] = useState<EquipmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const load = useCallback(() => {
    setLoading(true);
    api('/equipment-units').then(setUnits).catch(console.error).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const openDetail = async (unit: EquipmentUnit) => {
    setDetail({ ...unit, repairs: [] });
    setDetailLoading(true);
    try {
      const d = await api(`/equipment-units/${unit.id}`);
      setDetail(d);
    } catch { }
    finally { setDetailLoading(false); }
  };

  const filtered = units.filter(u => {
    if (statusFilter && u.status !== statusFilter) return false;
    if (midCategoryFilter && subToMid[u.category ?? ''] !== midCategoryFilter) return false;
    if (search && !u.item_name.includes(search) && !u.serial_no.includes(search) && !u.department_name.includes(search)) return false;
    return true;
  });

  const paginatedData = filtered.slice((page - 1) * pageSize, page * pageSize);

  // FilterChips
  const chips: FilterChip[] = [];
  if (search) chips.push({ key: 'search', label: '검색', value: search, onRemove: () => { setSearch(''); setPage(1); } });
  if (statusFilter) chips.push({ key: 'status', label: '상태', value: EQ_STATUS_LABEL[statusFilter] || statusFilter, onRemove: () => { setStatusFilter(''); setPage(1); } });
  if (midCategoryFilter) {
    const mid = equipMidOptions.find(m => m.value === midCategoryFilter);
    chips.push({ key: 'mid', label: '분류', value: mid?.label || midCategoryFilter, onRemove: () => { setMidCategoryFilter(''); setPage(1); } });
  }

  const handleReset = () => {
    setSearch('');
    setStatusFilter('');
    setMidCategoryFilter('');
    setPage(1);
  };

  const columns = useMemo<Column<EquipmentUnit>[]>(() => [
    {
      key: 'serial_no',
      header: '일련번호',
      render: (row) => <span className="font-mono text-xs text-blue-700 font-semibold">{row.serial_no}</span>,
      sortable: true,
      sortValue: (row) => row.serial_no,
      cardPosition: 'subtitle',
    },
    {
      key: 'item_name',
      header: '품목명',
      render: (row) => (
        <div>
          <div className="font-medium text-sm">{row.item_name}</div>
          {row.item_code && <div className="text-xs text-gray-400">{row.item_code}</div>}
        </div>
      ),
      sortable: true,
      sortValue: (row) => row.item_name,
      cardPosition: 'title',
    },
    {
      key: 'department',
      header: '부서',
      render: (row) => <span className="text-sm text-gray-700">{row.department_name}</span>,
      sortable: true,
      sortValue: (row) => row.department_name,
      cardPosition: 'body',
    },
    {
      key: 'location',
      header: '위치',
      render: (row) => <span className="text-xs text-gray-500">{row.location || '-'}</span>,
      cardPosition: 'body',
    },
    {
      key: 'is_primary',
      header: '정/부',
      className: 'text-center',
      render: (row) => (
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${row.is_primary ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
          {row.is_primary ? '정' : '부'}
        </span>
      ),
      cardPosition: 'body',
    },
    {
      key: 'status',
      header: '상태',
      className: 'text-center',
      render: (row) => <span className={EQ_STATUS_CLS[row.status]}>{EQ_STATUS_LABEL[row.status]}</span>,
      cardPosition: 'badge',
    },
    {
      key: 'created_at',
      header: '등록일',
      render: (row) => <span className="text-xs text-gray-400">{new Date(row.created_at).toLocaleDateString('ko-KR')}</span>,
      sortable: true,
      sortValue: (row) => new Date(row.created_at).getTime(),
      cardPosition: 'body',
    },
  ], []);

  return (
    <>
      <FilterBar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        searchPlaceholder="품목명/일련번호/부서 검색"
        filters={[
          {
            key: 'mid',
            label: '전체 분류',
            options: equipMidOptions.map(m => ({ value: m.value, label: m.label })),
            value: midCategoryFilter,
            onChange: (v) => { setMidCategoryFilter(v); setPage(1); },
          },
          {
            key: 'status',
            label: '전체 상태',
            options: [
              { value: 'ACTIVE', label: '정상' },
              { value: 'IN_REPAIR', label: '수리중' },
              { value: 'DISPOSED', label: '폐기' },
            ],
            value: statusFilter,
            onChange: (v) => { setStatusFilter(v); setPage(1); },
          },
        ]}
        onReset={handleReset}
      />

      <FilterChips chips={chips} totalCount={filtered.length} onResetAll={handleReset} />

      {loading ? (
        <div className="card">
          <EmptyState icon={Package} message="로딩 중..." />
        </div>
      ) : (
        <>
          <DataTable
            columns={columns}
            data={paginatedData}
            keyField="id"
            onRowClick={openDetail}
            emptyMessage="비품 데이터가 없습니다."
          />
          <Pagination
            currentPage={page}
            totalItems={filtered.length}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </>
      )}

      <div className="text-xs text-gray-400 mt-2 text-right">
        총 {filtered.length}건
      </div>

      {/* 상세 모달 */}
      <Modal
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail ? `${detail.item_name} (${detail.serial_no})` : ''}
        size="md"
      >
        {detail && (
          <>
            <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
              <div>
                <span className="text-gray-500">부서</span>
                <p className="font-medium text-gray-800 mt-0.5">{detail.department_name}</p>
              </div>
              <div>
                <span className="text-gray-500">위치</span>
                <p className="font-medium text-gray-800 mt-0.5">{detail.location || '—'}</p>
              </div>
              <div>
                <span className="text-gray-500">정/부</span>
                <p className="font-medium text-gray-800 mt-0.5">{detail.is_primary ? '정(正)' : '부(副)'}</p>
              </div>
              <div>
                <span className="text-gray-500">상태</span>
                <p className="mt-0.5"><span className={EQ_STATUS_CLS[detail.status]}>{EQ_STATUS_LABEL[detail.status]}</span></p>
              </div>
            </div>

            {detail.notes && (
              <div className="mb-4 text-sm">
                <span className="text-gray-500">메모</span>
                <p className="text-gray-700 mt-0.5">{detail.notes}</p>
              </div>
            )}

            <div className="border-t border-gray-200 pt-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
                <Wrench className="w-4 h-4 text-gray-400" />
                수리 이력
              </h3>
              {detailLoading ? (
                <p className="text-xs text-gray-400">불러오는 중...</p>
              ) : detail.repairs.length === 0 ? (
                <EmptyState icon={Wrench} message="수리 이력이 없습니다." />
              ) : (
                <div className="space-y-2">
                  {detail.repairs.map(r => (
                    <div key={r.id} className="bg-gray-50 rounded-lg p-3 text-xs">
                      <div className="flex items-center justify-between mb-1">
                        <span className={`px-2 py-0.5 rounded-full font-medium ${
                          r.status === 'COMPLETED' ? 'bg-green-100 text-green-700' :
                          r.status === 'DISPOSED'  ? 'bg-gray-100 text-gray-500' :
                          r.status === 'IN_PROGRESS' ? 'bg-blue-100 text-blue-700' :
                          'bg-yellow-100 text-yellow-700'
                        }`}>
                          {REPAIR_STATUS_LABEL[r.status] ?? r.status}
                        </span>
                        <span className="text-gray-400">{new Date(r.created_at).toLocaleDateString('ko-KR')}</span>
                      </div>
                      {r.description && <p className="text-gray-600 mb-1">{r.description}</p>}
                      {r.result_note && <p className="text-gray-500 italic">처리내용: {r.result_note}</p>}
                      {r.requesting_dept && <p className="text-gray-400 mt-1">신청부서: {r.requesting_dept.name}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

// ─── 메인 페이지 ─────────────────────────────────────────────────
type MainTab = 'consumables' | 'equipment';

export default function InventoryPage() {
  const [tab, setTab] = useState<MainTab>('consumables');

  return (
    <div>
      <PageHeader
        icon={Boxes}
        title="재고 현황"
        description="소모품 및 비품 재고를 관리합니다"
      />

      {/* 소모품/비품 탭 */}
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {[
          { key: 'consumables' as MainTab, label: '소모품', icon: Package },
          { key: 'equipment' as MainTab, label: '비품', icon: Wrench },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === t.key
                ? 'border-teal-500 text-teal-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'consumables' && <ConsumablesTab />}
      {tab === 'equipment' && <EquipmentTab />}
    </div>
  );
}
