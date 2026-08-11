
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, downloadBlob } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { PageHeader, FilterBar, DataTable, Modal, EmptyState, FilterChips, Pagination, DateRangeFilter, inDateRange } from '../components/ui';
import type { Column, FilterChip, DateRange } from '../components/ui';
import type { Item, Vendor } from '@shared/types';
import { MID_CATEGORIES, setUserMidCategories } from '@shared/types';
import { FileText, Send, Trash2, Eye, Download, Plus, ChevronDown, ChevronRight, BarChart3, PackagePlus } from 'lucide-react';
import { PurchaseOrderHierarchyList } from './components/PurchaseOrderHierarchyList';
// PendingQueuePanel 은 결의서 화면으로 작업이 일원화되어 발주 페이지에서 제거됨.
// 발주서는 결의서를 불러와 변환하는 방식으로 생성한다.

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
  { v: 'CONSUMABLE_MEDICAL', l: '의료소모품' },
  { v: 'CONSUMABLE_REGULAR', l: '일반소모품' },
  { v: 'CONSUMABLE_OFFICE', l: '사무용품' },
  { v: 'DIAPER', l: '기저귀' },
  { v: 'NIGHT_SNACK', l: '야간간식' },
  { v: 'ADHOC', l: '비정기' },
  { v: 'EQUIPMENT', l: '비품' },
  { v: 'MANUAL', l: '수동' },
] as const;

const SOURCE_TYPE_LABEL: Record<string, string> = {
  CONSUMABLE_MEDICAL: '의료소모품',
  CONSUMABLE_REGULAR: '일반소모품',
  CONSUMABLE_OFFICE: '사무용품',
  DIAPER: '기저귀',
  NIGHT_SNACK: '야간간식',
  ADHOC: '비정기',
  EQUIPMENT: '비품',
  MANUAL: '수동',
};

