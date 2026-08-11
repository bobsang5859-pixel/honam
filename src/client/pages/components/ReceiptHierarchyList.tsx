import React, { useCallback, useMemo, useState } from 'react';
import { Eye, CheckCircle, RotateCcw } from 'lucide-react';
import type { GoodsReceipt } from '@shared/types';
import { api } from '../../utils/api';

const MAJOR_LABEL_KO: Record<string, string> = { MEDICAL: '의료', GENERAL: '일반', DIAPER: '기저귀', OFFICE: '사무', EQUIPMENT: '비품' };
const MAJOR_BG: Record<string, string> = {
  MEDICAL: 'bg-rose-100 text-rose-700',
  GENERAL: 'bg-sky-100 text-sky-700',
  DIAPER: 'bg-amber-100 text-amber-700',
  OFFICE: 'bg-indigo-100 text-indigo-700',
  EQUIPMENT: 'bg-emerald-100 text-emerald-700',
};
const STATUS_LABEL: Record<string, string> = {
  PENDING: '검수 대기', CONFIRMED: '검수완료', DIFF_CONFIRMED: '차이확정', REVERSED: '취소',
};
const STATUS_CLS: Record<string, string> = {
  PENDING: 'badge-amber', CONFIRMED: 'badge-green', DIFF_CONFIRMED: 'badge-purple', REVERSED: 'badge-gray',
};

// received_at 기준 월 라벨 (YYYY년 M월)
function monthLabel(d: string | Date | null | undefined): string {
  if (!d) return '기간 미지정';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '기간 미지정';
  return `${dt.getFullYear()}년 ${dt.getMonth() + 1}월`;
}

