
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, downloadBlob } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { PageHeader, FilterBar, DataTable, Modal, EmptyState, FilterChips, Pagination } from '../components/ui';
import type { Column, FilterChip } from '../components/ui';
import type { Item, Vendor } from '@shared/types';
import { FileText, Send, Trash2, Eye, Download, Plus, ChevronDown, ChevronRight, BarChart3 } from 'lucide-react';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '임시',
  SENT: '발주완료',
  PARTIAL_RECEIVED: '부분입고',
  CLOSED: '완료',
  CANCELLED: '취소',
};

const STATUS_CLS: Record<string, string> = {
  DRAFT: 'badge-gray',
  SENT: 'badge-blue',
  PARTIAL_RECEIVED: 'badge-yellow',
  CLOSED: 'badge-green',
  CANCELLED: 'badge-red',
};

const SOURCE_TYPE_TABS = [
  { v: '', l: '전체' },
  { v: 'CONSUMABLE_REGULAR', l: '정기소모품' },
  { v: 'DIAPER', l: '기저귀' },
  { v: 'NIGHT_SNACK', l: '야간당직간식' },
  { v: 'ADHOC', l: '비정기' },
  { v: 'MANUAL', l: '수동' },
] as const;

const SOURCE_TYPE_LABEL: Record<string, string> = {
  CONSUMABLE_REGULAR: '정기소모품',
  DIAPER: '기저귀',
  NIGHT_SNACK: '야간당직간식',
  ADHOC: '비정기',
  MANUAL: '수동',
};

const SOURCE_TYPE_COLOR: Record<string, string> = {
  CONSUMABLE_REGULAR: 'bg-blue-100 text-blue-700',
  DIAPER: 'bg-purple-100 text-purple-700',
  NIGHT_SNACK: 'bg-cyan-100 text-cyan-700',
  ADHOC: 'bg-orange-100 text-orange-700',
  MANUAL: 'bg-gray-100 text-gray-700',
};

const STATUS_SCOPE_TABS = [
  { v: 'ACTIVE', l: '진행중' },
  { v: 'DRAFT', l: '임시저장' },
  { v: 'COMPLETED', l: '완료/취소' },
  { v: 'ALL', l: '전체' },
] as const;

interface POItem {
  id?: string;
  item_id: string;
  item_name?: string;
  item_code?: string;
  uom?: string;
  ordered_qty: number;
  unit_price: number;
  line_amount: number;
}

interface POSource {
  ward_request_id: string;
  request_no?: string;
  department_id?: string;
  department_name?: string;
  request_type?: string;
  items: { item_id: string; item_name?: string; requested_qty: number }[];
}

interface PurchaseOrder {
  id: string;
  po_no: string;
  vendor_id: string;
  vendor_name?: string;
  creator_name?: string;
  status: string;
  ordered_at: string;
  expected_at?: string;
  total_amount: number;
  note?: string;
  item_count?: number;
  source_type?: string;
  schedule_period_label?: string;
  schedule_period_start?: string;
  schedule_period_matched?: boolean;
  has_mixed_period_labels?: boolean;
  items?: POItem[];
  sources?: POSource[];
}

interface EditItem {
  item_id: string;
  item_name: string;
  item_code?: string;
  uom?: string;
  ordered_qty: number;
  unit_price: number;
}

interface GroupedRow {
  item_id: string;
  item_name: string;
  requested_qty: number;
  ordered_qty: number;
  unit_price: number;
  line_amount: number;
}

interface VendorGroupedOrder {
  vendor_id: string;
  vendor_name: string;
  orders: PurchaseOrder[];
  request_nos: string[];
  items: GroupedRow[];
}

interface PeriodGroupedVendorOrders {
  period_label: string;
  period_start: string;
  period_matched: boolean;
  has_mixed_period_labels: boolean;
  vendors: VendorGroupedOrder[];
}

