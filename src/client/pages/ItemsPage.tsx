import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Package, Pencil, ToggleLeft, ToggleRight } from 'lucide-react';
import { api, downloadBlob } from '../utils/api';
import type { Item, Vendor, HiraItemResult } from '@shared/types';
import {
  CONSUMABLE_CATEGORIES,
  EQUIPMENT_CATEGORIES,
  ITEM_EXPENSE_SCOPES,
  ITEM_STATS_BUCKETS,
  getCategoryLabel,
} from '@shared/types';
import { PageHeader, FilterBar, DataTable, Modal, EmptyState, FormField } from '../components/ui';
import type { Column } from '../components/ui';

const STATS_BUCKET_LABEL = Object.fromEntries(ITEM_STATS_BUCKETS.map(x => [x.value, x.label]));
const EXPENSE_SCOPE_LABEL = Object.fromEntries(ITEM_EXPENSE_SCOPES.map(x => [x.value, x.label]));
const CAT_GROUPS = [
  { group: '소모품', items: CONSUMABLE_CATEGORIES },
  { group: '비품', items: EQUIPMENT_CATEGORIES },
] as const;

const inferStatsBucket = (category: string, name?: string) => {
  const cat = String(category || '').toUpperCase();
  const text = String(name ?? '').toLowerCase();
  if (cat === 'GENERAL_SERVICE') return 'FOOD';
  if (cat === 'OFFICE_SUPPLY' || cat === 'OFFICE_SEMI') return 'OFFICE';
  if (/기저귀|diaper/i.test(text)) return 'DIAPER_CARE';
  if (cat.startsWith('GENERAL_')) return 'GENERAL';
  if (cat.startsWith('MEDICAL_')) return 'MEDICAL';
  return 'MEDICAL';
};

const inferExpenseScope = (statsBucket: string) => {
  if (statsBucket === 'OFFICE' || statsBucket === 'FOOD') return 'OPS_INDIRECT';
  return 'PATIENT_DIRECT';
};

