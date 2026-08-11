/**
 * 금액 관리 — 입출고 내역(수불부) 한 화면.
 * 다른 재고프로그램(이카운트 등) 표준: 품목/거래처/부서 골라 날짜순 입고·출고·잔량을 보고,
 * 입고 단가가 틀리면 그 자리에서 고치면 출고 금액이 자동 재계산.
 *
 *  - 품목: 입고+출고 전체 + 잔량 (그 품목이 언제 들어오고 나갔나)
 *  - 거래처: 입고(구매)만 — 그 거래처에서 언제 무엇을 얼마에 샀나 (= 구매금액)
 *  - 부서: 출고(불출)만 — 그 부서에 언제 무엇이 얼마에 나갔나 (= 비용금액)
 */
import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../utils/api';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { StatsFilterBar, ReportTable } from '../components/stats';

const fmt = (n: number) => new Intl.NumberFormat('ko-KR').format(Math.round(Number(n) || 0));
const dt = (v: any) => { const d = new Date(v); return isNaN(d.getTime()) ? '-' : d.toISOString().slice(0, 10); };

type Mode = 'item' | 'vendor' | 'dept';

export default function CostReconcilePage() {
  const { hasPerm } = useAuth();
  const { showToast } = useToast();
  const canEdit = hasPerm('ACCOUNTING_CLOSE') || hasPerm('PURCHASE_MANAGE') || hasPerm('SYSTEM_ADMIN');

  const [mode, setMode] = useState<Mode>('item');
  const [period, setPeriod] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1 }; });
  const [items, setItems] = useState<any[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [depts, setDepts] = useState<any[]>([]);
  const [targetId, setTargetId] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [edit, setEdit] = useState<{ key: string; kind: 'IN' | 'OUT'; val: string; itemId?: string; soNo?: string; fillAll?: boolean; fromDate?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [rowFilter, setRowFilter] = useState<'all' | 'missing' | 'in' | 'out' | 'base'>('all');

  useEffect(() => { api('/items').then(d => setItems(Array.isArray(d) ? d : [])).catch(() => {}); }, []);
  useEffect(() => { api('/vendors').then(d => setVendors(Array.isArray(d) ? d : [])).catch(() => {}); }, []);
  useEffect(() => { api('/departments').then(d => setDepts(Array.isArray(d) ? d : [])).catch(() => {}); }, []);
  useEffect(() => { setTargetId(''); setData(null); setQ(''); setRowFilter('all'); }, [mode]);
  useEffect(() => { setRowFilter('all'); }, [targetId, period.year, period.month]);

  const load = useCallback(() => {
    // 선택 없으면 전체(이번 달) — 항상 자료를 보여줌
    setLoading(true); setEdit(null);
    const idq = targetId ? `&id=${targetId}` : '';
    api(`/cost-reconcile/ledger?mode=${mode}${idq}&year=${period.year}&month=${period.month}`)
      .then(setData)
      .catch(() => { setData(null); showToast('내역을 불러오지 못했습니다.', 'error'); })
      .finally(() => setLoading(false));
  }, [mode, targetId, period, showToast]);
  useEffect(() => { load(); }, [load]);

  const saveLotPrice = async (lotId: string, val: string) => {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) { showToast('0 이상 숫자', 'error'); return; }
    setBusy(true);
    try {
      const r: any = await api('/cost-reconcile/lot-price', { method: 'POST', body: JSON.stringify({ lot_id: lotId, new_unit_cost: n }) });
      showToast(r?.message || '단가 수정 완료', 'success');
      setEdit(null); load();
    } catch (e: any) { showToast(e?.message || '단가 수정 실패', 'error'); }
    finally { setBusy(false); }
  };

  // lot 없이 fallback 단가로 산정된 OUT 라인(미상 ₩0 포함 기존 추정단가도) 단가 수동 보정.
  // fill_all_for_item=true 면 같은 품목 전체(옵션: fromDate 이후만).
  const saveMissingCost = async (soNo: string, itemId: string, val: string, fillAll: boolean, fromDate?: string) => {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) { showToast('0 이상 숫자', 'error'); return; }
    setBusy(true);
    try {
      const r: any = await api('/cost-reconcile/fill-missing-cost', {
        method: 'POST',
        body: JSON.stringify({ so_no: soNo, item_id: itemId, unit_cost: n, fill_all_for_item: fillAll, from_date: fillAll && fromDate ? fromDate : undefined }),
      });
      showToast(r?.message || '단가 보정 완료', 'success');
      setEdit(null); load();
    } catch (e: any) { showToast(e?.message || '단가 보정 실패', 'error'); }
    finally { setBusy(false); }
  };

  const itemOpts = items.filter((i: any) => !q || (i.name || '').includes(q) || (i.item_code || '').includes(q));

  // 컬럼: 품목 모드는 상대처+잔량, 거래처/부서 모드는 품목 표시
  const unitCell = (v: any, r: any) => {
    // 입고 lot 단가 수정 (재산정 포함)
    if (r.kind === 'IN' && canEdit && r.lot_id) {
      const key = `IN__${r.lot_id}`;
      if (edit && edit.key === key) {
        return (
          <span className="inline-flex items-center gap-1">
            <input className="input w-24 py-0.5 text-right" autoFocus value={edit.val}
              onChange={e => setEdit({ ...edit, val: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') saveLotPrice(r.lot_id, edit.val); if (e.key === 'Escape') setEdit(null); }} />
            <button className="text-emerald-600 text-xs" disabled={busy} onClick={() => saveLotPrice(r.lot_id, edit.val)}>저장</button>
            <button className="text-slate-400 text-xs" onClick={() => setEdit(null)}>취소</button>
          </span>
        );
      }
      return (
        <button className="text-blue-600 hover:underline" title="입고 단가 수정 → 출고 자동 재산정"
          onClick={() => setEdit({ key, kind: 'IN', val: String(r.unit_cost) })}>
          ₩{fmt(v)} ✎
        </button>
      );
    }

    // 출고 — lot 없이 fallback 단가로 산정된 라인(미상 ₩0 또는 기존 추정단가) 수동 보정 가능 (lot 미생성, 라인만 수정)
    const fallbackEditable = r.kind === 'OUT' && (r.is_missing_cost || r.manual_filled) && canEdit && r.item_id && r.doc;
    if (fallbackEditable) {
      const key = `OUT__${r.doc}__${r.item_id}`;
      if (edit && edit.key === key) {
        return (
          <span className="inline-flex items-center gap-1.5 align-middle flex-wrap">
            <input className="input w-24 py-0.5 text-right" autoFocus value={edit.val}
              placeholder="단가"
              onChange={e => setEdit({ ...edit, val: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') saveMissingCost(edit.soNo || '', edit.itemId || '', edit.val, Boolean(edit.fillAll), edit.fromDate); if (e.key === 'Escape') setEdit(null); }} />
            <label className="inline-flex items-center gap-1 text-[11px] text-slate-500 whitespace-nowrap">
              <input type="checkbox" className="h-3 w-3" checked={Boolean(edit.fillAll)}
                onChange={e => setEdit({ ...edit, fillAll: e.target.checked })} />
              같은 품목 전체
            </label>
            {edit.fillAll && (
              <input type="date" className="input w-32 py-0.5 text-xs" value={edit.fromDate || ''}
                title="이 날짜부터 적용 (비우면 전체 기간)"
                onChange={e => setEdit({ ...edit, fromDate: e.target.value })} />
            )}
            <button className="text-emerald-600 text-xs" disabled={busy}
              onClick={() => saveMissingCost(edit.soNo || '', edit.itemId || '', edit.val, Boolean(edit.fillAll), edit.fromDate)}>저장</button>
            <button className="text-slate-400 text-xs" onClick={() => setEdit(null)}>취소</button>
          </span>
        );
      }
      if (r.is_missing_cost) {
        return (
          <button className="text-red-600 hover:underline" title="미상 단가 수동 보정 — 음수재고로 lot 없이 나간 라인"
            onClick={() => setEdit({ key, kind: 'OUT', val: '', itemId: r.item_id, soNo: r.doc, fillAll: false, fromDate: '' })}>
            미상 ✎
          </button>
        );
      }
      return (
        <button className="inline-flex items-center gap-1 hover:underline" title="추정단가 수정 — lot 연결 없이 fallback 단가로 산정된 라인"
          onClick={() => setEdit({ key, kind: 'OUT', val: String(v), itemId: r.item_id, soNo: r.doc, fillAll: false, fromDate: '' })}>
          ₩{fmt(v)}
          <span className="text-[10px] bg-amber-100 text-amber-700 px-1 rounded">보정 ✎</span>
        </button>
      );
    }

    if (r.kind === 'OUT' && (v === 0 || v == null)) return <span className="text-red-500">미상</span>;
    if (r.kind === 'OUT' && r.manual_filled) {
      return (
        <span className="inline-flex items-center gap-1">
          ₩{fmt(v)}
          <span className="text-[10px] bg-amber-100 text-amber-700 px-1 rounded" title="추정(fallback) 단가">보정</span>
        </span>
      );
    }
    return `₩${fmt(v)}`;
  };

  const effMode = data?.mode || 'all';
  const C = {
    date: { key: 'date', label: '일자', render: dt },
    kind: { key: 'kind', label: '구분', align: 'center' as const, render: (v: string, r: any) => r.src === 'BASE' ? <span className="text-slate-500">기초재고</span> : v === 'IN' ? <span className="text-emerald-600">입고</span> : <span className="text-blue-600">출고</span> },
    code: { key: 'item_code', label: '코드' },
    name: { key: 'item_name', label: '품명' },
    counter: { key: 'counter', label: '거래처/부서' },
    doc: { key: 'doc', label: '문서' },
    qty: { key: 'qty', label: '수량', align: 'right' as const, render: (v: number) => <span className={v < 0 ? 'text-blue-600' : 'text-emerald-700'}>{v > 0 ? '+' : ''}{fmt(v)}</span> },
    unit: { key: 'unit_cost', label: '단가', align: 'right' as const, render: unitCell },
    amount: { key: 'amount', label: '금액', align: 'right' as const, render: (v: number) => `₩${fmt(v)}` },
    balance: { key: 'balance', label: '잔량', align: 'right' as const, render: (v: number) => fmt(v) },
  };
  const cols = effMode === 'item'
    ? [C.date, C.kind, C.counter, C.doc, C.qty, C.unit, C.amount, C.balance]
    : effMode === 'all'
      ? [C.date, C.kind, C.code, C.name, C.counter, C.doc, C.qty, C.unit, C.amount]
      : [C.date, C.code, C.name, C.doc, C.qty, C.unit, C.amount];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-bold text-slate-800">금액 관리 — 입출고 내역</h1>
        <p className="text-xs text-slate-400">언제 무엇이 얼마에 입고/불출됐는지. 입고 단가 ✎ 수정하면 출고 금액이 자동 재계산됩니다.</p>
      </div>

      <StatsFilterBar>
        <div><label className="label">보기 기준</label>
          <select className="input w-28" value={mode} onChange={e => setMode(e.target.value as Mode)}>
            <option value="item">품목</option>
            <option value="vendor">거래처(구매)</option>
            <option value="dept">부서(비용)</option>
          </select></div>

        {mode === 'item' && (
          <>
            <div><label className="label">품목 검색</label>
              <input className="input w-40" placeholder="코드/품명" value={q} onChange={e => setQ(e.target.value)} /></div>
            <div><label className="label">품목</label>
              <select className="input w-56" value={targetId} onChange={e => setTargetId(e.target.value)}>
                <option value="">선택...</option>
                {itemOpts.slice(0, 300).map((i: any) => <option key={i.id} value={i.id}>{i.item_code} {i.name}</option>)}
              </select></div>
          </>
        )}
        {mode === 'vendor' && (
          <div><label className="label">거래처</label>
            <select className="input w-56" value={targetId} onChange={e => setTargetId(e.target.value)}>
              <option value="">선택...</option>
              {vendors.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select></div>
        )}
        {mode === 'dept' && (
          <div><label className="label">부서</label>
            <select className="input w-48" value={targetId} onChange={e => setTargetId(e.target.value)}>
              <option value="">선택...</option>
              {depts.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></div>
        )}

        <div><label className="label">연도</label>
          <select className="input w-24" value={period.year} onChange={e => setPeriod(p => ({ ...p, year: Number(e.target.value) }))}>
            {[0, 1, 2].map(d => { const y = new Date().getFullYear() - d; return <option key={y} value={y}>{y}</option>; })}
          </select></div>
        <div><label className="label">월</label>
          <select className="input w-20" value={period.month} onChange={e => setPeriod(p => ({ ...p, month: Number(e.target.value) }))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => <option key={m} value={m}>{m}</option>)}
          </select></div>
      </StatsFilterBar>

      {loading ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center text-slate-400 text-sm">불러오는 중...</div>
      ) : data ? (() => {
        const rows: any[] = data.rows ?? [];
        const missingCount = rows.filter((r) => r.kind === 'OUT' && r.is_missing_cost).length;
        const filtered = rows.filter((r) => {
          if (rowFilter === 'all') return true;
          if (rowFilter === 'missing') return r.kind === 'OUT' && r.is_missing_cost;
          if (rowFilter === 'in') return r.kind === 'IN' && r.src !== 'BASE';
          if (rowFilter === 'out') return r.kind === 'OUT';
          if (rowFilter === 'base') return r.kind === 'IN' && r.src === 'BASE';
          return true;
        });
        const pillCls = (active: boolean, color: 'slate' | 'red' | 'emerald' | 'blue' | 'amber') => {
          const palette = {
            slate: active ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
            red: active ? 'bg-red-600 text-white' : 'bg-red-50 text-red-600 hover:bg-red-100',
            emerald: active ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
            blue: active ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700 hover:bg-blue-100',
            amber: active ? 'bg-amber-600 text-white' : 'bg-amber-50 text-amber-700 hover:bg-amber-100',
          };
          return `px-3 py-1 rounded-full text-xs font-medium transition ${palette[color]}`;
        };
        return (
          <>
            <div className="flex flex-wrap gap-3 text-sm">
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-2 font-semibold text-slate-700">{data.title}{data.mode === 'item' ? ' (전체 기간)' : ''}</div>
              {data.total_in > 0 && <div className="bg-emerald-50 rounded-xl px-4 py-2 text-emerald-700">구매입고 합계 <b>₩{fmt(data.total_in)}</b></div>}
              {data.total_base > 0 && <div className="bg-slate-100 rounded-xl px-4 py-2 text-slate-600">기초재고 합계 <b>₩{fmt(data.total_base)}</b></div>}
              {data.total_out > 0 && <div className="bg-blue-50 rounded-xl px-4 py-2 text-blue-700">출고(비용) 합계 <b>₩{fmt(data.total_out)}</b></div>}
            </div>

            {missingCount > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800 flex items-start gap-2">
                <span className="text-amber-600 font-bold">⚠</span>
                <div className="flex-1">
                  <div className="font-semibold">단가 미상 출고 <span className="text-red-600">{missingCount}건</span></div>
                  <div className="text-[12px] text-amber-700/90 mt-0.5">
                    재고가 없는 상태에서 불출되어 단가를 정할 수 없는 라인입니다. ₩0 으로 잡혀 비용 통계에 빠져 있습니다.
                    {canEdit
                      ? ' 「미상 ✎」 클릭으로 단가를 직접 입력하면 비용에 반영됩니다.'
                      : ' (회계마감 권한자만 보정 가능)'}
                  </div>
                </div>
                <button className={pillCls(rowFilter === 'missing', 'red')} onClick={() => setRowFilter(rowFilter === 'missing' ? 'all' : 'missing')}>
                  {rowFilter === 'missing' ? '전체 보기' : '미상만 보기'}
                </button>
              </div>
            )}

            {(data.total_base > 0) && <p className="text-[11px] text-slate-400">※ 기초재고 = 실사로 등록한 보유재고(실제 구매 아님). 구매금액에 포함되지 않으며, FIFO 출고원가 계산에는 사용됩니다.</p>}

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-slate-400 mr-1">필터</span>
              <button className={pillCls(rowFilter === 'all', 'slate')} onClick={() => setRowFilter('all')}>전체 <span className="opacity-70">{rows.length}</span></button>
              {missingCount > 0 && <button className={pillCls(rowFilter === 'missing', 'red')} onClick={() => setRowFilter('missing')}>미상 <span className="opacity-90">{missingCount}</span></button>}
              <button className={pillCls(rowFilter === 'in', 'emerald')} onClick={() => setRowFilter('in')}>입고</button>
              <button className={pillCls(rowFilter === 'out', 'blue')} onClick={() => setRowFilter('out')}>출고</button>
              {data.total_base > 0 && <button className={pillCls(rowFilter === 'base', 'amber')} onClick={() => setRowFilter('base')}>기초재고</button>}
              {rowFilter !== 'all' && <span className="text-[11px] text-slate-500 ml-2">표시 {filtered.length}건</span>}
            </div>

            <ReportTable
              emptyMessage={rowFilter === 'missing' ? '미상 출고가 없습니다.' : '해당 내역이 없습니다.'}
              columns={cols as any}
              data={filtered}
            />
            {!canEdit && <p className="text-[11px] text-slate-400">※ 단가 수정은 회계마감/구매업무 권한이 필요합니다 (조회만 가능).</p>}
          </>
        );
      })() : (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center text-slate-400 text-sm">데이터 없음</div>
      )}
    </div>
  );
}