const SOURCE_TYPE_COLOR: Record<string, string> = {
  CONSUMABLE_MEDICAL: 'bg-rose-100 text-rose-700',
  CONSUMABLE_REGULAR: 'bg-blue-100 text-blue-700',
  CONSUMABLE_OFFICE: 'bg-indigo-100 text-indigo-700',
  DIAPER: 'bg-purple-100 text-purple-700',
  NIGHT_SNACK: 'bg-cyan-100 text-cyan-700',
  ADHOC: 'bg-orange-100 text-orange-700',
  EQUIPMENT: 'bg-amber-100 text-amber-700',
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
  const [dateRange, setDateRange] = useState<DateRange>({ from: '', to: '' });
  const [statusView, setStatusView] = useState<'active' | 'cancelled' | 'all'>('active');
  const filteredOrders = useMemo(
    () => orders.filter(o => {
      if (!inDateRange((o as any).ordered_at, dateRange)) return false;
      const isCancelled = o.status === 'CANCELLED' || (o as any).deleted_at;
      if (statusView === 'active') return !isCancelled;
      if (statusView === 'cancelled') return isCancelled;
      return true; // all
    }),
    [orders, dateRange, statusView],
  );
  // 토글 카운트 (필터 없는 raw 기준) — 사용자에게 어느 쪽에 얼마나 있는지 보여주기
  const statusCounts = useMemo(() => {
    let active = 0, cancelled = 0;
    for (const o of orders) {
      if (!inDateRange((o as any).ordered_at, dateRange)) continue;
      if (o.status === 'CANCELLED' || (o as any).deleted_at) cancelled++;
      else active++;
    }
    return { active, cancelled, all: active + cancelled };
  }, [orders, dateRange]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceTypeTab, setSourceTypeTab] = useState('');
  // 서버 호출용 — 클라 필터로 statusView 가 책임지므로 무제한으로 두고 클라에서 분기
  const [statusScope, setStatusScope] = useState<'ACTIVE' | 'DRAFT' | 'COMPLETED' | 'ALL'>('ALL');
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

  // 결의서 → 발주서 변환 picker
  const [decisionPickerOpen, setDecisionPickerOpen] = useState(false);
  const [draftDecisions, setDraftDecisions] = useState<any[]>([]);
  const [decisionPickerLoading, setDecisionPickerLoading] = useState(false);
  const [decisionConverting, setDecisionConverting] = useState<string | null>(null);

  const loadDraftDecisions = async () => {
    setDecisionPickerLoading(true);
    try {
      const list: any[] = await api('/purchase-decisions');
      // DRAFT 만 필터 — LOCKED 는 이미 발주에 사용됨
      setDraftDecisions(list.filter(d => d.status === 'DRAFT'));
    } catch (e: any) {
      setMsg({ type: 'err', text: e?.message ?? '결의서 목록 조회 실패' });
    } finally {
      setDecisionPickerLoading(false);
    }
  };

  // 결의서의 품목을 발주서 작성 form 에 로드.
  // 자동 변환이 아니라 사용자가 form 에서 검토·편집 후 저장 — 자유입력 라인도 form 에 보이게 로드해서
  // 사용자가 직접 처리(삭제 / 등록 품목으로 교체) 할 수 있도록.
  const [loadedFromDecisionNo, setLoadedFromDecisionNo] = useState<string | null>(null);
  const [loadedFromDecisionId, setLoadedFromDecisionId] = useState<string | null>(null);
  const [freeInputLines, setFreeInputLines] = useState<{ name: string; spec: string; qty: number; unit_price: number; comment?: string }[]>([]);

  // 자유입력 라인을 마스터에 등록하면서 발주서에 추가하는 폼 상태
  const [registerFreeIdx, setRegisterFreeIdx] = useState<number | null>(null);
  const [registerForm, setRegisterForm] = useState({ item_code: '', name: '', uom: 'EA', pack_size: 1, mid_category: '' });
  const [registerSubmitting, setRegisterSubmitting] = useState(false);
  // 사용자 추가 중분류 — 자유입력 마스터 등록의 분류 선택지에 합쳐 표시
  const [userMids, setUserMids] = useState<{ code: string; name: string; major_label: string }[]>([]);
  useEffect(() => {
    api('/item-categories')
      .then((rows: any[]) => {
        const list = (Array.isArray(rows) ? rows : [])
          .filter(r => r.is_active !== false && r.is_active !== 0)
          .map(r => ({ code: String(r.code), name: String(r.name), major_label: String(r.major_label || '') }));
        setUserMids(list);
        setUserMidCategories(list.map(x => ({ code: x.code, name: x.name })));
      })
      .catch(() => {});
  }, []);

  const openRegisterFreeModal = (idx: number) => {
    const f = freeInputLines[idx];
    if (!f) return;
    setRegisterForm({
      item_code: '',
      name: f.name ?? '',
      uom: (f.spec && f.spec.trim()) || 'EA',
      pack_size: 1,
      mid_category: '',
    });
    setRegisterFreeIdx(idx);
  };

  const submitRegisterFree = async () => {
    if (registerFreeIdx === null) return;
    const code = registerForm.item_code.trim();
    const name = registerForm.name.trim();
    if (!name) {
      showMsg('err', '품명은 필수입니다.');
      return;
    }
    const mid = MID_CATEGORIES.find(m => m.value === registerForm.mid_category);
    const userMid = userMids.find(u => u.code === registerForm.mid_category);
    if (!mid && !userMid) {
      showMsg('err', '카테고리를 선택해주세요.');
      return;
    }
    // 기본 중분류는 첫 소분류 코드를, 사용자 추가 중분류는 그 코드 자체를 category 로 사용
    const subCategory = mid ? mid.subs[0] : userMid!.code;
    const free = freeInputLines[registerFreeIdx];
    if (!free) return;
    setRegisterSubmitting(true);
    try {
      const uom = (registerForm.uom || 'EA').trim() || 'EA';
      const newItem: Item = await api('/items', {
        method: 'POST',
        body: JSON.stringify({
          // 비우면 서버가 분류 접두어로 자동 채번 (예: GEN-0001)
          ...(code ? { item_code: code } : {}),
          name,
          category: subCategory,
          uom,
          purchase_uom: uom,
          issue_uom: uom,
          pack_size: Math.max(1, Number(registerForm.pack_size) || 1),
        }),
      });
      setItems(prev => [...prev, newItem]);
      setOrderItems(prev => prev.some(o => o.item_id === newItem.id) ? prev : [
        ...prev,
        {
          item_id: newItem.id,
          item_name: newItem.name,
          uom: newItem.purchase_uom ?? newItem.uom,
          ordered_qty: Math.max(1, Number(free.qty) || 1),
          unit_price: Math.max(0, Number(free.unit_price) || 0),
        },
      ]);
      setFreeInputLines(prev => prev.filter((_, j) => j !== registerFreeIdx));
      setRegisterFreeIdx(null);
      showMsg('ok', `${newItem.name} 마스터 등록 후 발주서에 추가했습니다.`);
    } catch (e: any) {
      showMsg('err', e?.message ?? '등록에 실패했습니다.');
    } finally {
      setRegisterSubmitting(false);
    }
  };

  const loadDecisionIntoForm = (d: any) => {
    // 거래처 + 비고 채움
    setForm({
      vendor_id: d.vendor_id ?? '',
      expected_at: '',
      note: d.comment ?? '',
    });

    // 품목: item_id 가 있는 것만 form 에 — items 마스터에서 매칭해서 loadable 한 형태로 변환
    const itemsWithId: EditItem[] = [];
    const free: typeof freeInputLines = [];
    for (const it of (d.items ?? [])) {
      if (it.item_id) {
        const masterItem = items.find(m => m.id === it.item_id);
        itemsWithId.push({
          item_id: it.item_id,
          item_name: it.name ?? masterItem?.name ?? '',
          uom: it.unit ?? masterItem?.purchase_uom ?? masterItem?.uom ?? '',
          ordered_qty: Number(it.qty ?? 0),
          unit_price: Number(it.unit_price ?? 0),
        } as EditItem);
      } else {
        free.push({
          name: it.name ?? '',
          spec: it.spec ?? '',
          qty: Number(it.qty ?? 0),
          unit_price: Number(it.unit_price ?? 0),
          comment: it.comment ?? '',
        });
      }
    }
    setOrderItems(itemsWithId);
    setFreeInputLines(free);
    setLoadedFromDecisionNo(d.decision_no);
    setLoadedFromDecisionId(d.id);

    setDecisionPickerOpen(false);
    setCreateModal(true);
  };

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
        uom: item.purchase_uom ?? item.uom,
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
      const body: any = {
        vendor_id: form.vendor_id,
        expected_at: form.expected_at || null,
        note: form.note,
        items: orderItems.map((o) => ({ item_id: o.item_id, ordered_qty: o.ordered_qty, unit_price: o.unit_price })),
      };
      // 결의서에서 로드된 경우 — 서버가 PO 생성 후 결의서를 LOCKED 로 잠금
      if (loadedFromDecisionId) body.from_decision_id = loadedFromDecisionId;
      await api('/purchase-orders', { method: 'POST', body: JSON.stringify(body) });
      showMsg('ok', loadedFromDecisionId
        ? `발주서가 생성되고 결의서 ${loadedFromDecisionNo} 가 발주됨으로 잠겼습니다.`
        : '발주서를 생성했습니다.');
      setCreateModal(false);
      setOrderItems([]);
      setForm({ vendor_id: '', expected_at: '', note: '' });
      setLoadedFromDecisionNo(null);
      setLoadedFromDecisionId(null);
      setFreeInputLines([]);
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
        uom: item.purchase_uom ?? item.uom,
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

  // 발주서 「되돌리기」 — CANCELLED 상태로 변경 + 묶인 구매결의서 자동 DRAFT 복원.
  // DRAFT 는 협의 없이 자유롭게, SENT 는 거래처와 협의 후. PARTIAL_RECEIVED/CLOSED 는 서버가 차단.
  const revertPO = async (po: { id: string; po_no: string; status: string }) => {
    const warnSent = po.status === 'SENT'
      ? '\n\n⚠ 이미 거래처로 발송된 발주서입니다. 거래처에 별도로 취소 통보를 해주세요.'
      : '';
    const reason = window.prompt(
      `발주서 ${po.po_no} 를 「되돌리기」 합니다:\n` +
      ` · 이 발주서는 「취소됨(CANCELLED)」 상태로 변경 (목록엔 남음)\n` +
      ` · 묶여 있던 구매결의서가 있으면 임시저장(DRAFT) 으로 복원되어 다시 편집 가능${warnSent}\n\n` +
      `사유를 5자 이상 입력해주세요:`,
      '',
    );
    if (reason === null) return;
    const trimmed = reason.trim();
    if (trimmed.length < 5) { showMsg('err', '사유는 5자 이상 입력해주세요.'); return; }
    try {
      await api(`/purchase-orders/${po.id}/revert`, {
        method: 'POST',
        body: JSON.stringify({ reason: trimmed }),
      });
      showMsg('ok', `${po.po_no} 되돌리기 완료 (취소됨). 연결된 결의서가 있으면 편집 가능합니다.`);
      setDetail(null);
      load();
    } catch (e: any) {
      showMsg('err', e?.message ?? '되돌리기 실패');
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
        description="발주서 작성 · 결의서/기안서 출력"
        actions={
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setGumaeModal(true)} className="btn-secondary inline-flex items-center gap-1.5" title="선택한 발주서들로 구매결의서 양식 PDF 출력">
              <Download className="w-4 h-4" /> 구매결의서
            </button>
            <button onClick={() => setGianModal(true)} className="btn-secondary inline-flex items-center gap-1.5" title="선택한 발주서들로 기안서 양식 PDF 출력">
              <Download className="w-4 h-4" /> 기안서
            </button>
            {canCreate && (
              <button onClick={() => { setDecisionPickerOpen(true); loadDraftDecisions(); }} className="btn-secondary inline-flex items-center gap-1.5" title="구매결의서를 불러와 발주서를 만듭니다">
                <FileText className="w-4 h-4" /> 결의서 불러오기
              </button>
            )}
            {canCreate && (
              <button onClick={() => setCreateModal(true)} className="btn-primary inline-flex items-center gap-1.5">
                <Plus className="w-4 h-4" /> 발주서 생성
              </button>
            )}
          </div>
        }
      />

      {msg && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      <div className="mb-3">
        <DateRangeFilter value={dateRange} onChange={setDateRange} label="발주일" />
      </div>

      <div className="flex items-center gap-1 mb-3">
        {([
          ['active',    '완료'],
          ['cancelled', '취소'],
          ['all',       '전체'],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => { setStatusView(k); setPoPage(1); }}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
              statusView === k ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card p-0 overflow-hidden">
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm">로딩 중...</div>
        </div>
      ) : filteredOrders.length === 0 ? (
        <div className="card p-0"><EmptyState message={orders.length === 0 ? '발주 내역이 없습니다.' : '선택한 기간에 해당하는 발주서가 없습니다.'} /></div>
      ) : (
        <>
          <PurchaseOrderHierarchyList
            orders={filteredOrders as any}
            openDetail={openDetail}
            sendPO={sendPO}
            canSend={canSend}
            fmt={fmt}
            onPeriodChanged={load}
          />
          <Pagination
            currentPage={poPage}
            totalItems={filteredOrders.length}
            pageSize={poPageSize}
            onPageChange={setPoPage}
            onPageSizeChange={setPoPageSize}
          />
        </>
      )}

      {/* 발주서 생성 모달 */}
      <Modal open={createModal} onClose={() => { setCreateModal(false); setLoadedFromDecisionNo(null); setLoadedFromDecisionId(null); setFreeInputLines([]); }} title="발주서 생성" size="lg">
        {loadedFromDecisionNo && (
          <div className="mb-3 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-700">
            결의서 <strong>{loadedFromDecisionNo}</strong> 에서 품목 로드됨. 검토 후 저장하면 발주서가 생성됩니다.
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 mb-3">
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

        {/* 결의서에서 품목 불러오기 진입점 */}
        <div className="mb-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => { setDecisionPickerOpen(true); loadDraftDecisions(); }}
            className="text-xs px-3 py-1.5 rounded border border-teal-300 text-teal-700 hover:bg-teal-50 inline-flex items-center gap-1"
          >
            <FileText className="w-3.5 h-3.5" /> 결의서에서 품목 불러오기
          </button>
          <span className="text-xs text-slate-400">선택한 결의서의 거래처·품목을 form 에 채웁니다.</span>
        </div>

        <div className="section-title mb-2">발주 품목</div>
        <div className="relative mb-3">
          <input type="text" value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} className="input" placeholder="품목 검색 (이름 또는 코드)" />
          {filteredSearch.length > 0 && (
            <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
              {filteredSearch.map((item) => (
                <button key={item.id} onClick={() => addItemToCreate(item)} className="w-full text-left px-4 py-2 hover:bg-gray-50 text-sm border-b border-gray-50 last:border-0">
                  <span className="font-medium">{item.name}</span>
                  <span className="text-gray-400 ml-2 text-xs">{item.item_code} · {item.purchase_uom ?? item.uom}{item.latest_price ? ` · ${fmt(item.latest_price)}원` : ''}</span>
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

        {/* 자유입력 라인 — 결의서에 있던 마스터 미등록 품목. 발주서엔 못 들어가므로 사용자가 직접 처리 안내 */}
        {freeInputLines.length > 0 && (
          <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded">
            <div className="flex items-start gap-2 mb-2">
              <span className="text-amber-700 text-sm font-medium">⚠ 자유입력 항목 {freeInputLines.length}건 — 발주서에 자동으로 들어가지 않음</span>
            </div>
            <p className="text-xs text-amber-700 mb-2">
              아래 품목들은 마스터에 등록되지 않아 발주서 라인으로 저장 불가. 처리 방법:
              ① 행 옆 <PackagePlus className="inline w-3 h-3 -mt-0.5" /> 클릭 → 마스터 등록 후 자동으로 발주서에 추가
              ② 결의서 인쇄/엑셀로 거래처에 별도 전달
            </p>
            <div className="overflow-x-auto rounded bg-white border border-amber-200">
              <table className="text-xs w-full">
                <thead className="bg-amber-100">
                  <tr>
                    <th className="px-2 py-1 text-left">품명</th>
                    <th className="px-2 py-1 text-left">규격</th>
                    <th className="px-2 py-1 text-right">수량</th>
                    <th className="px-2 py-1 text-right">단가</th>
                    <th className="px-2 py-1 text-right">금액</th>
                    <th className="px-2 py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {freeInputLines.map((f, i) => (
                    <tr key={i} className="border-t border-amber-100">
                      <td className="px-2 py-1">{f.name}</td>
                      <td className="px-2 py-1 text-slate-500">{f.spec}</td>
                      <td className="px-2 py-1 text-right">{fmt(f.qty)}</td>
                      <td className="px-2 py-1 text-right">{fmt(f.unit_price)}</td>
                      <td className="px-2 py-1 text-right font-medium">{fmt(Math.round(f.qty * f.unit_price))}</td>
                      <td className="px-2 py-1">
                        <div className="inline-flex items-center gap-2">
                          <button
                            onClick={() => openRegisterFreeModal(i)}
                            className="text-blue-600 hover:text-blue-800"
                            title="품목 마스터에 등록하고 발주서에 추가"
                          >
                            <PackagePlus className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setFreeInputLines(prev => prev.filter((_, j) => j !== i))}
                            className="text-amber-600 hover:text-amber-800"
                            title="이 라인 무시 (목록에서 제거)"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-amber-50 font-semibold">
                    <td colSpan={4} className="px-2 py-1 text-right">자유입력 합계</td>
                    <td className="px-2 py-1 text-right text-amber-700">
                      {fmt(Math.round(freeInputLines.reduce((s, f) => s + f.qty * f.unit_price, 0)))}원
                    </td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={() => { setCreateModal(false); setLoadedFromDecisionNo(null); setLoadedFromDecisionId(null); setFreeInputLines([]); }} className="btn-secondary">취소</button>
          <button onClick={createPO} disabled={submitting} className="btn-primary">{submitting ? '저장 중...' : '저장'}</button>
        </div>
      </Modal>

      {/* 자유입력 → 마스터 등록 + 발주서 추가 모달 */}
      <Modal
        open={registerFreeIdx !== null}
        onClose={() => { if (!registerSubmitting) setRegisterFreeIdx(null); }}
        title="자유입력 항목 마스터 등록"
      >
        <p className="text-xs text-slate-500 mb-3">
          품목 마스터에 등록한 뒤 현재 작성 중인 발주서에 자동으로 추가합니다. 코드와 카테고리는 나중에 품목관리에서 수정 가능합니다.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">품목코드</label>
            <input
              type="text"
              value={registerForm.item_code}
              onChange={e => setRegisterForm(f => ({ ...f, item_code: e.target.value }))}
              className="input"
              placeholder="비우면 분류별 자동 생성 (MED/GEN/OFF/EQP-####)"
              autoFocus
            />
          </div>
          <div>
            <label className="label">카테고리 *</label>
            <select
              value={registerForm.mid_category}
              onChange={e => setRegisterForm(f => ({ ...f, mid_category: e.target.value }))}
              className="input"
            >
              <option value="">선택...</option>
              {MID_CATEGORIES.map(mid => (
                <option key={mid.value} value={mid.value}>{mid.label}</option>
              ))}
              {userMids.length > 0 && (
                <optgroup label="사용자 추가 분류">
                  {userMids.map(u => (
                    <option key={u.code} value={u.code}>{u.major_label ? `${u.major_label} › ${u.name}` : u.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <div className="col-span-2">
            <label className="label">품명 *</label>
            <input
              type="text"
              value={registerForm.name}
              onChange={e => setRegisterForm(f => ({ ...f, name: e.target.value }))}
              className="input"
            />
          </div>
          <div>
            <label className="label">단위(uom)</label>
            <input
              type="text"
              value={registerForm.uom}
              onChange={e => setRegisterForm(f => ({ ...f, uom: e.target.value }))}
              className="input"
              placeholder="EA"
            />
          </div>
          <div>
            <label className="label">포장변환비율</label>
            <input
              type="number"
              min={1}
              value={registerForm.pack_size}
              onChange={e => setRegisterForm(f => ({ ...f, pack_size: Math.max(1, Number(e.target.value) || 1) }))}
              className="input"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={() => setRegisterFreeIdx(null)} disabled={registerSubmitting} className="btn-secondary">취소</button>
          <button onClick={submitRegisterFree} disabled={registerSubmitting} className="btn-primary">
            {registerSubmitting ? '등록 중...' : '등록 후 발주서에 추가'}
          </button>
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
              {canCreate && (detail.status === 'DRAFT' || detail.status === 'SENT') && (
                <button
                  onClick={() => revertPO({ id: detail.id, po_no: detail.po_no, status: detail.status })}
                  className="text-sm text-orange-600 hover:bg-orange-50 px-3 py-1 rounded inline-flex items-center gap-1 border border-orange-200"
                  title="이 발주서를 취소하고 연결된 결의서를 다시 편집 가능하게 되돌리기"
                >
                  되돌리기
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
                {canCreate && (detail.status === 'DRAFT' || detail.status === 'SENT') && !editMode && <button onClick={() => setEditMode(true)} className="text-xs btn-secondary px-3 py-1">수정</button>}
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
                          <span className="text-gray-400 ml-2 text-xs">{item.item_code} · {item.purchase_uom ?? item.uom}{item.latest_price ? ` · ${fmt(item.latest_price)}원` : ''}</span>
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
                          <div className="text-xs text-gray-400">{item.item_code} · {item.purchase_uom ?? item.uom}</div>
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

      {/* 결의서 → 발주서 변환 picker */}
      <Modal
        open={decisionPickerOpen}
        onClose={() => setDecisionPickerOpen(false)}
        title="결의서 품목 불러오기"
        size="lg"
        footer={<button onClick={() => setDecisionPickerOpen(false)} className="btn-secondary">닫기</button>}
      >
        {decisionPickerLoading ? (
          <div className="py-8 text-center text-sm text-slate-400">불러오는 중...</div>
        ) : draftDecisions.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">
            DRAFT 상태 결의서가 없습니다.
            <div className="text-xs mt-1">구매결의서 메뉴에서 새로 작성하거나, 기존 결의서를 편집하세요.</div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-slate-500 mb-2">결의서를 선택하면 발주서 작성 form 에 거래처와 품목이 채워집니다. 검토·편집 후 저장하세요.</p>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-left">결의서</th>
                    <th className="px-3 py-2 text-left">거래처</th>
                    <th className="px-3 py-2 text-center">회차</th>
                    <th className="px-3 py-2 text-right">품목수</th>
                    <th className="px-3 py-2 text-right">합계</th>
                    <th className="px-3 py-2 text-center">작성</th>
                    <th className="px-3 py-2 w-28"></th>
                  </tr>
                </thead>
                <tbody>
                  {draftDecisions.map((d: any) => {
                    const total = (d.items ?? []).reduce(
                      (s: number, it: any) => s + Number(it.qty ?? 0) * Number(it.unit_price ?? 0), 0,
                    );
                    const freeCount = (d.items ?? []).filter((it: any) => !it.item_id).length;
                    return (
                      <tr key={d.id} className="border-t border-slate-100 hover:bg-slate-50/40">
                        <td className="px-3 py-2 font-mono text-xs">{d.decision_no}</td>
                        <td className="px-3 py-2">{d.vendor_name}</td>
                        <td className="px-3 py-2 text-center text-xs">{d.period_label || '-'}</td>
                        <td className="px-3 py-2 text-right">
                          {(d.items ?? []).length}
                          {freeCount > 0 && (
                            <span className="text-[10px] text-amber-600 ml-1" title="자유입력(마스터 미등록) 라인">
                              ({freeCount} 자유)
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-blue-700">
                          ₩{Math.round(total).toLocaleString('ko-KR')}
                        </td>
                        <td className="px-3 py-2 text-center text-xs text-slate-500">
                          {d.created_at ? new Date(d.created_at).toLocaleDateString('ko-KR') : '-'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => loadDecisionIntoForm(d)}
                            disabled={(d.items ?? []).length === 0}
                            className="text-xs px-2 py-1 rounded bg-teal-500 text-white hover:bg-teal-600 disabled:opacity-40"
                          >
                            품목 불러오기
                          </button>
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

