import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../utils/api';
import { Modal } from '../ui';
import type { Vendor } from '@shared/types';
import { ChevronDown, ChevronRight, AlertTriangle, Inbox } from 'lucide-react';
import { ceilToPurchaseQty } from '@shared/units';

const TYPE_LABEL: Record<string, string> = {
  CONSUMABLE_MEDICAL: '의료소모품',
  CONSUMABLE_REGULAR: '일반소모품',
  CONSUMABLE_OFFICE: '사무용품',
  DIAPER: '기저귀',
  NIGHT_SNACK: '야간간식',
  ADHOC: '비정기',
  EQUIPMENT: '비품',
};

interface PendingLine {
  item_id: string;
  item_code: string;
  item_name: string;
  purchase_uom: string;
  pack_size: number;
  approved_qty: number;
  po_qty: number;
  stock_out_qty: number;
  unfulfilled_qty: number;
  default_vendor_id: string | null;
  default_vendor_name: string | null;
  last_unit_price: number;
  approval_action_item_ids: string[];
  source_ward_request_ids: string[];
}

interface PendingBucket {
  vendor_id: string | null;
  vendor_name: string;
  schedule_period_label: string;
  schedule_period_start: string;
  schedule_period_matched: boolean;
  request_type: string;
  ward_requests: { id: string; request_no: string; department_name: string; period_start: string; is_test: boolean }[];
  lines: PendingLine[];
}

interface PendingResponse {
  buckets: PendingBucket[];
  unassigned_vendor_lines_count: number;
  as_of: string;
}

interface SelectionState {
  checked: boolean;
  qty: number;
  vendorOverride: string | null;
}

interface DraftPO {
  vendor_id: string;
  vendor_name: string;
  request_type: string;
  schedule_period_label: string;
  source_ward_request_ids: string[];
  source_approval_item_ids: string[];
  items: { item_id: string; item_name: string; ordered_qty: number; unit_price: number; line_amount: number }[];
}

interface Props {
  sourceType: string;
  vendors: Vendor[];
  onCreated: () => void;
}

