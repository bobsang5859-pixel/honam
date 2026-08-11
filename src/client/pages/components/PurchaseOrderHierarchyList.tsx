import React, { useCallback, useMemo, useState } from 'react';
import { Eye, Send } from 'lucide-react';
import type { PurchaseOrder } from '@shared/types';
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
  DRAFT: '임시', SENT: '발주완료', PARTIAL_RECEIVED: '부분입고', CLOSED: '완료', CANCELLED: '취소',
};
const STATUS_CLS: Record<string, string> = {
  DRAFT: 'badge-amber', SENT: 'badge-blue', PARTIAL_RECEIVED: 'badge-purple', CLOSED: 'badge-green', CANCELLED: 'badge-gray',
};

export function PurchaseOrderHierarchyList({ orders, openDetail, sendPO, canSend, fmt, onPeriodChanged }: {
  orders: PurchaseOrder[];
  openDetail: (id: string) => void;
  sendPO: (id: string) => void;
  canSend: boolean;
  fmt: (n: number) => string;
  onPeriodChanged?: () => void;
}) {
  const changePeriodLabel = async (o: PurchaseOrder) => {
    const current = (o as any).manual_period_label ?? o.schedule_period_label ?? '';
    const input = window.prompt(`${o.po_no} 의 주차 라벨을 입력하세요.\n비우면 자동 라벨로 복귀합니다.`, current);
    if (input === null) return;
    try {
      await api(`/purchase-orders/${o.id}/period-label`, {
        method: 'PATCH',
        body: JSON.stringify({ period_label: input.trim() || null }),
      });
      onPeriodChanged?.();
    } catch (e: any) {
      alert(e?.message ?? '주차 라벨 변경 실패');
    }
  };

  const hierarchy = useMemo(() => {
    const periodMap = new Map<string, Map<string, PurchaseOrder[]>>();
    for (const o of orders) {
      const period = (o.schedule_period_label && String(o.schedule_period_label).trim())
        || (o.ordered_at ? `${new Date(o.ordered_at).getFullYear()}년 ${new Date(o.ordered_at).getMonth() + 1}월` : '기간 미지정');
      const vendorId = String(o.vendor_id ?? '_unknown');
      let vMap = periodMap.get(period);
      if (!vMap) { vMap = new Map(); periodMap.set(period, vMap); }
      const arr = vMap.get(vendorId) ?? [];
      arr.push(o);
      vMap.set(vendorId, arr);
    }
    return Array.from(periodMap.entries()).map(([period, vMap]) => {
      const vendors = Array.from(vMap.entries()).map(([vendorId, pos]) => {
        const sorted = [...pos].sort((a, b) => new Date(b.ordered_at).getTime() - new Date(a.ordered_at).getTime());
        const breakdown: Record<string, number> = {};
        let totalAmt = 0;
        for (const po of sorted) {
          for (const [k, v] of Object.entries((po as any).category_breakdown ?? {})) breakdown[k] = (breakdown[k] ?? 0) + Number(v ?? 0);
          totalAmt += Number(po.total_amount ?? 0);
        }
        return { vendor_id: vendorId, vendor_name: sorted[0]?.vendor_name ?? '미지정', orders: sorted, breakdown, total_amount: totalAmt };
      }).sort((a, b) => a.vendor_name.localeCompare(b.vendor_name, 'ko'));
      const totalPo = vendors.reduce((s, v) => s + v.orders.length, 0);
      const totalAmt = vendors.reduce((s, v) => s + v.total_amount, 0);
      const totalBreakdown: Record<string, number> = {};
      for (const v of vendors) for (const [k, vv] of Object.entries(v.breakdown)) totalBreakdown[k] = (totalBreakdown[k] ?? 0) + Number(vv ?? 0);
      return { period, vendors, totalPo, totalAmt, totalBreakdown };
    }).sort((a, b) => b.period.localeCompare(a.period));
  }, [orders]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = useCallback((k: string) => {
    setExpanded(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  }, []);

  return (
    <div className="card p-0">
      <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-700">기간 · 거래처별 발주</div>
        <div className="flex gap-2 text-xs">
          <button className="text-blue-600 hover:underline" onClick={() => {
            const all = new Set<string>();
            for (const p of hierarchy) {
              all.add(`po::${p.period}`);
              for (const v of p.vendors) all.add(`po::${p.period}::${v.vendor_id}`);
            }
            setExpanded(all);
          }}>모두 펼치기</button>
          <span className="text-slate-300">·</span>
          <button className="text-blue-600 hover:underline" onClick={() => setExpanded(new Set())}>모두 접기</button>
        </div>
      </div>
      <div className="divide-y divide-slate-100">
        {hierarchy.map(p => {
          const pKey = `po::${p.period}`;
          const pOpen = expanded.has(pKey);
          return (
            <div key={pKey}>
              <button onClick={() => toggle(pKey)} className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-slate-50 text-left">
                <span className="text-slate-400">{pOpen ? '▼' : '▶'}</span>
                <span className="font-semibold text-sm text-slate-800">{p.period}</span>
                <span className="text-xs text-slate-500">{p.totalPo}건 · {p.vendors.length}개 거래처 · ₩{p.totalAmt.toLocaleString('ko-KR')}</span>
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
                          <span className="text-xs text-slate-500">{v.orders.length}건 · ₩{v.total_amount.toLocaleString('ko-KR')}</span>
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
                                <th className="px-3 py-1.5 text-left">유형</th>
                                <th className="px-3 py-1.5 text-center">발주일</th>
                                <th className="px-3 py-1.5 text-center">예상입고</th>
                                <th className="px-3 py-1.5 text-right">금액</th>
                                <th className="px-3 py-1.5 text-center">상태</th>
                                <th className="px-3 py-1.5 text-left">발주번호</th>
                                <th className="px-3 py-1.5 text-right"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {v.orders.map(o => (
                                <tr key={o.id} className="border-t border-slate-100 hover:bg-slate-50/40 cursor-pointer" onClick={() => openDetail(o.id)}>
                                  <td className="px-3 py-1.5">
                                    <div className="flex flex-wrap gap-1">
                                      {Object.entries((o as any).category_breakdown ?? {}).map(([k, vv]: any) => (
                                        <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded ${MAJOR_BG[k] ?? 'bg-slate-100 text-slate-600'}`}>
                                          {MAJOR_LABEL_KO[k] ?? k} {vv}
                                        </span>
                                      ))}
                                    </div>
                                  </td>
                                  <td className="px-3 py-1.5 text-xs text-slate-500">{o.source_type ?? '-'}</td>
                                  <td className="px-3 py-1.5 text-center text-xs text-slate-500">{new Date(o.ordered_at).toLocaleDateString('ko-KR')}</td>
                                  <td className="px-3 py-1.5 text-center text-xs text-slate-500">{o.expected_at ? new Date(o.expected_at).toLocaleDateString('ko-KR') : '-'}</td>
                                  <td className="px-3 py-1.5 text-right">₩{fmt(o.total_amount)}</td>
                                  <td className="px-3 py-1.5 text-center">
                                    <span className={STATUS_CLS[o.status] || 'badge-gray'}>{STATUS_LABEL[o.status] || o.status}</span>
                                  </td>
                                  <td className="px-3 py-1.5 font-mono text-xs text-slate-400">{o.po_no}</td>
                                  <td className="px-3 py-1.5 text-right">
                                    <div className="inline-flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                      <button onClick={() => openDetail(o.id)} className="text-xs text-accent-600 hover:underline inline-flex items-center gap-1">
                                        <Eye className="w-3.5 h-3.5" /> 보기
                                      </button>
                                      <button onClick={() => changePeriodLabel(o)} className="text-xs text-slate-500 hover:text-blue-600" title="주차 라벨 수정">주차</button>
                                      {canSend && o.status === 'DRAFT' && (
                                        <button onClick={() => sendPO(o.id)} className="text-xs text-navy-700 hover:underline inline-flex items-center gap-1">
                                          <Send className="w-3.5 h-3.5" /> 발송
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
