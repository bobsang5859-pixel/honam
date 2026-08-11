import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FileText, Plus, Trash2, Printer, X, Save, AlertTriangle, ArrowRightLeft } from 'lucide-react';
import { api, downloadBlob, getToken } from '../utils/api';
import { useToast } from '../components/Toast';
import { PageHeader, EmptyState, Modal, DateRangeFilter, inDateRange } from '../components/ui';
import type { DateRange } from '../components/ui';
import { getMajor, MAJOR_GROUP_LABEL, type MajorGroup } from '@shared/types';
import type { Vendor } from '@shared/types';

const MAJOR_LABEL_KO: Record<string, string> = { MEDICAL: '의료', GENERAL: '일반', DIAPER: '기저귀', OFFICE: '사무', EQUIPMENT: '비품' };
const MAJOR_BG: Record<string, string> = {
  MEDICAL: 'bg-rose-100 text-rose-700',
  GENERAL: 'bg-sky-100 text-sky-700',
  DIAPER: 'bg-amber-100 text-amber-700',
  OFFICE: 'bg-indigo-100 text-indigo-700',
  EQUIPMENT: 'bg-emerald-100 text-emerald-700',
};

interface DecisionItem {
  item_id?: string;
  item_code?: string;
  name: string;
  spec: string;
  unit?: string;
  pack_size?: number;
  category?: string;
  qty: number;
  unit_price: number;
  comment?: string;
}

interface Decision {
  id: string;
  decision_no: string;
  title: string;
  vendor_id: string;
  vendor_name: string;
  doc_date: string;
  period_label: string;
  period_from: string | null;
  period_to: string | null;
  dept_label: string;
  approver_lines: string[];
  comment: string;
  items: DecisionItem[];
  source_po_ids: string[];
  used_in_po_id: string | null;
  used_in_po_no: string | null;
  status: 'DRAFT' | 'LOCKED';
  creator_name: string;
  created_at: string;
  updated_at: string;
  category_breakdown?: Record<string, number>;
  total_amount?: number;
}

const DEFAULT_APPROVERS = ['담당', '부서장', '행정원장', '상임이사', '이사장'];

