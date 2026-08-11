/**
 * 승인 페이지 — 신청/승인 내역 목록 (2단 그룹 + 평면 행)
 *
 * groupBy='period' (통합 보기): 신청주기(기간 라벨)별로 부서를 합쳐 의뢰서 나열
 * groupBy='dept'   (부서별 보기): 부서별로 의뢰서 나열
 * 그룹 → 의뢰서 행. 행에는 반대 축(통합이면 부서, 부서별이면 주기)을 컬럼으로 표시.
 */
import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2, AlertTriangle } from 'lucide-react';

interface ListItem {
  id: string;
  request_no: string;
  department_id?: string;
  department_name?: string;
  requester_name?: string;
  period_start?: string;
  period_label?: string;
  status: string;
  request_type?: string;
  is_emergency?: boolean;
  submitted_at?: string;
  item_count?: number;
}

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: '제출', APPROVED: '승인', PARTIAL_APPROVED: '부분승인', REJECTED: '반려', CANCELLED: '취소',
};
const STATUS_BADGE: Record<string, string> = {
  SUBMITTED: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-green-100 text-green-700',
  PARTIAL_APPROVED: 'bg-yellow-100 text-yellow-700',
  REJECTED: 'bg-red-100 text-red-700',
  CANCELLED: 'bg-slate-100 text-slate-500',
};
const TYPE_LABEL: Record<string, string> = {
  CONSUMABLE_MEDICAL: '의료소모품', CONSUMABLE_REGULAR: '일반소모품', CONSUMABLE_OFFICE: '사무용품',
  DIAPER: '기저귀', NIGHT_SNACK: '야간간식', ADHOC: '비정기', EQUIPMENT: '비품',
};
const TYPE_COLOR: Record<string, string> = {
  CONSUMABLE_MEDICAL: 'bg-rose-100 text-rose-700',
  CONSUMABLE_REGULAR: 'bg-blue-100 text-blue-700',
  CONSUMABLE_OFFICE: 'bg-indigo-100 text-indigo-700',
  DIAPER: 'bg-purple-100 text-purple-700',
  NIGHT_SNACK: 'bg-cyan-100 text-cyan-700',
  ADHOC: 'bg-orange-100 text-orange-700',
  EQUIPMENT: 'bg-amber-100 text-amber-700',
};

// 대분류 소구분 정렬 순서: 의료 → 일반 → 사무 → 기저귀 → 야간간식 → 비품 → 비정기
const TYPE_ORDER = ['CONSUMABLE_MEDICAL', 'CONSUMABLE_REGULAR', 'CONSUMABLE_OFFICE', 'DIAPER', 'NIGHT_SNACK', 'EQUIPMENT', 'ADHOC'];

function periodLabelOf(r: ListItem): string {
  if (r.period_label && r.period_label.trim()) return r.period_label;
  const m = /^(\d{4})-(\d{2})/.exec(String(r.period_start ?? ''));
  return m ? `${m[1]}년 ${Number(m[2])}월 (주기 미지정)` : '주기 미지정';
}

interface Props {
  data: ListItem[];
  groupBy: 'period' | 'dept';
  onOpenDetail: (id: string) => void;
  onDelete?: (item: ListItem) => void;
  canDelete?: boolean;
  loadTypeItemTotals?: (requestIds: string[]) => Promise<Array<{ item_name: string; item_code?: string; total_approved_qty: number }>>;
}

