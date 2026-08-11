/**
 * 발주 준비 (라우팅 작업대)
 *
 * 승인된 (신청×품목) 수요를 **신청주기 단위**로 정리해서, 품목별로 어느 경로로
 * 보낼지 결정한다. 같은 품목이라도 신청주기가 다르면 별도 행 → 각자 그 회차
 * 구매결의서로 정확히 들어간다(회차 혼선·오라벨 없음).
 *   - 구매결의서(DECISION) : (거래처 × 주기)별 결의서 생성/추가 → 발주
 *   - 기안서(GIAN)         : 기안 대상 표시만 (문서 미생성, 발주 직접)
 *   - 재고보유(HOLD)       : 발주 안 함 (보류 목록 → 해제 가능)
 *
 * 화면: 신청주기(접고펴기) → 거래처(미지정 먼저) → 품목 표.
 * 스마트 기본값: 중앙창고 재고 ≥ 승인합계 → 재고보유, 아니면 구매결의서.
 */
import { useEffect, useMemo, useState } from 'react';
import { Truck, AlertTriangle, PackageCheck, RotateCcw, CheckCircle2, ChevronDown, ChevronRight, CalendarRange } from 'lucide-react';
import { api } from '../utils/api';
import { useToast } from '../components/Toast';
import { PageHeader, EmptyState, DateRangeFilter, inDateRange } from '../components/ui';
import type { DateRange } from '../components/ui';
import { getMajor, MAJOR_GROUP_LABEL, type MajorGroup } from '@shared/types';
import type { Vendor } from '@shared/types';

type Route = 'DECISION' | 'GIAN' | 'HOLD';

interface PoolRow {
  item_id: string;
  item_code: string;
  name: string;
  spec: string;
  category: string;
  uom: string;
  pack_size: number;
  period_label: string;
  period_start: string;
  vendor_id: string | null;
  vendor_name: string | null;
  depts: { dept_name: string; qty_pack: number }[];
  total_qty_pack: number;
  total_qty_box: number;
  central_stock_pack: number;
  central_stock_box: number;
  unit_price: number;
  est_amount: number;
  suggested_route: 'HOLD' | 'DECISION';
}
interface VendorGroup { vendor_id: string; vendor_name: string; rows: PoolRow[] }
interface PeriodGroup { period_label: string; period_start: string; no_vendor: PoolRow[]; vendors: VendorGroup[] }

const ROUTE_LABEL: Record<Route, string> = { DECISION: '구매결의서', GIAN: '기안서', HOLD: '재고보유' };
const ROUTE_BADGE: Record<string, string> = {
  DECISION: 'bg-teal-100 text-teal-700',
  GIAN: 'bg-indigo-100 text-indigo-700',
  HOLD: 'bg-slate-200 text-slate-600',
};

const rowKey = (r: { item_id: string; period_label: string }) => `${r.item_id}::${r.period_label}`;

