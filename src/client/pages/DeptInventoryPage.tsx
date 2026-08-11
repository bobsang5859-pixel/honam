// 부서 재고관리 — 부서 직원이 자기 보관함의 소모품·비품 현황을 보고 수정.
// 소모품: 수량 직접 입력(덮어쓰기), 타 부서로 대여 가능.
// 비품: 시리얼별 상태/위치 표시.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { PageHeader, FilterBar, FilterChips, EmptyState, Modal } from '../components/ui';
import type { FilterChip } from '../components/ui';
import { Boxes, Save, ArrowLeftRight, Wrench } from 'lucide-react';
import { getMajor, MAJOR_GROUP_LABEL, type MajorGroup } from '@shared/types';

interface DeptInventoryRow {
  id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  category: string;
  uom: string;
  on_hand_qty: number;
  updated_at: string;
}
interface EquipmentRow {
  id: string;
  serial_no: string;
  item_id: string;
  item_name: string;
  item_code: string;
  category?: string;
  location: string;
  is_primary: boolean;
  status: 'ACTIVE' | 'IN_REPAIR' | 'DISPOSED';
  notes: string;
  created_at: string;
}
interface Department {
  id: string;
  name: string;
}

const MAJOR_BG: Record<string, string> = {
  MEDICAL: 'bg-rose-100 text-rose-700',
  GENERAL: 'bg-sky-100 text-sky-700',
  DIAPER: 'bg-amber-100 text-amber-700',
  OFFICE: 'bg-indigo-100 text-indigo-700',
  EQUIPMENT: 'bg-emerald-100 text-emerald-700',
};
const EQ_STATUS_LABEL: Record<string, string> = { ACTIVE: '정상', IN_REPAIR: '수리중', DISPOSED: '폐기' };
const EQ_STATUS_CLS: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  IN_REPAIR: 'bg-yellow-100 text-yellow-800',
  DISPOSED: 'bg-gray-100 text-gray-500',
};

