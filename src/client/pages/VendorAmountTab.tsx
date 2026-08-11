import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';

type VendorRow = {
  vendor_id: string;
  vendor_name: string;
  amounts: Record<string, number>;
  total: number;
};

type AmountData = {
  year: number;
  month: number;
  weeks: string[];
  rows: VendorRow[];
  grand_total: Record<string, number>;
  overall_total: number;
};

export default function VendorAmountTab() {
  const [yearMonth, setYearMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [data, setData] = useState<AmountData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const [y, m] = yearMonth.split('-');
    setLoading(true);
    setError(null);
    api(`/purchase-orders/vendor-weekly-amounts?year=${y}&month=${Number(m)}`)
      .then(setData)
      .catch((e: any) => setError(e?.message ?? '불러오기 실패'))
      .finally(() => setLoading(false));
  }, [yearMonth]);

  const fmt = (n: number) => n.toLocaleString('ko-KR');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label className="text-sm text-slate-600 font-medium">기준 월</label>
        <input
          type="month"
          value={yearMonth}
          onChange={e => setYearMonth(e.target.value)}
          className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
      </div>

      {loading && (
        <div className="text-slate-400 text-sm py-12 text-center">불러오는 중...</div>
      )}

      {error && (
        <div className="text-red-500 text-sm bg-red-50 border border-red-200 rounded-lg px-4 py-3">{error}</div>
      )}

      {data && !loading && (
        <>
          {data.rows.length === 0 ? (
            <div className="py-12 text-center text-slate-400 text-sm">
              {data.year}년 {data.month}월에 발주 완료된 내역이 없습니다
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-teal-700 text-white">
                    <th className="px-4 py-2.5 text-left font-semibold border-r border-teal-600 min-w-[180px]">
                      업체명
                    </th>
                    {data.weeks.map(w => (
                      <th
                        key={w}
                        className="px-4 py-2.5 text-right font-semibold border-r border-teal-600 min-w-[130px]"
                      >
                        {w} 물품금액
                      </th>
                    ))}
                    <th className="px-4 py-2.5 text-right font-semibold min-w-[130px]">합 계</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, i) => (
                    <tr
                      key={row.vendor_id}
                      className={i % 2 === 0 ? 'bg-white hover:bg-slate-50' : 'bg-slate-50 hover:bg-slate-100'}
                    >
                      <td className="px-4 py-2 border-r border-b border-slate-200 font-medium text-slate-700">
                        {row.vendor_name}
                      </td>
                      {data.weeks.map(w => (
                        <td
                          key={w}
                          className="px-4 py-2 border-r border-b border-slate-200 text-right text-slate-600 tabular-nums"
                        >
                          {row.amounts[w] ? fmt(row.amounts[w]) : '—'}
                        </td>
                      ))}
                      <td className="px-4 py-2 border-b border-slate-200 text-right font-semibold text-slate-700 tabular-nums">
                        {fmt(row.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-teal-50">
                    <td className="px-4 py-2.5 border-r border-t border-slate-300 font-bold text-teal-800">
                      총 액
                    </td>
                    {data.weeks.map(w => (
                      <td
                        key={w}
                        className="px-4 py-2.5 border-r border-t border-slate-300 text-right font-bold text-teal-800 tabular-nums"
                      >
                        {fmt(data.grand_total[w] || 0)}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 border-t border-slate-300 text-right font-bold text-teal-800 tabular-nums">
                      {fmt(data.overall_total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