export default function PendingQueuePanel({ sourceType, vendors, onCreated }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [data, setData] = useState<PendingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Map<string, SelectionState>>(new Map());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ ok: number; fail: { vendor_name: string; error: string }[] } | null>(null);

  const lineKey = (bucketIdx: number, itemId: string) => `${bucketIdx}:${itemId}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (sourceType) params.set('source_type', sourceType);
      const json: PendingResponse = await api(`/purchase-orders/pending?${params}`);
      setData(json);
      setSelection(new Map());
    } catch (e: any) {
      setError(e?.message ?? '발주 대기 큐를 불러오지 못했습니다.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [sourceType]);

  useEffect(() => { load(); }, [load]);

  const setLineState = (key: string, partial: Partial<SelectionState>) => {
    setSelection(prev => {
      const next = new Map(prev);
      const current = next.get(key) ?? { checked: false, qty: 0, vendorOverride: null };
      next.set(key, { ...current, ...partial });
      return next;
    });
  };

  // 거래처 미지정 bucket 은 발주 화면에서 숨김 — 결의서(구매결의서) 화면의 "거래처 미지정 품목" 패널에서 처리하도록 분리.
  // (양쪽에 같은 정보를 노출하면 사용자가 어디서 거래처를 지정해야 할지 혼란스러움)
  const assignedBuckets = useMemo(
    () => (data?.buckets ?? []).filter(b => !!b.vendor_id),
    [data],
  );

  const totalLineCount = assignedBuckets.reduce((s, b) => s + b.lines.length, 0);
  const selectedCount = Array.from(selection.values()).filter(v => v.checked).length;

  // 거래처별 합계 — 전체 / 선택 두 종류 같이 계산
  // qty 는 박스 단위 (사용자 입력값 또는 기본 ceilToPurchaseQty 환산), unit_price 는 박스 단가.
  type VendorSum = { vendor_id: string | null; vendor_name: string; lineCount: number; totalAmount: number; selectedLineCount: number; selectedAmount: number };
  const vendorSummary = useMemo<VendorSum[]>(() => {
    if (!data) return [];
    const map = new Map<string, VendorSum>();
    assignedBuckets.forEach((bucket, bIdx) => {
      bucket.lines.forEach(line => {
        const key = lineKey(bIdx, line.item_id);
        const sel = selection.get(key);
        const overrideVendor = sel?.vendorOverride ?? null;
        const vendorId = overrideVendor ?? line.default_vendor_id ?? bucket.vendor_id;
        const vendorName = (vendorId ? vendors.find(v => v.id === vendorId)?.name : null) ?? line.default_vendor_name ?? bucket.vendor_name ?? '거래처 미지정';
        const mapKey = vendorId ?? '__UNASSIGNED__';
        let entry = map.get(mapKey);
        if (!entry) {
          entry = { vendor_id: vendorId, vendor_name: vendorName, lineCount: 0, totalAmount: 0, selectedLineCount: 0, selectedAmount: 0 };
          map.set(mapKey, entry);
        }
        entry.lineCount += 1;
        // 전체 합계 — 기본 박스수(미달팩 → ceilToPurchaseQty) × 박스단가
        const defaultBoxQty = ceilToPurchaseQty(line.unfulfilled_qty, line.pack_size);
        entry.totalAmount += defaultBoxQty * Number(line.last_unit_price);
        // 선택 합계 — 사용자 입력 박스수 × 박스단가
        if (sel?.checked && sel.qty > 0) {
          entry.selectedLineCount += 1;
          entry.selectedAmount += Number(sel.qty) * Number(line.last_unit_price);
        }
      });
    });
    return Array.from(map.values()).sort((a, b) => b.totalAmount - a.totalAmount);
  }, [data, selection, vendors, assignedBuckets]);

  const summaryGrandTotal = vendorSummary.reduce((s, v) => s + v.totalAmount, 0);
  const summarySelectedTotal = vendorSummary.reduce((s, v) => s + v.selectedAmount, 0);
  const fmtWon = (n: number) => `₩${Math.round(n).toLocaleString('ko-KR')}`;

  const drafts = useMemo<DraftPO[]>(() => {
    if (!data) return [];
    const map = new Map<string, DraftPO>();
    assignedBuckets.forEach((bucket, idx) => {
      bucket.lines.forEach(line => {
        const key = lineKey(idx, line.item_id);
        const sel = selection.get(key);
        if (!sel?.checked) return;
        const vendorId = sel.vendorOverride ?? line.default_vendor_id ?? bucket.vendor_id;
        if (!vendorId) return;
        const qty = Math.max(0, sel.qty);
        if (qty <= 0) return;
        const vendorName = vendors.find(v => v.id === vendorId)?.name ?? line.default_vendor_name ?? bucket.vendor_name;
        const draftKey = `${vendorId}::${bucket.schedule_period_label}::${bucket.request_type}`;
        let draft = map.get(draftKey);
        if (!draft) {
          draft = {
            vendor_id: vendorId,
            vendor_name: vendorName,
            request_type: bucket.request_type,
            schedule_period_label: bucket.schedule_period_label,
            source_ward_request_ids: [],
            source_approval_item_ids: [],
            items: [],
          };
          map.set(draftKey, draft);
        }
        const lineAmount = qty * line.last_unit_price;
        const existing = draft.items.find(x => x.item_id === line.item_id);
        if (existing) {
          existing.ordered_qty += qty;
          existing.line_amount += lineAmount;
        } else {
          draft.items.push({
            item_id: line.item_id,
            item_name: line.item_name,
            ordered_qty: qty,
            unit_price: line.last_unit_price,
            line_amount: lineAmount,
          });
        }
        for (const wrId of line.source_ward_request_ids) {
          if (!draft.source_ward_request_ids.includes(wrId)) draft.source_ward_request_ids.push(wrId);
        }
        for (const aaiId of line.approval_action_item_ids) {
          if (!draft.source_approval_item_ids.includes(aaiId)) draft.source_approval_item_ids.push(aaiId);
        }
      });
    });
    return Array.from(map.values());
  }, [data, selection, vendors, assignedBuckets]);

  const skippedUnassignedCount = useMemo(() => {
    if (!data) return 0;
    let count = 0;
    // 거래처 미지정 bucket 은 화면에 안 보이므로 0 으로 유지 (결의서 화면에서 처리)
    assignedBuckets.forEach((bucket, idx) => {
      bucket.lines.forEach(line => {
        const key = lineKey(idx, line.item_id);
        const sel = selection.get(key);
        if (!sel?.checked) return;
        const vid = sel.vendorOverride ?? line.default_vendor_id ?? bucket.vendor_id;
        if (!vid) count += 1;
      });
    });
    return count;
  }, [data, selection, assignedBuckets]);

  const submitDrafts = async () => {
    setSubmitting(true);
    setSubmitResult(null);
    let ok = 0;
    const fail: { vendor_name: string; error: string }[] = [];
    for (const d of drafts) {
      try {
        await api('/purchase-orders', {
          method: 'POST',
          body: JSON.stringify({
            vendor_id: d.vendor_id,
            note: `[AUTO] ${TYPE_LABEL[d.request_type] ?? d.request_type} ${d.schedule_period_label}`,
            items: d.items.map(it => ({ item_id: it.item_id, ordered_qty: it.ordered_qty, unit_price: it.unit_price })),
            source_ward_request_ids: d.source_ward_request_ids,
            source_approval_item_ids: d.source_approval_item_ids,
          }),
        });
        ok += 1;
      } catch (e: any) {
        fail.push({ vendor_name: d.vendor_name, error: e?.message ?? '알 수 없는 오류' });
        break;
      }
    }
    setSubmitting(false);
    setSubmitResult({ ok, fail });
    if (ok > 0) {
      onCreated();
      await load();
    }
  };

  const toggleLine = (bucketIdx: number, line: PendingLine) => {
    const key = lineKey(bucketIdx, line.item_id);
    const cur = selection.get(key);
    if (cur?.checked) setLineState(key, { checked: false });
    else {
      // 기본 발주수량 = 미달 팩수를 박스 단위로 올림 환산 (단가가 박스단가이므로 일치)
      setLineState(key, {
        checked: true,
        qty: cur?.qty || ceilToPurchaseQty(line.unfulfilled_qty, line.pack_size),
        vendorOverride: cur?.vendorOverride ?? null,
      });
    }
  };

  return (
    <div className="card p-0 mb-4">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50"
      >
        <div className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          <span className="font-semibold text-navy-800">발주 대기 큐</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
            {loading ? '로딩 중' : `${totalLineCount}건`}
          </span>
          {/* 거래처 미지정 배지 — 결의서 화면에서 처리하도록 분리되어 여기 노출 X */}
        </div>
        <span className="text-xs text-gray-500">
          {sourceType ? `유형: ${TYPE_LABEL[sourceType] ?? sourceType}` : '전체 유형'}
        </span>
      </button>

      {!collapsed && (
        <div className="border-t border-slate-100 p-4">
          {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm mb-3">{error}</div>}
          {loading ? (
            <div className="py-8 text-center text-sm text-gray-400">불러오는 중...</div>
          ) : !data || assignedBuckets.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400 inline-flex items-center justify-center gap-2 w-full">
              <Inbox className="w-5 h-5" />
              발주 대기 항목이 없습니다.
            </div>
          ) : (
            <div className="space-y-3">
              {/* 거래처별 발주 금액 미리보기 — 전체 / 선택 합계 */}
              <div className="card p-0 overflow-hidden border-slate-200">
                <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                  <span className="font-semibold text-navy-800 text-sm">거래처별 발주 금액 미리보기</span>
                  <span className="text-xs text-gray-500">
                    전체 <b className="text-blue-700">{fmtWon(summaryGrandTotal)}</b>
                    {summarySelectedTotal > 0 && <> · 선택 <b className="text-emerald-700">{fmtWon(summarySelectedTotal)}</b></>}
                  </span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-slate-100 bg-gray-50">
                      <th className="px-3 py-1.5 text-left">거래처</th>
                      <th className="px-3 py-1.5 text-right">전체 라인</th>
                      <th className="px-3 py-1.5 text-right">전체 금액</th>
                      <th className="px-3 py-1.5 text-right">선택 라인</th>
                      <th className="px-3 py-1.5 text-right">선택 금액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendorSummary.map(v => (
                      <tr key={v.vendor_id ?? '__unassigned__'} className={`border-b border-slate-100 ${!v.vendor_id ? 'bg-red-50/40' : ''}`}>
                        <td className="px-3 py-1.5">
                          {v.vendor_id
                            ? <span className="text-slate-800">{v.vendor_name}</span>
                            : <span className="inline-flex items-center gap-1 text-red-700"><AlertTriangle className="w-3.5 h-3.5" />거래처 미지정</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{v.lineCount}</td>
                        <td className="px-3 py-1.5 text-right font-medium text-blue-700">{fmtWon(v.totalAmount)}</td>
                        <td className="px-3 py-1.5 text-right text-gray-600">{v.selectedLineCount > 0 ? v.selectedLineCount : '-'}</td>
                        <td className="px-3 py-1.5 text-right font-medium text-emerald-700">{v.selectedAmount > 0 ? fmtWon(v.selectedAmount) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50">
                      <td className="px-3 py-1.5 text-right text-sm font-medium text-gray-600">합계</td>
                      <td className="px-3 py-1.5 text-right text-gray-600">{vendorSummary.reduce((s, v) => s + v.lineCount, 0)}</td>
                      <td className="px-3 py-1.5 text-right text-base font-bold text-blue-700">{fmtWon(summaryGrandTotal)}</td>
                      <td className="px-3 py-1.5 text-right text-gray-600">{vendorSummary.reduce((s, v) => s + v.selectedLineCount, 0) || '-'}</td>
                      <td className="px-3 py-1.5 text-right text-base font-bold text-emerald-700">{summarySelectedTotal > 0 ? fmtWon(summarySelectedTotal) : '-'}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {assignedBuckets.map((bucket, bIdx) => (
                <div
                  key={`${bucket.vendor_id ?? 'unassigned'}-${bucket.schedule_period_label}-${bucket.request_type}-${bIdx}`}
                  className={`border rounded-xl overflow-hidden ${bucket.vendor_id ? 'border-slate-200' : 'border-red-200 bg-red-50/30'}`}
                >
                  <div className="px-4 py-2 border-b border-slate-100 flex flex-wrap items-center gap-2">
                    {!bucket.vendor_id && <AlertTriangle className="w-4 h-4 text-red-600" />}
                    <span className="font-medium text-navy-800">{bucket.vendor_name}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                      {bucket.schedule_period_label}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                      {TYPE_LABEL[bucket.request_type] ?? bucket.request_type}
                    </span>
                    <span className="text-xs text-gray-500 ml-auto">
                      {bucket.ward_requests.map(w => w.request_no).join(', ')} · {bucket.ward_requests.map(w => w.department_name).filter(Boolean).join(', ')}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr className="text-xs text-gray-500">
                          <th className="px-3 py-2 w-8"></th>
                          <th className="px-3 py-2 text-left">품목</th>
                          <th className="px-3 py-2 text-right">승인</th>
                          <th className="px-3 py-2 text-right">발주</th>
                          <th className="px-3 py-2 text-right">불출</th>
                          <th className="px-3 py-2 text-right">잔량</th>
                          <th className="px-3 py-2 text-right">단가</th>
                          <th className="px-3 py-2 text-left">거래처</th>
                          <th className="px-3 py-2 text-right">발주수량</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bucket.lines.map(line => {
                          const key = lineKey(bIdx, line.item_id);
                          const sel = selection.get(key);
                          const checked = sel?.checked ?? false;
                          const qty = sel?.qty ?? Math.ceil(line.unfulfilled_qty);
                          const overrideVendor = sel?.vendorOverride ?? null;
                          return (
                            <tr key={line.item_id} className={`border-t border-slate-100 ${checked ? 'bg-blue-50/40' : ''}`}>
                              <td className="px-3 py-2 text-center">
                                <input type="checkbox" checked={checked} onChange={() => toggleLine(bIdx, line)} />
                              </td>
                              <td className="px-3 py-2">
                                <div className="font-medium text-slate-800">{line.item_name}</div>
                                <div className="text-xs text-gray-400">{line.item_code} · {line.purchase_uom}</div>
                              </td>
                              <td className="px-3 py-2 text-right text-gray-600">{Math.round(line.approved_qty)}</td>
                              <td className="px-3 py-2 text-right text-gray-500">{Math.round(line.po_qty)}</td>
                              <td className="px-3 py-2 text-right text-gray-500">{Math.round(line.stock_out_qty)}</td>
                              <td className="px-3 py-2 text-right font-semibold text-blue-700">{Math.ceil(line.unfulfilled_qty)}</td>
                              <td className="px-3 py-2 text-right text-gray-600">{Number(line.last_unit_price).toLocaleString()}</td>
                              <td className="px-3 py-2">
                                {line.default_vendor_id ? (
                                  <span className="text-xs text-gray-600">{line.default_vendor_name}</span>
                                ) : (
                                  <select
                                    value={overrideVendor ?? ''}
                                    onChange={(e) => setLineState(key, { vendorOverride: e.target.value || null })}
                                    className="input text-xs py-1 px-1 min-w-[8rem]"
                                  >
                                    <option value="">거래처 선택…</option>
                                    {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                                  </select>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right">
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={qty}
                                  onChange={(e) => setLineState(key, { qty: Math.max(0, Number(e.target.value) || 0), checked: true })}
                                  className="input text-right w-24 text-sm py-1"
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}

              <div className="flex items-center justify-between pt-2">
                <span className="text-sm text-gray-600">
                  {selectedCount}건 선택 · <b>{drafts.length}장</b>의 발주서가 생성됩니다
                  {skippedUnassignedCount > 0 && (
                    <span className="text-red-600 ml-2">⚠ 거래처 미지정 {skippedUnassignedCount}건은 제외됩니다</span>
                  )}
                </span>
                <button
                  onClick={() => setConfirmOpen(true)}
                  disabled={drafts.length === 0 || submitting}
                  className="btn-primary disabled:opacity-40"
                >
                  선택 항목으로 발주서 만들기
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {confirmOpen && (
        <Modal
          open={true}
          onClose={() => { if (!submitting) { setConfirmOpen(false); setSubmitResult(null); } }}
          title="발주서 생성 확인"
          size="lg"
          footer={
            submitResult ? (
              <button onClick={() => { setConfirmOpen(false); setSubmitResult(null); }} className="btn-primary">닫기</button>
            ) : (
              <>
                <button onClick={() => setConfirmOpen(false)} disabled={submitting} className="btn-secondary">취소</button>
                <button onClick={submitDrafts} disabled={submitting || drafts.length === 0} className="btn-primary">
                  {submitting ? '생성 중...' : `${drafts.length}장 발주서 생성`}
                </button>
              </>
            )
          }
        >
          {submitResult ? (
            <div className="space-y-3">
              <div className="p-3 rounded-lg bg-green-50 text-green-700 text-sm">
                ✅ 성공 {submitResult.ok}건
              </div>
              {submitResult.fail.length > 0 && (
                <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">
                  ❌ 실패 {submitResult.fail.length}건
                  <ul className="mt-2 list-disc list-inside">
                    {submitResult.fail.map((f, i) => <li key={i}>{f.vendor_name}: {f.error}</li>)}
                  </ul>
                  <p className="mt-2 text-xs">실패한 라인은 큐에 그대로 남아있어 다시 시도할 수 있습니다.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                아래 <b>{drafts.length}장</b>의 발주서가 임시저장(DRAFT) 상태로 생성됩니다. 각 발주서를 검토 후 발송해 주세요.
              </p>
              {skippedUnassignedCount > 0 && (
                <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm">
                  거래처 미지정 라인 {skippedUnassignedCount}건은 이번 생성에서 <b>제외</b>됩니다.
                  취소한 후 거래처를 지정하거나 그대로 진행하세요.
                </div>
              )}
              <div className="space-y-2">
                {drafts.map((d, i) => {
                  const total = d.items.reduce((s, x) => s + x.line_amount, 0);
                  return (
                    <div key={i} className="border rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <div className="font-medium">{d.vendor_name}</div>
                          <div className="text-xs text-gray-500">
                            {TYPE_LABEL[d.request_type] ?? d.request_type} · {d.schedule_period_label}
                          </div>
                        </div>
                        <div className="text-right text-sm">
                          <div className="font-semibold">{total.toLocaleString()}원</div>
                          <div className="text-xs text-gray-500">{d.items.length}품목</div>
                        </div>
                      </div>
                      <table className="w-full text-xs">
                        <tbody>
                          {d.items.map(it => (
                            <tr key={it.item_id} className="border-t border-slate-100">
                              <td className="py-1 text-gray-700">{it.item_name}</td>
                              <td className="py-1 text-right text-gray-500 w-20">{it.ordered_qty}</td>
                              <td className="py-1 text-right text-gray-500 w-24">@{it.unit_price.toLocaleString()}</td>
                              <td className="py-1 text-right w-28">{it.line_amount.toLocaleString()}원</td>
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
        </Modal>
      )}
    </div>
  );
}
