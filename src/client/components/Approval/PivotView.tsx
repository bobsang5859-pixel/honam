/**
 * 승인 페이지 — 통합뷰 (부서 × 품목 피벗)
 *
 * 한 유형(의료소모품 / 일반소모품 / 사무용품) 의 모든 신청을 한 표에 펼침.
 * 행 = 품목 (코드번호순), 열 = 부서, 셀 = 신청수량 또는 승인수량.
 * 우측 끝 합계 컬럼 + 하단 합계 행 → 거래처 발주 수량 한 눈에.
 */
import { useMemo, useState } from 'react';
import { Loader2, Tag, Users, ExternalLink } from 'lucide-react';

interface Item {
  id?: string;
  item_id: string;
  item_code?: string;
  item_name?: string;
  custom_name?: string;
  custom_spec?: string;
  is_custom?: boolean;
  requested_qty: number;
  last_approved_qty?: number | null;
}

interface Detail {
  id: string;
  request_no: string;
  department_id?: string;
  department_name?: string;
  status: string;
  request_type?: string;
  period_start?: string;
  items: Item[];
}

const STATUS_BADGE: Record<string, string> = {
  SUBMITTED: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-green-100 text-green-700',
  PARTIAL_APPROVED: 'bg-yellow-100 text-yellow-700',
  REJECTED: 'bg-red-100 text-red-700',
  CANCELLED: 'bg-slate-100 text-slate-500',
};

interface Props {
  data: Detail[];
  loading: boolean;
  type: 'CONSUMABLE_MEDICAL' | 'CONSUMABLE_REGULAR' | 'CONSUMABLE_OFFICE';
  onTypeChange: (t: 'CONSUMABLE_MEDICAL' | 'CONSUMABLE_REGULAR' | 'CONSUMABLE_OFFICE') => void;
  period: string;
  onPeriodChange: (p: string) => void;
  showApproved: boolean;
  onToggleApproved: (b: boolean) => void;
  onOpenDetail: (id: string) => void;
}