// ── 엑셀 스타일 시트 에디터 ─────────────────────────────────────
// 메타·라인·합계·비고가 한 장의 표 안에서 셀 단위 편집되도록.
// - 셀에 클릭하면 입력 가능, Tab/Shift+Tab 으로 옆 셀 이동, Enter 로 같은 컬럼 다음 행 (라인 영역)
// - 라인 영역 마지막 빈 행은 자동으로 1줄 더 노출 (입력하면 다음 빈 행 추가)
// - 금액 셀은 자동 계산 (회색)
function SheetEditor(props: {
  editing: Decision;
  setEditing: (d: Decision) => void;
  vendors: Vendor[];
  itemMaster: any[];   // 품목 마스터 — 행 추가 시 검색해서 선택
  updateLine: (idx: number, patch: Partial<DecisionItem>) => void;
  addLine: () => void;
  addLineFromItem: (item: any) => void;
  removeLine: (idx: number) => void;
  totalAmount: (items: DecisionItem[]) => number;
  onMoveItemToVendor: (idx: number, vendor_id: string) => Promise<void>;
  onRequestRemoveLine: (idx: number) => Promise<void>;  // X 클릭 → 재고 체크 후 결정
}) {
  const { editing, setEditing, vendors, itemMaster, updateLine, addLine, addLineFromItem, removeLine, totalAmount, onMoveItemToVendor, onRequestRemoveLine } = props;
  const [moveMenuRow, setMoveMenuRow] = useState<number | null>(null);
  const [vendorSearch, setVendorSearch] = useState('');
  const filteredVendors = vendors
    .filter(v => v.id !== editing.vendor_id)
    .filter(v => !vendorSearch.trim() || (v.name ?? '').toLowerCase().includes(vendorSearch.trim().toLowerCase()));
  const movingItem = moveMenuRow !== null ? editing.items[moveMenuRow] : null;

  // 숫자 셀 입력 중 raw text 보존 (toLocaleString이 "1." 같은 입력 중간 상태의 소수점을 잘라먹는 문제 회피)
  const [editingNum, setEditingNum] = useState<{ row: number; col: 'qty' | 'unit_price'; text: string } | null>(null);

  // 품목 검색 — 행 추가 헤더의 검색창
  const [itemSearch, setItemSearch] = useState('');
  const itemSearchResults = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    if (!q) return [];
    return itemMaster
      .filter((it: any) => {
        const name = String(it.name ?? '').toLowerCase();
        const code = String(it.item_code ?? '').toLowerCase();
        const spec = String(it.sub_category ?? '').toLowerCase();
        return name.includes(q) || code.includes(q) || spec.includes(q);
      })
      .slice(0, 20);
  }, [itemSearch, itemMaster]);

  // 마지막 라인이 비어있지 않으면 자동으로 빈 행 1개 추가
  const ensureTrailingEmpty = () => {
    const last = editing.items[editing.items.length - 1];
    if (!last || last.name.trim() || last.spec.trim() || last.qty || last.unit_price) {
      addLine();
    }
  };

  // 라인 표 컬럼 순서 — 방향키 좌우 이동에 사용(금액 칸은 계산값이라 편집 불가라 제외)
  const LINE_COL_ORDER = ['name', 'spec', 'qty', 'unit_price', 'comment'];

  // 라인 영역에서 Tab/Enter/방향키 처리: 자동 행 추가 + 엑셀 같은 셀 이동
  const onLineKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, rowIdx: number) => {
    // 마지막 행에서 Tab/Enter 누르면 새 행 자동 추가 (포커스 이동은 default 동작)
    if (rowIdx === editing.items.length - 1) {
      if (e.key === 'Tab' || e.key === 'Enter') {
        const last = editing.items[rowIdx];
        if (last && (last.name.trim() || last.qty || last.unit_price)) {
          addLine();
        }
      }
    }
    // Enter 는 같은 컬럼 다음 행으로 이동 (default 폼 제출 방지)
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = e.currentTarget;
      const colName = target.dataset.col;
      const nextRow = rowIdx + 1;
      // 다음 행의 같은 컬럼 input 찾기
      setTimeout(() => {
        const next = document.querySelector<HTMLInputElement>(`[data-row="${nextRow}"][data-col="${colName}"]`);
        next?.focus();
      }, 0);
      return;
    }
    // ↑↓ — 같은 컬럼의 위/아래 행으로 한 칸 이동
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const colName = e.currentTarget.dataset.col;
      const nextRow = rowIdx + (e.key === 'ArrowUp' ? -1 : 1);
      if (nextRow < 0 || nextRow > editing.items.length - 1) return;
      const next = document.querySelector<HTMLInputElement>(`[data-row="${nextRow}"][data-col="${colName}"]`);
      next?.focus();
      next?.select();
      return;
    }
    // ←→ — 텍스트 커서가 이미 그 방향 끝에 있을 때만 옆 칸으로 이동(중간이면 기본 커서 이동 유지)
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const el = e.currentTarget;
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
      const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
      const goLeft = e.key === 'ArrowLeft' && atStart;
      const goRight = e.key === 'ArrowRight' && atEnd;
      if (!goLeft && !goRight) return;
      e.preventDefault();
      const colName = el.dataset.col!;
      const ci = LINE_COL_ORDER.indexOf(colName);
      const nextCi = ci + (goLeft ? -1 : 1);
      if (nextCi < 0 || nextCi > LINE_COL_ORDER.length - 1) return;
      const next = document.querySelector<HTMLInputElement>(`[data-row="${rowIdx}"][data-col="${LINE_COL_ORDER[nextCi]}"]`);
      next?.focus();
      next?.select();
    }
  };

  // 셀 공통 스타일 — 엑셀 같은 가벼운 테두리, 포커스 시 강조
  const cellStyle: React.CSSProperties = {
    width: '100%',
    border: 'none',
    background: 'transparent',
    padding: '6px 8px',
    fontSize: 14,
    outline: 'none',
  };
  const cellFocusStyle = `focus:bg-yellow-50 focus:ring-2 focus:ring-blue-300 focus:ring-inset`;

  return (
    <div className="border border-slate-300 rounded overflow-hidden bg-white">
      <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 110 }} />
          <col />
          <col style={{ width: 110 }} />
          <col />
        </colgroup>
        <tbody>
          {/* 메타 영역 */}
          <tr className="border-b border-slate-300">
            <th className="bg-slate-100 px-2 py-1 text-left text-xs text-slate-700 border-r border-slate-300 font-medium">제목</th>
            <td colSpan={3} className="border-r border-slate-300">
              <input type="text" value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} className={cellFocusStyle} style={cellStyle} placeholder="예: 5월 1주 의료소모품 구매" />
            </td>
          </tr>
          <tr className="border-b border-slate-300">
            <th className="bg-slate-100 px-2 py-1 text-left text-xs text-slate-700 border-r border-slate-300 font-medium">거래처</th>
            <td className="border-r border-slate-300">
              <select value={editing.vendor_id} onChange={e => setEditing({ ...editing, vendor_id: e.target.value })} className={cellFocusStyle} style={cellStyle}>
                <option value="">선택...</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </td>
            <th className="bg-slate-100 px-2 py-1 text-left text-xs text-slate-700 border-r border-slate-300 font-medium">청구부서</th>
            <td>
              <input type="text" value={editing.dept_label} onChange={e => setEditing({ ...editing, dept_label: e.target.value })} className={cellFocusStyle} style={cellStyle} placeholder="의료부 / 총무부" />
            </td>
          </tr>
          <tr className="border-b border-slate-300">
            <th className="bg-slate-100 px-2 py-1 text-left text-xs text-slate-700 border-r border-slate-300 font-medium">작성일자</th>
            <td className="border-r border-slate-300">
              <input type="date" value={editing.doc_date} onChange={e => setEditing({ ...editing, doc_date: e.target.value })} className={cellFocusStyle} style={cellStyle} />
            </td>
            <th className="bg-slate-100 px-2 py-1 text-left text-xs text-slate-700 border-r border-slate-300 font-medium">회차</th>
            <td>
              <input type="text" value={editing.period_label} onChange={e => setEditing({ ...editing, period_label: e.target.value })} className={cellFocusStyle} style={cellStyle} placeholder="05월1주" />
            </td>
          </tr>
          <tr className="border-b border-slate-300">
            <th className="bg-slate-100 px-2 py-1 text-left text-xs text-slate-700 border-r border-slate-300 font-medium">사용기간</th>
            <td colSpan={3} className="px-2 py-1">
              <div className="flex items-center gap-2">
                <input type="date" value={editing.period_from?.slice(0, 10) ?? ''} onChange={e => setEditing({ ...editing, period_from: e.target.value || null })} className={cellFocusStyle} style={{ ...cellStyle, width: 140 }} />
                <span className="text-slate-400">~</span>
                <input type="date" value={editing.period_to?.slice(0, 10) ?? ''} onChange={e => setEditing({ ...editing, period_to: e.target.value || null })} className={cellFocusStyle} style={{ ...cellStyle, width: 140 }} />
              </div>
            </td>
          </tr>
          <tr className="border-b border-slate-300">
            <th className="bg-slate-100 px-2 py-1 text-left text-xs text-slate-700 border-r border-slate-300 font-medium">결재라인</th>
            <td colSpan={3}>
              <input type="text" value={editing.approver_lines.join(', ')} onChange={e => setEditing({ ...editing, approver_lines: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} className={cellFocusStyle} style={cellStyle} placeholder="담당, 부서장, 행정원장, 상임이사, 이사장" />
            </td>
          </tr>
        </tbody>
      </table>

      {/* 라인 영역 — 별도 표 (다른 컬럼 폭) */}
      <div className="border-t-2 border-slate-400 bg-slate-50 px-3 py-1.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs font-semibold text-slate-700">품목 ({editing.items.length})</span>
          <div className="relative flex items-center gap-2 flex-1 max-w-xl ml-auto">
            <input
              type="text"
              placeholder="품목 검색 (코드 / 이름 / 규격) → 클릭하면 행 추가"
              value={itemSearch}
              onChange={e => setItemSearch(e.target.value)}
              className="text-xs px-2 py-1 border border-slate-200 rounded flex-1 bg-white focus:outline-none focus:border-blue-400"
            />
            <button
              onClick={addLine}
              className="text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded inline-flex items-center gap-0.5 border border-blue-200"
              title="자유입력 빈 행 추가"
            >
              <Plus className="w-3 h-3" /> 빈 행
            </button>
            {itemSearchResults.length > 0 && (
              <div className="absolute top-full right-0 left-0 mt-1 z-20 bg-white border border-slate-200 rounded-md shadow-lg max-h-72 overflow-y-auto">
                {itemSearchResults.map((it: any) => (
                  <button
                    key={it.id}
                    onClick={() => { addLineFromItem(it); setItemSearch(''); }}
                    className="w-full text-left px-3 py-1.5 hover:bg-blue-50 border-b border-slate-100 last:border-b-0 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-slate-400">{it.item_code}</span>
                      <span className="font-medium">{it.name}</span>
                      {it.sub_category && <span className="text-xs text-slate-500">({it.sub_category})</span>}
                      <span className="ml-auto text-xs text-slate-400">{it.purchase_uom ?? it.uom ?? ''}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 36 }} />
          <col />
          <col style={{ width: 110 }} />
          <col style={{ width: 70 }} />
          <col style={{ width: 100 }} />
          <col style={{ width: 110 }} />
          <col style={{ width: 130 }} />
          <col style={{ width: 60 }} />
        </colgroup>
        <thead>
          <tr className="bg-slate-100 border-y border-slate-300">
            <th className="px-1 py-1 text-center text-xs text-slate-700 border-r border-slate-300">NO</th>
            <th className="px-2 py-1 text-center text-xs text-slate-700 border-r border-slate-300">품명</th>
            <th className="px-2 py-1 text-center text-xs text-slate-700 border-r border-slate-300">규격</th>
            <th className="px-2 py-1 text-center text-xs text-slate-700 border-r border-slate-300">수량</th>
            <th className="px-2 py-1 text-center text-xs text-slate-700 border-r border-slate-300">단가</th>
            <th className="px-2 py-1 text-center text-xs text-slate-700 border-r border-slate-300">금액</th>
            <th className="px-2 py-1 text-center text-xs text-slate-700 border-r border-slate-300">비고</th>
            <th className="px-1 py-1 text-center text-xs text-slate-700">조작</th>
          </tr>
        </thead>
        <tbody>
          {editing.items.length === 0 ? (
            <tr>
              <td colSpan={8} className="text-center py-6 text-slate-400 text-xs">
                "행 추가" 또는 발주서에서 가져오기로 품목 입력
              </td>
            </tr>
          ) : editing.items.map((it, idx) => (
            <tr key={idx} className="border-b border-slate-200 hover:bg-slate-50/40">
              <td className="text-center text-xs text-slate-400 border-r border-slate-200">{idx + 1}</td>
              <td className="border-r border-slate-200">
                <input
                  type="text" value={it.name}
                  onChange={e => updateLine(idx, { name: e.target.value })}
                  onKeyDown={e => onLineKeyDown(e, idx)}
                  onFocus={ensureTrailingEmpty}
                  data-row={idx} data-col="name"
                  className={cellFocusStyle} style={cellStyle}
                />
              </td>
              <td className="border-r border-slate-200">
                <input
                  type="text" value={it.spec}
                  onChange={e => updateLine(idx, { spec: e.target.value })}
                  onKeyDown={e => onLineKeyDown(e, idx)}
                  data-row={idx} data-col="spec"
                  className={cellFocusStyle} style={cellStyle}
                />
              </td>
              <td className="border-r border-slate-200">
                <input
                  type="text" inputMode="decimal"
                  value={
                    editingNum?.row === idx && editingNum.col === 'qty'
                      ? editingNum.text
                      : (it.qty ? it.qty.toLocaleString('ko-KR', { maximumFractionDigits: 4 }) : '')
                  }
                  onChange={e => {
                    setEditingNum({ row: idx, col: 'qty', text: e.target.value });
                    updateLine(idx, { qty: Number(e.target.value.replace(/[^0-9.-]/g, '')) || 0 });
                  }}
                  onBlur={() => setEditingNum(null)}
                  onKeyDown={e => onLineKeyDown(e, idx)}
                  data-row={idx} data-col="qty"
                  className={cellFocusStyle} style={{ ...cellStyle, textAlign: 'right' }}
                />
              </td>
              <td className="border-r border-slate-200">
                <input
                  type="text" inputMode="decimal"
                  value={
                    editingNum?.row === idx && editingNum.col === 'unit_price'
                      ? editingNum.text
                      : (it.unit_price ? it.unit_price.toLocaleString('ko-KR', { maximumFractionDigits: 4 }) : '')
                  }
                  onChange={e => {
                    setEditingNum({ row: idx, col: 'unit_price', text: e.target.value });
                    updateLine(idx, { unit_price: Number(e.target.value.replace(/[^0-9.-]/g, '')) || 0 });
                  }}
                  onBlur={() => setEditingNum(null)}
                  onKeyDown={e => onLineKeyDown(e, idx)}
                  data-row={idx} data-col="unit_price"
                  className={cellFocusStyle} style={{ ...cellStyle, textAlign: 'right' }}
                />
              </td>
              <td className="px-2 py-1 text-right font-medium text-blue-700 bg-slate-50 border-r border-slate-200">
                {Math.round(it.qty * it.unit_price).toLocaleString('ko-KR')}
              </td>
              <td className="border-r border-slate-200">
                <input
                  type="text" value={it.comment ?? ''}
                  onChange={e => updateLine(idx, { comment: e.target.value })}
                  onKeyDown={e => onLineKeyDown(e, idx)}
                  data-row={idx} data-col="comment"
                  className={cellFocusStyle} style={cellStyle}
                />
              </td>
              <td className="text-center">
                <div className="inline-flex items-center gap-1">
                  <button
                    onClick={() => { setMoveMenuRow(idx); setVendorSearch(''); }}
                    className="text-slate-400 hover:text-blue-600"
                    title="다른 거래처의 결의서로 이동"
                  >
                    <ArrowRightLeft className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => onRequestRemoveLine(idx)} className="text-red-400 hover:text-red-600" title="행 삭제 (창고 재고 있으면 불출 옵션 안내)">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-slate-100 border-t-2 border-slate-400 font-semibold">
            <td colSpan={5} className="px-2 py-2 text-right text-slate-700 border-r border-slate-300">합 계 금 액</td>
            <td className="px-2 py-2 text-right text-blue-700 text-base border-r border-slate-300">
              ₩{Math.round(totalAmount(editing.items)).toLocaleString('ko-KR')}
            </td>
            <td colSpan={2}></td>
          </tr>
        </tfoot>
      </table>

      {/* 비고 영역 */}
      <table className="w-full border-collapse text-sm border-t-2 border-slate-400" style={{ tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 110 }} />
          <col />
        </colgroup>
        <tbody>
          <tr>
            <th className="bg-slate-100 px-2 py-1 text-left text-xs text-slate-700 border-r border-slate-300 font-medium align-top">비고</th>
            <td>
              <textarea value={editing.comment} onChange={e => setEditing({ ...editing, comment: e.target.value })} className={cellFocusStyle} style={{ ...cellStyle, resize: 'vertical', minHeight: 50 }} />
            </td>
          </tr>
        </tbody>
      </table>

      {/* 거래처 이동 모달 */}
      <Modal
        open={moveMenuRow !== null}
        onClose={() => setMoveMenuRow(null)}
        title={movingItem ? `"${movingItem.name || '(이름 없음)'}" — 다른 거래처로 이동` : '거래처 선택'}
        size="md"
        footer={<button onClick={() => setMoveMenuRow(null)} className="btn-secondary">취소</button>}
      >
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            현재 거래처: <strong>{vendors.find(v => v.id === editing.vendor_id)?.name ?? '-'}</strong>
            <br />
            대상 거래처를 선택하세요. 같은 회차의 DRAFT 결의서가 있으면 그쪽에 합쳐지고, 없으면 새로 만들어집니다.
          </p>
          <input
            type="text"
            placeholder="거래처 검색..."
            value={vendorSearch}
            onChange={e => setVendorSearch(e.target.value)}
            autoFocus
            className="w-full px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:border-blue-400"
          />
          <div className="max-h-[50vh] overflow-y-auto border border-slate-200 rounded">
            {filteredVendors.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-slate-400">
                {vendorSearch ? '검색 결과 없음' : '다른 거래처 없음'}
              </div>
            ) : (
              filteredVendors.map(v => (
                <button
                  key={v.id}
                  onClick={async () => {
                    const idx = moveMenuRow;
                    setMoveMenuRow(null);
                    if (idx !== null) await onMoveItemToVendor(idx, v.id);
                  }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 border-b border-slate-100 last:border-b-0"
                >
                  {v.name}
                </button>
              ))
            )}
          </div>
          <p className="text-xs text-slate-400">총 {filteredVendors.length}개 거래처</p>
        </div>
      </Modal>
    </div>
  );
}

export default function PurchaseDecisionsPage() {
  const { showToast } = useToast();
  const [list, setList] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>({ from: '', to: '' });
  const filteredList = useMemo(() => list.filter(d => inDateRange(d.doc_date, dateRange)), [list, dateRange]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [itemMaster, setItemMaster] = useState<any[]>([]);
  const [editing, setEditing] = useState<Decision | null>(null);
  const [saving, setSaving] = useState(false);

  // 거래처 미지정 품목 목록 — 자동 prefill 후 사용자가 인라인으로 거래처 지정 가능
  type SkippedItem = {
    item_id: string;
    item_code: string;
    name: string;
    category: string;
    pack_size: number;
    qty: number;
    depts: string[];
    assigning?: boolean; // 거래처 지정 중 (drop-down 변경 직후)
    assigned?: string;   // 지정 완료 (vendor_id)
  };
  const [skippedItems, setSkippedItems] = useState<SkippedItem[]>([]);

  const showMsg = (type: 'ok' | 'err', text: string) => showToast(text, type === 'ok' ? 'success' : 'error');

  const load = async () => {
    setLoading(true);
    try {
      const data = await api('/purchase-decisions');
      setList(data ?? []);
    } catch (e: any) {
      showMsg('err', e?.message ?? '결의서 목록 조회 실패');
    } finally {
      setLoading(false);
    }
  };

  const loadVendors = async () => {
    try {
      const v = await api('/vendors');
      setVendors(v ?? []);
    } catch { /* ignore */ }
  };

  const loadItemMaster = async () => {
    try {
      const items = await api('/items?status=active');
      setItemMaster(Array.isArray(items) ? items : []);
    } catch { /* ignore */ }
  };

  // 거래처 미지정 품목 — 서버에서 재계산해서 가져오기 (새로고침해도 유지)
  const loadPendingVendorItems = async () => {
    try {
      const r = await api('/purchase-decisions/pending-vendor-items');
      setSkippedItems(Array.isArray(r?.items) ? r.items : []);
    } catch (e: any) {
      // 서버에 GET 엔드포인트가 없거나 오류 — 사용자에게 알림 (서버 재시작 안 한 경우)
      console.error('[loadPendingVendorItems]', e);
      showMsg('err', `미지정 품목 조회 실패: ${e?.message ?? '서버 재시작 필요할 수 있음'}`);
    }
  };

  useEffect(() => {
    load();
    loadVendors();
    loadItemMaster();
  }, []);

  // 빈 결의서 신규 작성 (수동 — 가급적 자동 prefill 사용 권장)
  const openCreateBlank = () => {
    setEditing({
      id: '',
      decision_no: '(저장 시 자동 생성)',
      title: '',
      vendor_id: '',
      vendor_name: '',
      doc_date: new Date().toISOString().slice(0, 10),
      period_label: '',
      period_from: null,
      period_to: null,
      dept_label: '',
      approver_lines: [...DEFAULT_APPROVERS],
      comment: '',
      items: [],
      source_po_ids: [],
      used_in_po_id: null,
      used_in_po_no: null,
      status: 'DRAFT',
      creator_name: '',
      created_at: '',
      updated_at: '',
    });
  };

  const openEdit = (d: Decision) => {
    setEditing({ ...d, doc_date: d.doc_date ? d.doc_date.slice(0, 10) : '' });
  };

  // 승인된 신청에서 거래처별 자동 prefill — 결의서 N장 한번에 생성
  const createFromApproved = async () => {
    if (!confirm('승인된 신청 중 아직 결의서로 만들지 않은 것을 거래처별로 묶어 결의서를 자동 생성합니다. 진행할까요?')) return;
    try {
      const r = await api('/purchase-decisions/from-approved', { method: 'POST' });
      if ((r.created?.length ?? 0) === 0 && (r.skipped_items?.length ?? 0) === 0 && (r.skipped_vendors?.length ?? 0) === 0) {
        showMsg('ok', r.message ?? '새로 만들 결의서가 없습니다.');
      } else {
        const parts: string[] = [];
        if ((r.created?.length ?? 0) > 0) parts.push(`${r.created.length}개 거래처 결의서 생성 (신청 ${r.source_wr_count}건 묶음)`);
        if ((r.skipped_no_vendor ?? 0) > 0) parts.push(`거래처 미지정 ${r.skipped_no_vendor}건 — 아래에서 지정`);
        if ((r.skipped_vendors?.length ?? 0) > 0) {
          const reasons = r.skipped_vendors.map((v: any) => `${v.vendor_name}: ${v.reason}`).join(' / ');
          parts.push(`건너뜀 ${r.skipped_vendors.length}곳 — ${reasons}`);
        }
        showMsg('ok', parts.join(' · '));
      }
      setSkippedItems(Array.isArray(r.skipped_items) ? r.skipped_items : []);
      await load();
    } catch (e: any) {
      showMsg('err', e?.message ?? '자동 생성 실패');
    }
  };

  // 미지정 품목에 거래처 지정 — Item.default_vendor_id 갱신
  const assignVendor = async (item_id: string, vendor_id: string) => {
    if (!vendor_id) return;
    setSkippedItems(prev => prev.map(s => s.item_id === item_id ? { ...s, assigning: true } : s));
    try {
      await api(`/items/${item_id}`, {
        method: 'PUT',
        body: JSON.stringify({ default_vendor_id: vendor_id }),
      });
      // 마스터에 저장됐으니 항목 자체는 화면에서 표시만 변경
      setSkippedItems(prev => prev.map(s => s.item_id === item_id ? { ...s, assigning: false, assigned: vendor_id } : s));
      showMsg('ok', '거래처가 지정되었습니다.');
    } catch (e: any) {
      setSkippedItems(prev => prev.map(s => s.item_id === item_id ? { ...s, assigning: false } : s));
      showMsg('err', e?.message ?? '거래처 지정 실패');
    }
  };

  // 거래처 지정한 품목들로 결의서 추가 생성
  const retryFromApproved = async () => {
    const assignedCount = skippedItems.filter(s => s.assigned).length;
    if (assignedCount === 0) {
      showMsg('err', '거래처를 지정한 품목이 없습니다.');
      return;
    }
    try {
      const r = await api('/purchase-decisions/from-approved', { method: 'POST' });
      if ((r.created?.length ?? 0) > 0) {
        showMsg('ok', `${r.created.length}개 거래처 결의서 추가 생성됨`);
      } else {
        showMsg('ok', '추가로 생성된 결의서가 없습니다.');
      }
      setSkippedItems(Array.isArray(r.skipped_items) ? r.skipped_items : []);
      await load();
      await loadPendingVendorItems(); // 서버 기준으로 재동기화
    } catch (e: any) {
      showMsg('err', e?.message ?? '재시도 실패');
    }
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.vendor_id) { showMsg('err', '거래처를 선택해주세요.'); return; }
    setSaving(true);
    try {
      const payload = {
        title: editing.title,
        vendor_id: editing.vendor_id,
        doc_date: editing.doc_date,
        period_label: editing.period_label,
        period_from: editing.period_from,
        period_to: editing.period_to,
        dept_label: editing.dept_label,
        approver_lines: editing.approver_lines,
        comment: editing.comment,
        items: editing.items,
      };
      if (editing.id) {
        await api(`/purchase-decisions/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showMsg('ok', '저장되었습니다.');
      } else {
        await api('/purchase-decisions', { method: 'POST', body: JSON.stringify(payload) });
        showMsg('ok', '신규 결의서 생성됨.');
      }
      setEditing(null);
      await load();
    } catch (e: any) {
      showMsg('err', e?.message ?? '저장 실패');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (d: Decision) => {
    if (!confirm(`${d.decision_no} 를 삭제합니다. 진행하시겠습니까?`)) return;
    try {
      await api(`/purchase-decisions/${d.id}`, { method: 'DELETE' });
      showMsg('ok', '삭제됨.');
      await load();
    } catch (e: any) {
      showMsg('err', e?.message ?? '삭제 실패');
    }
  };

  // LOCKED 결의서 되돌리기 — 묶인 PO를 CANCELLED 로 + 결의서를 DRAFT 복원 (편집 가능)
  const revertDecision = async (d: Decision) => {
    if (!d.used_in_po_id) { showMsg('err', '연결된 발주서가 없습니다.'); return; }
    const poNo = d.used_in_po_no ?? '(번호 없음)';
    const reason = window.prompt(
      `「${d.decision_no}」 가 발주서 ${poNo} 에 묶여 있어 편집이 잠겨 있습니다.\n\n` +
      `「되돌리기」 진행하면:\n` +
      ` · 발주서 ${poNo} 는 「취소됨(CANCELLED)」 상태로 변경 (목록엔 남음)\n` +
      ` · 이 결의서는 임시저장(DRAFT) 로 복원되어 다시 편집 가능\n\n` +
      `※ 거래처에 이미 발주서가 발송된 경우 별도로 취소 통보를 해주세요.\n\n` +
      `사유를 5자 이상 입력해주세요:`,
      '',
    );
    if (reason === null) return;
    const trimmed = reason.trim();
    if (trimmed.length < 5) { showMsg('err', '사유는 5자 이상 입력해주세요.'); return; }
    try {
      await api(`/purchase-orders/${d.used_in_po_id}/revert`, {
        method: 'POST',
        body: JSON.stringify({ reason: trimmed }),
      });
      showMsg('ok', `${poNo} 취소 + ${d.decision_no} 잠금 해제됨. 이제 편집 가능합니다.`);
      await load();
    } catch (e: any) {
      showMsg('err', e?.message ?? '되돌리기 실패');
    }
  };

  // DRAFT 결의서 되돌리기 — 라우팅(DECISION) 해제 + 결의서 목록에서 제거 → 발주대기 복귀
  const revertToRouting = async (d: Decision) => {
    const reason = window.prompt(
      `「${d.decision_no}」 를 서류작성에서 빼고 발주대기로 되돌립니다.\n\n` +
      `진행하면:\n` +
      ` · 이 결의서에 연결된 품목들이 발주대기(발주 준비)로 복귀\n` +
      ` · 결의서는 목록에서 제거\n\n` +
      `사유를 5자 이상 입력해주세요:`,
      '',
    );
    if (reason === null) return;
    const trimmed = reason.trim();
    if (trimmed.length < 5) { showMsg('err', '사유는 5자 이상 입력해주세요.'); return; }
    try {
      const r: any = await api(`/purchase-decisions/${d.id}/revert-to-routing`, {
        method: 'POST',
        body: JSON.stringify({ reason: trimmed }),
      });
      showMsg('ok', `${d.decision_no} 되돌림 완료 (복귀 ${Number(r?.released_routing_count ?? 0)}건)`);
      await load();
    } catch (e: any) {
      showMsg('err', e?.message ?? '발주대기 되돌리기 실패');
    }
  };

  // PDF 출력 — 인증 헤더 포함 fetch 후 blob 다운로드
  const printPdf = async (d: Decision) => {
    try {
      const token = getToken();
      const r = await fetch(`/api/purchase-decisions/${d.id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) throw new Error('PDF 다운로드 실패');
      const blob = await r.blob();
      downloadBlob(blob, `${d.decision_no}.pdf`);
    } catch (e: any) {
      showMsg('err', e?.message ?? 'PDF 출력 실패');
    }
  };

  // 엑셀 다운로드 — 사내 양식(.xlsx) 그대로 채워서 받기
  const downloadExcel = async (d: Decision) => {
    try {
      const token = getToken();
      const r = await fetch(`/api/purchase-decisions/${d.id}/excel`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) {
        let msg = '엑셀 다운로드 실패';
        try { const j = await r.json(); msg = j.error ?? msg; } catch {}
        throw new Error(msg);
      }
      const blob = await r.blob();
      downloadBlob(blob, `${d.decision_no}.xlsx`);
    } catch (e: any) {
      showMsg('err', e?.message ?? '엑셀 다운로드 실패');
    }
  };

  const totalAmount = (items: DecisionItem[]) => items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_price), 0);

  // 라인 편집 헬퍼
  const updateLine = (idx: number, patch: Partial<DecisionItem>) => {
    if (!editing) return;
    setEditing({
      ...editing,
      items: editing.items.map((it, i) => i === idx ? { ...it, ...patch } : it),
    });
  };
  const addLine = () => {
    if (!editing) return;
    setEditing({
      ...editing,
      items: [...editing.items, { name: '', spec: '', qty: 0, unit_price: 0, comment: '' }],
    });
  };
  // 품목 마스터에서 선택한 품목으로 새 행 추가 — item_id 가 박혀서 발주서 변환 시 자유입력 분리 안 됨
  const addLineFromItem = (it: any) => {
    if (!editing) return;
    setEditing({
      ...editing,
      items: [...editing.items, {
        item_id: it.id,
        item_code: it.item_code ?? '',
        name: it.name ?? '',
        spec: it.sub_category ?? '',
        unit: it.purchase_uom ?? it.uom ?? '',
        pack_size: Number(it.pack_size ?? 1),
        category: String(it.category ?? ''),
        qty: 1,
        unit_price: Number(it.latest_price ?? 0),
        comment: '',
      }],
    });
  };
  const removeLine = (idx: number) => {
    if (!editing) return;
    setEditing({ ...editing, items: editing.items.filter((_, i) => i !== idx) });
  };

  // 한 품목을 다른 거래처의 결의서로 옮김 (서버에 저장된 상태에서만 가능)
  const moveItemToVendor = async (idx: number, to_vendor_id: string) => {
    if (!editing) return;
    const targetName = vendors.find(v => v.id === to_vendor_id)?.name ?? '';
    const item = editing.items[idx];
    if (!item) return;
    if (!confirm(`"${item.name}" 을(를) ${targetName} 의 결의서로 옮기시겠습니까?\n현재 편집중인 변경사항은 먼저 저장됩니다.`)) return;
    try {
      // 1) 현재 편집 중인 결의서 먼저 저장 (서버 인덱스 = 클라이언트 인덱스 동기화)
      setSaving(true);
      const saved = await api(`/purchase-decisions/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: editing.title,
          vendor_id: editing.vendor_id,
          doc_date: editing.doc_date,
          period_label: editing.period_label,
          period_from: editing.period_from,
          period_to: editing.period_to,
          dept_label: editing.dept_label,
          approver_lines: editing.approver_lines,
          comment: editing.comment,
          items: editing.items,
        }),
      }) as Decision;
      // 2) 이동
      const moveRes: any = await api('/purchase-decisions/move-item', {
        method: 'POST',
        body: JSON.stringify({
          from_decision_id: editing.id,
          item_index: idx,
          to_vendor_id,
        }),
      });
      // 3) 편집 상태 갱신 — 서버가 반환한 src 의 items 다시 로드
      const refreshed = await api(`/purchase-decisions/${editing.id}`) as Decision;
      setEditing(refreshed);
      await load();
      showMsg(
        'ok',
        moveRes.created_target
          ? `${moveRes.to_vendor_name} 의 새 결의서(${moveRes.to_decision_no}) 가 생성되어 이동했습니다.`
          : `${moveRes.to_vendor_name} 의 기존 결의서(${moveRes.to_decision_no}) 로 이동했습니다.`,
      );
      void saved;
    } catch (e: any) {
      showMsg('err', e?.message ?? '거래처 이동 실패');
    } finally {
      setSaving(false);
    }
  };

  // ── 라인 삭제 시 창고 재고 안내 + 영구 처리 마킹 ──
  // X 클릭 → GET line-stock 으로 창고 재고 조회 (참고용 안내)
  //   재고 있으면 confirm "창고에 N팩 있습니다. 빼시겠어요?"
  //     확인 → POST exclude-line (라인 제거 + 영구 처리됨 마킹 → 다음 신규작성 시 또 안 들이댐)
  //     취소 → 아무 일 안 함
  //   재고 없으면 → 바로 exclude-line 호출
  // 자유입력 라인 또는 저장 안 된 결의서 → 클라이언트에서만 라인 제거 (서버 추적 X)
  // ※ 실제 창고 → 부서 불출은 별도 불출 화면에서 처리 (자동화 X)
  const onRequestRemoveLine = async (idx: number) => {
    if (!editing) return;
    const line = editing.items[idx];
    if (!line) return;
    // 자유입력 또는 저장 안 된 결의서 — 단순 클라이언트 제거
    if (!line.item_id || !editing.id) {
      removeLine(idx);
      return;
    }

    // 편집중 변경사항 먼저 저장 — 인덱스 동기화
    const saveCurrent = async () => {
      await api(`/purchase-decisions/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: editing.title,
          vendor_id: editing.vendor_id,
          doc_date: editing.doc_date,
          period_label: editing.period_label,
          period_from: editing.period_from,
          period_to: editing.period_to,
          dept_label: editing.dept_label,
          approver_lines: editing.approver_lines,
          comment: editing.comment,
          items: editing.items,
        }),
      });
    };

    const performExclude = async (reason: string) => {
      try {
        await saveCurrent();
        await api(`/purchase-decisions/${editing.id}/exclude-line`, {
          method: 'POST',
          body: JSON.stringify({ item_index: idx, reason }),
        });
        const refreshed = await api(`/purchase-decisions/${editing.id}`) as Decision;
        setEditing(refreshed);
        showMsg('ok', `"${line.name}" 라인 제거 — 다음 "신규 작성" 시 다시 안 들어옵니다.`);
      } catch (e: any) {
        showMsg('err', e?.message ?? '라인 제거 실패');
      }
    };

    try {
      const r: any = await api(`/purchase-decisions/${editing.id}/line-stock?index=${idx}`);
      if (r.has_stock && r.central_stock_pack > 0) {
        const ok = confirm(
          `"${r.item_name}"\n\n` +
          `총무구매 창고에 ${r.central_stock_pack}팩 (${r.central_stock_box}박스) 있습니다.\n` +
          `이 라인을 결의서에서 빼시겠습니까?\n\n` +
          `→ 빼면 발주에서 제외 + 다음 신규작성 시 다시 안 들이댐.\n` +
          `→ 창고 재고는 별도 불출 화면에서 신청 부서로 처리.`,
        );
        if (!ok) return;
        await performExclude('재고 있음');
      } else {
        await performExclude('수동 제거');
      }
    } catch (e: any) {
      console.error('[line-stock] error:', e);
      if (confirm('재고 조회 실패. 그래도 라인을 빼시겠습니까?')) {
        await performExclude('재고조회 실패');
      }
    }
  };

  // ── 편집 모드 — 풀페이지 ──
  if (editing) {
    return (
      <div className="-mx-2 sm:-mx-4 lg:-mx-6">
        <div className="px-2 sm:px-4 lg:px-6 pb-3 flex items-center justify-between gap-2 sticky top-0 bg-white border-b border-slate-200 z-10 py-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-800">
              {editing.id ? `결의서 편집` : '신규 결의서 작성'}
            </h1>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{editing.decision_no}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setEditing(null)} className="btn-secondary">취소</button>
            <button onClick={save} disabled={saving} className="btn-primary inline-flex items-center gap-1.5">
              <Save className="w-4 h-4" /> {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </div>
        <div className="px-2 sm:px-4 lg:px-6 pt-4">
          <SheetEditor
            editing={editing}
            setEditing={setEditing}
            vendors={vendors}
            itemMaster={itemMaster}
            updateLine={updateLine}
            addLine={addLine}
            addLineFromItem={addLineFromItem}
            removeLine={removeLine}
            totalAmount={totalAmount}
            onMoveItemToVendor={moveItemToVendor}
            onRequestRemoveLine={onRequestRemoveLine}
          />

        </div>
      </div>
    );
  }

  // ── 목록 모드 ──
  return (
    <div>
      <PageHeader icon={FileText} title="구매결의서" description="발주 준비에서 라우팅된 결의서를 편집 → 인쇄" />

      <div className="mb-3">
        <DateRangeFilter value={dateRange} onChange={setDateRange} label="작성일" />
      </div>

      <div className="card p-3 mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-600 inline-flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 text-slate-400" />
          결의서는 <strong>「발주 준비」</strong>에서 품목을 구매결의서로 라우팅하면 거래처별로 자동 생성됩니다.
        </span>
        <button onClick={openCreateBlank} className="btn-secondary inline-flex items-center gap-1.5 ml-auto">
          <Plus className="w-4 h-4" /> 빈 결의서 작성
        </button>
        <span className="text-xs text-slate-500">총 {filteredList.length}{filteredList.length !== list.length ? ` / ${list.length}` : ''}건</span>
      </div>

      {/* 거래처 미지정 처리는 「발주 준비」 페이지로 이전됨 */}
      {false && skippedItems.length > 0 && (
        <div className="card p-0 mb-4 border-l-4 border-l-amber-500 overflow-hidden">
          <div className="px-4 py-3 bg-amber-50 border-b border-amber-200 flex items-center justify-between">
            <span className="font-semibold text-amber-800 inline-flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" /> 거래처 미지정 품목 {skippedItems.length}개 — 거래처 지정 후 결의서에 추가하세요
            </span>
            <div className="flex items-center gap-2">
              <button onClick={retryFromApproved} className="btn-primary text-xs">결의서 추가 생성</button>
              <button onClick={() => setSkippedItems([])} className="text-xs text-slate-500 hover:underline">패널 닫기</button>
            </div>
          </div>
          <div className="px-4 py-3 space-y-4">
            {(['MEDICAL', 'GENERAL', 'OFFICE', 'DIAPER', 'EQUIPMENT'] as MajorGroup[]).map(major => {
              const itemsInMajor = skippedItems.filter(s => getMajor(s.category) === major);
              if (itemsInMajor.length === 0) return null;
              return (
                <div key={major}>
                  <div className="text-xs font-semibold text-slate-700 mb-1">
                    {MAJOR_GROUP_LABEL[major]} <span className="text-slate-400">({itemsInMajor.length})</span>
                  </div>
                  <table className="w-full text-sm border-collapse">
                    <thead className="bg-slate-50 text-xs text-slate-600">
                      <tr>
                        <th className="px-2 py-1.5 text-left border-b border-slate-200">품목코드</th>
                        <th className="px-2 py-1.5 text-left border-b border-slate-200">품목명</th>
                        <th className="px-2 py-1.5 text-right border-b border-slate-200" style={{ width: 100 }}>승인수량(팩)</th>
                        <th className="px-2 py-1.5 text-left border-b border-slate-200">신청 부서</th>
                        <th className="px-2 py-1.5 text-left border-b border-slate-200" style={{ width: 220 }}>거래처</th>
                      </tr>
                    </thead>
                    <tbody>
                      {itemsInMajor.map(s => (
                        <tr key={s.item_id} className={`border-b border-slate-100 ${s.assigned ? 'bg-emerald-50/50' : ''}`}>
                          <td className="px-2 py-1 font-mono text-xs text-slate-500">{s.item_code}</td>
                          <td className="px-2 py-1">{s.name}</td>
                          <td className="px-2 py-1 text-right">{s.qty}</td>
                          <td className="px-2 py-1 text-xs text-slate-600">{s.depts.join(', ')}</td>
                          <td className="px-2 py-1">
                            {s.assigned ? (
                              <span className="text-xs text-emerald-700 inline-flex items-center gap-1">
                                ✓ {vendors.find(v => v.id === s.assigned)?.name ?? '저장됨'}
                              </span>
                            ) : (
                              <select
                                value=""
                                disabled={s.assigning}
                                onChange={e => assignVendor(s.item_id, e.target.value)}
                                className="input text-xs py-1 w-full"
                              >
                                <option value="">{s.assigning ? '지정 중...' : '거래처 선택...'}</option>
                                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                              </select>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="card p-8 text-center text-slate-400">불러오는 중...</div>
      ) : filteredList.length === 0 ? (
        <div className="card"><EmptyState message={list.length === 0 ? '작성된 결의서가 없습니다.' : '선택한 기간에 해당하는 결의서가 없습니다.'} /></div>
      ) : (
        <PurchaseDecisionList
          list={filteredList}
          openEdit={openEdit}
          downloadExcel={downloadExcel}
          printPdf={printPdf}
          remove={remove}
          revertLocked={revertDecision}
          revertToRouting={revertToRouting}
          totalAmount={totalAmount}
          onPeriodChanged={load}
        />
      )}
    </div>
  );
}

// 기간 → 거래처 계층 그룹화 표시 컴포넌트
function PurchaseDecisionList({
  list, openEdit, downloadExcel, printPdf, remove, revertLocked, revertToRouting, totalAmount, onPeriodChanged,
}: {
  list: Decision[];
  openEdit: (d: Decision) => void;
  downloadExcel: (d: Decision) => void;
  printPdf: (d: Decision) => void;
  remove: (d: Decision) => void;
  revertLocked: (d: Decision) => void;
  revertToRouting: (d: Decision) => void;
  totalAmount: (items: DecisionItem[]) => number;
  onPeriodChanged: () => void;
}) {
  // 회차 라벨 수정 (LOCKED 상태에서도 가능)
  const changePeriodLabel = async (d: Decision) => {
    const input = window.prompt(`${d.decision_no} 의 회차 라벨을 입력하세요.\n예: 2026년 5월 1주차`, d.period_label ?? '');
    if (input === null) return;
    try {
      await api(`/purchase-decisions/${d.id}/period-label`, {
        method: 'PATCH',
        body: JSON.stringify({ period_label: input.trim() }),
      });
      onPeriodChanged();
    } catch (e: any) {
      alert(e?.message ?? '회차 라벨 변경 실패');
    }
  };
  const hierarchy = useMemo(() => {
    const periodMap = new Map<string, Map<string, Decision[]>>();
    for (const d of list) {
      const period = (d.period_label && String(d.period_label).trim()) || '기간 미지정';
      const vendorId = String(d.vendor_id ?? '_unknown');
      let vMap = periodMap.get(period);
      if (!vMap) { vMap = new Map(); periodMap.set(period, vMap); }
      const arr = vMap.get(vendorId) ?? [];
      arr.push(d);
      vMap.set(vendorId, arr);
    }
    return Array.from(periodMap.entries()).map(([period, vMap]) => {
      const vendors = Array.from(vMap.entries()).map(([vendorId, decisions]) => {
        const sorted = [...decisions].sort((a, b) => new Date(b.doc_date).getTime() - new Date(a.doc_date).getTime());
        const breakdown: Record<string, number> = {};
        let sumAmt = 0;
        for (const d of sorted) {
          for (const [k, v] of Object.entries(d.category_breakdown ?? {})) breakdown[k] = (breakdown[k] ?? 0) + Number(v ?? 0);
          sumAmt += Number(d.total_amount ?? 0);
        }
        return {
          vendor_id: vendorId,
          vendor_name: sorted[0]?.vendor_name ?? '미지정',
          decisions: sorted,
          breakdown,
          total_amount: sumAmt,
        };
      }).sort((a, b) => a.vendor_name.localeCompare(b.vendor_name, 'ko'));
      const totalDecisions = vendors.reduce((s, v) => s + v.decisions.length, 0);
      const totalAmt = vendors.reduce((s, v) => s + v.total_amount, 0);
      const totalBreakdown: Record<string, number> = {};
      for (const v of vendors) for (const [k, vv] of Object.entries(v.breakdown)) totalBreakdown[k] = (totalBreakdown[k] ?? 0) + Number(vv ?? 0);
      return { period, vendors, totalDecisions, totalAmt, totalBreakdown };
    }).sort((a, b) => b.period.localeCompare(a.period));
  }, [list]);

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const toggle = useCallback((k: string) => {
    setExpandedKeys(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  }, []);

  return (
    <div className="card p-0">
      <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-700">기간 · 거래처별 결의서</div>
        <div className="flex gap-2 text-xs">
          <button className="text-blue-600 hover:underline" onClick={() => {
            const all = new Set<string>();
            for (const p of hierarchy) {
              all.add(`pd::${p.period}`);
              for (const v of p.vendors) all.add(`pd::${p.period}::${v.vendor_id}`);
            }
            setExpandedKeys(all);
          }}>모두 펼치기</button>
          <span className="text-slate-300">·</span>
          <button className="text-blue-600 hover:underline" onClick={() => setExpandedKeys(new Set())}>모두 접기</button>
        </div>
      </div>
      <div className="divide-y divide-slate-100">
        {hierarchy.map((p) => {
          const pKey = `pd::${p.period}`;
          const pOpen = expandedKeys.has(pKey);
          return (
            <div key={pKey}>
              <button onClick={() => toggle(pKey)} className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-slate-50 text-left">
                <span className="text-slate-400">{pOpen ? '▼' : '▶'}</span>
                <span className="font-semibold text-sm text-slate-800">{p.period}</span>
                <span className="text-xs text-slate-500">{p.totalDecisions}건 · {p.vendors.length}개 거래처 · ₩{p.totalAmt.toLocaleString('ko-KR')}</span>
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
                  {p.vendors.map((v) => {
                    const vKey = `${pKey}::${v.vendor_id}`;
                    const vOpen = expandedKeys.has(vKey);
                    return (
                      <div key={vKey} className="border-t border-slate-100">
                        <button onClick={() => toggle(vKey)} className="w-full px-8 py-2 flex items-center gap-2 hover:bg-slate-50 text-left">
                          <span className="text-slate-400 text-xs">{vOpen ? '▼' : '▶'}</span>
                          <span className="font-medium text-sm text-slate-700">{v.vendor_name}</span>
                          <span className="text-xs text-slate-500">{v.decisions.length}건 · ₩{v.total_amount.toLocaleString('ko-KR')}</span>
                          <div className="flex flex-wrap gap-1 ml-2">
                            {Object.entries(v.breakdown).map(([k, vv]) => (
                              <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded ${MAJOR_BG[k] ?? 'bg-slate-100 text-slate-600'}`}>
                                {MAJOR_LABEL_KO[k] ?? k} {vv}
                              </span>
                            ))}
                          </div>
                        </button>
                        {vOpen && (
                          <table className="w-full text-sm">
                            <thead className="bg-slate-50">
                              <tr className="text-xs text-slate-600">
                                <th className="px-3 py-1.5 text-left">분류</th>
                                <th className="px-3 py-1.5 text-left">제목</th>
                                <th className="px-3 py-1.5 text-center">작성일</th>
                                <th className="px-3 py-1.5 text-right">합계금액</th>
                                <th className="px-3 py-1.5 text-center">상태</th>
                                <th className="px-3 py-1.5 text-left">결의서번호</th>
                                <th className="px-3 py-1.5 text-right"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {v.decisions.map(d => (
                                <tr key={d.id} className="border-t border-slate-100 hover:bg-slate-50/40">
                                  <td className="px-3 py-1.5">
                                    <div className="flex flex-wrap gap-1">
                                      {Object.entries(d.category_breakdown ?? {}).map(([k, vv]) => (
                                        <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded ${MAJOR_BG[k] ?? 'bg-slate-100 text-slate-600'}`}>
                                          {MAJOR_LABEL_KO[k] ?? k} {vv}
                                        </span>
                                      ))}
                                    </div>
                                  </td>
                                  <td className="px-3 py-1.5">{d.title || '-'}</td>
                                  <td className="px-3 py-1.5 text-center text-xs text-slate-500">{d.doc_date ? new Date(d.doc_date).toLocaleDateString('ko-KR') : '-'}</td>
                                  <td className="px-3 py-1.5 text-right">₩{Math.round(d.total_amount ?? totalAmount(d.items)).toLocaleString('ko-KR')}</td>
                                  <td className="px-3 py-1.5 text-center">
                                    {d.status === 'LOCKED' ? (
                                      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">발주됨</span>
                                    ) : (
                                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">임시저장</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-1.5 font-mono text-xs text-slate-400">{d.decision_no}</td>
                                  <td className="px-3 py-1.5 text-right">
                                    <div className="inline-flex items-center gap-2">
                                      <button onClick={() => openEdit(d)} disabled={d.status === 'LOCKED'} className="text-xs text-teal-600 hover:underline disabled:opacity-40 disabled:no-underline">편집</button>
                                      {d.status === 'DRAFT' && (
                                        <button
                                          onClick={() => revertToRouting(d)}
                                          className="text-xs text-amber-700 hover:underline"
                                          title="이 결의서 항목을 발주대기로 되돌리기"
                                        >
                                          발주대기로
                                        </button>
                                      )}
                                      {d.status === 'LOCKED' && d.used_in_po_id && (
                                        <button
                                          onClick={() => revertLocked(d)}
                                          className="text-xs text-orange-600 hover:underline"
                                          title={`발주서 ${d.used_in_po_no ?? ''} 취소 + 결의서 편집 가능하게 되돌리기`}
                                        >
                                          되돌리기
                                        </button>
                                      )}
                                      <button onClick={() => changePeriodLabel(d)} className="text-xs text-slate-500 hover:text-blue-600" title="회차 라벨 수정 (LOCKED 상태에서도 가능)">주차</button>
                                      <button onClick={() => downloadExcel(d)} className="text-xs text-emerald-700 hover:underline inline-flex items-center gap-0.5">
                                        <FileText className="w-3 h-3" /> 엑셀
                                      </button>
                                      <button onClick={() => printPdf(d)} className="text-xs text-blue-600 hover:underline inline-flex items-center gap-0.5">
                                        <Printer className="w-3 h-3" /> PDF
                                      </button>
                                      <button onClick={() => remove(d)} disabled={d.status === 'LOCKED'} className="text-xs text-red-500 hover:underline disabled:opacity-40 disabled:no-underline inline-flex items-center gap-0.5">
                                        <Trash2 className="w-3 h-3" /> 삭제
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
  );
}