export function ReceiptHierarchyList({ receipts, openVerify, fmt, canReverse, reverse, onPeriodChanged }: {
  receipts: GoodsReceipt[];
  openVerify: (id: string) => void;
  fmt: (n: number) => string;
  canReverse?: boolean;
  reverse?: (id: string) => void;
  onPeriodChanged?: () => void;
}) {
  const changeReceivedAt = async (r: GoodsReceipt) => {
    const current = new Date(r.received_at);
    const yyyy = current.getFullYear();
    const mm = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    const input = window.prompt(`${r.gr_no} 의 입고일자를 YYYY-MM-DD 로 입력하세요.`, `${yyyy}-${mm}-${dd}`);
    if (input === null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
      alert('YYYY-MM-DD 형식이어야 합니다.');
      return;
    }
    try {
      await api(`/receipts/${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ received_at: input.trim() }),
      });
      onPeriodChanged?.();
    } catch (e: any) {
      alert(e?.message ?? '입고일 변경 실패');
    }
  };

  const hierarchy = useMemo(() => {
    const periodMap = new Map<string, Map<string, GoodsReceipt[]>>();
    for (const r of receipts) {
      const period = monthLabel(r.received_at);
      const vendorId = String((r as any).vendor_id ?? (r as any).manual_vendor_id ?? '_unknown');
      let vMap = periodMap.get(period);
      if (!vMap) { vMap = new Map(); periodMap.set(period, vMap); }
      const arr = vMap.get(vendorId) ?? [];
      arr.push(r);
      vMap.set(vendorId, arr);
    }
    return Array.from(periodMap.entries()).map(([period, vMap]) => {
      const vendors = Array.from(vMap.entries()).map(([vendorId, rs]) => {
        const sorted = [...rs].sort((a, b) => new Date(b.received_at).getTime() - new Date(a.received_at).getTime());
        const breakdown: Record<string, number> = {};
        let totalAmt = 0;
        let diffCount = 0;
        for (const r of sorted) {
          for (const [k, v] of Object.entries((r as any).category_breakdown ?? {})) breakdown[k] = (breakdown[k] ?? 0) + Number(v ?? 0);
          totalAmt += Number((r as any).total_amount ?? 0);
          diffCount += Number((r as any).diff_count ?? 0);
        }
        const vendorName = String((sorted[0] as any).vendor_name ?? '미지정');
        return { vendor_id: vendorId, vendor_name: vendorName, receipts: sorted, breakdown, total_amount: totalAmt, diff_count: diffCount };
      }).sort((a, b) => a.vendor_name.localeCompare(b.vendor_name, 'ko'));
      const totalReceipts = vendors.reduce((s, v) => s + v.receipts.length, 0);
      const totalAmt = vendors.reduce((s, v) => s + v.total_amount, 0);
      const totalBreakdown: Record<string, number> = {};
      for (const v of vendors) for (const [k, vv] of Object.entries(v.breakdown)) totalBreakdown[k] = (totalBreakdown[k] ?? 0) + Number(vv ?? 0);
      return { period, vendors, totalReceipts, totalAmt, totalBreakdown };
    }).sort((a, b) => b.period.localeCompare(a.period));
  }, [receipts]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = useCallback((k: string) => {
    setExpanded(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  }, []);

  if (hierarchy.length === 0) {
    return <div className="card p-0"><div className="p-8 text-center text-sm text-gray-400">입고 내역이 없습니다.</div></div>;
  }

  return (
    <div className="card p-0">
      <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-700">월별 · 거래처별 입고</div>
        <div className="flex gap-2 text-xs">
          <button className="text-blue-600 hover:underline" onClick={() => {
            const all = new Set<string>();
            for (const p of hierarchy) {
              all.add(`gr::${p.period}`);
              for (const v of p.vendors) all.add(`gr::${p.period}::${v.vendor_id}`);
            }
            setExpanded(all);
          }}>모두 펼치기</button>
          <span className="text-slate-300">·</span>
          <button className="text-blue-600 hover:underline" onClick={() => setExpanded(new Set())}>모두 접기</button>
        </div>
      </div>
      <div className="divide-y divide-slate-100">
        {hierarchy.map(p => {
          const pKey = `gr::${p.period}`;
          const pOpen = expanded.has(pKey);
          return (
            <div key={pKey}>
              <button onClick={() => toggle(pKey)} className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-slate-50 text-left">
                <span className="text-slate-400">{pOpen ? '▼' : '▶'}</span>
                <span className="font-semibold text-sm text-slate-800">{p.period}</span>
                <span className="text-xs text-slate-500">{p.totalReceipts}건 · {p.vendors.length}개 거래처 · ₩{p.totalAmt.toLocaleString('ko-KR')}</span>
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
                  {p.vendors.map(v => {
                    const vKey = `${pKey}::${v.vendor_id}`;
                    const vOpen = expanded.has(vKey);
                    return (
                      <div key={vKey} className="border-t border-slate-100">
                        <button onClick={() => toggle(vKey)} className="w-full px-8 py-2 flex items-center gap-2 hover:bg-slate-50 text-left">
                          <span className="text-slate-400 text-xs">{vOpen ? '▼' : '▶'}</span>
                          <span className="font-medium text-sm text-slate-700">{v.vendor_name}</span>
                          <span className="text-xs text-slate-500">{v.receipts.length}건 · ₩{v.total_amount.toLocaleString('ko-KR')}</span>
                          {v.diff_count > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">차이 {v.diff_count}</span>}
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
                                <th className="px-3 py-1.5 text-center">입고일</th>
                                <th className="px-3 py-1.5 text-right">품목수</th>
                                <th className="px-3 py-1.5 text-right">총액</th>
                                <th className="px-3 py-1.5 text-center">상태</th>
                                <th className="px-3 py-1.5 text-left">입고번호</th>
                                <th className="px-3 py-1.5 text-right"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {v.receipts.map(r => (
                                <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50/40 cursor-pointer" onClick={() => openVerify(r.id)}>
                                  <td className="px-3 py-1.5">
                                    <div className="flex flex-wrap gap-1">
                                      {Object.entries((r as any).category_breakdown ?? {}).map(([k, vv]: any) => (
                                        <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded ${MAJOR_BG[k] ?? 'bg-slate-100 text-slate-600'}`}>
                                          {MAJOR_LABEL_KO[k] ?? k} {vv}
                                        </span>
                                      ))}
                                    </div>
                                  </td>
                                  <td className="px-3 py-1.5 text-center text-xs text-slate-500">{new Date(r.received_at).toLocaleDateString('ko-KR')}</td>
                                  <td className="px-3 py-1.5 text-right">{(r as any).item_count ?? r.items?.length ?? 0}건</td>
                                  <td className="px-3 py-1.5 text-right">₩{fmt(Number((r as any).total_amount ?? 0))}</td>
                                  <td className="px-3 py-1.5 text-center">
                                    <span className={STATUS_CLS[r.status] || 'badge-gray'}>{STATUS_LABEL[r.status] || r.status}</span>
                                    {Number((r as any).diff_count ?? 0) > 0 && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">차이 {(r as any).diff_count}</span>}
                                  </td>
                                  <td className="px-3 py-1.5 font-mono text-xs text-slate-400">{r.gr_no}</td>
                                  <td className="px-3 py-1.5 text-right">
                                    <div className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                      <button onClick={() => openVerify(r.id)} className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1">
                                        <Eye className="w-3.5 h-3.5" /> {r.status === 'PENDING' ? '검수' : '상세'}
                                      </button>
                                      <button onClick={() => changeReceivedAt(r)} className="text-xs text-slate-500 hover:text-blue-600" title="입고일자 수정">입고일</button>
                                      {canReverse && reverse && r.status !== 'REVERSED' && (
                                        <button onClick={() => reverse(r.id)} className="text-xs text-red-500 hover:underline inline-flex items-center gap-1">
                                          <RotateCcw className="w-3.5 h-3.5" /> 취소
                                        </button>
                                      )}
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