export default function GroupedListView({ data, groupBy, onOpenDetail, onDelete, canDelete, loadTypeItemTotals }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openTypeKeys, setOpenTypeKeys] = useState<Set<string>>(new Set());
  const [typeLoading, setTypeLoading] = useState<Record<string, boolean>>({});
  const [typeTotals, setTypeTotals] = useState<Record<string, Array<{ item_name: string; item_code?: string; total_approved_qty: number }>>>({});

  const groups = useMemo(() => {
    const map = new Map<string, ListItem[]>();
    for (const r of data) {
      const key = groupBy === 'period' ? periodLabelOf(r) : (r.department_name ?? '미지정');
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    const list = Array.from(map.entries()).map(([key, reqs]) => {
      const sorted = reqs.slice().sort((a, b) => (a.request_no ?? '').localeCompare(b.request_no ?? '', 'ko', { numeric: true }));
      // 그룹 안에서 대분류(신청유형)별로 소구분 — 섞이지 않게 분리
      const byType = new Map<string, ListItem[]>();
      for (const r of sorted) {
        const t = r.request_type ?? 'ETC';
        const arr = byType.get(t) ?? [];
        arr.push(r);
        byType.set(t, arr);
      }
      const sections = Array.from(byType.entries())
        .map(([type, rs]) => ({ type, reqs: rs }))
        .sort((a, b) => {
          const ia = TYPE_ORDER.indexOf(a.type); const ib = TYPE_ORDER.indexOf(b.type);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
      const secondary = groupBy === 'period'
        ? `${new Set(reqs.map(r => r.department_name ?? '-')).size}개 부서`
        : `${new Set(reqs.map(r => r.request_type ?? '-')).size}개 유형`;
      return { key, reqs: sorted, sections, count: reqs.length, secondary };
    });
    // 통합(주기): 최신 주기 위 / 부서별: 가나다
    return groupBy === 'period'
      ? list.sort((a, b) => b.key.localeCompare(a.key, 'ko'))
      : list.sort((a, b) => a.key.localeCompare(b.key, 'ko'));
  }, [data, groupBy]);

  const toggle = (k: string) => setExpanded(prev => {
    const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n;
  });
  const toggleTypeSummary = async (groupKey: string, type: string, reqIds: string[]) => {
    if (!loadTypeItemTotals) return;
    const key = `${groupKey}::${type}`;
    const isOpen = openTypeKeys.has(key);
    if (isOpen) {
      setOpenTypeKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }
    setOpenTypeKeys((prev) => new Set(prev).add(key));
    if (typeTotals[key] || typeLoading[key]) return;
    setTypeLoading((prev) => ({ ...prev, [key]: true }));
    try {
      const rows = await loadTypeItemTotals(reqIds);
      setTypeTotals((prev) => ({ ...prev, [key]: Array.isArray(rows) ? rows : [] }));
    } catch {
      setTypeTotals((prev) => ({ ...prev, [key]: [] }));
    } finally {
      setTypeLoading((prev) => ({ ...prev, [key]: false }));
    }
  };
  const expandAll = () => setExpanded(new Set(groups.map(g => g.key)));
  const collapseAll = () => setExpanded(new Set());

  if (groups.length === 0) {
    return <div className="py-12 text-center text-sm text-slate-400">표시할 내역이 없습니다.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <button onClick={expandAll} className="text-blue-600 hover:underline">모두 펼치기</button>
        <span className="text-slate-300">·</span>
        <button onClick={collapseAll} className="text-blue-600 hover:underline">모두 접기</button>
      </div>

      {groups.map(g => {
        const open = expanded.has(g.key);
        return (
          <div key={g.key} className="card p-0 overflow-hidden border-slate-200">
            <button
              onClick={() => toggle(g.key)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50"
            >
              <div className="flex items-center gap-2">
                {open ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                <span className="font-semibold text-navy-800 text-base">{g.key}</span>
                <span className="text-xs text-slate-500">{g.count}건 · {g.secondary}</span>
              </div>
            </button>

            {open && (
              <div className="border-t border-slate-100">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-[11px] text-slate-500">
                      <th className="pl-4 pr-3 py-1.5 text-left font-medium w-40">신청번호</th>
                      <th className="px-3 py-1.5 text-left font-medium">{groupBy === 'period' ? '부서' : '신청주기'}</th>
                      <th className="px-3 py-1.5 text-left font-medium w-24">유형</th>
                      <th className="px-3 py-1.5 text-left font-medium w-28">신청자</th>
                      <th className="px-3 py-1.5 text-right font-medium w-16">품목</th>
                      <th className="px-3 py-1.5 text-center font-medium w-14">긴급</th>
                      <th className="px-3 py-1.5 text-center font-medium w-20">상태</th>
                      <th className="px-3 py-1.5 text-right font-medium w-24">제출일</th>
                      <th className="pr-4 pl-2 py-1.5 text-right font-medium w-24"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.sections.map(sec => (
                    <Fragment key={sec.type}>
                      <tr className={TYPE_COLOR[sec.type] ?? 'bg-slate-100 text-slate-700'}>
                        <td colSpan={9} className="px-4 py-1.5 text-xs font-semibold">
                          {loadTypeItemTotals ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                void toggleTypeSummary(g.key, sec.type, sec.reqs.map((r) => r.id));
                              }}
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              {openTypeKeys.has(`${g.key}::${sec.type}`)
                                ? <ChevronDown className="w-3.5 h-3.5" />
                                : <ChevronRight className="w-3.5 h-3.5" />}
                              <span>{TYPE_LABEL[sec.type] ?? sec.type}</span>
                              <span className="font-normal opacity-70">({sec.reqs.length}건)</span>
                            </button>
                          ) : (
                            <>
                              {TYPE_LABEL[sec.type] ?? sec.type}
                              <span className="font-normal opacity-70"> ({sec.reqs.length}건)</span>
                            </>
                          )}
                        </td>
                      </tr>
                      {loadTypeItemTotals && openTypeKeys.has(`${g.key}::${sec.type}`) && (
                        <tr className="border-b border-slate-100 bg-white">
                          <td colSpan={9} className="px-4 py-2">
                            {typeLoading[`${g.key}::${sec.type}`] ? (
                              <div className="text-xs text-slate-500">품목 합계 계산 중...</div>
                            ) : (typeTotals[`${g.key}::${sec.type}`] ?? []).length === 0 ? (
                              <div className="text-xs text-slate-500">승인 품목 합계가 없습니다.</div>
                            ) : (
                              <div className="overflow-x-auto rounded border border-slate-200">
                                <table className="w-full text-xs">
                                  <thead className="bg-slate-50 text-slate-500">
                                    <tr>
                                      <th className="px-2 py-1.5 text-left">품목코드</th>
                                      <th className="px-2 py-1.5 text-left">품목명</th>
                                      <th className="px-2 py-1.5 text-right">승인 합계</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(typeTotals[`${g.key}::${sec.type}`] ?? []).map((row, idx) => (
                                      <tr key={`${row.item_code ?? ''}::${row.item_name}::${idx}`} className="border-t border-slate-100">
                                        <td className="px-2 py-1.5 font-mono text-[11px] text-slate-500">{row.item_code ?? '-'}</td>
                                        <td className="px-2 py-1.5 text-slate-700">{row.item_name}</td>
                                        <td className="px-2 py-1.5 text-right text-slate-800 font-semibold">
                                          {new Intl.NumberFormat('ko-KR').format(Number(row.total_approved_qty ?? 0))}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                      {sec.reqs.map(r => (
                      <tr key={r.id} className="border-t border-slate-50 hover:bg-slate-50/50">
                        <td className="pl-4 pr-3 py-1.5 w-40">
                          <a
                            href={`/approvals?detail=${r.id}`}
                            onClick={(e) => {
                              if (e.ctrlKey || e.metaKey || e.button === 1) return;
                              e.preventDefault();
                              onOpenDetail(r.id);
                            }}
                            className="font-medium text-teal-600 hover:underline"
                          >
                            {r.request_no}
                          </a>
                        </td>
                        <td className="px-3 py-1.5 text-xs text-slate-700">
                          {groupBy === 'period' ? (r.department_name ?? '-') : periodLabelOf(r)}
                        </td>
                        <td className="px-3 py-1.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${TYPE_COLOR[r.request_type ?? ''] ?? 'bg-slate-100 text-slate-600'}`}>
                            {TYPE_LABEL[r.request_type ?? ''] ?? r.request_type ?? '-'}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-xs text-slate-600">{r.requester_name ?? '-'}</td>
                        <td className="px-3 py-1.5 text-xs text-right text-slate-700">{r.item_count ?? '-'}건</td>
                        <td className="px-3 py-1.5 text-center">
                          {r.is_emergency && (
                            <span className="text-red-600 inline-flex items-center gap-0.5 text-[10px]">
                              <AlertTriangle className="w-3 h-3" />긴급
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-center">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full ${STATUS_BADGE[r.status] ?? 'bg-slate-100 text-slate-500'}`}>
                            {STATUS_LABEL[r.status] ?? r.status}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-xs text-slate-500 text-right">
                          {r.submitted_at ? new Date(r.submitted_at).toLocaleDateString('ko-KR') : '-'}
                        </td>
                        <td className="pr-4 pl-2 py-1.5 text-right">
                          <button onClick={() => onOpenDetail(r.id)} className="text-xs text-teal-600 hover:underline">검토</button>
                          {canDelete && onDelete && (
                            <button
                              onClick={(e) => { e.stopPropagation(); onDelete(r); }}
                              className="text-xs text-red-500 hover:underline ml-2 inline-flex items-center gap-0.5"
                            >
                              <Trash2 className="w-3 h-3" />삭제
                            </button>
                          )}
                        </td>
                      </tr>
                      ))}
                    </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
