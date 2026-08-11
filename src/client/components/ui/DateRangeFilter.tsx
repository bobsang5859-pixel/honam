/**
 * 공용 기간 필터 — 시작일 ~ 종료일 + 빠른선택 프리셋.
 *
 * 사용:
 *   const [range, setRange] = useState<{from: string; to: string}>({ from: '', to: '' });
 *   <DateRangeFilter value={range} onChange={setRange} />
 *
 * 또는 URL 동기화:
 *   const [params, setParams] = useSearchParams();
 *   <DateRangeFilter value={{ from: params.get('from') ?? '', to: params.get('to') ?? '' }}
 *     onChange={(r) => { const n = new URLSearchParams(params); n.set('from', r.from); n.set('to', r.to); setParams(n, { replace: true }); }} />
 *
 * 빈 문자열 = "전체" (필터 미적용). 빠른선택은 KST 로컬 기준 ISO 날짜(YYYY-MM-DD) 만 다룹니다.
 */
import { useMemo } from 'react';
import { Calendar, X } from 'lucide-react';

export type DateRange = { from: string; to: string };

interface Props {
  value: DateRange;
  onChange: (r: DateRange) => void;
  className?: string;
  /** label 좌측에 추가할 텍스트. 없으면 "기간". */
  label?: string;
}

const iso = (d: Date) => {
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

function presets(): { key: string; label: string; range: () => DateRange }[] {
  const now = new Date();
  // 이번주 (월요일 시작)
  const dow = (now.getDay() + 6) % 7;
  const thisMonStart = new Date(now); thisMonStart.setDate(now.getDate() - dow);
  const thisMonEnd = new Date(thisMonStart); thisMonEnd.setDate(thisMonStart.getDate() + 6);
  // 이번달
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  // 지난달
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  // 최근 3개월 (오늘 포함 -90일)
  const threeMonthsAgo = new Date(now); threeMonthsAgo.setDate(now.getDate() - 90);
  // 최근 1년
  const oneYearAgo = new Date(now); oneYearAgo.setFullYear(now.getFullYear() - 1);

  return [
    { key: 'thisWeek',   label: '이번주',     range: () => ({ from: iso(thisMonStart), to: iso(thisMonEnd) }) },
    { key: 'thisMonth',  label: '이번달',     range: () => ({ from: iso(thisMonthStart), to: iso(thisMonthEnd) }) },
    { key: 'lastMonth',  label: '지난달',     range: () => ({ from: iso(lastMonthStart), to: iso(lastMonthEnd) }) },
    { key: '3m',         label: '최근 3개월', range: () => ({ from: iso(threeMonthsAgo), to: iso(now) }) },
    { key: '1y',         label: '최근 1년',   range: () => ({ from: iso(oneYearAgo), to: iso(now) }) },
    { key: 'all',        label: '전체',       range: () => ({ from: '', to: '' }) },
  ];
}

export default function DateRangeFilter({ value, onChange, className = '', label = '기간' }: Props) {
  const items = useMemo(presets, []);
  const active = items.find(p => {
    const r = p.range();
    return r.from === value.from && r.to === value.to;
  });
  const cleared = !value.from && !value.to;

  return (
    <div className={`card p-3 flex flex-wrap items-center gap-2 ${className}`}>
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700">
        <Calendar className="w-3.5 h-3.5" />
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {items.map(p => {
          const isActive = active?.key === p.key || (p.key === 'all' && cleared);
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => onChange(p.range())}
              className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                isActive
                  ? 'bg-teal-600 text-white border-teal-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <span className="text-slate-300">|</span>
      <input
        type="date"
        value={value.from}
        onChange={e => onChange({ ...value, from: e.target.value })}
        className="input text-xs py-1 w-36"
      />
      <span className="text-slate-400">~</span>
      <input
        type="date"
        value={value.to}
        onChange={e => onChange({ ...value, to: e.target.value })}
        className="input text-xs py-1 w-36"
      />
      {!cleared && (
        <button
          type="button"
          onClick={() => onChange({ from: '', to: '' })}
          className="text-xs text-slate-500 hover:text-slate-700 inline-flex items-center gap-0.5"
          title="기간 필터 해제"
        >
          <X className="w-3 h-3" /> 해제
        </button>
      )}
    </div>
  );
}

/** 날짜 문자열이 [from, to] 범위 안에 있는지 (둘 다 빈값이면 통과) */
export function inDateRange(value: string | Date | null | undefined, range: DateRange): boolean {
  if (!range.from && !range.to) return true;
  if (!value) return false;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return false;
  const v = iso(d);
  if (range.from && v < range.from) return false;
  if (range.to && v > range.to) return false;
  return true;
}
