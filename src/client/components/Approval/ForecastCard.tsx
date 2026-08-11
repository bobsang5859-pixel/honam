import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, RefreshCw } from 'lucide-react';
import { ceilToPurchaseQty } from '@shared/units';

export interface ForecastLine {
  ward_request_id: string;
  item_id: string;
  item_name: string;
  qty: number;            // 신청/승인 수량 (issue_uom = 팩)
  pack_size?: number;     // 1 purchase_uom = N issue_uom (박스↔팩)
  unit_price: number;     // 박스 단가 (purchase_uom 기준)
  default_vendor_id: string | null;
  default_vendor_name: string | null;
}

interface Props {
  lines: ForecastLine[];
  loading?: boolean;
  onRefresh?: () => void;
  currentRequestId?: string;
}

interface VendorBucket {
  vendor_id: string | null;
  vendor_name: string;
  line_count: number;
  request_ids: Set<string>;
  amount: number;
}

export default function ForecastCard({ lines, loading = false, onRefresh, currentRequestId }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  const { vendors, unassigned, total } = useMemo(() => {
    const byVendor = new Map<string, VendorBucket>();
    let total = 0;
    for (const ln of lines) {
      const key = ln.default_vendor_id ?? '__UNASSIGNED__';
      let bucket = byVendor.get(key);
      if (!bucket) {
        bucket = {
          vendor_id: ln.default_vendor_id,
          vendor_name: ln.default_vendor_name ?? '거래처 미지정',
          line_count: 0,
          request_ids: new Set(),
          amount: 0,
        };
        byVendor.set(key, bucket);
      }
      // qty 는 팩 단위이고 unit_price 는 박스단가이므로, 박스 환산 후 곱해야 단위 일치
      const boxQty = ceilToPurchaseQty(ln.qty, ln.pack_size ?? 1);
      const lineAmount = boxQty * ln.unit_price;
      bucket.line_count += 1;
      bucket.amount += lineAmount;
      bucket.request_ids.add(ln.ward_request_id);
      total += lineAmount;
    }
    const arr = Array.from(byVendor.values());
    return {
      vendors: arr.filter(b => b.vendor_id !== null).sort((a, b) => b.amount - a.amount),
      unassigned: arr.find(b => b.vendor_id === null) ?? null,
      total,
    };
  }, [lines]);

  const fmt = (n: number) => `₩${Math.round(n).toLocaleString('ko-KR')}`;
  const currentLineCount = currentRequestId ? lines.filter(ln => ln.ward_request_id === currentRequestId).length : 0;
  const otherRequestCount = useMemo(() => {
    const ids = new Set<string>();
    for (const ln of lines) if (ln.ward_request_id !== currentRequestId) ids.add(ln.ward_request_id);
    return ids.size;
  }, [lines, currentRequestId]);

  return (
    <div className="card p-0 mb-4 border-l-4 border-l-blue-500">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50"
      >
        <div className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          <span className="font-semibold text-navy-800">예상 발주 요약</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
            승인 대기 전체
          </span>
          <span className="text-xs text-gray-500">
            {currentRequestId ? `현재 신청 ${currentLineCount}라인 + 다른 ${otherRequestCount}건` : `${vendors.length + (unassigned ? 1 : 0)}개 거래처`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-base font-bold text-blue-700">{fmt(total)}</span>
          {onRefresh && (
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); onRefresh(); }}
              className="text-gray-400 hover:text-gray-600"
              title="다시 불러오기"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </span>
          )}
        </div>
      </button>
      {!collapsed && (
        <div className="border-t border-slate-100 px-4 py-3">
          {loading && lines.length === 0 ? (
            <div className="py-4 text-center text-sm text-gray-400">불러오는 중...</div>
          ) : lines.length === 0 ? (
            <div className="py-4 text-center text-sm text-gray-400">승인 대기 중인 신청이 없습니다.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-slate-100">
                  <th className="text-left py-1.5 font-medium">거래처</th>
                  <th className="text-right py-1.5 font-medium">라인</th>
                  <th className="text-right py-1.5 font-medium">신청건수</th>
                  <th className="text-right py-1.5 font-medium">예상금액</th>
                </tr>
              </thead>
              <tbody>
                {vendors.map(b => (
                  <tr key={b.vendor_id!} className="border-b border-slate-100">
                    <td className="py-1.5 font-medium text-slate-800">{b.vendor_name}</td>
                    <td className="py-1.5 text-right text-gray-600">{b.line_count}</td>
                    <td className="py-1.5 text-right text-gray-600">{b.request_ids.size}</td>
                    <td className="py-1.5 text-right font-medium">{fmt(b.amount)}</td>
                  </tr>
                ))}
                {unassigned && (
                  <tr className="border-b border-slate-100 bg-red-50/30">
                    <td className="py-1.5 inline-flex items-center gap-1 text-red-700">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      거래처 미지정
                    </td>
                    <td className="py-1.5 text-right text-gray-600">{unassigned.line_count}</td>
                    <td className="py-1.5 text-right text-gray-600">{unassigned.request_ids.size}</td>
                    <td className="py-1.5 text-right font-medium text-red-700">{fmt(unassigned.amount)}</td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="py-2 text-right text-sm font-medium text-gray-600">총 합계</td>
                  <td className="py-2 text-right text-base font-bold text-blue-700">{fmt(total)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