export default function ItemsPage() {
  const [activeTab, setActiveTab] = useState<'items' | 'permissions'>('items');
  const [items, setItems] = useState<Item[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [statsBucketFilter, setStatsBucketFilter] = useState('');
  const [expenseScopeFilter, setExpenseScopeFilter] = useState('');

  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Item | null>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const [editingImageUrl, setEditingImageUrl] = useState<string | null>(null);
  const [form, setForm] = useState({
    item_code: '',
    name: '',
    category: 'MEDICAL_FIXED',
    stats_bucket: 'MEDICAL',
    expense_scope: 'PATIENT_DIRECT',
    uom: '',
    pack_size: 1,
    default_vendor_id: '',
    min_order_qty: 1,
    reorder_days_threshold: 7,
    is_regular_order: true,
    unit_price: '',
  });
  const [submitting, setSubmitting] = useState(false);

  // HIRA 급여목록 검색
  const [hiraModal, setHiraModal] = useState(false);
  const [hiraSearch, setHiraSearch] = useState('');
  const [hiraResults, setHiraResults] = useState<HiraItemResult[]>([]);
  const [hiraLoading, setHiraLoading] = useState(false);
  const [hiraPage, setHiraPage] = useState(1);
  const [hiraTotalCount, setHiraTotalCount] = useState(0);
  const HIRA_PAGE_SIZE = 20;

  const [excelModal, setExcelModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ created: number; skipped: number; errors: { row: number; message: string }[] } | null>(null);
  const [exporting, setExporting] = useState(false);

  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [checkedItems, setCheckedItems] = useState<Set<string>>(new Set());
  const [permCatFilter, setPermCatFilter] = useState('');
  const [permLoading, setPermLoading] = useState(false);
  const [permSaving, setPermSaving] = useState(false);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3000);
  };

  const downloadExport = async () => {
    setExporting(true);
    try {
      const blob = await api('/items/export');
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      downloadBlob(blob, `items_${today}.xlsx`);
    } catch (e: any) {
      showMsg('err', e.message || '내보내기 실패');
    } finally {
      setExporting(false);
    }
  };

  const downloadTemplate = async () => {
    try {
      const blob = await api('/items/import/template');
      downloadBlob(blob, 'item_import_template.xlsx');
    } catch (e: any) {
      showMsg('err', e.message || '템플릿 다운로드 실패');
    }
  };

  const doImport = async () => {
    if (!importFile) return;
    setImporting(true);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append('file', importFile);
      const result = await api('/items/import', { method: 'POST', body: formData });
      setImportResult(result);
      if (result.created > 0) await loadItems();
    } catch (e: any) {
      showMsg('err', e.message || '가져오기 실패');
    } finally {
      setImporting(false);
    }
  };

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (catFilter) params.set('category', catFilter);
      const rows = await api(`/items?${params}`);
      setItems(rows);
    } catch (e: any) {
      showMsg('err', e.message || '품목 조회 실패');
    } finally {
      setLoading(false);
    }
  }, [catFilter]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  useEffect(() => { api('/vendors?is_active=true').then(setVendors).catch(() => {}); }, []);
  useEffect(() => {
    api('/departments').then((data: any) => {
      const list = Array.isArray(data) ? data : (data.data ?? []);
      setDepartments(list.filter((d: any) => d.code !== 'CENTRAL' && d.is_active));
    }).catch(() => {});
  }, []);

  const filtered = useMemo(() => items.filter(i =>
    (!search || i.name.includes(search) || i.item_code.includes(search))
    && (!statsBucketFilter || i.stats_bucket === statsBucketFilter)
    && (!expenseScopeFilter || i.expense_scope === expenseScopeFilter),
  ), [items, search, statsBucketFilter, expenseScopeFilter]);

  const openCreate = () => {
    setEditing(null);
    setEditingImageUrl(null);
    setForm({
      item_code: '', name: '', category: 'MEDICAL_FIXED', stats_bucket: 'MEDICAL', expense_scope: 'PATIENT_DIRECT',
      uom: '', pack_size: 1, default_vendor_id: '', min_order_qty: 1, reorder_days_threshold: 7, is_regular_order: true,
      unit_price: '',
    });
    setModal('create');
  };

  const openEdit = (item: Item) => {
    const statsBucket = item.stats_bucket || inferStatsBucket(item.category, item.name);
    const expenseScope = item.expense_scope || inferExpenseScope(statsBucket);
    setEditing(item);
    setEditingImageUrl(item.image_url ?? null);
    setForm({
      item_code: item.item_code, name: item.name, category: item.category, stats_bucket: statsBucket, expense_scope: expenseScope,
      uom: item.uom, pack_size: item.pack_size, default_vendor_id: item.default_vendor_id || '',
      min_order_qty: item.min_order_qty, reorder_days_threshold: item.reorder_days_threshold, is_regular_order: item.is_regular_order,
      unit_price: '',
    });
    setModal('edit');
  };

  const save = async () => {
    if (!form.item_code || !form.name || !form.uom || !form.stats_bucket || !form.expense_scope) {
      showMsg('err', '코드, 품목명, 단위, 통계카테고리, 비용구분을 입력해 주세요.');
      return;
    }
    setSubmitting(true);
    try {
      const { unit_price, ...rest } = form;
      const body = { ...rest, default_vendor_id: form.default_vendor_id || null };
      let savedId: string;
      if (editing) {
        await api(`/items/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
        savedId = editing.id;
      } else {
        const created = await api('/items', { method: 'POST', body: JSON.stringify(body) });
        savedId = created.id;
      }
      // 업체+단가 함께 입력한 경우 단가 이력 등록
      if (form.default_vendor_id && unit_price && Number(unit_price) > 0) {
        await api(`/items/${savedId}/price`, {
          method: 'POST',
          body: JSON.stringify({
            vendor_id: form.default_vendor_id,
            price: Number(unit_price),
            effective_from: new Date().toISOString(),
            source: 'MANUAL',
          }),
        });
      }
      setModal(null);
      await loadItems();
      showMsg('ok', editing ? '수정했습니다.' : '등록했습니다.');
    } catch (e: any) {
      showMsg('err', e.message || '저장 실패');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (item: Item) => {
    try {
      await api(`/items/${item.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !item.is_active }) });
      await loadItems();
    } catch (e: any) {
      showMsg('err', e.message || '상태 변경 실패');
    }
  };

  const uploadItemImage = async (itemId: string, file: File) => {
    setImageUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const token = localStorage.getItem('token');
      const resp = await fetch(`/api/items/${itemId}/image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || '업로드 실패');
      setEditingImageUrl(data.image_url);
      await loadItems();
    } catch (e: any) {
      showMsg('err', e.message || '업로드 실패');
    } finally {
      setImageUploading(false);
    }
  };

  const deleteItemImage = async (itemId: string) => {
    if (!confirm('이미지를 삭제하시겠습니까?')) return;
    try {
      await api(`/items/${itemId}/image`, { method: 'DELETE' });
      setEditingImageUrl(null);
      await loadItems();
    } catch (e: any) {
      showMsg('err', e.message || '삭제 실패');
    }
  };

  const selectDept = async (deptId: string) => {
    setSelectedDeptId(deptId);
    setPermLoading(true);
    try {
      const data = await api(`/dept-permissions/items/${deptId}`);
      setCheckedItems(new Set(data.item_ids ?? []));
    } catch {
      setCheckedItems(new Set());
    } finally {
      setPermLoading(false);
    }
  };

  const permFilteredItems = items.filter(i => !permCatFilter || i.category === permCatFilter);

  const savePermissions = async () => {
    if (!selectedDeptId) return;
    setPermSaving(true);
    try {
      await api(`/dept-permissions/items/${selectedDeptId}`, {
        method: 'PUT',
        body: JSON.stringify({ item_ids: Array.from(checkedItems) }),
      });
      showMsg('ok', '권한을 저장했습니다.');
    } catch (e: any) {
      showMsg('err', e.message || '권한 저장 실패');
    } finally {
      setPermSaving(false);
    }
  };

  const fmt = (n: number) => new Intl.NumberFormat('ko-KR').format(n);

  const searchHira = async (page = 1) => {
    if (!hiraSearch.trim()) return;
    setHiraLoading(true);
    try {
      const params = new URLSearchParams({ search: hiraSearch.trim(), pageNo: String(page), numOfRows: String(HIRA_PAGE_SIZE) });
      const data = await api(`/hira/items?${params}`);
      setHiraResults(data.items ?? []);
      setHiraTotalCount(data.totalCount ?? 0);
      setHiraPage(page);
    } catch (e: any) {
      showMsg('err', e.message || 'HIRA 검색 실패');
    } finally {
      setHiraLoading(false);
    }
  };

  const selectHiraItem = (item: HiraItemResult) => {
    setForm(f => ({
      ...f,
      name: item.itmNm || f.name,
      uom: item.unit || f.uom,
      unit_price: item.mxUnprc ? String(item.mxUnprc) : f.unit_price,
    }));
    setHiraModal(false);
    showMsg('ok', `"${item.itmNm}" 정보를 불러왔습니다.`);
  };

  const itemColumns: Column<Item>[] = [
    {
      key: 'image', header: '사진', cardPosition: 'hidden', className: 'w-14',
      render: item => item.image_url ? (
        <div className="relative inline-block group">
          <img src={item.image_url} alt={item.name} loading="lazy" className="w-9 h-9 object-cover rounded border border-slate-200 cursor-pointer" onClick={() => window.open(item.image_url!, '_blank')} />
          <div className="pointer-events-none absolute left-full top-0 ml-2 z-50 hidden group-hover:block">
            <img src={item.image_url} alt={item.name} loading="lazy" className="w-36 h-36 object-cover rounded-xl shadow-2xl border border-slate-200" />
          </div>
        </div>
      ) : <span className="text-slate-300">-</span>,
    },
    { key: 'code', header: '코드', cardPosition: 'subtitle', render: item => <span className="font-mono text-xs text-slate-500">{item.item_code}</span> },
    { key: 'name', header: '품목명', cardPosition: 'title', sortable: true, sortValue: item => item.name, render: item => <span className="font-medium text-sm">{item.name}</span> },
    { key: 'category', header: '분류', cardPosition: 'badge', render: item => <span className={`text-xs ${item.category.startsWith('EQUIP_') ? 'badge-blue' : 'badge-gray'}`}>{getCategoryLabel(item.category)}</span> },
    { key: 'stats_bucket', header: '통계카테고리', cardPosition: 'hidden', render: item => <span className="text-xs">{STATS_BUCKET_LABEL[item.stats_bucket as keyof typeof STATS_BUCKET_LABEL] ?? item.stats_bucket}</span> },
    { key: 'expense_scope', header: '비용구분', cardPosition: 'hidden', render: item => <span className="text-xs">{EXPENSE_SCOPE_LABEL[item.expense_scope as keyof typeof EXPENSE_SCOPE_LABEL] ?? item.expense_scope}</span> },
    { key: 'uom', header: '단위', cardPosition: 'body', render: item => <span className="text-xs text-slate-500">{item.uom}</span> },
    { key: 'price', header: '최신단가', cardPosition: 'body', className: 'text-right', render: item => <span className="text-sm">{item.latest_price ? `${fmt(item.latest_price)}원` : '-'}</span> },
    { key: 'stock', header: '재고', cardPosition: 'body', className: 'text-right', render: item => <span className="text-sm">{item.on_hand_qty ?? '-'}</span> },
    { key: 'vendor', header: '기본업체', cardPosition: 'hidden', render: item => <span className="text-xs text-slate-500">{item.default_vendor_name || '-'}</span> },
    { key: 'status', header: '상태', cardPosition: 'badge', render: item => <span className={item.is_active ? 'badge-green' : 'badge-gray'}>{item.is_active ? '활성' : '비활성'}</span> },
    {
      key: 'actions', header: '', cardPosition: 'hidden', render: item => (
        <div className="flex gap-2">
          <button onClick={(e) => { e.stopPropagation(); openEdit(item); }} className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1"><Pencil className="w-3 h-3" />수정</button>
          <button onClick={(e) => { e.stopPropagation(); toggleActive(item); }} className="text-xs text-slate-500 hover:underline inline-flex items-center gap-1">
            {item.is_active ? <><ToggleRight className="w-3 h-3" />비활성화</> : <><ToggleLeft className="w-3 h-3" />활성화</>}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        icon={Package}
        title="품목 관리"
        description="품목 마스터 관리"
        actions={activeTab === 'items' ? (
          <div className="flex gap-2 flex-wrap">
            <button onClick={downloadExport} disabled={exporting} className="btn-secondary">{exporting ? '내보내는 중...' : '엑셀 내보내기'}</button>
            <button onClick={() => { setImportFile(null); setImportResult(null); setExcelModal(true); }} className="btn-secondary">엑셀 가져오기</button>
            <button onClick={openCreate} className="btn-primary">+ 품목 등록</button>
          </div>
        ) : undefined}
      />

      <div className="flex border-b border-slate-200 mb-4">
        <button onClick={() => setActiveTab('items')} className={`px-5 py-2.5 text-sm font-medium border-b-2 ${activeTab === 'items' ? 'border-navy-600 text-navy-700' : 'border-transparent text-slate-500'}`}>품목 목록</button>
        <button onClick={() => setActiveTab('permissions')} className={`px-5 py-2.5 text-sm font-medium border-b-2 ${activeTab === 'permissions' ? 'border-navy-600 text-navy-700' : 'border-transparent text-slate-500'}`}>신청 권한</button>
      </div>

      {msg && <div className={`mb-4 p-3 rounded text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}

      {activeTab === 'items' && (
        <>
          <FilterBar
            search={search}
            onSearch={setSearch}
            searchPlaceholder="품목명/코드 검색"
            filters={[
              {
                key: 'category', label: '전체 분류', value: catFilter, onChange: setCatFilter,
                options: [
                  ...CONSUMABLE_CATEGORIES.map(c => ({ value: c.value, label: c.label })),
                  ...EQUIPMENT_CATEGORIES.map(c => ({ value: c.value, label: c.label })),
                ],
              },
              {
                key: 'stats_bucket', label: '전체 통계카테고리', value: statsBucketFilter, onChange: setStatsBucketFilter,
                options: ITEM_STATS_BUCKETS.map(c => ({ value: c.value, label: c.label })),
              },
              {
                key: 'expense_scope', label: '전체 비용구분', value: expenseScopeFilter, onChange: setExpenseScopeFilter,
                options: ITEM_EXPENSE_SCOPES.map(c => ({ value: c.value, label: c.label })),
              },
            ]}
            onReset={() => { setCatFilter(''); setStatsBucketFilter(''); setExpenseScopeFilter(''); setSearch(''); }}
          />

          {loading ? (
            <div className="card p-0"><EmptyState message="로딩 중..." /></div>
          ) : (
            <DataTable
              columns={itemColumns}
              data={filtered}
              keyField="id"
              emptyMessage="품목이 없습니다."
            />
          )}
        </>
      )}

      {activeTab === 'permissions' && (
        <div className="flex gap-4" style={{ minHeight: 520 }}>
          <div className="card p-0 overflow-hidden" style={{ width: 220, flexShrink: 0 }}>
            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50"><p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">부서 목록</p></div>
            <div className="overflow-y-auto" style={{ maxHeight: 520 }}>
              {departments.map(d => (
                <button key={d.id} onClick={() => selectDept(d.id)} className={`w-full text-left px-4 py-3 text-sm border-b border-slate-50 ${selectedDeptId === d.id ? 'bg-navy-50 text-navy-700 font-medium' : 'hover:bg-slate-50 text-slate-700'}`}>
                  {d.name}
                </button>
              ))}
            </div>
          </div>

          <div className="card flex-1 p-0 overflow-hidden flex flex-col">
            {!selectedDeptId ? <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">왼쪽에서 부서를 선택하세요.</div> : (
              <>
                <div className="px-5 py-3 border-b border-slate-100 flex flex-wrap gap-2 items-center">
                  <button onClick={() => setPermCatFilter('')} className={`px-3 py-1 rounded-full text-xs border ${!permCatFilter ? 'bg-navy-600 text-white border-navy-600' : 'bg-white text-slate-600 border-slate-300'}`}>전체</button>
                  {CAT_GROUPS.map(group => (
                    <React.Fragment key={group.group}>
                      <span className="text-slate-300 text-xs">|</span>
                      {group.items.map(c => (
                        <button key={c.value} onClick={() => setPermCatFilter(c.value)} className={`px-3 py-1 rounded-full text-xs border ${permCatFilter === c.value ? 'bg-navy-600 text-white border-navy-600' : 'bg-white text-slate-600 border-slate-300'}`}>{c.label}</button>
                      ))}
                    </React.Fragment>
                  ))}
                </div>

                <div className="px-5 py-2.5 border-b border-slate-100 flex items-center gap-3">
                  <button onClick={() => setCheckedItems(prev => new Set([...prev, ...permFilteredItems.map(i => i.id)]))} className="text-xs text-navy-600 hover:underline">전체 선택</button>
                  <button onClick={() => setCheckedItems(prev => new Set([...prev].filter(id => !permFilteredItems.some(i => i.id === id))))} className="text-xs text-slate-500 hover:underline">전체 해제</button>
                  <span className="text-xs text-slate-400 ml-auto">{checkedItems.size}개 선택됨</span>
                  <button onClick={savePermissions} disabled={permSaving} className="btn-primary text-xs py-1.5 px-4">{permSaving ? '저장 중...' : '저장'}</button>
                </div>

                <div className="flex-1 overflow-y-auto">
                  {permLoading ? <EmptyState message="로딩 중..." /> : (
                    <table className="tbl">
                      <thead><tr><th style={{ width: 48 }}></th><th>코드</th><th>품목명</th><th>분류</th><th>단위</th><th className="text-right">재고</th></tr></thead>
                      <tbody>
                        {permFilteredItems.map(item => {
                          const checked = checkedItems.has(item.id);
                          return (
                            <tr key={item.id} onClick={() => setCheckedItems(prev => { const next = new Set(prev); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} className={`cursor-pointer ${checked ? 'bg-blue-50' : 'hover:bg-slate-50'}`}>
                              <td className="text-center"><input type="checkbox" checked={checked} onChange={() => {}} onClick={e => e.stopPropagation()} className="rounded border-slate-300 text-navy-600" /></td>
                              <td className="font-mono text-xs text-slate-500">{item.item_code}</td>
                              <td className="text-sm">{item.name}</td>
                              <td><span className={`text-xs ${item.category.startsWith('EQUIP_') ? 'badge-blue' : 'badge-gray'}`}>{getCategoryLabel(item.category)}</span></td>
                              <td className="text-xs text-slate-500">{item.uom}</td>
                              <td className="text-right text-sm">{item.on_hand_qty ?? 0}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 엑셀 가져오기 모달 */}
      <Modal
        open={excelModal}
        onClose={() => setExcelModal(false)}
        title="엑셀 가져오기"
        footer={
          <>
            <button onClick={() => setExcelModal(false)} className="btn-secondary">닫기</button>
            <button onClick={doImport} disabled={!importFile || importing} className="btn-primary">
              {importing ? '가져오는 중...' : '가져오기'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
            <div>
              <p className="text-sm font-medium text-slate-700">등록 서식 다운로드</p>
              <p className="text-xs text-slate-400 mt-0.5">품목코드, 품목명, 단위 등 필수 항목 포함</p>
            </div>
            <button onClick={downloadTemplate} className="btn-secondary text-xs">서식 받기</button>
          </div>

          <FormField label="엑셀 파일 선택 (.xlsx)">
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={e => { setImportFile(e.target.files?.[0] ?? null); setImportResult(null); }}
              className="block w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
            />
          </FormField>

          {importResult && (
            <div className={`p-3 rounded-lg text-sm ${importResult.errors.length > 0 ? 'bg-yellow-50' : 'bg-green-50'}`}>
              <p className="font-medium mb-1">
                등록 완료: <span className="text-green-700">{importResult.created}건</span>
                {importResult.skipped > 0 && <span className="text-slate-500 ml-2">중복 스킵: {importResult.skipped}건</span>}
              </p>
              {importResult.errors.length > 0 && (
                <div className="mt-2">
                  <p className="text-red-600 font-medium mb-1">오류 {importResult.errors.length}건</p>
                  <ul className="text-xs text-red-500 space-y-0.5 max-h-32 overflow-y-auto">
                    {importResult.errors.map((e, i) => (
                      <li key={i}>{e.row}행: {e.message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* 품목 등록/수정 모달 */}
      <Modal
        open={modal === 'create' || modal === 'edit'}
        onClose={() => setModal(null)}
        title={modal === 'create' ? '품목 등록' : '품목 수정'}
        size="lg"
        footer={
          <>
            <button onClick={() => setModal(null)} className="btn-secondary">취소</button>
            <button onClick={save} disabled={submitting} className="btn-primary">{submitting ? '저장 중...' : '저장'}</button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 flex justify-end">
            <button type="button" onClick={() => { setHiraSearch(form.name); setHiraResults([]); setHiraTotalCount(0); setHiraModal(true); }} className="btn-secondary text-xs">
              급여목록 검색 (HIRA)
            </button>
          </div>
          <FormField label="품목 코드" required>
            <input value={form.item_code} onChange={e => setForm(f => ({ ...f, item_code: e.target.value }))} className="input" />
          </FormField>
          <FormField label="분류" required>
            <select value={form.category} onChange={e => {
              const cat = e.target.value;
              setForm(f => ({ ...f, category: cat, ...(cat.startsWith('EQUIP_') && { is_regular_order: false }) }));
            }} className="input">
              <optgroup label="-- 소모품 --">
                {CONSUMABLE_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </optgroup>
              <optgroup label="-- 비품 --">
                {EQUIPMENT_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </optgroup>
            </select>
            {form.category.startsWith('EQUIP_') && (
              <p className="text-xs text-blue-600 mt-1">비품은 불출 시 일련번호(EQ-YYYY-NNNNN)가 자동 부여됩니다.</p>
            )}
          </FormField>
          <FormField label="통계카테고리" required>
            <select value={form.stats_bucket} onChange={e => setForm(f => ({ ...f, stats_bucket: e.target.value }))} className="input">{ITEM_STATS_BUCKETS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
          </FormField>
          <FormField label="비용구분" required>
            <select value={form.expense_scope} onChange={e => setForm(f => ({ ...f, expense_scope: e.target.value }))} className="input">{ITEM_EXPENSE_SCOPES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
          </FormField>
          <div className="col-span-2">
            <FormField label="품목명" required>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" />
            </FormField>
          </div>
          <FormField label="단위" required>
            <input value={form.uom} onChange={e => setForm(f => ({ ...f, uom: e.target.value }))} className="input" />
          </FormField>
          <FormField label="포장단위">
            <input type="number" min={1} value={form.pack_size} onChange={e => setForm(f => ({ ...f, pack_size: Number(e.target.value) }))} className="input" />
          </FormField>
          <FormField label="최소발주수량">
            <input type="number" min={1} value={form.min_order_qty} onChange={e => setForm(f => ({ ...f, min_order_qty: Number(e.target.value) }))} className="input" />
          </FormField>
          <FormField label="재주문기준(일)">
            <input type="number" min={0} value={form.reorder_days_threshold} onChange={e => setForm(f => ({ ...f, reorder_days_threshold: Number(e.target.value) }))} className="input" />
          </FormField>
          <div className="col-span-2">
            <FormField label="기본 공급업체">
              <select value={form.default_vendor_id} onChange={e => setForm(f => ({ ...f, default_vendor_id: e.target.value }))} className="input"><option value="">없음</option>{vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
            </FormField>
          </div>
          {form.default_vendor_id && (
            <div className="col-span-2">
              <FormField label="단가 (선택)">
                <input type="number" min={0} value={form.unit_price} onChange={e => setForm(f => ({ ...f, unit_price: e.target.value }))} className="input" placeholder="예: 5000 (입력 시 단가 이력에 등록)" />
              </FormField>
            </div>
          )}
          <div className="col-span-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_regular_order} onChange={e => setForm(f => ({ ...f, is_regular_order: e.target.checked }))} />정기 발주 품목</label></div>
          {modal === 'edit' && editing && (
            <div className="col-span-2 pt-2 border-t border-slate-100">
              <FormField label="제품 이미지">
                <div className="flex items-center gap-4">
                  {editingImageUrl ? <img src={editingImageUrl} alt="제품" loading="lazy" className="w-20 h-20 object-cover rounded border border-slate-200" /> : <div className="w-20 h-20 border border-dashed border-slate-300 rounded flex items-center justify-center text-xs text-slate-400">없음</div>}
                  <div className="flex-1">
                    <input type="file" accept="image/*" onChange={e => { const file = e.target.files?.[0]; if (file) uploadItemImage(editing.id, file); }} className="block w-full text-sm text-slate-600" />
                    <div className="flex gap-2 mt-2">
                      <button type="button" onClick={() => deleteItemImage(editing.id)} className="btn-secondary text-xs">이미지 삭제</button>
                      {imageUploading && <span className="text-xs text-teal-600">업로드 중...</span>}
                    </div>
                  </div>
                </div>
              </FormField>
            </div>
          )}
        </div>
      </Modal>

      {/* HIRA 검색 모달 */}
      <Modal
        open={hiraModal}
        onClose={() => setHiraModal(false)}
        title="급여/비급여 목록 검색 (HIRA)"
        size="xl"
        footer={<button onClick={() => setHiraModal(false)} className="btn-secondary">닫기</button>}
      >
        <div className="flex gap-2 mb-4">
          <input
            value={hiraSearch}
            onChange={e => setHiraSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') searchHira(1); }}
            className="input flex-1"
            placeholder="품목명으로 검색 (예: 거즈, 카테터)"
            autoFocus
          />
          <button onClick={() => searchHira(1)} disabled={hiraLoading || !hiraSearch.trim()} className="btn-primary text-sm px-5">
            {hiraLoading ? '검색 중...' : '검색'}
          </button>
        </div>

        {hiraResults.length > 0 && (
          <>
            <p className="text-xs text-slate-500 mb-2">총 {fmt(hiraTotalCount)}건 (페이지 {hiraPage}/{Math.ceil(hiraTotalCount / HIRA_PAGE_SIZE)})</p>
            <div className="overflow-x-auto border border-slate-200 rounded-lg" style={{ maxHeight: 380 }}>
              <table className="tbl text-xs">
                <thead>
                  <tr>
                    <th>품목명</th><th>규격</th><th>단위</th><th className="text-right">상한가</th><th>급여유형</th><th>제조/수입업체</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {hiraResults.map((it, i) => (
                    <tr key={i} className="hover:bg-blue-50 cursor-pointer" onClick={() => selectHiraItem(it)}>
                      <td className="font-medium max-w-[200px] truncate" title={it.itmNm}>{it.itmNm}</td>
                      <td className="max-w-[140px] truncate" title={it.nomNm}>{it.nomNm || '-'}</td>
                      <td>{it.unit || '-'}</td>
                      <td className="text-right">{it.mxUnprc != null ? `${fmt(it.mxUnprc)}원` : '-'}</td>
                      <td>{it.payTpNm || '-'}</td>
                      <td className="max-w-[120px] truncate" title={it.mnfEntpNm || it.impEntpNm}>{it.mnfEntpNm || it.impEntpNm || '-'}</td>
                      <td><button className="text-xs text-accent-600 hover:underline" onClick={e => { e.stopPropagation(); selectHiraItem(it); }}>선택</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {hiraTotalCount > HIRA_PAGE_SIZE && (
              <div className="flex justify-center gap-3 mt-3">
                <button onClick={() => searchHira(hiraPage - 1)} disabled={hiraPage <= 1 || hiraLoading} className="btn-secondary text-xs">이전</button>
                <button onClick={() => searchHira(hiraPage + 1)} disabled={hiraPage >= Math.ceil(hiraTotalCount / HIRA_PAGE_SIZE) || hiraLoading} className="btn-secondary text-xs">다음</button>
              </div>
            )}
          </>
        )}

        {!hiraLoading && hiraResults.length === 0 && hiraTotalCount === 0 && hiraSearch && (
          <EmptyState message="검색 결과가 없습니다." />
        )}
      </Modal>
    </div>
  );
}