export default function DeptInventoryPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [tab, setTab] = useState<'consumable' | 'equipment'>('consumable');

  // 소모품
  const [rows, setRows] = useState<DeptInventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [majorFilter, setMajorFilter] = useState<MajorGroup | ''>('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  // 비품
  const [equipments, setEquipments] = useState<EquipmentRow[]>([]);
  const [eqLoading, setEqLoading] = useState(true);

  // 대여 모달
  const [loanRow, setLoanRow] = useState<DeptInventoryRow | null>(null);
  const [loanForm, setLoanForm] = useState({ to_department_id: '', qty: 0, note: '' });
  const [loanSubmitting, setLoanSubmitting] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);

  const loadConsumables = () => {
    setLoading(true);
    api('/inventory')
      .then((data: any[]) => setRows(Array.isArray(data) ? data : []))
      .catch(() => showToast('재고 목록을 불러오지 못했습니다.', 'error'))
      .finally(() => setLoading(false));
  };

  const loadEquipments = () => {
    setEqLoading(true);
    api('/equipment-units/my-dept')
      .then((data: any[]) => setEquipments(Array.isArray(data) ? data : []))
      .catch(() => showToast('비품 목록을 불러오지 못했습니다.', 'error'))
      .finally(() => setEqLoading(false));
  };

  useEffect(() => {
    loadConsumables();
    loadEquipments();
    api('/departments')
      .then((d: any[]) => setDepartments(Array.isArray(d) ? d.filter(x => x.id !== user?.department_id) : []))
      .catch(() => setDepartments([]));
  }, [user?.department_id]);

  const filtered = useMemo(() => rows.filter(r => {
    if (search && !r.item_name.includes(search) && !r.item_code.includes(search)) return false;
    if (majorFilter && getMajor(r.category ?? '') !== majorFilter) return false;
    return true;
  }), [rows, search, majorFilter]);

  const chips: FilterChip[] = [];
  if (search) chips.push({ key: 'search', label: '검색', value: search, onRemove: () => setSearch('') });
  if (majorFilter) chips.push({ key: 'major', label: '분류', value: MAJOR_GROUP_LABEL[majorFilter], onRemove: () => setMajorFilter('') });

  const saveQty = async (row: DeptInventoryRow) => {
    const raw = drafts[row.item_id];
    if (raw == null) return;
    const qty = Number(String(raw).replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(qty) || qty < 0) { showToast('0 이상의 숫자만 입력 가능합니다.', 'error'); return; }
    setSaving(s => ({ ...s, [row.item_id]: true }));
    try {
      await api('/ward-requests/register-stock', {
        method: 'POST',
        body: JSON.stringify({ items: [{ item_id: row.item_id, current_stock_qty: qty }] }),
      });
      showToast(`${row.item_name} 재고를 ${qty}로 저장했습니다.`, 'success');
      setDrafts(d => { const n = { ...d }; delete n[row.item_id]; return n; });
      loadConsumables();
    } catch (e: any) {
      showToast(e?.message || '저장 실패', 'error');
    } finally {
      setSaving(s => ({ ...s, [row.item_id]: false }));
    }
  };

  const openLoan = (row: DeptInventoryRow) => {
    setLoanRow(row);
    setLoanForm({ to_department_id: '', qty: Math.min(Number(row.on_hand_qty), 1), note: '' });
  };

  const submitLoan = async () => {
    if (!loanRow) return;
    if (!loanForm.to_department_id) { showToast('대상 부서를 선택해주세요.', 'error'); return; }
    if (loanForm.qty <= 0) { showToast('대여 수량은 1 이상이어야 합니다.', 'error'); return; }
    if (loanForm.qty > Number(loanRow.on_hand_qty)) { showToast('보유 수량을 초과할 수 없습니다.', 'error'); return; }
    setLoanSubmitting(true);
    try {
      await api('/loans', {
        method: 'POST',
        body: JSON.stringify({
          from_department_id: user?.department_id,
          to_department_id: loanForm.to_department_id,
          item_id: loanRow.item_id,
          qty: loanForm.qty,
          note: loanForm.note,
        }),
      });
      showToast('대여가 등록되었습니다.', 'success');
      setLoanRow(null);
      loadConsumables();
    } catch (e: any) {
      showToast(e?.message || '대여 등록 실패', 'error');
    } finally {
      setLoanSubmitting(false);
    }
  };

  return (
    <div>
      <PageHeader icon={Boxes} title="재고관리" description="부서 보관함 재고를 관리합니다 (소모품 · 비품)" />

      <div className="flex gap-2 mb-4">
        {([
          { key: 'consumable' as const, label: '소모품', count: rows.length },
          { key: 'equipment' as const, label: '비품', count: equipments.length },
        ]).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold border transition-colors ${tab === t.key ? 'bg-teal-600 text-white border-teal-600' : 'bg-gray-100 text-slate-700 border-gray-200 hover:border-slate-300'}`}>
            {t.label}
            <span className={`inline-flex min-w-5 h-5 px-1 items-center justify-center rounded-full text-xs ${tab === t.key ? 'bg-white/30 text-white' : 'bg-slate-200 text-slate-600'}`}>{t.count}</span>
          </button>
        ))}
      </div>

      {tab === 'consumable' && (
        <>
          <FilterBar
            search={search}
            onSearch={setSearch}
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
                onChange: (v) => setMajorFilter(v as MajorGroup | ''),
              },
            ]}
            onReset={() => { setSearch(''); setMajorFilter(''); }}
          />
          <FilterChips chips={chips} totalCount={filtered.length} onResetAll={() => { setSearch(''); setMajorFilter(''); }} />

          {loading ? (
            <div className="card p-8 text-center text-slate-400">불러오는 중...</div>
          ) : filtered.length === 0 ? (
            <div className="card"><EmptyState message="해당하는 재고가 없습니다." /></div>
          ) : (
            <div className="card p-0 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-left">분류</th>
                    <th className="px-3 py-2 text-left">품목</th>
                    <th className="px-3 py-2 text-center">단위</th>
                    <th className="px-3 py-2 text-right">현재 수량</th>
                    <th className="px-3 py-2 text-right">실사 입력</th>
                    <th className="px-3 py-2 text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const major = getMajor(r.category ?? '');
                    const draftValue = drafts[r.item_id];
                    const isDirty = draftValue != null && Number(draftValue) !== Number(r.on_hand_qty);
                    return (
                      <tr key={r.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${MAJOR_BG[major] ?? 'bg-slate-100 text-slate-600'}`}>
                            {MAJOR_GROUP_LABEL[major]}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{r.item_name}</div>
                          <div className="text-xs text-slate-400 font-mono">{r.item_code}</div>
                        </td>
                        <td className="px-3 py-2 text-center text-xs">{r.uom}</td>
                        <td className="px-3 py-2 text-right font-semibold">{Number(r.on_hand_qty)}</td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            min={0}
                            className="input w-24 text-right text-sm"
                            placeholder={String(Number(r.on_hand_qty))}
                            value={draftValue ?? ''}
                            onChange={e => setDrafts(d => ({ ...d, [r.item_id]: e.target.value }))}
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            {isDirty && (
                              <button
                                onClick={() => saveQty(r)}
                                disabled={!!saving[r.item_id]}
                                className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
                              >
                                <Save className="w-3.5 h-3.5" />{saving[r.item_id] ? '저장 중' : '저장'}
                              </button>
                            )}
                            <button
                              onClick={() => openLoan(r)}
                              className="text-xs text-amber-600 hover:underline inline-flex items-center gap-1"
                              title="타 부서로 대여"
                            >
                              <ArrowLeftRight className="w-3.5 h-3.5" />대여
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'equipment' && (
        <>
          {eqLoading ? (
            <div className="card p-8 text-center text-slate-400">불러오는 중...</div>
          ) : equipments.length === 0 ? (
            <div className="card"><EmptyState icon={Wrench} message="보유 비품이 없습니다." /></div>
          ) : (
            <div className="card p-0 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-left">시리얼</th>
                    <th className="px-3 py-2 text-left">품목</th>
                    <th className="px-3 py-2 text-center">위치</th>
                    <th className="px-3 py-2 text-center">정/부</th>
                    <th className="px-3 py-2 text-center">상태</th>
                    <th className="px-3 py-2 text-left">메모</th>
                  </tr>
                </thead>
                <tbody>
                  {equipments.map(eq => (
                    <tr key={eq.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-mono text-xs text-blue-700">{eq.serial_no}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{eq.item_name}</div>
                        <div className="text-xs text-slate-400">{eq.item_code}</div>
                      </td>
                      <td className="px-3 py-2 text-center text-xs">{eq.location || '-'}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded font-medium ${eq.is_primary ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                          {eq.is_primary ? '정' : '부'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded ${EQ_STATUS_CLS[eq.status]}`}>
                          {EQ_STATUS_LABEL[eq.status]}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">{eq.notes || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* 대여 등록 모달 */}
      <Modal
        open={loanRow !== null}
        onClose={() => { if (!loanSubmitting) setLoanRow(null); }}
        title="타 부서로 대여"
        footer={
          <>
            <button onClick={() => setLoanRow(null)} disabled={loanSubmitting} className="btn-secondary">취소</button>
            <button onClick={submitLoan} disabled={loanSubmitting} className="btn-primary inline-flex items-center gap-1.5">
              <ArrowLeftRight className="w-4 h-4" /> {loanSubmitting ? '처리 중...' : '대여 등록'}
            </button>
          </>
        }
      >
        {loanRow && (
          <div className="space-y-3 text-sm">
            <div>
              <span className="label">품목</span>
              <p className="font-medium">{loanRow.item_name}</p>
              <p className="text-xs text-slate-400">현재 보유: {Number(loanRow.on_hand_qty)} {loanRow.uom}</p>
            </div>
            <div>
              <label className="label">받는 부서 *</label>
              <select
                value={loanForm.to_department_id}
                onChange={e => setLoanForm(f => ({ ...f, to_department_id: e.target.value }))}
                className="input"
              >
                <option value="">선택...</option>
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">대여 수량 *</label>
              <input
                type="number"
                min={1}
                max={Number(loanRow.on_hand_qty)}
                value={loanForm.qty}
                onChange={e => setLoanForm(f => ({ ...f, qty: Math.max(0, Number(e.target.value) || 0) }))}
                className="input"
              />
              <p className="mt-1 text-xs text-amber-700">
                ⓘ 빌리는 부서의 재고는 빌린 수량({loanForm.qty || 0})으로 덮어쓰기 됩니다 (기존 값 무시). 반환 절차는 없습니다.
              </p>
            </div>
            <div>
              <label className="label">사유 (선택)</label>
              <input
                type="text"
                value={loanForm.note}
                onChange={e => setLoanForm(f => ({ ...f, note: e.target.value }))}
                className="input"
                placeholder="응급 처치용, 일시 부족 등"
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