export default function PivotView({
  data, loading, type, onTypeChange, period, onPeriodChange,
  showApproved, onToggleApproved, onOpenDetail,
}: Props) {
  // 상태 필터 — 기본 "승인됨" (APPROVED + PARTIAL_APPROVED) 만.
  //   ALL: 모든 상태 (제출/승인/부분승인/반려/취소)
  //   APPROVED: 승인 + 부분승인 (실제 발주 대상)
  //   SUBMITTED: 대기 중인 신청만
  const [statusFilter, setStatusFilter] = useState<'APPROVED' | 'SUBMITTED' | 'ALL'>('APPROVED');

  // 1) 사용 가능한 신청주기 후보 (period_start 의 'YYYY-MM' 추출)
  const availablePeriods = useMemo(() => {
    const set = new Set<string>();
    for (const d of data) {
      if (d.period_start) set.add(d.period_start.slice(0, 7));
    }
    return Array.from(set).sort().reverse();
  }, [data]);

  // 2) period + status 필터 적용
  const filtered = useMemo(() => {
    let result = data;
    if (period) result = result.filter(d => (d.period_start ?? '').slice(0, 7) === period);
    if (statusFilter === 'APPROVED') {
      result = result.filter(d => d.status === 'APPROVED' || d.status === 'PARTIAL_APPROVED');
    } else if (statusFilter === 'SUBMITTED') {
      result = result.filter(d => d.status === 'SUBMITTED');
    }
    // 'ALL' 은 필터 안 함
    return result;
  }, [data, period, statusFilter]);

  // 3) 피벗 — itemKey × dept 매트릭스
  // itemKey = item_id 또는 'custom::{name}::{spec}'
  type Cell = { qty: number; details: { req_id: string; status: string; req_no: string; }[] };
  const { rows, cols, matrix, rowTotals, colTotals, grandTotal } = useMemo(() => {
    const itemMap = new Map<string, { code: string; name: string; spec: string; key: string; }>();
    const deptMap = new Map<string, { id: string; name: string; }>();
    const cellMap = new Map<string, Cell>(); // key: `${itemKey}|${deptId}`

    for (const d of filtered) {
      const deptId = d.department_id ?? '_unknown';
      const deptName = d.department_name ?? '미지정';
      if (!deptMap.has(deptId)) deptMap.set(deptId, { id: deptId, name: deptName });

      for (const it of d.items ?? []) {
        const itemKey = it.is_custom
          ? `custom::${it.custom_name ?? ''}::${it.custom_spec ?? ''}`
          : (it.item_id || `unknown::${it.item_name ?? ''}`);
        if (!itemMap.has(itemKey)) {
          itemMap.set(itemKey, {
            code: it.item_code ?? (it.is_custom ? '[직접입력]' : ''),
            name: it.item_name ?? it.custom_name ?? '',
            spec: it.custom_spec ?? '',
            key: itemKey,
          });
        }
        const cellKey = `${itemKey}|${deptId}`;
        const qty = showApproved
          ? (it.last_approved_qty ?? it.requested_qty)
          : it.requested_qty;
        // qty 0 인 라인은 표시 안 함 — 0이면 결재자가 헷갈림 (반려된 라인 등)
        const numQty = Number(qty || 0);
        if (numQty <= 0) continue;
        const cell = cellMap.get(cellKey) ?? { qty: 0, details: [] };
        cell.qty += numQty;
        cell.details.push({ req_id: d.id, status: d.status, req_no: d.request_no });
        cellMap.set(cellKey, cell);
      }
    }

    const rows = Array.from(itemMap.values()).sort((a, b) =>
      (a.code ?? '').localeCompare(b.code ?? '', 'ko', { numeric: true }),
    );
    const cols = Array.from(deptMap.values()).sort((a, b) =>
      (a.name ?? '').localeCompare(b.name ?? '', 'ko'),
    );

    const matrix: Record<string, Record<string, Cell | undefined>> = {};
    const rowTotals: Record<string, number> = {};
    const colTotals: Record<string, number> = {};
    let grandTotal = 0;

    for (const r of rows) {
      matrix[r.key] = {};
      rowTotals[r.key] = 0;
      for (const c of cols) {
        const cell = cellMap.get(`${r.key}|${c.id}`);
        matrix[r.key][c.id] = cell;
        if (cell) {
          rowTotals[r.key] += cell.qty;
          colTotals[c.id] = (colTotals[c.id] ?? 0) + cell.qty;
          grandTotal += cell.qty;
        }
      }
    }

    return { rows, cols, matrix, rowTotals, colTotals, grandTotal };
  }, [filtered, showApproved]);

  return (
    <div className="space-y-4">
      {/* 컨트롤 바 */}
      <div className="flex flex-wrap items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
        {/* 유형 서브탭 */}
        <div className="flex border border-slate-200 rounded-md overflow-hidden bg-white">
          {([
            { v: 'CONSUMABLE_MEDICAL', l: '의료소모품' },
            { v: 'CONSUMABLE_REGULAR', l: '일반소모품' },
            { v: 'CONSUMABLE_OFFICE', l: '사무용품' },
          ] as const).map(t => (
            <button
              key={t.v}
              onClick={() => onTypeChange(t.v)}
              className={`px-4 py-1.5 text-sm font-medium ${
                type === t.v ? 'bg-teal-500 text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              {t.l}
            </button>
          ))}
        </div>

        {/* 신청주기 */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-500">주기</span>
          <select
            value={period}
            onChange={e => onPeriodChange(e.target.value)}
            className="border border-slate-200 rounded px-2 py-1 text-sm bg-white"
          >
            <option value="">전체</option>
            {availablePeriods.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>

        {/* 상태 필터 */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-500">상태</span>
          <div className="flex border border-slate-200 rounded overflow-hidden bg-white">
            {([
              { v: 'APPROVED' as const, l: '승인됨' },
              { v: 'SUBMITTED' as const, l: '대기중' },
              { v: 'ALL' as const, l: '전체' },
            ]).map(s => (
              <button
                key={s.v}
                onClick={() => setStatusFilter(s.v)}
                className={`px-3 py-1 text-xs ${
                  statusFilter === s.v ? 'bg-blue-500 text-white' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                {s.l}
              </button>
            ))}
          </div>
        </div>

        {/* 수량 토글 */}
        <div className="flex items-center gap-2 text-sm ml-auto">
          <button
            onClick={() => onToggleApproved(false)}
            className={`px-3 py-1 text-xs rounded ${
              !showApproved ? 'bg-blue-500 text-white' : 'bg-white text-slate-600 border border-slate-200'
            }`}
          >
            요청수량
          </button>
          <button
            onClick={() => onToggleApproved(true)}
            className={`px-3 py-1 text-xs rounded ${
              showApproved ? 'bg-green-500 text-white' : 'bg-white text-slate-600 border border-slate-200'
            }`}
          >
            승인수량
          </button>
        </div>
      </div>

      {/* 본문 */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 text-sm gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> 로딩 중...
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 text-slate-400 text-sm">
          <Tag className="w-10 h-10 mx-auto mb-2 text-slate-300" />
          해당 조건의 신청이 없습니다.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="text-sm w-full" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead className="bg-slate-50">
              <tr>
                <th className="sticky left-0 bg-slate-50 px-3 py-2 text-left font-medium text-slate-600 border-b border-r border-slate-200" style={{ minWidth: 80 }}>코드</th>
                <th className="sticky bg-slate-50 px-3 py-2 text-left font-medium text-slate-600 border-b border-r border-slate-200" style={{ left: 80, minWidth: 200 }}>품목</th>
                {cols.map(c => (
                  <th key={c.id} className="px-2 py-2 text-center font-medium text-slate-600 border-b border-slate-200" style={{ minWidth: 60 }}>
                    {c.name}
                  </th>
                ))}
                <th className="px-3 py-2 text-center font-semibold text-slate-700 border-b border-l border-slate-200 bg-slate-100" style={{ minWidth: 80 }}>합계</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rIdx) => (
                <tr key={r.key} className={rIdx % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'}>
                  <td className="sticky left-0 px-3 py-1.5 font-mono text-xs text-slate-500 border-r border-slate-100"
                      style={{ background: rIdx % 2 === 0 ? '#fff' : '#f8fafc' }}>
                    {r.code}
                  </td>
                  <td className="sticky px-3 py-1.5 border-r border-slate-100"
                      style={{ left: 80, background: rIdx % 2 === 0 ? '#fff' : '#f8fafc' }}>
                    <div>{r.name}</div>
                    {r.spec && <div className="text-xs text-slate-400">{r.spec}</div>}
                  </td>
                  {cols.map(c => {
                    const cell = matrix[r.key][c.id];
                    return (
                      <td key={c.id} className="px-2 py-1.5 text-center border-l border-slate-100">
                        {cell ? (
                          <div className="inline-flex flex-col items-center gap-0.5">
                            <span className="font-medium text-slate-800">{cell.qty.toLocaleString('ko-KR')}</span>
                            {cell.details.length > 0 && (
                              <div className="flex gap-0.5">
                                {cell.details.slice(0, 3).map((dt, i) => (
                                  <button
                                    key={i}
                                    onClick={() => onOpenDetail(dt.req_id)}
                                    className={`text-[9px] px-1 rounded ${STATUS_BADGE[dt.status] ?? 'bg-slate-100 text-slate-500'}`}
                                    title={`${dt.req_no} (${dt.status}) — 클릭해서 검토`}
                                  >
                                    {dt.req_no.split('-').pop()}
                                  </button>
                                ))}
                                {cell.details.length > 3 && (
                                  <span className="text-[9px] text-slate-400">+{cell.details.length - 3}</span>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-300">-</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-3 py-1.5 text-center font-semibold text-slate-800 border-l bg-slate-50">
                    {rowTotals[r.key].toLocaleString('ko-KR')}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-100 sticky bottom-0">
              <tr>
                <td colSpan={2} className="sticky left-0 px-3 py-2 text-right font-semibold text-slate-700 border-t-2 border-slate-300 bg-slate-100">
                  부서 합계
                </td>
                {cols.map(c => (
                  <td key={c.id} className="px-2 py-2 text-center font-semibold text-slate-700 border-t-2 border-slate-300">
                    {(colTotals[c.id] ?? 0).toLocaleString('ko-KR')}
                  </td>
                ))}
                <td className="px-3 py-2 text-center font-bold text-teal-700 border-t-2 border-slate-300 bg-teal-50">
                  {grandTotal.toLocaleString('ko-KR')}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* 안내 */}
      <div className="text-xs text-slate-500 flex items-start gap-1.5">
        <Users className="w-3 h-3 mt-0.5 flex-shrink-0" />
        <div>
          셀 안의 작은 배지는 그 부서가 이 품목을 신청한 신청서 번호 끝자리. 클릭하면 검토 모달이 열립니다.
          여러 신청서에 같은 품목이 있으면 자동으로 합산. 새 탭으로 열고 싶으면 신청서 번호를 <ExternalLink className="w-3 h-3 inline" /> Ctrl+클릭.
        </div>
      </div>
    </div>
  );
}
