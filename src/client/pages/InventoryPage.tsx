import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Boxes, Package, Wrench, AlertTriangle, CheckCircle, MapPin, Calendar, Hash, Tag } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { PageHeader, FilterBar, DataTable, Modal, EmptyState, FilterChips, Pagination } from '../components/ui';
import type { Column, FilterChip } from '../components/ui';
import type { InventoryItem, InventoryLocation, VendorSummaryResponse } from '@shared/types';

// ─── 비품 탭 타입 ─────────────────────────────────────────────────
interface EquipmentUnit {
  id: string;
  serial_no: string;
  item_name: string;
  item_code: string;
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
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [vendorSummary, setVendorSummary] = useState<VendorSummaryResponse | null>(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  useEffect(() => {
    const params = new URLSearchParams();
    if (locationFilter) params.set('location_id', locationFilter);
    if (lowStockOnly) params.set('low_stock', 'true');
    setLoading(true);
    api(`/inventory?${params}`)
      .then(setInventory)
      .catch(() => showToast('재고 목록을 불러오지 못했습니다.', 'error'))
      .finally(() => setLoading(false));
  }, [locationFilter, lowStockOnly]);

  useEffect(() => {
    api('/inventory/locations')
      .then(setLocations)
      .catch(() => showToast('재고 위치 목록을 불러오지 못했습니다.', 'error'));
  }, []);

  useEffect(() => {
    api('/cost/vendor-summary')
      .then((r: VendorSummaryResponse) => setVendorSummary(r))
      .catch(() => { setVendorSummary(null); });
  }, []);

  const filtered = inventory.filter(i =>
    !search || i.item_name.includes(search) || i.item_code.includes(search)
  );

  const totalValue = filtered.reduce((s, i) => s + i.total_value, 0);

  const paginatedData = filtered.slice((page - 1) * pageSize, page * pageSize);

  // FilterChips
  const chips: FilterChip[] = [];
  if (search) chips.push({ key: 'search', label: '검색', value: search, onRemove: () => { setSearch(''); setPage(1); } });
  if (locationFilter) chips.push({ key: 'location', label: '위치', value: locations.find(l => l.id === locationFilter)?.name || locationFilter, onRemove: () => { setLocationFilter(''); setPage(1); } });
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
        render: (row) => <span className="text-xs text-gray-500">{row.uom}</span>,
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
        render: (row) => (
          <span className={`font-semibold ${row.on_hand_qty === 0 ? 'text-red-600' : row.is_low_stock ? 'text-yellow-600' : 'text-navy-800'}`}>
            {row.on_hand_qty}
          </span>
        ),
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

    return cols;
  }, [showFinancials]);

  const vendorColumns = useMemo<Column<{ vendor_id: string; vendor_name: string; inventory_amount_fifo: number; lot_count: number; item_count: number }>[]>(() => [
    { key: 'vendor_name', header: '업체', render: (row) => <span>{row.vendor_name}</span>, cardPosition: 'title' },
    { key: 'inventory_amount_fifo', header: 'FIFO 재고금액', className: 'text-right', render: (row) => <span className="font-medium">{fmt(row.inventory_amount_fifo)}</span>, cardPosition: 'body' },
    { key: 'lot_count', header: 'LOT 수', className: 'text-right', render: (row) => <span>{fmt(row.lot_count)}</span>, cardPosition: 'body' },
    { key: 'item_count', header: '품목 수', className: 'text-right', render: (row) => <span>{fmt(row.item_count)}</span>, cardPosition: 'body' },
  ], []);

  const handleReset = () => {
    setSearch('');
    setLocationFilter('');
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
          <DataTable
            columns={columns}
            data={paginatedData}
            keyField="id"
            emptyMessage="재고 데이터가 없습니다."
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
        {filtered.length}종{showFinancials ? ` · 총 평가금액 ${fmt(totalValue)}원` : ''}
      </div>
    </>
  );
}

// ─── 비품 탭 ─────────────────────────────────────────────────────
function EquipmentTab() {
  const [units, setUnits] = useState<EquipmentUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
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
    if (search && !u.item_name.includes(search) && !u.serial_no.includes(search) && !u.department_name.includes(search)) return false;
    return true;
  });

  const paginatedData = filtered.slice((page - 1) * pageSize, page * pageSize);

  // FilterChips
  const chips: FilterChip[] = [];
  if (search) chips.push({ key: 'search', label: '검색', value: search, onRemove: () => { setSearch(''); setPage(1); } });
  if (statusFilter) chips.push({ key: 'status', label: '상태', value: EQ_STATUS_LABEL[statusFilter] || statusFilter, onRemove: () => { setStatusFilter(''); setPage(1); } });

  const handleReset = () => {
    setSearch('');
    setStatusFilter('');
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