function GumaeModal({ orders, selectedIds, onToggle, onToggleAll, onClose, onDownload, from, to, label, onFromChange, onToChange, onLabelChange, comparePeriods, onCompareChange }: {
  orders: PurchaseOrder[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[]) => void;
  onClose: () => void;
  onDownload: () => void;
  from: string; to: string; label: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  onLabelChange: (v: string) => void;
  comparePeriods: { label: string; from: string; to: string }[];
  onCompareChange: (v: { label: string; from: string; to: string }[]) => void;
}) {
  const selectable = orders.filter(o => !['DRAFT', 'CANCELLED'].includes(o.status));
  const allIds = selectable.map(o => o.id);
  const allChecked = allIds.length > 0 && allIds.every(id => selectedIds.has(id));
  const addCompare = () => onCompareChange([...comparePeriods, { label: '', from: '', to: '' }]);
  const removeCompare = (i: number) => onCompareChange(comparePeriods.filter((_, idx) => idx !== i));
  const updateCompare = (i: number, key: string, val: string) =>
    onCompareChange(comparePeriods.map((cp, idx) => idx === i ? { ...cp, [key]: val } : cp));
  return (
    <Modal open={true} onClose={onClose} title="구매결의서 출력 — 발주서 선택" size="lg">
      <div className="space-y-3 pb-3 border-b">
        <div>
          <label className="form-label">기간 라벨 (예: 03월1주)</label>
          <input type="text" className="form-input" placeholder="03월1주" value={label} onChange={e => onLabelChange(e.target.value)} />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="form-label">물품사용기간 시작일</label>
            <input type="date" className="form-input" value={from} onChange={e => onFromChange(e.target.value)} />
          </div>
          <div className="flex-1">
            <label className="form-label">종료일</label>
            <input type="date" className="form-input" value={to} onChange={e => onToChange(e.target.value)} />
          </div>
        </div>
        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="form-label mb-0">비교 기간 (요약표 컬럼 추가)</span>
            {comparePeriods.length < 2 && (
              <button onClick={addCompare} className="text-xs btn-secondary py-0.5 px-2">+ 추가</button>
            )}
          </div>
          {comparePeriods.length === 0 && (
            <p className="text-xs text-gray-400">비교 기간을 추가하면 업체별 구매금액 표에 이전 기간 컬럼이 추가됩니다.</p>
          )}
          {comparePeriods.map((cp, i) => (
            <div key={i} className="flex gap-2 items-end">
              <div className="w-24">
                <label className="form-label">라벨</label>
                <input type="text" className="form-input" placeholder="02월4주" value={cp.label}
                  onChange={e => updateCompare(i, 'label', e.target.value)} />
              </div>
              <div className="flex-1">
                <label className="form-label">시작일</label>
                <input type="date" className="form-input" value={cp.from}
                  onChange={e => updateCompare(i, 'from', e.target.value)} />
              </div>
              <div className="flex-1">
                <label className="form-label">종료일</label>
                <input type="date" className="form-input" value={cp.to}
                  onChange={e => updateCompare(i, 'to', e.target.value)} />
              </div>
              <button onClick={() => removeCompare(i)} className="btn-danger text-xs py-1 px-2 mb-0.5">삭제</button>
            </div>
          ))}
        </div>
      </div>
      <div className="p-0 -mx-5">
        {selectable.length === 0 ? (
          <p className="p-4 text-sm text-gray-500">현재 탭에 발주서가 없습니다. (임시저장/취소 제외)</p>
        ) : (
          <div className="overflow-y-auto max-h-64">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input type="checkbox" checked={allChecked} onChange={() => onToggleAll(allIds)} />
                  </th>
                  <th className="px-3 py-2 text-left">발주번호</th>
                  <th className="px-3 py-2 text-left">업체</th>
                  <th className="px-3 py-2 text-left">발주일</th>
                  <th className="px-3 py-2 text-right">금액</th>
                </tr>
              </thead>
              <tbody>
                {selectable.map(o => (
                  <tr key={o.id} className={`border-t cursor-pointer hover:bg-blue-50 ${selectedIds.has(o.id) ? 'bg-blue-50' : ''}`} onClick={() => onToggle(o.id)}>
                    <td className="px-3 py-2 text-center">
                      <input type="checkbox" checked={selectedIds.has(o.id)} onChange={() => onToggle(o.id)} onClick={e => e.stopPropagation()} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{o.po_no}</td>
                    <td className="px-3 py-2">{o.vendor_name}</td>
                    <td className="px-3 py-2 text-gray-500">{new Date(o.ordered_at).toLocaleDateString('ko-KR')}</td>
                    <td className="px-3 py-2 text-right">{Number(o.total_amount).toLocaleString('ko-KR')}원</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between pt-3 border-t -mx-5 px-5">
        <span className="text-sm text-gray-500">{selectedIds.size}건 선택됨</span>
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-secondary">취소</button>
          <button onClick={onDownload} disabled={selectedIds.size === 0} className="btn-primary disabled:opacity-40">PDF 생성</button>
        </div>
      </div>
    </Modal>
  );
}

interface GianFormData {
  doc_type: 'poomui' | 'bogo' | 'hyupjo';
  doc_no: string;
  doc_date: string;
  enforce_date: string;
  coop_dept: string;
  retention: string;
  title: string;
  content: string;
  payment_method: string;
  attachment: string;
}

function GianModal({ orders, selectedIds, onToggle, onToggleAll, onClose, onDownload, form, onFormChange }: {
  orders: PurchaseOrder[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[]) => void;
  onClose: () => void;
  onDownload: () => void;
  form: GianFormData;
  onFormChange: (f: Partial<GianFormData>) => void;
}) {
  const selectable = orders.filter(o => !['DRAFT', 'CANCELLED'].includes(o.status));
  const allIds = selectable.map(o => o.id);
  const allChecked = allIds.length > 0 && allIds.every(id => selectedIds.has(id));
  const set = (key: keyof GianFormData, val: string) => onFormChange({ [key]: val });
  return (
    <Modal open={true} onClose={onClose} title="기안서 작성" size="xl">
      <div className="space-y-3 pb-3 border-b overflow-y-auto max-h-[60vh]">
        <div className="flex gap-3 items-end">
          <div>
            <label className="form-label">기안구분</label>
            <div className="flex gap-3 mt-1">
              {([['poomui', '품의'], ['bogo', '보고'], ['hyupjo', '협조']] as const).map(([v, l]) => (
                <label key={v} className="flex items-center gap-1 text-sm cursor-pointer">
                  <input type="radio" name="doc_type" checked={form.doc_type === v} onChange={() => set('doc_type', v)} />
                  {l}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="form-label">문서번호</label>
            <input type="text" className="form-input" placeholder="호남 - 26 - 061" value={form.doc_no} onChange={e => set('doc_no', e.target.value)} />
          </div>
          <div>
            <label className="form-label">기안일자</label>
            <input type="date" className="form-input" value={form.doc_date} onChange={e => set('doc_date', e.target.value)} />
          </div>
          <div>
            <label className="form-label">시행일자</label>
            <input type="text" className="form-input" placeholder="재가 후 즉시" value={form.enforce_date} onChange={e => set('enforce_date', e.target.value)} />
          </div>
          <div>
            <label className="form-label">협조부서</label>
            <input type="text" className="form-input" placeholder="" value={form.coop_dept} onChange={e => set('coop_dept', e.target.value)} />
          </div>
          <div>
            <label className="form-label">보존년한</label>
            <input type="text" className="form-input" placeholder="1년" value={form.retention} onChange={e => set('retention', e.target.value)} />
          </div>
        </div>
        <div>
          <label className="form-label">제 목</label>
          <input type="text" className="form-input" value={form.title} onChange={e => set('title', e.target.value)} />
        </div>
        <div>
          <label className="form-label">내용 (본문)</label>
          <textarea className="form-input" rows={3} placeholder="본원 ... 품의 하오니 검토 재가 바랍니다." value={form.content} onChange={e => set('content', e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="form-label">결제방법</label>
            <input type="text" className="form-input" placeholder="올랏결제" value={form.payment_method} onChange={e => set('payment_method', e.target.value)} />
          </div>
          <div>
            <label className="form-label">붙임</label>
            <input type="text" className="form-input" placeholder="견적서 1부" value={form.attachment} onChange={e => set('attachment', e.target.value)} />
          </div>
        </div>
      </div>
      <div className="p-0 border-b -mx-5">
        <div className="px-3 py-2 text-xs font-medium text-gray-500 bg-gray-50">발주서 선택 (품목 테이블에 포함)</div>
        {selectable.length === 0 ? (
          <p className="p-4 text-sm text-gray-500">발주서가 없습니다. (임시저장/취소 제외)</p>
        ) : (
          <div className="overflow-y-auto max-h-48">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input type="checkbox" checked={allChecked} onChange={() => onToggleAll(allIds)} />
                  </th>
                  <th className="px-3 py-2 text-left">발주번호</th>
                  <th className="px-3 py-2 text-left">업체</th>
                  <th className="px-3 py-2 text-left">발주일</th>
                  <th className="px-3 py-2 text-right">금액</th>
                </tr>
              </thead>
              <tbody>
                {selectable.map(o => (
                  <tr key={o.id} className={`border-t cursor-pointer hover:bg-blue-50 ${selectedIds.has(o.id) ? 'bg-blue-50' : ''}`} onClick={() => onToggle(o.id)}>
                    <td className="px-3 py-2 text-center">
                      <input type="checkbox" checked={selectedIds.has(o.id)} onChange={() => onToggle(o.id)} onClick={e => e.stopPropagation()} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{o.po_no}</td>
                    <td className="px-3 py-2">{o.vendor_name}</td>
                    <td className="px-3 py-2 text-gray-500">{new Date(o.ordered_at).toLocaleDateString('ko-KR')}</td>
                    <td className="px-3 py-2 text-right">{Number(o.total_amount).toLocaleString('ko-KR')}원</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between pt-3 border-t -mx-5 px-5">
        <span className="text-sm text-gray-500">{selectedIds.size}건 선택됨</span>
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-secondary">취소</button>
          <button onClick={onDownload} disabled={selectedIds.size === 0} className="btn-primary disabled:opacity-40">PDF 생성</button>
        </div>
      </div>
    </Modal>
  );
}

export default function PurchaseOrdersPage() {
  const { hasPerm } = useAuth();
  const { showToast } = useToast();
  const canCreate = hasPerm('PURCHASE_MANAGE');
  const canSend = hasPerm('PURCHASE_MANAGE');

  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceTypeTab, setSourceTypeTab] = useState('');
  const [statusScope, setStatusScope] = useState<'ACTIVE' | 'DRAFT' | 'COMPLETED' | 'ALL'>('ACTIVE');
  const [poPage, setPoPage] = useState(1);
  const [poPageSize, setPoPageSize] = useState(20);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [showAnalysis, setShowAnalysis] = useState(false);
  const [sumRange, setSumRange] = useState(() => {
    const d = new Date();
    const from = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
    const to = d.toISOString().slice(0, 10);
    return { from, to };
  });
  const [vendorSummary, setVendorSummary] = useState<any>(null);

  const [createModal, setCreateModal] = useState(false);
  const [form, setForm] = useState({ vendor_id: '', expected_at: '', note: '' });
  const [orderItems, setOrderItems] = useState<EditItem[]>([]);
  const [itemSearch, setItemSearch] = useState('');
  const [filteredSearch, setFilteredSearch] = useState<Item[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [detail, setDetail] = useState<PurchaseOrder | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editItems, setEditItems] = useState<EditItem[]>([]);
  const [detailSearch, setDetailSearch] = useState('');
  const [detailFiltered, setDetailFiltered] = useState<Item[]>([]);
  const [showSources, setShowSources] = useState(false);
  const [saving, setSaving] = useState(false);

  const [groupDetails, setGroupDetails] = useState<PurchaseOrder[]>([]);
  const [groupLoading, setGroupLoading] = useState(false);

  const [inventoryByItem, setInventoryByItem] = useState<Record<string, number>>({});
  const [inventoryLoadedAt, setInventoryLoadedAt] = useState(0);
  const [inventoryLoading, setInventoryLoading] = useState(false);

  const [docTab, setDocTab] = useState<'gumae' | 'gian'>('gumae');

  const [gumaeModal, setGumaeModal] = useState(false);
  const [gmSelectedIds, setGmSelectedIds] = useState<Set<string>>(new Set());
  const [gmFrom, setGmFrom] = useState('');
  const [gmTo, setGmTo] = useState('');
  const [gmLabel, setGmLabel] = useState('');
  const [gmCompare, setGmCompare] = useState<{ label: string; from: string; to: string }[]>([]);

  const [gianModal, setGianModal] = useState(false);
  const [gnSelectedIds, setGnSelectedIds] = useState<Set<string>>(new Set());
  const defaultGianForm = (): GianFormData => ({
    doc_type: 'poomui', doc_no: '', doc_date: new Date().toISOString().slice(0, 10),
    enforce_date: '재가 후 즉시', coop_dept: '', retention: '1년',
    title: '물품 구매의 건', content: '', payment_method: '', attachment: '',
  });
  const [gnForm, setGnForm] = useState<GianFormData>(defaultGianForm);

  const fmt = (n: number) => new Intl.NumberFormat('ko-KR').format(n);
  const parseNumericInput = (value: string) => {
    const numeric = value.replace(/[^\d]/g, '');
    if (!numeric) return 0;
    const parsed = Number(numeric);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const toMonthLabel = (dateLike?: string) => {
    if (!dateLike) return '미분류';
    const d = new Date(dateLike);
    if (Number.isNaN(d.getTime())) return '미분류';
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
  };
  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3000);
  };
  const load = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams();
    if (sourceTypeTab) p.set('source_type', sourceTypeTab);
    p.set('status_scope', statusScope);
    api(`/purchase-orders?${p}`)
      .then(setOrders)
      .catch(() => showToast('발주 목록을 불러오지 못했습니다.', 'error'))
      .finally(() => setLoading(false));
  }, [sourceTypeTab, statusScope, showToast]);

  const loadInventory = useCallback(
    async (force = false) => {
      const now = Date.now();
      if (!force && now - inventoryLoadedAt < 60_000 && Object.keys(inventoryByItem).length > 0) return;
      setInventoryLoading(true);
      try {
        const rows: any[] = await api('/inventory');
        const next: Record<string, number> = {};
        for (const r of rows ?? []) {
          const itemId = String(r.item_id ?? '');
          if (!itemId) continue;
          next[itemId] = (next[itemId] ?? 0) + Number(r.on_hand_qty ?? 0);
        }
        setInventoryByItem(next);
        setInventoryLoadedAt(now);
      } catch {
        // keep page usable
      } finally {
        setInventoryLoading(false);
      }
    },
    [inventoryByItem, inventoryLoadedAt]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api('/vendors?is_active=true').then(setVendors).catch(() => showToast('업체 목록을 불러오지 못했습니다.', 'error'));
    api('/items?is_active=true').then(setItems).catch(() => showToast('품목 목록을 불러오지 못했습니다.', 'error'));
    loadInventory();
  }, [loadInventory]);

  useEffect(() => {
    if (!sourceTypeTab || sourceTypeTab === 'MANUAL' || orders.length === 0) {
      setGroupDetails([]);
      return;
    }
    setGroupLoading(true);
    Promise.all(orders.map((o) => api(`/purchase-orders/${o.id}`).catch(() => null)))
      .then((rows) => setGroupDetails(rows.filter(Boolean)))
      .finally(() => setGroupLoading(false));
  }, [orders, sourceTypeTab]);

  useEffect(() => {
    const p = new URLSearchParams({ date_from: sumRange.from, date_to: sumRange.to });
    api(`/cost/vendor-summary?${p}`).then(setVendorSummary).catch(() => setVendorSummary(null));
  }, [sumRange.from, sumRange.to]);

  useEffect(() => {
    if (!itemSearch.trim()) {
      setFilteredSearch([]);
      return;
    }
    setFilteredSearch(items.filter((i) => i.name.includes(itemSearch) || i.item_code.includes(itemSearch)).slice(0, 15));
  }, [itemSearch, items]);

  useEffect(() => {
    if (!detailSearch.trim()) {
      setDetailFiltered([]);
      return;
    }
    setDetailFiltered(items.filter((i) => i.name.includes(detailSearch) || i.item_code.includes(detailSearch)).slice(0, 15));
  }, [detailSearch, items]);

  const addItemToCreate = (item: Item) => {
    if (orderItems.some((o) => o.item_id === item.id)) return;
    setOrderItems((prev) => [
      ...prev,
      {
        item_id: item.id,
        item_name: item.name,
        uom: item.uom,
        ordered_qty: 1,
        unit_price: item.latest_price || 0,
      },
    ]);
    setItemSearch('');
    setFilteredSearch([]);
  };

  const createPO = async () => {
    if (!form.vendor_id || orderItems.length === 0) {
      showMsg('err', '업체와 품목을 입력해주세요.');
      return;
    }
    setSubmitting(true);
    try {
      await api('/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          vendor_id: form.vendor_id,
          expected_at: form.expected_at || null,
          note: form.note,
          items: orderItems.map((o) => ({ item_id: o.item_id, ordered_qty: o.ordered_qty, unit_price: o.unit_price })),
        }),
      });
      showMsg('ok', '발주서를 생성했습니다.');
      setCreateModal(false);
      setOrderItems([]);
      setForm({ vendor_id: '', expected_at: '', note: '' });
      load();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const openDetail = async (id: string) => {
    try {
      await loadInventory();
      const d = await api(`/purchase-orders/${id}`);
      setDetail(d);
      setEditMode(false);
      setEditItems(
        (d.items ?? []).map((it: POItem) => ({
          item_id: it.item_id,
          item_name: it.item_name ?? '',
          item_code: it.item_code,
          uom: it.uom,
          ordered_qty: it.ordered_qty,
          unit_price: it.unit_price,
        }))
      );
      setShowSources(false);
      setDetailSearch('');
      setDetailFiltered([]);
    } catch (e: any) {
      showMsg('err', e.message);
    }
  };

  const addItemToEdit = (item: Item) => {
    if (editItems.some((o) => o.item_id === item.id)) return;
    setEditItems((prev) => [
      ...prev,
      {
        item_id: item.id,
        item_name: item.name,
        item_code: item.item_code,
        uom: item.uom,
        ordered_qty: 1,
        unit_price: item.latest_price || 0,
      },
    ]);
    setDetailSearch('');
    setDetailFiltered([]);
  };
  const saveEdit = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      await api(`/purchase-orders/${detail.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          items: editItems.map((it) => ({ item_id: it.item_id, ordered_qty: it.ordered_qty, unit_price: it.unit_price })),
        }),
      });
      showMsg('ok', '발주서를 수정했습니다.');
      setEditMode(false);
      const d = await api(`/purchase-orders/${detail.id}`);
      setDetail(d);
      load();
    } catch (e: any) {
      showMsg('err', e.message);
    } finally {
      setSaving(false);
    }
  };

  const sendPO = async (id: string) => {
    if (!confirm('발주서를 확정(발송)하시겠습니까?')) return;
    try {
      await api(`/purchase-orders/${id}/send`, { method: 'POST' });
      showMsg('ok', '발주서를 발송했습니다.');
      load();
      if (detail?.id === id) {
        const d = await api(`/purchase-orders/${id}`);
        setDetail(d);
      }
    } catch (e: any) {
      showMsg('err', e.message);
    }
  };

  const deletePO = async (id: string) => {
    if (!confirm('발주서를 삭제하시겠습니까?')) return;
    try {
      await api(`/purchase-orders/${id}`, { method: 'DELETE' });
      showMsg('ok', '삭제했습니다.');
      setDetail(null);
      load();
    } catch (e: any) {
      showMsg('err', e.message);
    }
  };

  const downloadPdf = async (id: string, po_no: string) => {
    try {
      const blob = await api(`/purchase-orders/${id}/pdf`);
      downloadBlob(blob, `${po_no}.pdf`);
    } catch {
      showMsg('err', 'PDF 생성 실패');
    }
  };

  const closeGumaeModal = () => { setGumaeModal(false); setGmSelectedIds(new Set()); setGmFrom(''); setGmTo(''); setGmLabel(''); setGmCompare([]); };
  const downloadGumae = async (ids: string[]) => {
    if (ids.length === 0) { showMsg('err', '발주서를 선택해주세요.'); return; }
    try {
      const blob = await api('/purchase-orders/gumae-result-pdf', {
        method: 'POST',
        body: JSON.stringify({ ids, from: gmFrom, to: gmTo, label: gmLabel, comparePeriods: gmCompare }),
      });
      downloadBlob(blob, `구매결의서.pdf`);
      closeGumaeModal();
    } catch {
      showMsg('err', 'PDF 생성 실패');
    }
  };

  const closeGianModal = () => { setGianModal(false); setGnSelectedIds(new Set()); setGnForm(defaultGianForm()); };
  const downloadGian = async (ids: string[]) => {
    if (ids.length === 0) { showMsg('err', '발주서를 선택해주세요.'); return; }
    try {
      const blob = await api('/purchase-orders/gian-pdf', {
        method: 'POST',
        body: JSON.stringify({ ids, ...gnForm }),
      });
      downloadBlob(blob, `기안서.pdf`);
      closeGianModal();
    } catch {
      showMsg('err', 'PDF 생성 실패');
    }
  };

  const createTotal = orderItems.reduce((s, i) => s + i.ordered_qty * i.unit_price, 0);
  const editTotal = editItems.reduce((s, i) => s + i.ordered_qty * i.unit_price, 0);

  const periodGrouped: PeriodGroupedVendorOrders[] = useMemo(() => {
    if (!sourceTypeTab || sourceTypeTab === 'MANUAL' || groupDetails.length === 0) return [];
    const periodMap = new Map<string, PeriodGroupedVendorOrders>();
    for (const po of groupDetails) {
      const periodLabel = po.schedule_period_label || toMonthLabel(po.schedule_period_start || po.ordered_at);
      const periodStart = po.schedule_period_start || po.ordered_at;
      const periodKey = periodLabel;
      if (!periodMap.has(periodKey)) {
        periodMap.set(periodKey, {
          period_label: periodLabel,
          period_start: periodStart,
          period_matched: Boolean(po.schedule_period_matched),
          has_mixed_period_labels: Boolean(po.has_mixed_period_labels),
          vendors: [],
        });
      }
      const periodGroup = periodMap.get(periodKey)!;
      if (new Date(periodStart).getTime() < new Date(periodGroup.period_start).getTime()) {
        periodGroup.period_start = periodStart;
      }
      periodGroup.period_matched = periodGroup.period_matched || Boolean(po.schedule_period_matched);
      periodGroup.has_mixed_period_labels = periodGroup.has_mixed_period_labels || Boolean(po.has_mixed_period_labels);

      const vendorKey = po.vendor_id || po.vendor_name || 'unknown';
      let group = periodGroup.vendors.find((v) => (v.vendor_id || v.vendor_name || 'unknown') === vendorKey);
      if (!group) {
        group = {
          vendor_id: po.vendor_id,
          vendor_name: po.vendor_name ?? '-',
          orders: [],
          request_nos: [],
          items: [],
        };
        periodGroup.vendors.push(group);
      }
      group.orders.push(po);

      const reqNoSet = new Set(group.request_nos);
      const itemMap = new Map(group.items.map((it) => [it.item_id, it]));

      for (const poItem of po.items ?? []) {
        const current = itemMap.get(poItem.item_id) ?? {
          item_id: poItem.item_id,
          item_name: poItem.item_name ?? poItem.item_code ?? poItem.item_id,
          requested_qty: 0,
          ordered_qty: 0,
          unit_price: Number(poItem.unit_price ?? 0),
          line_amount: 0,
        };
        current.ordered_qty += Number(poItem.ordered_qty ?? 0);
        current.unit_price = Number(poItem.unit_price ?? current.unit_price ?? 0);
        current.line_amount = Number((current.ordered_qty * current.unit_price).toFixed(2));
        itemMap.set(poItem.item_id, current);
      }

      for (const src of po.sources ?? []) {
        if (src.request_no) reqNoSet.add(src.request_no);
        for (const srcItem of src.items ?? []) {
          const current = itemMap.get(srcItem.item_id) ?? {
            item_id: srcItem.item_id,
            item_name: srcItem.item_name ?? srcItem.item_id,
            requested_qty: 0,
            ordered_qty: 0,
            unit_price: 0,
            line_amount: 0,
          };
          current.requested_qty += Number(srcItem.requested_qty ?? 0);
          current.line_amount = Number((current.ordered_qty * current.unit_price).toFixed(2));
          itemMap.set(srcItem.item_id, current);
        }
      }

      group.request_nos = Array.from(reqNoSet);
      group.items = Array.from(itemMap.values()).sort((a, b) => b.line_amount - a.line_amount);
    }
    return Array.from(periodMap.values())
      .map((pg) => ({
        ...pg,
        vendors: [...pg.vendors].sort(
          (a, b) => b.items.reduce((s, i) => s + i.line_amount, 0) - a.items.reduce((s, i) => s + i.line_amount, 0)
        ),
      }))
      .sort((a, b) => new Date(a.period_start).getTime() - new Date(b.period_start).getTime());
  }, [sourceTypeTab, groupDetails]);

  const columns: Column<PurchaseOrder>[] = useMemo(() => [
    {
      key: 'po_no',
      header: '발주번호',
      cardPosition: 'title' as const,
      sortable: true,
      sortValue: (o: PurchaseOrder) => o.po_no,
      render: (o: PurchaseOrder) => <span className="font-medium text-accent-600">{o.po_no}</span>,
    },
    {
      key: 'source_type',
      header: '유형',
      cardPosition: 'badge' as const,
      render: (o: PurchaseOrder) => (
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SOURCE_TYPE_COLOR[o.source_type ?? ''] ?? 'bg-gray-100 text-gray-600'}`}>
          {SOURCE_TYPE_LABEL[o.source_type ?? ''] ?? o.source_type ?? '-'}
        </span>
      ),
    },
    {
      key: 'vendor_name',
      header: '업체',
      cardPosition: 'subtitle' as const,
      sortable: true,
      sortValue: (o: PurchaseOrder) => o.vendor_name ?? '',
      render: (o: PurchaseOrder) => <span className="text-sm">{o.vendor_name}</span>,
    },
    {
      key: 'item_count',
      header: '품목수',
      cardPosition: 'body' as const,
      render: (o: PurchaseOrder) => <>{o.item_count ?? 0}건</>,
    },
    {
      key: 'total_amount',
      header: '발주금액',
      className: 'text-right',
      cardPosition: 'body' as const,
      sortable: true,
      sortValue: (o: PurchaseOrder) => o.total_amount,
      render: (o: PurchaseOrder) => <span className="font-medium">{fmt(o.total_amount)}원</span>,
    },
    {
      key: 'status',
      header: '상태',
      cardPosition: 'body' as const,
      render: (o: PurchaseOrder) => <span className={STATUS_CLS[o.status] || 'badge-gray'}>{STATUS_LABEL[o.status] || o.status}</span>,
    },
    {
      key: 'ordered_at',
      header: '발주일',
      cardPosition: 'body' as const,
      sortable: true,
      sortValue: (o: PurchaseOrder) => new Date(o.ordered_at).getTime(),
      render: (o: PurchaseOrder) => <span className="text-xs text-gray-400">{new Date(o.ordered_at).toLocaleDateString('ko-KR')}</span>,
    },
    {
      key: 'expected_at',
      header: '예상입고일',
      cardPosition: 'hidden' as const,
      render: (o: PurchaseOrder) => <span className="text-xs text-gray-400">{o.expected_at ? new Date(o.expected_at).toLocaleDateString('ko-KR') : '-'}</span>,
    },
    {
      key: 'actions',
      header: '',
      cardPosition: 'hidden' as const,
      render: (o: PurchaseOrder) => (
        <div className="flex gap-2">
          <button onClick={(e) => { e.stopPropagation(); openDetail(o.id); }} className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1">
            <Eye className="w-3.5 h-3.5" /> 보기
          </button>
          {canSend && o.status === 'DRAFT' && (
            <button onClick={(e) => { e.stopPropagation(); sendPO(o.id); }} className="text-xs text-navy-700 hover:underline inline-flex items-center gap-1">
              <Send className="w-3.5 h-3.5" /> 발송
            </button>
          )}
        </div>
      ),
    },
  ], [canSend, inventoryByItem]);

  return (
    <div>
      <PageHeader
        icon={FileText}
        title="발주 관리"
        description="발주서 작성 및 관리"
        actions={
          <div className="flex gap-2">
            <button onClick={() => setShowAnalysis((v) => !v)} className="btn-secondary inline-flex items-center gap-1.5">
              <BarChart3 className="w-4 h-4" />
              {showAnalysis ? '분석 닫기' : '업체별 분석'}
            </button>
            <button onClick={() => docTab === 'gian' ? setGianModal(true) : setGumaeModal(true)} className="btn-secondary inline-flex items-center gap-1.5">
              <Download className="w-4 h-4" />
              {docTab === 'gian' ? '기안서 출력' : '구매결의서 출력'}
            </button>
            {canCreate && (
              <button onClick={() => setCreateModal(true)} className="btn-primary inline-flex items-center gap-1.5">
                <Plus className="w-4 h-4" />
                발주서 생성
              </button>
            )}
          </div>
        }
      />

      <div className="flex gap-1 mb-4">
        {(['gumae', 'gian'] as const).map(t => (
          <button key={t} onClick={() => setDocTab(t)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${docTab === t ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {t === 'gumae' ? '구매결의서' : '기안서'}
          </button>
        ))}
      </div>

      {msg && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {showAnalysis && (
        <div className="card mb-4 py-3">
          <div className="flex flex-wrap gap-2 items-end">
            <div>
              <label className="label">시작일</label>
              <input type="date" className="input w-40" value={sumRange.from} onChange={(e) => setSumRange((prev) => ({ ...prev, from: e.target.value }))} />
            </div>
            <div>
              <label className="label">종료일</label>
              <input type="date" className="input w-40" value={sumRange.to} onChange={(e) => setSumRange((prev) => ({ ...prev, to: e.target.value }))} />
            </div>
            <div className="text-xs text-gray-600 ml-auto">발주합계: <b>{Number(vendorSummary?.totals?.order_total_current ?? 0).toLocaleString()}</b>원</div>
          </div>
        </div>
      )}

      <FilterBar
        filters={[
          {
            key: 'source_type',
            label: '유형 전체',
            options: SOURCE_TYPE_TABS.filter(t => t.v !== '').map(t => ({ value: t.v, label: t.l })),
            value: sourceTypeTab,
            onChange: (v) => { setSourceTypeTab(v); setPoPage(1); },
          },
          {
            key: 'status_scope',
            label: '상태 범위',
            options: STATUS_SCOPE_TABS.map(t => ({ value: t.v, label: t.l })),
            value: statusScope,
            onChange: (v) => { setStatusScope(v as any); setPoPage(1); },
          },
        ]}
        onReset={() => { setSourceTypeTab(''); setStatusScope('ACTIVE'); setPoPage(1); }}
      />
      {(() => {
        const poChips: FilterChip[] = [];
        if (sourceTypeTab) poChips.push({ key: 'source_type', label: '유형', value: SOURCE_TYPE_LABEL[sourceTypeTab] || sourceTypeTab, onRemove: () => { setSourceTypeTab(''); setPoPage(1); } });
        if (statusScope !== 'ACTIVE') poChips.push({ key: 'status_scope', label: '상태', value: STATUS_SCOPE_TABS.find(t => t.v === statusScope)?.l || statusScope, onRemove: () => { setStatusScope('ACTIVE'); setPoPage(1); } });
        return <FilterChips chips={poChips} totalCount={orders.length} onResetAll={() => { setSourceTypeTab(''); setStatusScope('ACTIVE'); setPoPage(1); }} />;
      })()}

      {sourceTypeTab && sourceTypeTab !== 'MANUAL' && (
        <div className="space-y-3 mb-4">
          {groupLoading ? (
            <div className="card p-4 text-sm text-gray-400">업체 그룹 데이터를 불러오는 중...</div>
          ) : periodGrouped.length === 0 ? (
            <div className="card p-4 text-sm text-gray-400">그룹핑할 데이터가 없습니다.</div>
          ) : (
            periodGrouped.map((pg) => (
              <div key={`${pg.period_label}-${pg.period_start}`} className="space-y-2">
                <div className="flex items-center gap-2 px-1">
                  <span className="text-sm font-semibold text-navy-800">{pg.period_label}</span>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full ${pg.period_matched ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                    {pg.period_matched ? '스케줄 매칭' : '기본 월 라벨'}
                  </span>
                  {pg.has_mixed_period_labels && (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">복수 라벨 혼재</span>
                  )}
                </div>
                {pg.vendors.map((g) => (
                  <div key={`${pg.period_label}-${g.vendor_id || g.vendor_name}`} className="card p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <p className="font-semibold text-navy-800">{g.vendor_name}</p>
                        <p className="text-xs text-gray-500">연결 신청: {g.request_nos.length > 0 ? g.request_nos.join(', ') : '-'}</p>
                      </div>
                      <div className="flex gap-2">
                        {g.orders.slice(0, 3).map((o) => (
                          <button key={o.id} onClick={() => openDetail(o.id)} className="text-xs btn-secondary px-2 py-1">{o.po_no}</button>
                        ))}
                      </div>
                    </div>
                    <div className="overflow-x-auto rounded-xl border border-gray-200">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>품목</th>
                            <th className="text-right">신청합계</th>
                            <th className="text-right">창고재고</th>
                            <th className="text-right">발주수량</th>
                            <th className="text-right">단가</th>
                            <th className="text-right">금액</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.items.map((it) => (
                            <tr key={it.item_id}>
                              <td className="text-sm">{it.item_name}</td>
                              <td className="text-right">{fmt(it.requested_qty)}</td>
                              <td className="text-right">{fmt(inventoryByItem[it.item_id] ?? 0)}</td>
                              <td className="text-right">{fmt(it.ordered_qty)}</td>
                              <td className="text-right">{fmt(it.unit_price)}</td>
                              <td className="text-right">{fmt(it.line_amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}

      {loading ? (
        <div className="card p-0 overflow-hidden">
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm">로딩 중...</div>
        </div>
      ) : (
        <>
          <DataTable<PurchaseOrder>
            columns={columns}
            data={orders.slice((poPage - 1) * poPageSize, poPage * poPageSize)}
            keyField="id"
            onRowClick={(o) => openDetail(o.id)}
            emptyMessage="발주 내역이 없습니다."
          />
          <Pagination
            currentPage={poPage}
            totalItems={orders.length}
            pageSize={poPageSize}
            onPageChange={setPoPage}
            onPageSizeChange={setPoPageSize}
          />
        </>
      )}

      {/* 발주서 생성 모달 */}
      <Modal open={createModal} onClose={() => setCreateModal(false)} title="발주서 생성" size="lg">
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div>
            <label className="label">업체 *</label>
            <select value={form.vendor_id} onChange={(e) => setForm((f) => ({ ...f, vendor_id: e.target.value }))} className="input">
              <option value="">선택</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">예상 입고일</label>
            <input type="date" value={form.expected_at} onChange={(e) => setForm((f) => ({ ...f, expected_at: e.target.value }))} className="input" />
          </div>
          <div className="col-span-2">
            <label className="label">비고</label>
            <input type="text" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} className="input" />
          </div>
        </div>

        <div className="section-title mb-2">발주 품목</div>
        <div className="relative mb-3">
          <input type="text" value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} className="input" placeholder="품목 검색 (이름 또는 코드)" />
          {filteredSearch.length > 0 && (
            <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
              {filteredSearch.map((item) => (
                <button key={item.id} onClick={() => addItemToCreate(item)} className="w-full text-left px-4 py-2 hover:bg-gray-50 text-sm border-b border-gray-50 last:border-0">
                  <span className="font-medium">{item.name}</span>
                  <span className="text-gray-400 ml-2 text-xs">{item.item_code} · {item.uom}{item.latest_price ? ` · ${fmt(item.latest_price)}원` : ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {orderItems.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="tbl">
              <thead>
                <tr>
                  <th>품목</th>
                  <th className="text-right">창고재고</th>
                  <th className="text-right">수량</th>
                  <th className="text-right">단가</th>
                  <th className="text-right">금액</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {orderItems.map((o) => (
                  <tr key={o.item_id}>
                    <td>{o.item_name} <span className="text-xs text-gray-400">{o.uom}</span></td>
                    <td className="text-right">{fmt(inventoryByItem[o.item_id] ?? 0)}</td>
                    <td>
                      <input type="text" inputMode="numeric" value={fmt(o.ordered_qty)} onChange={(e) => setOrderItems((prev) => prev.map((i) => i.item_id === o.item_id ? { ...i, ordered_qty: Math.max(1, parseNumericInput(e.target.value)) } : i))} className="input w-20 text-right" />
                    </td>
                    <td>
                      <input type="text" inputMode="numeric" value={fmt(o.unit_price)} onChange={(e) => setOrderItems((prev) => prev.map((i) => i.item_id === o.item_id ? { ...i, unit_price: Math.max(0, parseNumericInput(e.target.value)) } : i))} className="input w-28 text-right" />
                    </td>
                    <td className="text-right font-medium">{fmt(o.ordered_qty * o.unit_price)}</td>
                    <td>
                      <button onClick={() => setOrderItems((prev) => prev.filter((i) => i.item_id !== o.item_id))} className="text-red-400 text-xs hover:text-red-600 inline-flex items-center gap-1">
                        <Trash2 className="w-3.5 h-3.5" /> 삭제
                      </button>
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold bg-gray-50">
                  <td colSpan={4} className="text-right">합계</td>
                  <td className="text-right">{fmt(createTotal)}원</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={() => setCreateModal(false)} className="btn-secondary">취소</button>
          <button onClick={createPO} disabled={submitting} className="btn-primary">{submitting ? '저장 중...' : '저장'}</button>
        </div>
      </Modal>

      {/* 발주서 상세 모달 */}
      <Modal
        open={!!detail}
        onClose={() => { setDetail(null); setEditMode(false); }}
        title={detail ? detail.po_no : ''}
        size="lg"
        footer={
          detail ? (
            <>
              {canCreate && detail.status === 'DRAFT' && (
                <button onClick={() => deletePO(detail.id)} className="btn-danger mr-auto text-sm inline-flex items-center gap-1">
                  <Trash2 className="w-3.5 h-3.5" /> 삭제
                </button>
              )}
              {canSend && detail.status === 'DRAFT' && (
                <button onClick={() => sendPO(detail.id)} className="btn-navy inline-flex items-center gap-1">
                  <Send className="w-4 h-4" /> 발주 확정
                </button>
              )}
              <button onClick={() => downloadGumae([detail.id])} className="btn-secondary inline-flex items-center gap-1">
                <Download className="w-4 h-4" /> 구매결의서
              </button>
              <button onClick={() => downloadPdf(detail.id, detail.po_no)} className="btn-secondary inline-flex items-center gap-1">
                <Download className="w-4 h-4" /> 발주서 PDF
              </button>
              <button onClick={() => { setDetail(null); setEditMode(false); }} className="btn-secondary">닫기</button>
            </>
          ) : undefined
        }
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className={STATUS_CLS[detail.status] || 'badge-gray'}>{STATUS_LABEL[detail.status] || detail.status}</span>
              {detail.source_type && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SOURCE_TYPE_COLOR[detail.source_type] ?? 'bg-gray-100 text-gray-600'}`}>
                  {SOURCE_TYPE_LABEL[detail.source_type] ?? detail.source_type}
                </span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-4 text-sm">
              <div><span className="label">업체</span><p>{detail.vendor_name}</p></div>
              <div><span className="label">발주일</span><p>{new Date(detail.ordered_at).toLocaleDateString('ko-KR')}</p></div>
              <div><span className="label">예상입고일</span><p>{detail.expected_at ? new Date(detail.expected_at).toLocaleDateString('ko-KR') : '-'}</p></div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="section-title m-0">발주 품목</div>
                {canCreate && detail.status === 'DRAFT' && !editMode && <button onClick={() => setEditMode(true)} className="text-xs btn-secondary px-3 py-1">수정</button>}
                {editMode && (
                  <div className="flex gap-2">
                    <button onClick={() => { setEditMode(false); setDetailSearch(''); setDetailFiltered([]); }} className="text-xs btn-secondary px-3 py-1">취소</button>
                    <button onClick={saveEdit} disabled={saving} className="text-xs btn-primary px-3 py-1">{saving ? '저장 중...' : '저장'}</button>
                  </div>
                )}
              </div>

              {editMode && (
                <div className="relative mb-2">
                  <input type="text" value={detailSearch} onChange={(e) => setDetailSearch(e.target.value)} className="input text-sm" placeholder="품목 추가 검색..." />
                  {detailFiltered.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-40 overflow-y-auto">
                      {detailFiltered.map((item) => (
                        <button key={item.id} onClick={() => addItemToEdit(item)} className="w-full text-left px-4 py-2 hover:bg-gray-50 text-sm border-b border-gray-50 last:border-0">
                          <span className="font-medium">{item.name}</span>
                          <span className="text-gray-400 ml-2 text-xs">{item.item_code} · {item.uom}{item.latest_price ? ` · ${fmt(item.latest_price)}원` : ''}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>품목</th>
                      <th className="text-right">창고재고</th>
                      <th className="text-right">수량</th>
                      <th className="text-right">단가</th>
                      <th className="text-right">금액</th>
                      {editMode && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(editMode ? editItems : detail.items ?? []).map((item: any) => (
                      <tr key={item.item_id}>
                        <td>
                          <div className="font-medium text-sm">{item.item_name}</div>
                          <div className="text-xs text-gray-400">{item.item_code} · {item.uom}</div>
                        </td>
                        <td className="text-right text-sm text-gray-600">{fmt(inventoryByItem[item.item_id] ?? 0)}</td>
                        {editMode ? (
                          <>
                            <td>
                              <input type="text" inputMode="numeric" value={fmt(item.ordered_qty)} onChange={(e) => setEditItems((prev) => prev.map((i) => i.item_id === item.item_id ? { ...i, ordered_qty: Math.max(0, parseNumericInput(e.target.value)) } : i))} className="input w-20 text-right text-sm" />
                            </td>
                            <td>
                              <input type="text" inputMode="numeric" value={fmt(item.unit_price)} onChange={(e) => setEditItems((prev) => prev.map((i) => i.item_id === item.item_id ? { ...i, unit_price: Math.max(0, parseNumericInput(e.target.value)) } : i))} className="input w-28 text-right text-sm" />
                            </td>
                            <td className="text-right font-medium text-sm">{fmt(item.ordered_qty * item.unit_price)}</td>
                            <td>
                              <button onClick={() => setEditItems((prev) => prev.filter((i) => i.item_id !== item.item_id))} className="text-red-400 text-xs hover:text-red-600 inline-flex items-center gap-1">
                                <Trash2 className="w-3.5 h-3.5" /> 삭제
                              </button>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="text-right">{fmt(item.ordered_qty)}</td>
                            <td className="text-right">{fmt(item.unit_price)}</td>
                            <td className="text-right font-medium">{fmt(item.line_amount ?? item.ordered_qty * item.unit_price)}</td>
                          </>
                        )}
                      </tr>
                    ))}
                    <tr className="font-semibold bg-gray-50">
                      <td colSpan={3} className="text-right">합계</td>
                      <td></td>
                      <td className="text-right">{editMode ? fmt(editTotal) : fmt(detail.total_amount)}원</td>
                      {editMode && <td></td>}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {detail.sources && detail.sources.length > 0 && (
              <div>
                <button onClick={() => setShowSources((v) => !v)} className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">
                  {showSources ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  <span>부서별 신청내역 ({detail.sources.length}건)</span>
                </button>
                {showSources && (
                  <div className="mt-2 border border-gray-200 rounded-xl overflow-hidden">
                    {detail.sources.map((src, i) => (
                      <div key={src.ward_request_id} className={`p-3 ${i > 0 ? 'border-t border-gray-100' : ''}`}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="font-medium text-sm text-gray-800">{src.department_name}</span>
                          {src.request_no && <span className="text-xs text-gray-400">{src.request_no}</span>}
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          {src.items.map((it) => (
                            <span key={it.item_id} className="text-xs text-gray-600">{it.item_name}: <strong>{fmt(it.requested_qty)}</strong></span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      {gumaeModal && <GumaeModal
        orders={orders}
        selectedIds={gmSelectedIds}
        onToggle={(id) => setGmSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
        onToggleAll={(ids) => setGmSelectedIds(prev => ids.every(id => prev.has(id)) ? new Set() : new Set(ids))}
        onClose={closeGumaeModal}
        onDownload={() => downloadGumae(Array.from(gmSelectedIds))}
        from={gmFrom} to={gmTo} label={gmLabel}
        onFromChange={setGmFrom} onToChange={setGmTo} onLabelChange={setGmLabel}
        comparePeriods={gmCompare} onCompareChange={setGmCompare}
      />}
      {gianModal && <GianModal
        orders={orders}
        selectedIds={gnSelectedIds}
        onToggle={(id) => setGnSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
        onToggleAll={(ids) => setGnSelectedIds(prev => ids.every(id => prev.has(id)) ? new Set() : new Set(ids))}
        onClose={closeGianModal}
        onDownload={() => downloadGian(Array.from(gnSelectedIds))}
        form={gnForm}
        onFormChange={(partial) => setGnForm(prev => ({ ...prev, ...partial }))}
      />}
    </div>
  );
}
