import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Package, Pencil, Trash2, CheckSquare, Square, Edit3 } from 'lucide-react';
import { api, downloadBlob } from '../utils/api';
import type { Item, Vendor, HiraItemResult } from '@shared/types';
import {
  CONSUMABLE_CATEGORIES,
  EQUIPMENT_CATEGORIES,
  ITEM_EXPENSE_SCOPES,
  MAJOR_GROUP_LABEL,
  MID_CATEGORIES,
  getMajor,
  getMidCategory,
  getCategoryLabel,
  setUserMidCategories,
} from '@shared/types';
import { Link } from 'react-router-dom';
import { PageHeader, FilterBar, DataTable, Modal, EmptyState, FormField } from '../components/ui';
import type { Column } from '../components/ui';

const EXPENSE_SCOPE_LABEL = Object.fromEntries(ITEM_EXPENSE_SCOPES.map(x => [x.value, x.label]));

// 카테고리 prefix → 비용구분 자동 추천. 마이그레이션 스크립트(fix-expense-scope.js)와 동일한 규칙.
//  환자 진료에 직접 들어가는 것 = PATIENT_DIRECT
//  운영성(청소·사무·식음료·비품) = OPS_INDIRECT
const inferExpenseScopeFromCategory = (category: string): 'PATIENT_DIRECT' | 'OPS_INDIRECT' => {
  const prefix = String(category || '').split('_')[0].toUpperCase();
  if (['FAC', 'OFF', 'FOOD', 'EQUIP'].includes(prefix)) return 'OPS_INDIRECT';
  if (['MED', 'INFECT', 'PAT', 'DIAPER'].includes(prefix)) return 'PATIENT_DIRECT';
  return 'PATIENT_DIRECT';
};

