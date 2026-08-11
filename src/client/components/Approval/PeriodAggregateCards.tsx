/**
 * 승인 페이지 — 수량 조절 탭 상단 "주기별 통합" 카드
 *
 * 동작:
 * - 주기별로 카드 하나씩 (예: "2026-05" / "2026-04")
 * - 카드 헤더: 의료/일반/사무 신청 건수 + 총액
 * - 카드 클릭(펼침) → 그 주기의 모든 신청을 품목 단위로 합산한 표
 *   - 행 = 품목 (코드번호순)
 *   - 컬럼 = 유형 / 합계 수량 / 단가 / 합계 금액 / 요청 부서 목록
 *   - 같은 품목을 여러 부서가 신청했으면 합산
 * - 부서명 클릭 → 그 신청서로 점프 (검토 모달)
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import { ceilToPurchaseQty } from '@shared/units';

interface Item {
  id?: string;
  item_id: string;
  item_code?: string;
  item_name?: string;
  custom_name?: string;
  custom_spec?: string;
  is_custom?: boolean;
  uom?: string;
  requested_qty: number;
  // latest_price 는 price_history 단가 = 발주(박스) 단위 단가.
  // 신청 수량(requested_qty/last_approved_qty)은 불출(팩) 단위 → 박스 환산 후 곱해야 단위 일치.
  pack_size?: number;
  latest_price?: number;
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
  period_label?: string;
  // 검토 중 임시저장 — 있으면 그 조정수량으로 합산 (wr_item_id = Item.id 매칭)
  review_draft?: { items?: { wr_item_id: string; approved_qty: number }[] } | null;
  items: Item[];
}

// 주기별 통합에 합산하는 신청유형 (의료·일반·사무 소모품 + 기저귀)
const INCLUDED_TYPES = ['CONSUMABLE_MEDICAL', 'CONSUMABLE_REGULAR', 'CONSUMABLE_OFFICE', 'DIAPER'] as const;

const TYPE_LABEL: Record<string, string> = {
  CONSUMABLE_MEDICAL: '의료소모품',
  CONSUMABLE_REGULAR: '일반소모품',
  CONSUMABLE_OFFICE: '사무용품',
  DIAPER: '기저귀',
};

const TYPE_COLOR: Record<string, string> = {
  CONSUMABLE_MEDICAL: 'bg-rose-100 text-rose-700',
  CONSUMABLE_REGULAR: 'bg-blue-100 text-blue-700',
  CONSUMABLE_OFFICE: 'bg-indigo-100 text-indigo-700',
  DIAPER: 'bg-amber-100 text-amber-700',
};

// 신청주기 라벨이 없을 때의 폴백 — "2026년 5월 (주기 미지정)" 형식 (GroupedListView 와 동일 규칙)
const fallbackPeriodLabel = (periodStart?: string): string => {
  const m = /^(\d{4})-(\d{2})/.exec(String(periodStart ?? ''));
  return m ? `${m[1]}년 ${Number(m[2])}월 (주기 미지정)` : '주기 미지정';
};

const fmt = (n: number) => Math.round(n).toLocaleString('ko-KR');

interface Props {
  data: Detail[];
  loading: boolean;
  onOpenDetail: (id: string, itemId?: string) => void;
}

export default function PeriodAggregateCards({ data, loading, onOpenDetail }: Props) {
  const [expandedPeriod, setExpandedPeriod] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('');  // 빈값 = 전체

  // 의료/일반/사무 외 타입은 제외
  const filtered = useMemo(
    () => data.filter(d => (INCLUDED_TYPES as readonly string[]).includes(d.request_type ?? '')),
    [data],
  );

  // 주기별 그룹
  const periods = useMemo(() => {
    const map = new Map<string, Detail[]>();
    for (const d of filtered) {
      const period = (d.period_label && d.period_label.trim())
        ? d.period_label
        : fallbackPeriodLabel(d.period_start);
      const arr = map.get(period) ?? [];
      arr.push(d);
      map.set(period, arr);
    }
    return Array.from(map.entries())
      .map(([period, reqs]) => {
        const byType = new Map<string, { count: number; amount: number }>();
        let total = 0;
        for (const r of reqs) {
          const type = r.request_type ?? '';
          const amount = (r.items ?? []).reduce((s, it) => {
            const qty = (it.last_approved_qty ?? it.requested_qty) || 0;
            return s + qty * (it.latest_price ?? 0);
          }, 0);
          const cur = byType.get(type) ?? { count: 0, amount: 0 };
          cur.count += 1;
          cur.amount += amount;
          byType.set(type, cur);
          total += amount;
        }
        return { period, reqs, byType, total };
      })
      .sort((a, b) => b.period.localeCompare(a.period));
  }, [filtered]);

  // 펼친 주기의 통합 품목 표
  const aggregated = useMemo(() => {
    if (!expandedPeriod) return [];
    const period = periods.find(p => p.period === expandedPeriod);
    if (!period) return [];
    const filteredReqs = typeFilter
      ? period.reqs.filter(r => r.request_type === typeFilter)
      : period.reqs;

    type Agg = {
      key: string;
      item_id: string;
      item_code: string;
      name: string;
      uom: string;
      type: string;
      total_qty: number;     // 합계 신청 수량 (팩, issue 단위)
      pack_size: number;     // 1박스 = pack_size 팩
      box_qty: number;       // 박스 환산 수량 (총 수요를 한 번만 올림)
      unit_price: number;    // 박스 단가 (price_history)
      total_amount: number;  // box_qty × unit_price
      depts: { dept_name: string; req_id: string; req_no: string; qty: number; status: string }[];
    };
    const map = new Map<string, Agg>();
    for (const req of filteredReqs) {
      // 검토 중 임시저장이 있으면 그 조정수량을 우선 사용 (wr_item_id 기준)
      const draftQ = new Map<string, number>();
      for (const di of (req.review_draft?.items ?? [])) {
        draftQ.set(String(di.wr_item_id), Number(di.approved_qty ?? 0));
      }
      for (const it of (req.items ?? [])) {
        const itemKey = it.is_custom
          ? `custom::${it.custom_name ?? ''}::${it.custom_spec ?? ''}::${req.request_type}`
          : `${it.item_id}::${req.request_type}`;
        const dq = it.id ? draftQ.get(String(it.id)) : undefined;
        const qty = (dq ?? it.last_approved_qty ?? it.requested_qty) || 0;
        const price = it.latest_price ?? 0;
        let agg = map.get(itemKey);
        if (!agg) {
          agg = {
            key: itemKey,
            item_id: it.is_custom ? '' : (it.item_id ?? ''),
            item_code: it.item_code ?? (it.is_custom ? '[직접]' : ''),
            name: it.item_name ?? it.custom_name ?? '',
            uom: it.uom ?? '',
            type: req.request_type ?? '',
            total_qty: 0,
            pack_size: Math.max(1, Number(it.pack_size ?? 1)),
            box_qty: 0,
            unit_price: price,
            total_amount: 0,
            depts: [],
          };
          map.set(itemKey, agg);
        }
        agg.total_qty += qty;
        agg.depts.push({
          dept_name: req.department_name ?? '',
          req_id: req.id,
          req_no: req.request_no,
          qty,
          status: req.status,
        });
      }
    }
    // 합계 수량(팩)을 박스로 한 번만 올림 환산 후 박스 단가를 곱한다.
    // (라인별 올림은 부서마다 잔여 박스가 중복 올림되어 과대 집계됨)
    for (const agg of map.values()) {
      agg.box_qty = ceilToPurchaseQty(agg.total_qty, agg.pack_size);
      agg.total_amount = agg.box_qty * agg.unit_price;
    }
    return Array.from(map.values()).sort((a, b) => {
      const c = (a.item_code ?? '').localeCompare(b.item_code ?? '', 'ko', { numeric: true });
      if (c !== 0) return c;
      return (a.name ?? '').localeCompare(b.name ?? '', 'ko');
    });
  }, [expandedPeriod, typeFilter, periods]);

  const aggregatedTotal = useMemo(
    () => aggregated.reduce((s, a) => s + a.total_amount, 0),
    [aggregated],
  );

  if (loading) {
    return (
      <div className="card p-4 text-center text-sm text-slate-400 inline-flex items-center justify-center gap-2 w-full">
        <Loader2 className="w-4 h-4 animate-spin" /> 주기별 데이터 로딩 중...
      </div>
    );
  }
  if (periods.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 mb-4">
      <div className="text-sm font-semibold text-slate-700 mb-1">주기별 통합 (의료·일반·사무·기저귀)</div>
      {periods.map(p => {
        const expanded = expandedPeriod === p.period;
        return (
          <div key={p.period} className="card p-0 overflow-hidden border-slate-200">
            <button
              onClick={() => setExpandedPeriod(expanded ? null : p.period)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50"
            >
              <div className="flex items-center gap-3 flex-wrap">
                {expanded ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                <span className="font-semibold text-navy-800">{p.period}</span>
                <span className="text-xs text-slate-500">{p.reqs.length}건</span>
                {INCLUDED_TYPES.map(t => {
                  const v = p.byType.get(t);
                  if (!v || v.count === 0) return null;
                  return (
                    <span key={t} className={`text-xs px-2 py-0.5 rounded-full ${TYPE_COLOR[t]}`}>
                      {TYPE_LABEL[t]} {v.count}건 · ₩{fmt(v.amount)}
                    </span>
                  );
                })}
              </div>
              <span className="text-base font-bold text-teal-700">₩{fmt(p.total)}</span>
            </button>

            {expanded && (
              <div className="border-t border-slate-100">
                {/* 유형 필터 */}
                <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center gap-2">
                  <span className="text-xs text-slate-500 mr-1">유형:</span>
                  <button
                    onClick={() => setTypeFilter('')}
                    className={`text-xs px-2 py-0.5 rounded ${typeFilter === '' ? 'bg-teal-500 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
                  >
                    전체
                  </button>
                  {INCLUDED_TYPES.map(t => {
                    const v = p.byType.get(t);
                    if (!v || v.count === 0) return null;
                    return (
                      <button
                        key={t}
                        onClick={() => setTypeFilter(typeFilter === t ? '' : t)}
                        className={`text-xs px-2 py-0.5 rounded ${typeFilter === t ? 'bg-teal-500 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                      >
                        {TYPE_LABEL[t]} ({v.count})
                      </button>
                    );
                  })}
                  <span className="ml-auto text-xs text-slate-500">
                    표시 합계 <strong className="text-teal-700">₩{fmt(aggregatedTotal)}</strong>
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-600">
                      <tr>
                        <th className="px-3 py-2 text-left">코드</th>
                        <th className="px-3 py-2 text-left">품명</th>
                        <th className="px-2 py-2 text-center">유형</th>
                        <th className="px-2 py-2 text-center">단위</th>
                        <th className="px-3 py-2 text-right">합계 수량</th>
                        <th className="px-3 py-2 text-right">단가</th>
                        <th className="px-3 py-2 text-right">합계 금액</th>
                        <th className="px-3 py-2 text-left">요청 부서</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aggregated.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="text-center py-6 text-slate-400 text-xs">
                            해당 유형의 신청이 없습니다.
                          </td>
                        </tr>
                      ) : aggregated.map(a => (
                        <tr key={a.key} className="border-t border-slate-100">
                          <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{a.item_code}</td>
                          <td className="px-3 py-1.5">{a.name}</td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${TYPE_COLOR[a.type] ?? 'bg-slate-100 text-slate-600'}`}>
                              {TYPE_LABEL[a.type] ?? a.type}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-center text-xs text-slate-500">{a.uom}</td>
                          <td className="px-3 py-1.5 text-right font-medium">
                            {fmt(a.total_qty)}
                            {a.pack_size > 1 && (
                              <span className="text-[10px] text-slate-400 ml-1">(={fmt(a.box_qty)}박스)</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right text-slate-600">
                            {fmt(a.unit_price)}
                            {a.pack_size > 1 && <span className="text-[10px] text-slate-400 ml-0.5">/박스</span>}
                          </td>
                          <td className="px-3 py-1.5 text-right font-medium text-blue-700">₩{fmt(a.total_amount)}</td>
                          <td className="px-3 py-1.5 text-xs">
                            <div className="flex flex-wrap gap-1">
                              {a.depts.map((d, i) => (
                                <a
                                  key={i}
                                  href={`/approvals?detail=${d.req_id}${a.item_id ? `&item=${a.item_id}` : ''}`}
                                  onClick={(e) => {
                                    if (e.ctrlKey || e.metaKey || e.button === 1) return;
                                    e.preventDefault();
                                    onOpenDetail(d.req_id, a.item_id || undefined);
                                  }}
                                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-slate-100 hover:bg-blue-100 text-slate-700"
                                  title={`${d.req_no} (${d.status}) — 클릭하면 이 의뢰서에서 「${a.name}」 품목으로 바로 이동`}
                                >
                                  {d.dept_name} <span className="text-slate-400">{fmt(d.qty)}</span>
                                  <ExternalLink className="w-2.5 h-2.5 text-slate-400" />
                                </a>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-slate-100 border-t-2 border-slate-300 font-semibold">
                        <td colSpan={6} className="px-3 py-2 text-right text-slate-700">합계</td>
                        <td className="px-3 py-2 text-right text-base text-teal-700">₩{fmt(aggregatedTotal)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