export default function OrderRoutingPage() {
  const { showToast } = useToast();
  const msg = (t: 'ok' | 'err', s: string) => showToast(s, t === 'ok' ? 'success' : 'error');

  const [tab, setTab] = useState<'pool' | 'held' | 'routed'>('pool');
  const [loading, setLoading] = useState(false);
  const [periods, setPeriods] = useState<PeriodGroup[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);

  // 행별 선택 경로 / 배치 포함 체크 — 키 = item_id::period_label
  const [routeOf, setRouteOf] = useState<Record<string, Route>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState(false);

  const [held, setHeld] = useState<any[]>([]);
  const [routed, setRouted] = useState<any[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>({ from: '', to: '' });
  // 재고보유·처리됨 탭의 신청주기 카드 접고펴기 (true=접힘)
  const [collapsedHeld, setCollapsedHeld] = useState<Record<string, boolean>>({});
  const [collapsedRouted, setCollapsedRouted] = useState<Record<string, boolean>>({});

  const loadPool = async () => {
    setLoading(true);
    try {
      const r = await api('/order-routing/pool');
      const ps: PeriodGroup[] = Array.isArray(r?.periods) ? r.periods : [];
      setPeriods(ps);
      const rt: Record<string, Route> = {};
      const ck: Record<string, boolean> = {};
      for (const g of ps) {
        for (const row of [...g.no_vendor, ...g.vendors.flatMap(v => v.rows)]) {
          rt[rowKey(row)] = row.suggested_route;
          ck[rowKey(row)] = true;
        }
      }
      setRouteOf(rt);
      setChecked(ck);
      // 기본은 모두 접힘 — 주기 카드 클릭해서 펼치기
      setCollapsed(Object.fromEntries(ps.map(g => [g.period_label, true])));
    } catch (e: any) {
      msg('err', e?.message ?? '대기풀 조회 실패 (서버 재시작 필요할 수 있음)');
    } finally {
      setLoading(false);
    }
  };
  const loadVendors = async () => {
    try { setVendors((await api('/vendors')) ?? []); } catch { /* ignore */ }
  };
  const loadHeld = async () => {
    try {
      const r = await api('/order-routing/held');
      const items = Array.isArray(r?.items) ? r.items : [];
      setHeld(items);
      // 기본 모두 접힘
      const labels = Array.from(new Set(items.map((x: any) => x.period_label || '주기 미지정')));
      setCollapsedHeld(Object.fromEntries(labels.map(l => [l, true])));
    } catch (e: any) { msg('err', e?.message ?? '재고보유 목록 조회 실패'); }
  };
  const loadRouted = async () => {
    try {
      const r = await api('/order-routing/routed');
      const items = Array.isArray(r?.items) ? r.items : [];
      setRouted(items);
      const labels = Array.from(new Set(items.map((x: any) => x.period_label || '주기 미지정')));
      setCollapsedRouted(Object.fromEntries(labels.map(l => [l, true])));
    } catch (e: any) { msg('err', e?.message ?? '처리현황 조회 실패'); }
  };

  useEffect(() => { loadPool(); loadVendors(); }, []);
  useEffect(() => { if (tab === 'held') loadHeld(); if (tab === 'routed') loadRouted(); }, [tab]);

  const assignVendor = async (item_id: string, vendor_id: string) => {
    if (!vendor_id) return;
    try {
      await api(`/items/${item_id}`, { method: 'PUT', body: JSON.stringify({ default_vendor_id: vendor_id }) });
      msg('ok', '거래처가 지정되었습니다.');
      await loadPool();
    } catch (e: any) {
      msg('err', e?.message ?? '거래처 지정 실패');
    }
  };

  // 기간 필터 적용된 데이터 (3 탭 공통)
  const filteredPeriods = useMemo(
    () => periods.filter(g => inDateRange(g.period_start, dateRange)),
    [periods, dateRange],
  );
  const filteredHeld = useMemo(
    () => held.filter(h => inDateRange(h.period_start, dateRange)),
    [held, dateRange],
  );
  const filteredRouted = useMemo(
    () => routed.filter(r => inDateRange(r.period_start, dateRange)),
    [routed, dateRange],
  );

  const allRows = useMemo(
    () => filteredPeriods.flatMap(g => [...g.no_vendor, ...g.vendors.flatMap(v => v.rows)]),
    [filteredPeriods],
  );
  const selectedRows = allRows.filter(r => checked[rowKey(r)]);

  const runRouting = async () => {
    const targets = selectedRows
      .map(r => ({ row: r, route: routeOf[rowKey(r)] }))
      .filter(x => !!x.route);
    if (targets.length === 0) { msg('err', '선택된 품목이 없습니다.'); return; }

    const needVendor = targets.filter(t => t.route !== 'HOLD' && !t.row.vendor_id);
    if (needVendor.length > 0) {
      msg('err', `거래처 미지정 ${needVendor.length}건은 구매결의서/기안서로 보낼 수 없습니다. 거래처를 먼저 지정하세요.`);
      return;
    }

    let holdReason = '재고 있음';
    if (targets.some(t => t.route === 'HOLD')) {
      const input = window.prompt('재고보유 사유를 입력하세요 (보류 목록에 표시됩니다).', '재고 있음');
      if (input === null) return;
      holdReason = input.trim() || '재고 있음';
    }

    const summary = targets.reduce((acc, t) => { acc[t.route] = (acc[t.route] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    const confirmMsg = '선택 품목을 다음 경로로 보냅니다:\n\n'
      + Object.entries(summary).map(([r, n]) => `· ${ROUTE_LABEL[r as Route]}: ${n}건`).join('\n')
      + '\n\n진행할까요?';
    if (!window.confirm(confirmMsg)) return;

    setRunning(true);
    try {
      const r = await api('/order-routing/route', {
        method: 'POST',
        body: JSON.stringify({
          targets: targets.map(t => ({
            item_id: t.row.item_id,
            period_label: t.row.period_label,
            route: t.route,
            vendor_id: t.row.vendor_id ?? undefined,
            hold_reason: t.route === 'HOLD' ? holdReason : undefined,
          })),
        }),
      });
      const parts: string[] = [];
      if ((r?.decisions?.length ?? 0) > 0) {
        const nos = r.decisions.map((d: any) => d.decision_no).join(', ');
        parts.push(`구매결의서 ${r.decisions.length}건 (${nos})`);
      }
      if ((r?.gian_count ?? 0) > 0) parts.push(`기안 대상 ${r.gian_count}건`);
      if ((r?.hold_count ?? 0) > 0) parts.push(`재고보유 ${r.hold_count}건`);
      if ((r?.skipped?.length ?? 0) > 0) parts.push(`건너뜀 ${r.skipped.length}건`);
      msg('ok', parts.length ? parts.join(' · ') : '라우팅 완료');
      await loadPool();
    } catch (e: any) {
      msg('err', e?.message ?? '라우팅 실패');
    } finally {
      setRunning(false);
    }
  };

  const releaseHeld = async (h: any) => {
    if (!window.confirm(`"${h.name}" (${h.period_label}) 보류를 해제하면 발주 준비 대기풀로 돌아갑니다. 진행할까요?`)) return;
    try {
      const r = await api('/order-routing/release', { method: 'POST', body: JSON.stringify({ routing_ids: h.routing_ids }) });
      msg('ok', `보류 해제 ${r?.released ?? 0}건 — 대기풀로 복귀`);
      await loadHeld();
    } catch (e: any) {
      msg('err', e?.message ?? '보류 해제 실패');
    }
  };

  // 한 신청주기의 재고보유 전체 해제 (실수로 통째 보유 처리한 경우 한 번에 풀로 복귀)
  const releasePeriodHeld = async (periodLabel: string, allRoutingIds: string[]) => {
    if (allRoutingIds.length === 0) return;
    if (!window.confirm(`「${periodLabel}」 의 재고보유 ${allRoutingIds.length}건을 모두 해제합니다. 풀로 복귀시킬까요?`)) return;
    try {
      const r = await api('/order-routing/release', { method: 'POST', body: JSON.stringify({ routing_ids: allRoutingIds }) });
      msg('ok', `${periodLabel} 보류 해제 ${r?.released ?? 0}건 — 대기풀로 복귀`);
      await loadHeld();
    } catch (e: any) {
      msg('err', e?.message ?? '보류 해제 실패');
    }
  };

  // ── 재고보유 그룹핑: 신청주기 → 대분류 → 품목 ──
  const heldGroups = useMemo(() => {
    type Group = { period_label: string; items: any[]; total_qty_pack: number; routing_ids: string[]; byMajor: Map<MajorGroup, any[]> };
    const m = new Map<string, Group>();
    for (const h of filteredHeld) {
      const k = h.period_label || '주기 미지정';
      let g = m.get(k);
      if (!g) { g = { period_label: k, items: [], total_qty_pack: 0, routing_ids: [], byMajor: new Map() }; m.set(k, g); }
      g.items.push(h);
      g.total_qty_pack += Number(h.total_qty_pack ?? 0);
      g.routing_ids.push(...(h.routing_ids ?? []));
      const major = getMajor(h.category ?? '') as MajorGroup;
      const arr = g.byMajor.get(major) ?? [];
      arr.push(h);
      g.byMajor.set(major, arr);
    }
    return Array.from(m.values()).sort((a, b) => (b.period_label || '').localeCompare(a.period_label || '', 'ko'));
  }, [filteredHeld]);

  // ── 처리됨 그룹핑: 신청주기 → 결의서(또는 기안 대상) → 품목 ──
  const routedGroups = useMemo(() => {
    type DecGroup = { key: string; decision_no: string | null; vendor_name: string | null; route: string; items: any[]; total_qty_pack: number };
    type PeriodGroup = { period_label: string; total_qty_pack: number; total_items: number; decisions: DecGroup[] };
    const m = new Map<string, Map<string, DecGroup>>();
    for (const r of filteredRouted) {
      const pk = r.period_label || '주기 미지정';
      const dk = r.route === 'GIAN' ? `__GIAN__` : (r.decision_no || '__NO_DEC__');
      let inner = m.get(pk);
      if (!inner) { inner = new Map(); m.set(pk, inner); }
      let d = inner.get(dk);
      if (!d) {
        d = { key: dk, decision_no: r.decision_no ?? null, vendor_name: r.vendor_name ?? null, route: r.route, items: [], total_qty_pack: 0 };
        inner.set(dk, d);
      }
      d.items.push(r);
      d.total_qty_pack += Number(r.total_qty_pack ?? 0);
    }
    const out: PeriodGroup[] = [];
    for (const [pk, inner] of m.entries()) {
      // GIAN 은 마지막, 그 외(결의서)는 결의서번호 오름차순
      const decisions = Array.from(inner.values()).sort((a, b) => {
        if (a.route === 'GIAN' && b.route !== 'GIAN') return 1;
        if (a.route !== 'GIAN' && b.route === 'GIAN') return -1;
        return (a.decision_no ?? '').localeCompare(b.decision_no ?? '', 'ko', { numeric: true });
      });
      const total_qty_pack = decisions.reduce((s, d) => s + d.total_qty_pack, 0);
      const total_items = decisions.reduce((s, d) => s + d.items.length, 0);
      out.push({ period_label: pk, total_qty_pack, total_items, decisions });
    }
    return out.sort((a, b) => b.period_label.localeCompare(a.period_label, 'ko'));
  }, [filteredRouted]);

  const setRowsChecked = (rows: PoolRow[], v: boolean) =>
    setChecked(p => { const n = { ...p }; for (const r of rows) n[rowKey(r)] = v; return n; });

  const RouteSelect = ({ row }: { row: PoolRow }) => (
    <select
      value={routeOf[rowKey(row)] ?? row.suggested_route}
      onChange={e => setRouteOf(p => ({ ...p, [rowKey(row)]: e.target.value as Route }))}
      className="input text-xs py-1"
    >
      <option value="DECISION" disabled={!row.vendor_id}>구매결의서{!row.vendor_id ? ' (거래처 필요)' : ''}</option>
      <option value="GIAN" disabled={!row.vendor_id}>기안서{!row.vendor_id ? ' (거래처 필요)' : ''}</option>
      <option value="HOLD">재고보유</option>
    </select>
  );

  const PoolTable = ({ rows, showVendorAssign }: { rows: PoolRow[]; showVendorAssign: boolean }) => (
    <table className="w-full text-sm border-collapse">
      <thead className="bg-slate-50 text-xs text-slate-600">
        <tr>
          <th className="px-2 py-1.5 text-center border-b border-slate-200" style={{ width: 34 }}>
            <input
              type="checkbox"
              checked={rows.length > 0 && rows.every(r => checked[rowKey(r)])}
              onChange={e => setRowsChecked(rows, e.target.checked)}
            />
          </th>
          <th className="px-2 py-1.5 text-left border-b border-slate-200">품목</th>
          <th className="px-2 py-1.5 text-left border-b border-slate-200">신청부서(팩)</th>
          <th className="px-2 py-1.5 text-right border-b border-slate-200" style={{ width: 90 }}>승인(박스)</th>
          <th className="px-2 py-1.5 text-right border-b border-slate-200" style={{ width: 90 }}>창고재고</th>
          <th className="px-2 py-1.5 text-right border-b border-slate-200" style={{ width: 90 }}>단가</th>
          <th className="px-2 py-1.5 text-right border-b border-slate-200" style={{ width: 110 }}>예상금액</th>
          {showVendorAssign
            ? <th className="px-2 py-1.5 text-left border-b border-slate-200" style={{ width: 200 }}>거래처 지정</th>
            : <th className="px-2 py-1.5 text-center border-b border-slate-200" style={{ width: 150 }}>경로</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(r => {
          const enough = r.central_stock_pack >= r.total_qty_pack;
          const k = rowKey(r);
          return (
            <tr key={k} className={`border-b border-slate-100 ${checked[k] ? 'bg-blue-50/30' : ''}`}>
              <td className="px-2 py-1 text-center">
                <input type="checkbox" checked={!!checked[k]} onChange={e => setChecked(p => ({ ...p, [k]: e.target.checked }))} />
              </td>
              <td className="px-2 py-1">
                <div className="font-medium text-slate-800" title={`코드 ${r.item_code}`}>{r.name}</div>
                {r.spec && <div className="text-[11px] text-slate-400">{r.spec}</div>}
              </td>
              <td className="px-2 py-1 text-xs text-slate-600">
                {r.depts.map(d => `${d.dept_name} ${d.qty_pack}`).join(', ')}
              </td>
              <td className="px-2 py-1 text-right">{r.total_qty_box.toLocaleString('ko-KR')}<span className="text-[10px] text-slate-400"> ({r.total_qty_pack}팩)</span></td>
              <td className={`px-2 py-1 text-right ${enough ? 'text-emerald-600 font-medium' : 'text-slate-500'}`}>
                {r.central_stock_box}박스<span className="text-[10px] text-slate-400"> ({r.central_stock_pack}팩)</span>
              </td>
              <td className="px-2 py-1 text-right text-slate-600">{r.unit_price ? `₩${r.unit_price.toLocaleString('ko-KR')}` : '-'}</td>
              <td className="px-2 py-1 text-right text-slate-700">{r.est_amount ? `₩${r.est_amount.toLocaleString('ko-KR')}` : '-'}</td>
              {showVendorAssign ? (
                <td className="px-2 py-1">
                  <select value="" onChange={e => assignVendor(r.item_id, e.target.value)} className="input text-xs py-1 w-full">
                    <option value="">거래처 선택...</option>
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </td>
              ) : (
                <td className="px-2 py-1 text-center"><RouteSelect row={r} /></td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div>
      <PageHeader icon={Truck} title="발주 준비" description="신청주기별로 승인 품목을 구매결의서 · 기안서 · 재고보유로 라우팅" />

      <div className="flex items-center gap-2 mb-4">
        {([['pool', '발주 대기'], ['held', '재고보유'], ['routed', '처리됨']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${tab === k ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mb-3">
        <DateRangeFilter value={dateRange} onChange={setDateRange} label="신청주기" />
      </div>

      {tab === 'pool' && (
        loading ? (
          <div className="card p-8 text-center text-slate-400">불러오는 중...</div>
        ) : allRows.length === 0 ? (
          <div className="card"><EmptyState message="발주 준비할 승인 품목이 없습니다." /></div>
        ) : (
          <div className="space-y-4">
            <div className="card p-3 flex flex-wrap items-center gap-3 sticky top-0 z-10">
              <span className="text-sm text-slate-600">선택 <strong className="text-teal-700">{selectedRows.length}</strong>건</span>
              <span className="text-xs text-slate-400">신청주기별로 묶여 있습니다. 행마다 경로 변경 가능 · 기본값은 재고와 승인량 비교로 자동 설정.</span>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => setCollapsed({})} className="text-xs text-slate-500 hover:underline">모두 펼치기</button>
                <span className="text-slate-300">·</span>
                <button onClick={() => setCollapsed(Object.fromEntries(filteredPeriods.map(g => [g.period_label, true])))} className="text-xs text-slate-500 hover:underline">모두 접기</button>
                <button
                  onClick={runRouting}
                  disabled={running || selectedRows.length === 0}
                  className="btn-primary inline-flex items-center gap-1.5 disabled:opacity-40 ml-2"
                >
                  <CheckCircle2 className="w-4 h-4" /> {running ? '처리 중...' : '선택분 라우팅 실행'}
                </button>
              </div>
            </div>

            {filteredPeriods.map(g => {
              const periodRows = [...g.no_vendor, ...g.vendors.flatMap(v => v.rows)];
              const open = !collapsed[g.period_label];
              return (
                <div key={g.period_label} className="card p-0 overflow-hidden">
                  <div className="px-4 py-3 bg-teal-50 border-b border-teal-200 flex items-center gap-2">
                    <button
                      onClick={() => setCollapsed(p => ({ ...p, [g.period_label]: open }))}
                      className="inline-flex items-center gap-1.5 font-semibold text-teal-800"
                    >
                      {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      <CalendarRange className="w-4 h-4" />
                      {g.period_label}
                    </button>
                    <span className="text-xs text-teal-700">
                      {periodRows.length}개 품목 · {g.vendors.length}개 거래처
                      {g.no_vendor.length > 0 ? ` · 거래처 미지정 ${g.no_vendor.length}` : ''}
                    </span>
                    <label className="ml-auto text-xs text-teal-700 inline-flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={periodRows.length > 0 && periodRows.every(r => checked[rowKey(r)])}
                        onChange={e => setRowsChecked(periodRows, e.target.checked)}
                      />
                      이 주기 전체 선택
                    </label>
                  </div>

                  {open && (
                    <div className="divide-y divide-slate-100">
                      {g.no_vendor.length > 0 && (
                        <div className="border-l-4 border-l-amber-500">
                          <div className="px-4 py-2 bg-amber-50 text-amber-800 text-sm font-semibold inline-flex items-center gap-1.5">
                            <AlertTriangle className="w-4 h-4" /> 거래처 미지정 {g.no_vendor.length}개 — 거래처 지정 후 구매결의서/기안서 가능 (재고보유는 바로 가능)
                          </div>
                          <div className="px-2 py-2 space-y-3">
                            {(['MEDICAL', 'GENERAL', 'OFFICE', 'DIAPER', 'EQUIPMENT'] as MajorGroup[]).map(major => {
                              const rows = g.no_vendor.filter(s => getMajor(s.category) === major);
                              if (rows.length === 0) return null;
                              return (
                                <div key={major}>
                                  <div className="text-xs font-semibold text-slate-700 px-2 mb-1">
                                    {MAJOR_GROUP_LABEL[major]} <span className="text-slate-400">({rows.length})</span>
                                  </div>
                                  <PoolTable rows={rows} showVendorAssign />
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {g.vendors.map(v => (
                        <div key={v.vendor_id}>
                          <div className="px-4 py-2 bg-slate-50 flex items-center gap-2">
                            <PackageCheck className="w-4 h-4 text-slate-500" />
                            <span className="font-semibold text-sm text-slate-800">{v.vendor_name}</span>
                            <span className="text-xs text-slate-500">{v.rows.length}개 품목</span>
                            <label className="ml-auto text-xs text-slate-500 inline-flex items-center gap-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={v.rows.length > 0 && v.rows.every(r => checked[rowKey(r)])}
                                onChange={e => setRowsChecked(v.rows, e.target.checked)}
                              />
                              거래처 전체
                            </label>
                          </div>
                          <PoolTable rows={v.rows} showVendorAssign={false} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {tab === 'held' && (
        filteredHeld.length === 0 ? (
          <div className="card"><EmptyState message={held.length === 0 ? '재고보유(발주 안 함)로 둔 품목이 없습니다.' : '선택한 기간에 해당하는 재고보유 항목이 없습니다.'} /></div>
        ) : (
          <div className="space-y-3">
            <div className="card p-3 flex flex-wrap items-center gap-3">
              <span className="text-sm text-slate-600">총 <strong className="text-teal-700">{filteredHeld.length}</strong>품목 · {heldGroups.length}개 주기</span>
              <div className="ml-auto flex items-center gap-2 text-xs">
                <button onClick={() => setCollapsedHeld({})} className="text-slate-500 hover:underline">모두 펼치기</button>
                <span className="text-slate-300">·</span>
                <button onClick={() => setCollapsedHeld(Object.fromEntries(heldGroups.map(g => [g.period_label, true])))} className="text-slate-500 hover:underline">모두 접기</button>
              </div>
            </div>
            {heldGroups.map(g => {
              const open = !collapsedHeld[g.period_label];
              return (
                <div key={g.period_label} className="card p-0 overflow-hidden">
                  <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
                    <button
                      onClick={() => setCollapsedHeld(p => ({ ...p, [g.period_label]: open }))}
                      className="inline-flex items-center gap-1.5 font-semibold text-slate-800"
                    >
                      {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      <CalendarRange className="w-4 h-4" />
                      {g.period_label}
                    </button>
                    <span className="text-xs text-slate-600">{g.items.length}품목 · 총 {g.total_qty_pack.toLocaleString('ko-KR')}팩</span>
                    <button
                      onClick={() => releasePeriodHeld(g.period_label, g.routing_ids)}
                      className="ml-auto text-xs text-blue-600 hover:underline inline-flex items-center gap-0.5"
                      title="이 주기의 재고보유를 모두 발주 대기 풀로 되돌림"
                    >
                      <RotateCcw className="w-3 h-3" /> 이 주기 전체 해제
                    </button>
                  </div>
                  {open && (
                    <div className="divide-y divide-slate-100">
                      {(['MEDICAL', 'GENERAL', 'OFFICE', 'DIAPER', 'EQUIPMENT'] as MajorGroup[]).map(major => {
                        const rows = g.byMajor.get(major) ?? [];
                        if (rows.length === 0) return null;
                        return (
                          <div key={major}>
                            <div className="px-4 py-1.5 bg-slate-50/60 text-xs font-semibold text-slate-600">
                              {MAJOR_GROUP_LABEL[major]} <span className="font-normal text-slate-400">({rows.length})</span>
                            </div>
                            <table className="w-full text-sm border-collapse">
                              <thead className="bg-white text-[11px] text-slate-500">
                                <tr>
                                  <th className="px-3 py-1 text-left border-b border-slate-200">품목</th>
                                  <th className="px-3 py-1 text-right border-b border-slate-200" style={{ width: 90 }}>수량(팩)</th>
                                  <th className="px-3 py-1 text-left border-b border-slate-200" style={{ width: 140 }}>사유</th>
                                  <th className="px-3 py-1 text-left border-b border-slate-200">출처(부서·신청)</th>
                                  <th className="px-3 py-1 text-right border-b border-slate-200" style={{ width: 100 }}>일자</th>
                                  <th className="px-3 py-1 text-right border-b border-slate-200" style={{ width: 90 }}></th>
                                </tr>
                              </thead>
                              <tbody>
                                {rows.sort((a: any, b: any) => (a.item_code ?? '').localeCompare(b.item_code ?? '', 'ko', { numeric: true })).map((h: any, i: number) => (
                                  <tr key={`${h.item_id}-${i}`} className="border-b border-slate-100">
                                    <td className="px-3 py-1.5 font-medium text-slate-800" title={`코드 ${h.item_code}`}>{h.name}</td>
                                    <td className="px-3 py-1.5 text-right">{Number(h.total_qty_pack).toLocaleString('ko-KR')}</td>
                                    <td className="px-3 py-1.5 text-slate-600 text-xs">{h.hold_reason || '-'}</td>
                                    <td className="px-3 py-1.5 text-xs text-slate-500">
                                      {(h.sources ?? []).map((s: any) => `${s.dept_name}(${s.wr_no}·${s.qty_pack})`).join(', ')}
                                    </td>
                                    <td className="px-3 py-1.5 text-right text-xs text-slate-500">{h.routed_at ? new Date(h.routed_at).toLocaleDateString('ko-KR') : '-'}</td>
                                    <td className="px-3 py-1.5 text-right">
                                      <button onClick={() => releaseHeld(h)} className="text-xs text-blue-600 hover:underline inline-flex items-center gap-0.5">
                                        <RotateCcw className="w-3 h-3" /> 해제
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {tab === 'routed' && (
        filteredRouted.length === 0 ? (
          <div className="card"><EmptyState message={routed.length === 0 ? '처리된(구매결의서·기안) 라우팅이 없습니다.' : '선택한 기간에 해당하는 처리 내역이 없습니다.'} /></div>
        ) : (
          <div className="space-y-3">
            <div className="card p-3 flex flex-wrap items-center gap-3">
              <span className="text-sm text-slate-600">{routedGroups.length}개 주기 · 총 {filteredRouted.length}품목 라인</span>
              <div className="ml-auto flex items-center gap-2 text-xs">
                <button onClick={() => setCollapsedRouted({})} className="text-slate-500 hover:underline">모두 펼치기</button>
                <span className="text-slate-300">·</span>
                <button onClick={() => setCollapsedRouted(Object.fromEntries(routedGroups.map(g => [g.period_label, true])))} className="text-slate-500 hover:underline">모두 접기</button>
              </div>
            </div>
            {routedGroups.map(g => {
              const open = !collapsedRouted[g.period_label];
              const decisionCount = g.decisions.filter(d => d.route !== 'GIAN').length;
              const gianCount = g.decisions.filter(d => d.route === 'GIAN').reduce((s, d) => s + d.items.length, 0);
              return (
                <div key={g.period_label} className="card p-0 overflow-hidden">
                  <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
                    <button
                      onClick={() => setCollapsedRouted(p => ({ ...p, [g.period_label]: open }))}
                      className="inline-flex items-center gap-1.5 font-semibold text-slate-800"
                    >
                      {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      <CalendarRange className="w-4 h-4" />
                      {g.period_label}
                    </button>
                    <span className="text-xs text-slate-600">
                      결의서 {decisionCount}장 · 품목 {g.total_items}개
                      {gianCount > 0 ? ` · 기안 ${gianCount}` : ''}
                    </span>
                  </div>
                  {open && (
                    <div className="divide-y divide-slate-100">
                      {g.decisions.map(d => (
                        <div key={d.key}>
                          <div className="px-4 py-2 bg-slate-50/60 flex items-center gap-2">
                            <span className={`text-[10px] px-2 py-0.5 rounded-full ${ROUTE_BADGE[d.route] ?? 'bg-slate-100 text-slate-600'}`}>
                              {ROUTE_LABEL[d.route as Route] ?? d.route}
                            </span>
                            {d.route === 'GIAN' ? (
                              <span className="text-sm font-medium text-slate-700">기안 대상 (결의서 미생성)</span>
                            ) : (
                              <>
                                <span className="font-mono text-xs text-slate-700">{d.decision_no ?? '(결의서 없음)'}</span>
                                {d.vendor_name && <span className="text-sm font-medium text-slate-700">· {d.vendor_name}</span>}
                              </>
                            )}
                            <span className="text-xs text-slate-500">· {d.items.length}품목 · 총 {d.total_qty_pack.toLocaleString('ko-KR')}팩</span>
                          </div>
                          <table className="w-full text-sm border-collapse">
                            <thead className="bg-white text-[11px] text-slate-500">
                              <tr>
                                <th className="px-3 py-1 text-left border-b border-slate-200">품목</th>
                                <th className="px-3 py-1 text-right border-b border-slate-200" style={{ width: 100 }}>수량(팩)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {d.items.sort((a: any, b: any) => (a.item_code ?? '').localeCompare(b.item_code ?? '', 'ko', { numeric: true })).map((r: any, i: number) => (
                                <tr key={`${r.item_id}-${i}`} className="border-b border-slate-100">
                                  <td className="px-3 py-1.5 font-medium text-slate-800" title={`코드 ${r.item_code}`}>{r.name}</td>
                                  <td className="px-3 py-1.5 text-right">{Number(r.total_qty_pack).toLocaleString('ko-KR')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