export default function ItemsPage() {
  const [activeTab, setActiveTab] = useState<'consumable' | 'equipment' | 'permissions'>('consumable');
  const [items, setItems] = useState<Item[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [treatmentTypes, setTreatmentTypes] = useState<{ id: string; name: string }[]>([]);
  const [departments, setDepartments] = useState<{ id: string; name: string; parent_id: string | null }[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [majorFilter, setMajorFilter] = useState('');
  const [midFilter, setMidFilter] = useState('');
  const [expenseScopeFilter, setExpenseScopeFilter] = useState('');

  const [modal, setModal] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Item | null>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const [editingImageUrl, setEditingImageUrl] = useState<string | null>(null);
  const [form, setForm] = useState({
    item_code: '',
    name: '',
    category: 'MED_OTHER',
    sub_category: '',
    expense_scope: 'PATIENT_DIRECT',
    purchase_uom: '',
    issue_uom: '',
    pack_size: 1,
    default_vendor_id: '',
    default_treatment_type_id: '',
    diaper_companion_for_wards: false,
    min_order_qty: 1,
    reorder_days_threshold: 7,
    is_regular_order: true,
    unit_price: '',
  });
  const [submitting, setSubmitting] = useState(false);
  // 사용자 추가 중분류 — "분류" 드롭다운에 합쳐 표시 + 전역 레지스트리 적재
  const [userMids, setUserMids] = useState<{ code: string; name: string; major: string; major_label: string }[]>([]);

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
  const [importResult, setImportResult] = useState<{ created: number; updated?: number; skipped: number; errors: { row: number; message: string }[] } | null>(null);
  const [exporting, setExporting] = useState(false);

  // 일괄 선택/수정/삭제
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEditModal, setBulkEditModal] = useState(false);
  const [bulkPatch, setBulkPatch] = useState<{ category?: string; expense_scope?: string; default_vendor_id?: string }>({});
  const [bulkSaving, setBulkSaving] = useState(false);

  // 신청권한 매트릭스 (행=품목, 열=부서)
  const [matrixItems, setMatrixItems] = useState<Item[]>([]);
  const [existingPerms, setExistingPerms] = useState<Map<string, Set<string>>>(new Map());
  const [targetPerms, setTargetPerms] = useState<Map<string, { mode: 'open' | 'restricted'; depts: Set<string> }>>(new Map());
  const [permLoading, setPermLoading] = useState(false);
  const [permSaving, setPermSaving] = useState(false);
  const [permItemSearch, setPermItemSearch] = useState('');
  const [permMajorFilter, setPermMajorFilter] = useState('');
  const [permMidFilter, setPermMidFilter] = useState('');
  const [permParentFilter, setPermParentFilter] = useState('');
  const [showOnlyDirtyDepts, setShowOnlyDirtyDepts] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 3000);
  };

  const downloadExport = async () => {
    setExporting(true);
    try {
      const blob = await api('/items/export');
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      downloadBlob(blob, `품목목록_${today}.xlsx`);
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
      if (result.created > 0 || (result.updated ?? 0) > 0) await loadItems();
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
  useEffect(() => { api('/treatment-types').then((r: any) => setTreatmentTypes(Array.isArray(r) ? r : (r?.items ?? []))).catch(() => {}); }, []);
  useEffect(() => {
    api('/departments').then((data: any) => {
      const list = Array.isArray(data) ? data : (data.data ?? []);
      setDepartments(list.filter((d: any) => d.code !== 'CENTRAL' && d.is_active));
    }).catch(() => {});
  }, []);

  // 사용자 추가 중분류 로드 — 드롭다운 옵션 + 전역 레지스트리(라벨/그룹 도출용) 적재
  useEffect(() => {
    api('/item-categories')
      .then((rows: any[]) => {
        const list = (Array.isArray(rows) ? rows : [])
          .filter(r => r.is_active !== false && r.is_active !== 0)
          .map(r => ({
            code: String(r.code), name: String(r.name),
            major: String(r.major || ''), major_label: String(r.major_label || ''),
          }));
        setUserMids(list);
        setUserMidCategories(list.map(x => ({ code: x.code, name: x.name })));
      })
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => items.filter(i => {
    // 탭 분리: 소모품 탭은 EQUIP_* 제외, 비품 탭은 EQUIP_* 만
    const isEquip = (i.category ?? '').startsWith('EQUIP_');
    if (activeTab === 'consumable' && isEquip) return false;
    if (activeTab === 'equipment' && !isEquip) return false;
    return (!search || i.name.includes(search) || i.item_code.includes(search))
      && (!catFilter || i.category === catFilter)
      && (!majorFilter || getMajor(i.category) === majorFilter)
      && (!midFilter || getMidCategory(i.category)?.value === midFilter)
      && (!expenseScopeFilter || i.expense_scope === expenseScopeFilter);
  }), [items, activeTab, search, catFilter, majorFilter, midFilter, expenseScopeFilter]);

  // 현재 탭의 카테고리별 품목 수 (필터 드롭다운에서 0개 카테고리 제거용)
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of items) {
      const isEquip = (i.category ?? '').startsWith('EQUIP_');
      if (activeTab === 'consumable' && isEquip) continue;
      if (activeTab === 'equipment' && !isEquip) continue;
      counts.set(i.category, (counts.get(i.category) || 0) + 1);
    }
    return counts;
  }, [items, activeTab]);

  const openCreate = () => {
    setEditing(null);
    setEditingImageUrl(null);
    const isEquip = activeTab === 'equipment';
    setForm({
      item_code: '', name: '',
      category: isEquip ? 'EQUIP_FURNITURE' : 'MED_OTHER',
      sub_category: '',
      expense_scope: 'PATIENT_DIRECT',
      purchase_uom: '', issue_uom: '', pack_size: 1, default_vendor_id: '', default_treatment_type_id: '', diaper_companion_for_wards: false, min_order_qty: 1, reorder_days_threshold: 7, is_regular_order: true,
      unit_price: '',
    });
    setModal('create');
  };

  const openEdit = (item: Item) => {
    const expenseScope = item.expense_scope || inferExpenseScopeFromCategory(item.category);
    setEditing(item);
    setEditingImageUrl(item.image_url ?? null);
    setForm({
      item_code: item.item_code, name: item.name, category: item.category,
      sub_category: (item as any).sub_category ?? '',
      expense_scope: expenseScope,
      purchase_uom: item.purchase_uom ?? item.uom ?? '',
      issue_uom: item.issue_uom ?? item.uom ?? '',
      pack_size: item.pack_size, default_vendor_id: item.default_vendor_id || '',
      default_treatment_type_id: (item as any).default_treatment_type_id || '',
      diaper_companion_for_wards: !!(item as any).diaper_companion_for_wards,
      min_order_qty: item.min_order_qty, reorder_days_threshold: item.reorder_days_threshold, is_regular_order: item.is_regular_order,
      unit_price: '',
    });
    setModal('edit');
  };

  const save = async () => {
    if (!form.name || !form.purchase_uom || !form.issue_uom || !form.expense_scope) {
      showMsg('err', '품목명, 발주단위, 불출단위, 비용구분을 입력해 주세요.');
      return;
    }
    if (!Number.isInteger(Number(form.pack_size)) || Number(form.pack_size) < 1) {
      showMsg('err', '포장변환비율은 1 이상의 정수여야 합니다.');
      return;
    }
    setSubmitting(true);
    try {
      const { unit_price, ...rest } = form;
      const body = {
        ...rest,
        default_vendor_id: form.default_vendor_id || null,
        default_treatment_type_id: form.default_treatment_type_id || null,
      };
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

  const deleteItem = async (item: Item) => {
    if (!confirm(`'${item.name}' 품목을 삭제하시겠습니까? 목록에서 사라집니다.\n(과거 신청·재고 이력은 유지되며, 필요 시 복구 가능합니다.)`)) return;
    try {
      await api(`/items/${item.id}`, { method: 'DELETE' });
      showMsg('ok', '삭제되었습니다.');
      await loadItems();
    } catch (e: any) {
      showMsg('err', e.message || '삭제 실패');
    }
  };

  // 일괄 선택/수정/삭제
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAllVisible = () => {
    const visibleIds = filtered.map(i => i.id);
    const allSelected = visibleIds.every(id => selectedIds.has(id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allSelected) visibleIds.forEach(id => next.delete(id));
      else visibleIds.forEach(id => next.add(id));
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  const bulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`선택한 ${ids.length}개 품목을 삭제하시겠습니까?\n(soft-delete — 과거 이력 유지, 필요 시 복구 가능)`)) return;
    try {
      const r = await api('/items/bulk', { method: 'DELETE', body: JSON.stringify({ ids }) });
      showMsg('ok', `${r.deleted}개 삭제됨`);
      clearSelection();
      await loadItems();
    } catch (e: any) {
      showMsg('err', e.message || '삭제 실패');
    }
  };

  const openBulkEdit = () => {
    setBulkPatch({});
    setBulkEditModal(true);
  };
  const bulkSave = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const patch: any = {};
    if (bulkPatch.category) patch.category = bulkPatch.category;
    if (bulkPatch.expense_scope) patch.expense_scope = bulkPatch.expense_scope;
    if (bulkPatch.default_vendor_id !== undefined) patch.default_vendor_id = bulkPatch.default_vendor_id;
    if (Object.keys(patch).length === 0) return showMsg('err', '변경할 필드를 하나 이상 선택하세요.');
    if (!confirm(`선택한 ${ids.length}개 품목에 변경사항을 적용합니다. 계속할까요?`)) return;
    setBulkSaving(true);
    try {
      const r = await api('/items/bulk-update', { method: 'PATCH', body: JSON.stringify({ ids, patch }) });
      showMsg('ok', `${r.updated}개 변경됨`);
      setBulkEditModal(false);
      clearSelection();
      await loadItems();
    } catch (e: any) {
      showMsg('err', e.message || '변경 실패');
    } finally {
      setBulkSaving(false);
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

  const loadMatrixItems = useCallback(async () => {
    try {
      const rows = await api('/items?is_active=true');
      setMatrixItems(rows);
    } catch (e: any) {
      showMsg('err', e.message || '품목 조회 실패');
    }
  }, []);

  const loadPermsMatrix = useCallback(async () => {
    setPermLoading(true);
    try {
      const data = await api('/dept-permissions/items/all');
      const map = new Map<string, Set<string>>();
      for (const p of (data.permissions ?? [])) {
        if (!map.has(p.item_id)) map.set(p.item_id, new Set());
        map.get(p.item_id)!.add(p.department_id);
      }
      setExistingPerms(map);
      setTargetPerms(new Map());
      setSelectedRows(new Set());
    } catch (e: any) {
      showMsg('err', e.message || '권한 조회 실패');
    } finally {
      setPermLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'permissions') {
      loadMatrixItems();
      loadPermsMatrix();
    }
  }, [activeTab, loadMatrixItems, loadPermsMatrix]);

  const parentDepts = useMemo(() => departments.filter(d => !d.parent_id), [departments]);

  // 부모별 자식 그룹 — 셀렉트 옵션 빌드용
  const deptGroups = useMemo(() => {
    const childrenByParent = new Map<string, typeof departments>();
    for (const d of departments) {
      if (d.parent_id) {
        const arr = childrenByParent.get(d.parent_id);
        if (arr) arr.push(d);
        else childrenByParent.set(d.parent_id, [d]);
      }
    }
    return parentDepts.map(p => ({ parent: p, children: childrenByParent.get(p.id) ?? [] }));
  }, [departments, parentDepts]);

  // 변경된 셀이 걸린 부서 ID 집합 — "변경된 셀만 보기" 토글용
  const dirtyDeptIds = useMemo(() => {
    const result = new Set<string>();
    for (const [item_id, t] of targetPerms) {
      const ex = existingPerms.get(item_id);
      const exAllowAll = !ex || ex.size === 0;
      const tgtAllowAll = t.mode === 'open';
      for (const d of departments) {
        const wasAllowed = exAllowAll ? true : ex!.has(d.id);
        const isAllowed = tgtAllowAll ? true : t.depts.has(d.id);
        if (wasAllowed !== isAllowed) result.add(d.id);
      }
      if (result.size === departments.length) break; // 단축
    }
    return result;
  }, [targetPerms, existingPerms, departments]);

  // 매트릭스 컬럼은 실제 신청 단위(말단 부서)만. 자식이 있는 부모는 그룹 노드라 컬럼에서 제외.
  const leafDepts = useMemo(() => {
    const hasChildren = new Set(departments.filter(d => d.parent_id).map(d => d.parent_id!));
    return departments.filter(d => !hasChildren.has(d.id));
  }, [departments]);

  const visibleDepts = useMemo(() => {
    let base = leafDepts;
    if (permParentFilter) {
      const target = departments.find(d => d.id === permParentFilter);
      if (target) {
        // 부모 선택 → 그 부모의 자식들만(부모 자신은 leaf 가 아니므로 자연스럽게 제외)
        // 자식 선택 → 그 자식만
        base = !target.parent_id
          ? leafDepts.filter(d => d.parent_id === permParentFilter)
          : leafDepts.filter(d => d.id === permParentFilter);
      }
    }
    if (showOnlyDirtyDepts) base = base.filter(d => dirtyDeptIds.has(d.id));
    return base;
  }, [departments, leafDepts, permParentFilter, showOnlyDirtyDepts, dirtyDeptIds]);

  const visibleMatrixItems = useMemo(() => matrixItems.filter(i => {
    // 신청권한 매트릭스는 소모품만 (비품 제외)
    if ((i.category ?? '').startsWith('EQUIP_')) return false;
    return (!permItemSearch || i.name.includes(permItemSearch) || i.item_code.includes(permItemSearch))
      && (!permMajorFilter || getMajor(i.category) === permMajorFilter)
      && (!permMidFilter || getMidCategory(i.category)?.value === permMidFilter);
  }), [matrixItems, permItemSearch, permMajorFilter, permMidFilter]);

  const isOpen = (item_id: string): boolean => {
    const t = targetPerms.get(item_id);
    if (t) return t.mode === 'open';
    const ex = existingPerms.get(item_id);
    return !ex || ex.size === 0;
  };

  // 행의 effective allowed set — open 이면 모든 부서, 아니면 명시된 부서들
  const getResolvedAllowed = (item_id: string): Set<string> => {
    const t = targetPerms.get(item_id);
    if (t) return t.mode === 'open' ? new Set(departments.map(d => d.id)) : t.depts;
    const ex = existingPerms.get(item_id);
    if (!ex || ex.size === 0) return new Set(departments.map(d => d.id));
    return ex;
  };

  // visible 부서 기준 행의 허용 상태
  const getVisibleStatus = (item_id: string): 'all' | 'partial' | 'none' => {
    const allowed = getResolvedAllowed(item_id);
    let on = 0;
    for (const d of visibleDepts) if (allowed.has(d.id)) on++;
    if (on === 0) return 'none';
    if (on === visibleDepts.length) return 'all';
    return 'partial';
  };

  const setTarget = (item_id: string, target: { mode: 'open' | 'restricted'; depts: Set<string> }) => {
    setTargetPerms(prev => {
      const next = new Map(prev);
      next.set(item_id, target);
      return next;
    });
  };

  // 모든 부서가 allowed 면 'open', 아니면 'restricted' — DB 표현 정규화
  const commitAllowed = (item_id: string, next: Set<string>) => {
    if (next.size === departments.length) setTarget(item_id, { mode: 'open', depts: new Set() });
    else setTarget(item_id, { mode: 'restricted', depts: next });
  };

  // visible 범위 안의 부서들만 토글. 비가시 부서는 절대 안 건드림.
  const setVisibleAllowed = (item_id: string, allow: boolean) => {
    const next = new Set(getResolvedAllowed(item_id));
    for (const d of visibleDepts) {
      if (allow) next.add(d.id);
      else next.delete(d.id);
    }
    commitAllowed(item_id, next);
  };

  // 행 단위 pill 클릭 — visible 기준 토글
  const toggleVisibleScope = (item_id: string) => {
    const status = getVisibleStatus(item_id);
    setVisibleAllowed(item_id, status !== 'all');
  };

  const toggleCell = (item_id: string, dept_id: string) => {
    const next = new Set(getResolvedAllowed(item_id));
    if (next.has(dept_id)) next.delete(dept_id);
    else next.add(dept_id);
    commitAllowed(item_id, next);
  };

  const toggleRowSelected = (item_id: string) => {
    setSelectedRows(prev => {
      const next = new Set(prev);
      if (next.has(item_id)) next.delete(item_id);
      else next.add(item_id);
      return next;
    });
  };

  const toggleSelectAllRows = () => {
    const ids = visibleMatrixItems.map(i => i.id);
    const allSelected = ids.length > 0 && ids.every(id => selectedRows.has(id));
    setSelectedRows(prev => {
      const next = new Set(prev);
      if (allSelected) ids.forEach(id => next.delete(id));
      else ids.forEach(id => next.add(id));
      return next;
    });
  };

  const bulkRowsAllowAll = () => {
    selectedRows.forEach(id => setVisibleAllowed(id, true));
  };

  const bulkRowsBlockAll = () => {
    selectedRows.forEach(id => setVisibleAllowed(id, false));
  };

  const dirtyCount = useMemo(() => {
    let count = 0;
    for (const [item_id, t] of targetPerms) {
      const ex = existingPerms.get(item_id) ?? new Set<string>();
      if (t.mode === 'open') {
        if (ex.size > 0) count++;
      } else {
        if (t.depts.size !== ex.size) { count++; continue; }
        let same = true;
        for (const d of t.depts) if (!ex.has(d)) { same = false; break; }
        if (!same) count++;
      }
    }
    return count;
  }, [targetPerms, existingPerms]);

  const savePermsBulk = async () => {
    if (dirtyCount === 0) return;
    setPermSaving(true);
    try {
      const changes: any[] = [];
      for (const [item_id, t] of targetPerms) {
        const ex = existingPerms.get(item_id) ?? new Set<string>();
        if (t.mode === 'open') {
          if (ex.size > 0) changes.push({ item_id, clear: true });
        } else {
          const add: string[] = [];
          const remove: string[] = [];
          for (const d of t.depts) if (!ex.has(d)) add.push(d);
          for (const d of ex) if (!t.depts.has(d)) remove.push(d);
          if (add.length === 0 && remove.length === 0) continue;
          const change: any = { item_id };
          if (add.length > 0) change.add = add;
          if (remove.length > 0) change.remove = remove;
          changes.push(change);
        }
      }
      if (changes.length === 0) return;
      // 큰 변경 세트는 청크로 나눠 전송 — 단일 트랜잭션 부담 + 일부 실패 격리
      const CHUNK = 100;
      for (let i = 0; i < changes.length; i += CHUNK) {
        await api('/dept-permissions/items/bulk', {
          method: 'POST',
          body: JSON.stringify({ changes: changes.slice(i, i + CHUNK) }),
        });
      }
      showMsg('ok', `${changes.length}개 품목 권한을 저장했습니다.`);
      await loadPermsMatrix();
    } catch (e: any) {
      showMsg('err', e.message || '저장 실패');
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
      // HIRA 단위는 일반적으로 최소 단위(=불출단위) — 발주단위가 비어 있으면 같이 채움
      issue_uom: item.unit || f.issue_uom,
      purchase_uom: f.purchase_uom || item.unit || '',
      unit_price: item.mxUnprc ? String(item.mxUnprc) : f.unit_price,
    }));
    setHiraModal(false);
    showMsg('ok', `"${item.itmNm}" 정보를 불러왔습니다.`);
  };

  const itemColumns: Column<Item>[] = [
    {
      key: 'select', header: '✓', cardPosition: 'hidden', className: 'w-8',
      render: item => (
        <input
          type="checkbox"
          checked={selectedIds.has(item.id)}
          onChange={(e) => { e.stopPropagation(); toggleSelect(item.id); }}
          onClick={(e) => e.stopPropagation()}
          className="cursor-pointer"
        />
      ),
    },
    {
      key: 'image', header: '사진', cardPosition: 'hidden', className: 'w-14',
      render: item => item.image_url ? (
        <div className="relative inline-block group">
          <img src={item.image_url} alt={item.name} loading="lazy" className="w-9 h-9 object-contain bg-slate-50 rounded border border-slate-200 cursor-pointer" onClick={() => window.open(item.image_url!, '_blank')} />
          <div className="pointer-events-none absolute left-full top-0 ml-2 z-50 hidden group-hover:block">
            <img src={item.image_url} alt={item.name} loading="lazy" className="w-36 h-36 object-contain bg-slate-50 rounded-xl shadow-2xl border border-slate-200" />
          </div>
        </div>
      ) : <span className="text-slate-300">-</span>,
    },
    { key: 'code', header: '코드', cardPosition: 'subtitle', render: item => <span className="font-mono text-xs text-slate-500">{item.item_code}</span> },
    { key: 'name', header: '품목명', cardPosition: 'title', sortable: true, sortValue: item => item.name, render: item => <span className="font-medium text-sm">{item.name}</span> },
    { key: 'major', header: '대분류', cardPosition: 'hidden', render: item => <span className="text-xs">{MAJOR_GROUP_LABEL[getMajor(item.category)]}</span> },
    { key: 'mid', header: '중분류', cardPosition: 'hidden', render: item => <span className="text-xs text-slate-500">{getMidCategory(item.category)?.label ?? '-'}</span> },
    { key: 'category', header: '소분류', cardPosition: 'badge', render: item => <span className={`text-xs ${item.category.startsWith('EQUIP_') ? 'badge-blue' : 'badge-gray'}`}>{getCategoryLabel(item.category)}</span> },
    { key: 'expense_scope', header: '비용구분', cardPosition: 'hidden', render: item => <span className="text-xs">{EXPENSE_SCOPE_LABEL[item.expense_scope as keyof typeof EXPENSE_SCOPE_LABEL] ?? item.expense_scope}</span> },
    { key: 'uom', header: '발주/불출단위', cardPosition: 'body', render: item => {
        const purchase = item.purchase_uom ?? item.uom;
        const issue = item.issue_uom ?? item.uom;
        const pack = Number(item.pack_size ?? 1);
        if (pack > 1 && purchase && issue && purchase !== issue) {
          return (
            <div className="text-xs">
              <span className="text-slate-600">발주: {purchase}</span>
              <span className="text-slate-400 mx-1">·</span>
              <span className="text-slate-600">불출: {issue}</span>
              <div className="text-blue-500 text-[10px]">1{purchase}={pack}{issue}</div>
            </div>
          );
        }
        return <span className="text-xs text-slate-500">{purchase || issue}</span>;
      } },
    { key: 'price', header: '최신단가', cardPosition: 'body', className: 'text-right', render: item => <span className="text-sm">{item.latest_price ? `${fmt(item.latest_price)}원` : '-'}</span> },
    { key: 'stock', header: '재고', cardPosition: 'body', className: 'text-right', render: item => <span className="text-sm">{item.on_hand_qty ?? '-'}</span> },
    { key: 'vendor', header: '기본업체', cardPosition: 'hidden', render: item => <span className="text-xs text-slate-500">{item.default_vendor_name || '-'}</span> },
    {
      key: 'actions', header: '', cardPosition: 'hidden', render: item => (
        <div className="flex gap-2">
          <button onClick={(e) => { e.stopPropagation(); openEdit(item); }} className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1"><Pencil className="w-3 h-3" />수정</button>
          <button onClick={(e) => { e.stopPropagation(); deleteItem(item); }} className="text-xs text-red-500 hover:underline inline-flex items-center gap-1"><Trash2 className="w-3 h-3" />삭제</button>
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
        actions={activeTab !== 'permissions' ? (
          <div className="flex gap-2 flex-wrap">
            {activeTab === 'consumable' && <Link to="/items/recategorize" className="btn-secondary">🗂️ 재분류 보정</Link>}
            <button onClick={downloadExport} disabled={exporting} className="btn-secondary">{exporting ? '내보내는 중...' : '엑셀 내보내기'}</button>
            <button onClick={() => { setImportFile(null); setImportResult(null); setExcelModal(true); }} className="btn-secondary">엑셀 가져오기</button>
            <button onClick={() => { openCreate(); }} className="btn-primary">+ {activeTab === 'equipment' ? '비품' : '품목'} 등록</button>
          </div>
        ) : undefined}
      />

      <div className="flex border-b border-slate-200 mb-4">
        <button onClick={() => { setActiveTab('consumable'); setCatFilter(''); setMajorFilter(''); setMidFilter(''); }} className={`px-5 py-2.5 text-sm font-medium border-b-2 ${activeTab === 'consumable' ? 'border-navy-600 text-navy-700' : 'border-transparent text-slate-500'}`}>소모품</button>
        <button onClick={() => { setActiveTab('equipment'); setCatFilter(''); setMajorFilter(''); setMidFilter(''); }} className={`px-5 py-2.5 text-sm font-medium border-b-2 ${activeTab === 'equipment' ? 'border-navy-600 text-navy-700' : 'border-transparent text-slate-500'}`}>비품</button>
        <button onClick={() => setActiveTab('permissions')} className={`px-5 py-2.5 text-sm font-medium border-b-2 ${activeTab === 'permissions' ? 'border-navy-600 text-navy-700' : 'border-transparent text-slate-500'}`}>신청 권한</button>
      </div>

      {msg && <div className={`mb-4 p-3 rounded text-sm ${msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}

      {activeTab !== 'permissions' && (
        <>
          <FilterBar
            search={search}
            onSearch={setSearch}
            searchPlaceholder={activeTab === 'equipment' ? '비품명/코드 검색' : '품목명/코드 검색'}
            filters={[
              ...(activeTab === 'consumable' ? [{
                key: 'major', label: '전체 대분류', value: majorFilter, onChange: (v: string) => { setMajorFilter(v); setMidFilter(''); setCatFilter(''); },
                options: (['MEDICAL','GENERAL','OFFICE'] as const).map(v => ({ value: v, label: MAJOR_GROUP_LABEL[v] })),
              }] : []),
              ...(activeTab === 'consumable' && majorFilter ? [{
                key: 'mid', label: '전체 중분류', value: midFilter, onChange: (v: string) => { setMidFilter(v); setCatFilter(''); },
                options: MID_CATEGORIES
                  .filter(m => m.major === majorFilter)
                  .map(m => ({ value: m.value, label: m.label })),
              }] : []),
              // 의료소모품은 소분류 단계 생략 (대분류=의료 일 때 소분류 필터 안 보임)
              ...(activeTab === 'equipment' || majorFilter !== 'MEDICAL' ? [{
                key: 'category',
                label: activeTab === 'equipment' ? '전체 비품분류' : '전체 소분류',
                value: catFilter, onChange: setCatFilter,
                options: activeTab === 'equipment'
                  ? EQUIPMENT_CATEGORIES.filter(c => (categoryCounts.get(c.value) ?? 0) > 0).map(c => ({ value: c.value, label: `${c.label} (${categoryCounts.get(c.value)})` }))
                  : CONSUMABLE_CATEGORIES
                      .filter(c => (categoryCounts.get(c.value) ?? 0) > 0)
                      .filter(c => !majorFilter || getMajor(c.value) === majorFilter)
                      .filter(c => !midFilter || getMidCategory(c.value)?.value === midFilter)
                      .map(c => ({ value: c.value, label: `${getMidCategory(c.value)?.label ?? c.group} › ${c.label} (${categoryCounts.get(c.value)})` })),
              }] : []),
              {
                key: 'expense_scope', label: '전체 비용구분', value: expenseScopeFilter, onChange: setExpenseScopeFilter,
                options: ITEM_EXPENSE_SCOPES.map(c => ({ value: c.value, label: c.label })),
              },
            ]}
            onReset={() => { setCatFilter(''); setMajorFilter(''); setMidFilter(''); setExpenseScopeFilter(''); setSearch(''); }}
          />

          {/* 일괄 선택 액션 바 */}
          {filtered.length > 0 && (
            <div className="card p-3 flex flex-wrap items-center gap-3 mb-3">
              <button
                onClick={toggleSelectAllVisible}
                className="inline-flex items-center gap-1.5 text-sm text-slate-700 hover:text-teal-600"
              >
                {filtered.every(i => selectedIds.has(i.id))
                  ? <CheckSquare className="w-4 h-4 text-teal-600" />
                  : <Square className="w-4 h-4" />}
                {filtered.every(i => selectedIds.has(i.id)) ? '전체 해제' : '전체 선택'}
              </button>
              <span className="text-sm text-slate-500">
                선택 <b className="text-teal-600">{selectedIds.size}</b>개 / 표시 {filtered.length}개
              </span>
              {selectedIds.size > 0 && (
                <>
                  <button onClick={openBulkEdit} className="btn-secondary inline-flex items-center gap-1 text-xs ml-auto">
                    <Edit3 className="w-3.5 h-3.5" />일괄 수정
                  </button>
                  <button onClick={bulkDelete} className="btn-secondary text-red-600 border-red-200 hover:bg-red-50 inline-flex items-center gap-1 text-xs">
                    <Trash2 className="w-3.5 h-3.5" />일괄 삭제
                  </button>
                  <button onClick={clearSelection} className="text-xs text-slate-400 hover:text-slate-600">선택 해제</button>
                </>
              )}
            </div>
          )}

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
        <div className="space-y-3">
          {/* 필터 + 저장 바 */}
          <div className="card p-3 flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder="품목명/코드 검색"
              value={permItemSearch}
              onChange={e => setPermItemSearch(e.target.value)}
              className="input w-48"
            />
            <select
              value={permMajorFilter}
              onChange={e => { setPermMajorFilter(e.target.value); setPermMidFilter(''); }}
              className="input"
            >
              <option value="">전체 대분류</option>
              {(['MEDICAL','GENERAL','OFFICE'] as const).map(v => (
                <option key={v} value={v}>{MAJOR_GROUP_LABEL[v]}</option>
              ))}
            </select>
            {permMajorFilter && permMajorFilter !== 'MEDICAL' && (
              <select value={permMidFilter} onChange={e => setPermMidFilter(e.target.value)} className="input">
                <option value="">전체 중분류</option>
                {MID_CATEGORIES.filter(m => m.major === permMajorFilter).map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            )}
            <span className="text-slate-300 text-xs px-1">|</span>
            <span className="text-sm text-slate-600">표시할 부서</span>
            <select value={permParentFilter} onChange={e => setPermParentFilter(e.target.value)} className="input">
              <option value="">전체</option>
              {deptGroups.map(({ parent, children }) => (
                children.length > 0 ? (
                  <optgroup key={parent.id} label={parent.name}>
                    <option value={parent.id}>{parent.name} 전체</option>
                    {children.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </optgroup>
                ) : (
                  <option key={parent.id} value={parent.id}>{parent.name}</option>
                )
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showOnlyDirtyDepts}
                onChange={e => setShowOnlyDirtyDepts(e.target.checked)}
                disabled={dirtyDeptIds.size === 0}
                className="cursor-pointer"
              />
              변경된 부서만
              {dirtyDeptIds.size > 0 && <span className="text-xs text-amber-600">({dirtyDeptIds.size})</span>}
            </label>
            <div className="ml-auto flex items-center gap-3">
              {dirtyCount > 0 && (
                <>
                  <span className="text-sm text-slate-600">변경 <b className="text-amber-600">{dirtyCount}</b>건</span>
                  <button
                    onClick={() => { setTargetPerms(new Map()); setSelectedRows(new Set()); }}
                    className="btn-secondary text-xs"
                  >
                    되돌리기
                  </button>
                </>
              )}
              <button
                onClick={savePermsBulk}
                disabled={permSaving || dirtyCount === 0}
                className="btn-primary"
              >
                {permSaving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>

          {/* 행 일괄 작업 바 — 보이는 부서에만 적용. 안 보이는 부서는 변경되지 않음 */}
          {selectedRows.size > 0 && (
            <div className="card p-3 flex flex-wrap items-center gap-3 bg-blue-50 border-blue-200">
              <span className="text-sm text-blue-800">선택 품목 <b>{selectedRows.size}</b>건</span>
              <button onClick={bulkRowsAllowAll} className="btn-secondary text-xs" title="현재 보이는 부서만 허용. 안 보이는 부서는 그대로 유지.">보이는 부서 일괄 허용</button>
              <button onClick={bulkRowsBlockAll} className="btn-secondary text-xs" title="현재 보이는 부서만 차단. 안 보이는 부서는 그대로 유지.">보이는 부서 일괄 차단</button>
              <button onClick={() => setSelectedRows(new Set())} className="text-xs text-slate-500 hover:underline ml-auto">선택 해제</button>
            </div>
          )}

          {/* 매트릭스 */}
          <div className="card p-0 overflow-hidden">
            {permLoading ? <EmptyState message="로딩 중..." /> : (
              <div className="overflow-auto" style={{ maxHeight: 'calc(100vh - 280px)' }}>
                <table className="text-sm border-collapse">
                  <thead>
                    <tr className="bg-slate-50">
                      <th className="px-2 py-2 sticky top-0 left-0 bg-slate-50 z-30 border-b border-r border-slate-200" style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          checked={visibleMatrixItems.length > 0 && visibleMatrixItems.every(i => selectedRows.has(i.id))}
                          onChange={toggleSelectAllRows}
                          className="cursor-pointer"
                        />
                      </th>
                      <th className="px-3 py-2 text-left sticky top-0 bg-slate-50 z-30 border-b border-r border-slate-200" style={{ minWidth: 220, left: 36 }}>품목</th>
                      <th className="px-2 py-2 text-center sticky top-0 bg-slate-50 z-20 border-b border-r border-slate-200 text-xs font-medium text-slate-600" style={{ minWidth: 72 }}>전체 허용</th>
                      {visibleDepts.map(d => (
                        <th
                          key={d.id}
                          className="px-1 py-2 text-center sticky top-0 bg-slate-50 z-20 border-b border-slate-200 text-xs font-medium text-slate-600"
                          style={{ minWidth: 64, maxWidth: 80 }}
                        >
                          <div className="truncate" title={d.name}>{d.name}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleMatrixItems.map(item => {
                      const allowed = getResolvedAllowed(item.id);
                      const visibleStatus = getVisibleStatus(item.id);
                      const isDirty = targetPerms.has(item.id);
                      const rowSelected = selectedRows.has(item.id);
                      const rowBg = isDirty ? 'bg-amber-50' : 'bg-white';
                      const pillStyle = visibleStatus === 'all'
                        ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                        : visibleStatus === 'partial'
                          ? 'bg-amber-50 text-amber-700 border-amber-200'
                          : 'bg-slate-100 text-slate-500 border-slate-300';
                      const pillLabel = visibleStatus === 'all' ? '전체' : visibleStatus === 'partial' ? '일부' : '차단';
                      const pillTitle = visibleStatus === 'all'
                        ? '보이는 부서 모두 허용 중. 클릭하면 보이는 부서만 일괄 차단 (안 보이는 부서는 변경 없음).'
                        : '클릭하면 보이는 부서를 모두 허용 (안 보이는 부서는 변경 없음).';
                      return (
                        <tr key={item.id} className={`border-b border-slate-100 hover:bg-slate-50/40`}>
                          <td className={`px-2 py-1.5 text-center sticky left-0 ${rowBg} border-r border-slate-100 z-10`}>
                            <input type="checkbox" checked={rowSelected} onChange={() => toggleRowSelected(item.id)} className="cursor-pointer" />
                          </td>
                          <td className={`px-3 py-1.5 sticky ${rowBg} border-r border-slate-100 z-10`} style={{ left: 36 }}>
                            <div className="flex flex-col">
                              <span className="font-medium text-sm text-slate-800">{item.name}</span>
                              <span className="font-mono text-[10px] text-slate-400">{item.item_code} · {getCategoryLabel(item.category)}</span>
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-center border-r border-slate-100">
                            <button
                              onClick={() => toggleVisibleScope(item.id)}
                              disabled={visibleDepts.length === 0}
                              className={`px-2 py-0.5 rounded-full text-xs font-medium border ${pillStyle} disabled:opacity-50`}
                              title={pillTitle}
                            >
                              {pillLabel}
                            </button>
                          </td>
                          {visibleDepts.map(d => (
                            <td key={d.id} className="px-1 py-1.5 text-center">
                              <input
                                type="checkbox"
                                checked={allowed.has(d.id)}
                                onChange={() => toggleCell(item.id, d.id)}
                                className="cursor-pointer"
                              />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                    {visibleMatrixItems.length === 0 && (
                      <tr>
                        <td colSpan={visibleDepts.length + 3} className="px-4 py-12 text-center text-slate-400 text-sm">
                          표시할 품목이 없습니다.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="text-xs text-slate-400">
            * "전체"는 권한 제한이 없어 모든 부서가 신청 가능한 상태입니다. "개별"로 전환하면 체크된 부서만 신청할 수 있습니다.
          </p>
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
                신규 등록: <span className="text-green-700">{importResult.created}건</span>
                {(importResult.updated ?? 0) > 0 && <span className="text-blue-700 ml-2">기존 업데이트: {importResult.updated}건</span>}
                {importResult.skipped > 0 && <span className="text-slate-500 ml-2">스킵: {importResult.skipped}건</span>}
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
          <FormField label="품목 코드">
            <input value={form.item_code} onChange={e => setForm(f => ({ ...f, item_code: e.target.value }))} className="input"
              placeholder={editing ? '' : '비우면 분류별 자동 생성 (MED/GEN/OFF/EQP-####)'} />
          </FormField>
          <FormField label="분류" required>
            <select value={form.category} onChange={e => {
              const cat = e.target.value;
              // 분류 변경 시 비용구분도 자동 추천 (사용자가 명시 변경 안 하면 카테고리 prefix 따라감)
              const inferredScope = inferExpenseScopeFromCategory(cat);
              setForm(f => ({
                ...f,
                category: cat,
                expense_scope: inferredScope,
                ...(cat.startsWith('EQUIP_') && { is_regular_order: false }),
              }));
            }} className="input">
              <optgroup label="-- 소모품 --">
                {CONSUMABLE_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </optgroup>
              <optgroup label="-- 비품 --">
                {EQUIPMENT_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </optgroup>
              {userMids.length > 0 && (
                <optgroup label="-- 사용자 추가 분류 --">
                  {userMids.map(m => <option key={m.code} value={m.code}>{m.major_label} › {m.name}</option>)}
                </optgroup>
              )}
            </select>
            {form.category.startsWith('EQUIP_') && (
              <p className="text-xs text-blue-600 mt-1">비품은 불출 시 일련번호(EQ-YYYY-NNNNN)가 자동 부여됩니다.</p>
            )}
          </FormField>
          <FormField label="대분류 / 중분류">
            <div className="input bg-slate-50 text-slate-600 cursor-not-allowed flex items-center justify-between">
              <span>{MAJOR_GROUP_LABEL[getMajor(form.category)]}{(() => { const m = getMidCategory(form.category); return m ? ` › ${m.label}` : ''; })()}</span>
              <span className="text-[10px] text-slate-400">분류에 따라 자동</span>
            </div>
          </FormField>
          <FormField label="소분류 (선택)">
            <input
              value={form.sub_category}
              onChange={e => setForm(f => ({ ...f, sub_category: e.target.value }))}
              className="input"
              placeholder="규격/사이즈 등 (예: 14Fr, 3호)"
            />
          </FormField>
          <FormField label="비용구분" required>
            <select value={form.expense_scope} onChange={e => setForm(f => ({ ...f, expense_scope: e.target.value }))} className="input">{ITEM_EXPENSE_SCOPES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
          </FormField>
          <div className="col-span-2">
            <FormField label="품목명" required>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" />
            </FormField>
          </div>
          <FormField label="발주단위" required>
            <input
              value={form.purchase_uom}
              onChange={e => setForm(f => ({
                ...f,
                purchase_uom: e.target.value,
                // 불출단위가 비어 있으면 같이 채워줌
                issue_uom: f.issue_uom || e.target.value,
              }))}
              placeholder="예: 박스"
              className="input"
            />
          </FormField>
          <FormField label="불출단위" required>
            <input
              value={form.issue_uom}
              onChange={e => setForm(f => ({ ...f, issue_uom: e.target.value }))}
              placeholder="예: 개"
              className="input"
            />
          </FormField>
          <FormField label={`포장변환비율 (1${form.purchase_uom || '발주단위'} = ? ${form.issue_uom || '불출단위'})`}>
            <input
              type="number"
              min={1}
              step={1}
              value={form.pack_size}
              onChange={e => setForm(f => ({ ...f, pack_size: Math.max(1, Math.floor(Number(e.target.value) || 1)) }))}
              className="input"
            />
            {form.pack_size > 1 && form.purchase_uom && form.issue_uom && form.purchase_uom !== form.issue_uom && (
              <p className="text-xs text-slate-500 mt-1">1{form.purchase_uom} = {form.pack_size}{form.issue_uom} (재고/불출은 {form.issue_uom} 단위로 관리)</p>
            )}
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
          <div className="col-span-2">
            <FormField label="기본 처치 (환자 매핑 자동 추론용)">
              <select
                value={form.default_treatment_type_id}
                onChange={e => setForm(f => ({ ...f, default_treatment_type_id: e.target.value }))}
                className="input"
              >
                <option value="">없음 (자동 추론에 영향 없음)</option>
                {treatmentTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <p className="text-xs text-slate-500 mt-1">
                같은 품목이 여러 처치에 매핑된 경우, 신청 시점 환자 추가의 기본값으로 사용됩니다.
              </p>
            </FormField>
          </div>
          <div className="col-span-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_regular_order} onChange={e => setForm(f => ({ ...f, is_regular_order: e.target.checked }))} />정기 발주 품목</label></div>
          <div className="col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.diaper_companion_for_wards} onChange={e => setForm(f => ({ ...f, diaper_companion_for_wards: e.target.checked }))} />
              병동에서 기저귀 신청과 같이 (예: 물티슈)
            </label>
            <p className="text-xs text-slate-500 ml-6 mt-0.5">
              체크하면 병동 사용자에게 — 기저귀 신청 화면에 노출 + 일반소모품 신청에서 숨김. 다른 부서엔 영향 없음.
            </p>
          </div>
          {modal === 'edit' && editing && (
            <div className="col-span-2 pt-2 border-t border-slate-100">
              <FormField label="제품 이미지">
                <div className="flex items-center gap-4">
                  {editingImageUrl ? <img src={editingImageUrl} alt="제품" loading="lazy" className="w-20 h-20 object-contain bg-slate-50 rounded border border-slate-200" /> : <div className="w-20 h-20 border border-dashed border-slate-300 rounded flex items-center justify-center text-xs text-slate-400">없음</div>}
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

      {/* 일괄 수정 모달 */}
      <Modal
        open={bulkEditModal}
        onClose={() => setBulkEditModal(false)}
        title={`일괄 수정 — ${selectedIds.size}개 선택`}
        size="md"
        footer={
          <>
            <button onClick={() => setBulkEditModal(false)} className="btn-secondary">취소</button>
            <button onClick={bulkSave} disabled={bulkSaving} className="btn-primary">
              {bulkSaving ? '저장 중...' : '적용'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            변경할 필드만 선택해서 입력하세요. 비워두면 변경 안됨.
          </p>
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-1.5 block">분류 변경</label>
            <select
              value={bulkPatch.category ?? ''}
              onChange={e => setBulkPatch(p => ({ ...p, category: e.target.value || undefined }))}
              className="input w-full"
            >
              <option value="">— 변경 안함 —</option>
              <optgroup label="-- 소모품 --">
                {CONSUMABLE_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.group} / {c.label}</option>)}
              </optgroup>
              <optgroup label="-- 비품 --">
                {EQUIPMENT_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </optgroup>
              {userMids.length > 0 && (
                <optgroup label="-- 사용자 추가 분류 --">
                  {userMids.map(m => <option key={m.code} value={m.code}>{m.major_label} / {m.name}</option>)}
                </optgroup>
              )}
            </select>
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-1.5 block">비용구분 변경</label>
            <select
              value={bulkPatch.expense_scope ?? ''}
              onChange={e => setBulkPatch(p => ({ ...p, expense_scope: e.target.value || undefined }))}
              className="input w-full"
            >
              <option value="">— 변경 안함 —</option>
              {ITEM_EXPENSE_SCOPES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm font-semibold text-slate-700 mb-1.5 block">기본 업체 변경</label>
            <select
              value={bulkPatch.default_vendor_id ?? ''}
              onChange={e => setBulkPatch(p => ({ ...p, default_vendor_id: e.target.value }))}
              className="input w-full"
            >
              <option value="">— 변경 안함 —</option>
              <option value=" ">(업체 없음으로 설정)</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
        </div>
      </Modal>
    </div>
  );
}
