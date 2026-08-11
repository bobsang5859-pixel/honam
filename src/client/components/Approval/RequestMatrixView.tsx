/**
 * 승인 페이지 — 통합 보기 (편집 가능한 「대분류별 품목 × 부서」 매트릭스)
 *
 * 행 = 품목(코드순), 열 = 부서, 셀 = 그 부서가 그 품목을 신청한 수량(수정 가능).
 * 대분류(의료/일반/사무/기저귀/야간간식/비품)별로 섹션을 나눠 표시.
 * 셀 수정 → 그 부서 신청건의 그 품목 승인수량으로 임시저장(/approvals/:id/draft).
 * 저장 = 분류 섹션별 / 전체 둘 다. 상태는 그대로(제출) 유지 — 나중에 건별 승인.
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Save, CheckCircle2 } from 'lucide-react';
import { api } from '../../utils/api';
import { getMajor, MAJOR_GROUP_LABEL } from '@shared/types';
import type { MajorGroup } from '@shared/types';
import { ceilToPurchaseQty } from '@shared/units';
import { Modal } from '../ui';

const fmt = (n: number) => `₩${Math.round(n).toLocaleString('ko-KR')}`;

interface Item {
  id?: string;            // WardRequestItem.id (wr_item_id)
  item_id: string;
  item_name?: string;
  item_code?: string;
  is_custom?: boolean;
  category?: string;
  requested_qty: number;
  pack_size?: number;     // 1 박스 = N 팩
  latest_price?: number;  // 박스 단가
  on_hand_qty?: number;   // 그 부서 보관함 재고
}
interface Detail {
  id: string;
  request_no: string;
  request_type?: string;
  department_id?: string;
  department_name?: string;
  status: string;
  items: Item[];
  review_draft?: {
    items?: { wr_item_id: string; approved_qty: number }[];
    removed?: string[];
    added?: { item_id: string; item_name?: string; item_code?: string; category?: string; latest_price?: number; approved_qty: number }[];
  } | null;
}

interface Props {
  data: Detail[];
  loading?: boolean;
  readOnly?: boolean;
  patientUsage?: Record<string, Record<string, any[]>>; // [deptId][itemId] = 사용 환자 배열
  onOpenDetail: (id: string) => void;
  onSaved: () => void;
}

const MAJOR_ORDER: MajorGroup[] = ['MEDICAL', 'GENERAL', 'DIAPER', 'OFFICE', 'EQUIPMENT'];
// 이 매트릭스는 "정기" 신청 전용 — 비정기(ADHOC) 등이 섞여 들어오면 대분류 섹션에 구분 없이 합쳐지고
// "이 분류 전체 승인"/"전체 저장"으로 검토자 모르게 같이 승인될 위험이 있어, 호출부 필터와 별개로 여기서도 한 번 더 막음.
const REGULAR_TYPES = ['CONSUMABLE_MEDICAL', 'CONSUMABLE_REGULAR', 'CONSUMABLE_OFFICE', 'DIAPER', 'NIGHT_SNACK'];
type Mode = 'qty' | 'ref' | 'recent';   // qty=신청수량(편집·금액) · ref=재고·환자 참조(읽기·금액숨김) · recent=최근불출 이력(읽기)
type RecentIssue = { date: string; qty: number };

export default function RequestMatrixView({ data, loading, readOnly, patientUsage, onOpenDetail, onSaved }: Props) {
  // 수정한 셀만 보관: edited[reqId][item_id] = qty(숫자) 또는 '' (명시적 빈칸 — 저장 시 0)
  const [edited, setEdited] = useState<Record<string, Record<string, number | ''>>>({});
  const [saving, setSaving] = useState<string | null>(null); // major key or 'ALL'
  const [approving, setApproving] = useState<string | null>(null); // major key — 일괄 승인 진행 중
  const [msg, setMsg] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  const [mode, setMode] = useState<Mode>('qty'); // 신청수량(편집) / 재고·환자(읽기) / 최근불출(읽기)
  const [activeMajor, setActiveMajor] = useState<MajorGroup | null>(null); // 한 번에 한 분류만 표시
  // 신청수량 모드에서 마지막으로 클릭/포커스한 셀 — 최근불출 모드로 넘어가도 그 품목 위치를 기억해뒀다가 스크롤·강조
  const [selectedCell, setSelectedCell] = useState<{ itemId: string; deptId: string } | null>(null);
  // 품목×부서별 전체 불출 이력(기간 제한 없음): key = `${item_id}|${department_id}`
  const [recentData, setRecentData] = useState<Record<string, RecentIssue[]>>({});
  const [recentLoadedMajor, setRecentLoadedMajor] = useState<MajorGroup | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);
  const [recentPopup, setRecentPopup] = useState<{ itemId: string; deptId: string; itemName: string; deptName: string } | null>(null);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  // 신청수량 모드의 품목×부서 입력칸 — 방향키 이동에 사용. key = `${행 인덱스}:${열 인덱스}`
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // 상단 고정 툴바 높이를 실측 → 그만큼 아래에 헤더를 고정(추측 픽셀 없이 정확히 붙음)
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [headerTop, setHeaderTop] = useState(0);
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const measure = () => setHeaderTop(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  // "`"=신청수량으로 이동 · "*"=최근불출 토글 · "/"=재고·환자 토글(다시 누르면 신청수량으로 복귀) — 텍스트 입력 중일 땐 무시
  useEffect(() => {
    const KEY_MODE: Record<string, Mode> = { '`': 'qty', '*': 'recent', '/': 'ref' };
    const handler = (e: KeyboardEvent) => {
      const targetMode = KEY_MODE[e.key];
      if (!targetMode) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTextInput = tag === 'TEXTAREA' || target?.isContentEditable
        || (tag === 'INPUT' && (target as HTMLInputElement).type !== 'number');
      if (isTextInput) return;
      e.preventDefault();
      setMode(prev => {
        if (targetMode === 'qty') return 'qty';
        return prev === targetMode ? 'qty' : targetMode;
      });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 제출(대기) 건만 매트릭스 대상 — 임시저장은 SUBMITTED 에서만 가능
  const subs = useMemo(
    () => data.filter(d => d.status === 'SUBMITTED' && REGULAR_TYPES.includes(String(d.request_type ?? 'CONSUMABLE_REGULAR'))),
    [data],
  );

  // 그 신청의 그 라인 임시저장 값
  const draftQty = (d: Detail, wrItemId?: string): number | undefined => {
    if (!wrItemId) return undefined;
    const di = d.review_draft?.items?.find(x => String(x.wr_item_id) === String(wrItemId));
    return di ? Number(di.approved_qty) : undefined;
  };

  // 대분류 → { items, depts, cell }
  const sections = useMemo(() => {
    type Cell = { reqId: string; wrItemId?: string; requested: number; draft?: number; onHand: number; patients: number; added?: boolean };
    const byMajor = new Map<MajorGroup, {
      items: Map<string, { code: string; name: string; pack_size: number; unit_price: number }>;
      depts: Map<string, string>;
      cell: Map<string, Cell>; // `${item_id}|${deptId}`
    }>();
    for (const d of subs) {
      const deptId = d.department_id ?? '_';
      const deptName = d.department_name ?? '미지정';
      // 모달 임시저장에서 삭제한 원 라인 — 매트릭스에서도 제외
      const removedSet = new Set((d.review_draft?.removed ?? []).map(String));
      for (const it of d.items ?? []) {
        if (it.is_custom || !it.item_id) continue; // 자유입력은 매트릭스 제외
        if (it.id && removedSet.has(String(it.id))) continue; // 임시저장에서 삭제됨
        const mj = getMajor(it.category ?? '') as MajorGroup;
        let sec = byMajor.get(mj);
        if (!sec) { sec = { items: new Map(), depts: new Map(), cell: new Map() }; byMajor.set(mj, sec); }
        if (!sec.items.has(it.item_id)) sec.items.set(it.item_id, {
          code: it.item_code ?? '', name: it.item_name ?? '',
          pack_size: Math.max(1, Number(it.pack_size ?? 1)),
          unit_price: Number(it.latest_price ?? 0),
        });
        sec.depts.set(deptId, deptName);
        sec.cell.set(`${it.item_id}|${deptId}`, {
          reqId: d.id, wrItemId: it.id, requested: Number(it.requested_qty),
          draft: draftQty(d, it.id),
          onHand: Number(it.on_hand_qty ?? 0),
          patients: (patientUsage?.[deptId]?.[it.item_id]?.length) ?? 0,
        });
      }
      // 모달 임시저장에서 검토자가 추가한 품목 — 그 부서 칸으로 반영(읽기전용)
      for (const a of (d.review_draft?.added ?? [])) {
        if (!a.item_id) continue;
        const mj = getMajor(a.category ?? '') as MajorGroup;
        let sec = byMajor.get(mj);
        if (!sec) { sec = { items: new Map(), depts: new Map(), cell: new Map() }; byMajor.set(mj, sec); }
        if (!sec.items.has(a.item_id)) sec.items.set(a.item_id, {
          code: a.item_code ?? '', name: a.item_name ?? '',
          pack_size: 1,
          unit_price: Number(a.latest_price ?? 0),
        });
        sec.depts.set(deptId, deptName);
        sec.cell.set(`${a.item_id}|${deptId}`, {
          reqId: d.id, wrItemId: undefined, requested: 0,
          draft: Number(a.approved_qty ?? 0),
          onHand: 0, patients: 0, added: true,
        });
      }
    }
    return MAJOR_ORDER.filter(mj => byMajor.has(mj)).map(mj => {
      const s = byMajor.get(mj)!;
      const items = Array.from(s.items.entries())
        .map(([item_id, v]) => ({ item_id, ...v }))
        .sort((a, b) => (a.code || '').localeCompare(b.code || '', 'ko', { numeric: true }));
      const depts = Array.from(s.depts.entries()).map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      return { major: mj, label: MAJOR_GROUP_LABEL[mj], items, depts, cell: s.cell };
    });
  }, [subs, patientUsage]);

  // 현재값(편집 ?? 임시저장 ?? 신청) 기준 금액 — 발주 요약과 동일(박스환산 × 박스단가)
  const amounts = useMemo(() => {
    const byMajor: Record<string, number> = {};
    let grand = 0;
    for (const sec of sections) {
      let secAmt = 0;
      for (const row of sec.items) {
        let qty = 0;
        for (const dp of sec.depts) {
          const c = sec.cell.get(`${row.item_id}|${dp.id}`);
          if (!c) continue;
          qty += Number(edited[c.reqId]?.[row.item_id] ?? c.draft ?? c.requested) || 0;
        }
        secAmt += ceilToPurchaseQty(qty, row.pack_size || 1) * (row.unit_price || 0);
      }
      byMajor[sec.major] = secAmt;
      grand += secAmt;
    }
    return { byMajor, grand };
  }, [sections, edited]);

  const setCell = (reqId: string, itemId: string, raw: string) => {
    // 셀을 완전히 비우면 빈칸 유지(명시적 클리어 — 저장 시 0으로 처리). 명시적 "0" 입력은 그대로 0.
    if (raw === '') {
      setEdited(prev => ({ ...prev, [reqId]: { ...(prev[reqId] ?? {}), [itemId]: '' } }));
      return;
    }
    const n = Math.max(0, Math.floor(Number(raw)));
    setEdited(prev => ({ ...prev, [reqId]: { ...(prev[reqId] ?? {}), [itemId]: Number.isFinite(n) ? n : 0 } }));
  };

  const changedCount = useMemo(
    () => Object.values(edited).reduce((s, m) => s + Object.keys(m).length, 0),
    [edited],
  );

  // 저장 — scope=major 면 그 분류 품목이 든 신청만, 'ALL' 이면 변경된 전 신청
  const save = async (scope: MajorGroup | 'ALL') => {
    // 영향 신청 id 수집
    const sectionItemIds = scope === 'ALL'
      ? null
      : new Set(sections.find(s => s.major === scope)?.items.map(i => i.item_id) ?? []);
    const reqIds = new Set<string>();
    for (const [reqId, m] of Object.entries(edited)) {
      for (const itemId of Object.keys(m)) {
        if (!sectionItemIds || sectionItemIds.has(itemId)) reqIds.add(reqId);
      }
    }
    if (reqIds.size === 0) { setMsg({ t: 'err', m: '변경한 수량이 없습니다.' }); return; }
    setSaving(scope);
    try {
      let ok = 0;
      for (const reqId of reqIds) {
        const d = subs.find(x => x.id === reqId);
        if (!d) continue;
        // 모달에서 임시저장한 삭제/추가를 보존하면서 함께 전송 (덮어쓰기 방지)
        const removedSet = new Set((d.review_draft?.removed ?? []).map(String));
        // 셀 값 해석 — '' (명시적 빈칸) → 0 / undefined(미수정) → 기존값
        const cellQty = (ev: number | '' | undefined, fallback: number) =>
          ev === '' ? 0 : (ev ?? fallback);
        const items = d.items
          .filter(it => it.id && !it.is_custom && !removedSet.has(String(it.id)))
          .map(it => ({
            wr_item_id: it.id,
            approved_qty: cellQty(edited[reqId]?.[it.item_id], draftQty(d, it.id) ?? Number(it.requested_qty)),
            approver_note: '',
          }));
        const removed = (d.review_draft?.removed ?? []).map(String);
        const added = (d.review_draft?.added ?? []).map(a => ({
          ...a,
          approved_qty: cellQty(edited[reqId]?.[a.item_id], Number(a.approved_qty ?? 0)),
        }));
        await api(`/approvals/${reqId}/draft`, { method: 'POST', body: JSON.stringify({ items, removed, added }) });
        ok++;
      }
      setMsg({ t: 'ok', m: `${ok}개 신청 임시저장했습니다. (상태는 그대로 — 나중에 건별 승인)` });
      setEdited(prev => {
        if (scope === 'ALL') return {};
        const next = { ...prev };
        for (const id of reqIds) delete next[id];
        return next;
      });
      onSaved();
    } catch (e: any) {
      setMsg({ t: 'err', m: e.message ?? '임시저장 실패' });
    } finally {
      setSaving(null);
    }
  };

  // Ctrl+S(또는 ⌘S) — 변경한 셀 전체 저장(브라우저 기본 "페이지 저장" 동작은 막음)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      if (!readOnly && changedCount > 0 && saving === null) save('ALL');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [changedCount, saving, save, readOnly]);

  // 이 분류 일괄 승인 — 그 분류 품목이 든 신청들을 현재 셀 값(edited > draft > requested) 그대로 /decide 호출.
  // 사유는 자동으로 "통합 보기 일괄 승인" 으로 채움(서버 5자 검증 통과). APPROVE/ADJUST/REJECT 자동 판정.
  const bulkApproveSection = async (major: MajorGroup) => {
    const sectionItemIds = new Set(sections.find(s => s.major === major)?.items.map(i => i.item_id) ?? []);
    if (sectionItemIds.size === 0) return;
    const cellQty = (ev: number | '' | undefined, fallback: number) =>
      ev === '' ? 0 : (ev ?? fallback);

    type Plan = {
      d: Detail; action: 'APPROVE' | 'ADJUST' | 'REJECT'; payloadItems: any[];
    };
    const plans: Plan[] = [];
    let approveN = 0, adjustN = 0, rejectN = 0;

    for (const d of subs) {
      const removedSet = new Set((d.review_draft?.removed ?? []).map(String));
      const draftByWrItem = new Map((d.review_draft?.items ?? []).map(x => [String(x.wr_item_id), Number(x.approved_qty)]));
      const addedList = (d.review_draft?.added ?? []);

      // 이 분류 품목이 든 신청만 대상
      const hasSectionItem = d.items.some(it => it.item_id && sectionItemIds.has(it.item_id) && !removedSet.has(String(it.id)))
        || addedList.some(a => sectionItemIds.has(a.item_id));
      if (!hasSectionItem) continue;

      // 원 신청 라인(보존분) — wr_item_id 포함
      const keptItems = d.items
        .filter(it => it.id && !it.is_custom && !removedSet.has(String(it.id)))
        .map(it => {
          const fallback = draftByWrItem.get(String(it.id)) ?? Number(it.requested_qty);
          const approvedQty = cellQty(edited[d.id]?.[it.item_id], fallback);
          return {
            wr_item_id: it.id!,
            item_id: it.item_id,
            approved_qty: approvedQty,
            approver_note: '',
            requested_qty: Number(it.requested_qty),
          };
        });
      // 검토자 추가 라인 — wr_item_id 없음(서버가 추가로 인식)
      const addedItems = addedList.map(a => ({
        item_id: a.item_id,
        custom_name: a.item_name ?? '',
        approved_qty: cellQty(edited[d.id]?.[a.item_id], Number(a.approved_qty ?? 0)),
        approver_note: '',
      }));

      const hasStructural = removedSet.size > 0 || addedList.length > 0;
      const anyChange = keptItems.some(it => Number(it.approved_qty) !== it.requested_qty);
      const allZero = keptItems.every(it => Number(it.approved_qty) === 0)
        && addedItems.every(a => Number(a.approved_qty) === 0);
      const action: 'APPROVE' | 'ADJUST' | 'REJECT' = allZero
        ? 'REJECT'
        : (hasStructural || anyChange) ? 'ADJUST' : 'APPROVE';
      if (action === 'APPROVE') approveN++; else if (action === 'ADJUST') adjustN++; else rejectN++;

      const payloadItems = [
        ...keptItems.map(({ requested_qty, ...rest }) => rest),
        ...addedItems,
      ];
      plans.push({ d, action, payloadItems });
    }

    if (plans.length === 0) { setMsg({ t: 'err', m: '승인할 신청이 없습니다.' }); return; }

    const confirmMsg =
      `「${MAJOR_GROUP_LABEL[major]}」 분류의 ${plans.length}개 신청을 일괄 승인합니다:\n\n` +
      `· 그대로 승인: ${approveN}건\n` +
      (adjustN > 0 ? `· 수량 조정: ${adjustN}건\n` : '') +
      (rejectN > 0 ? `· 반려(전부 0): ${rejectN}건\n` : '') +
      `\n진행할까요?`;
    if (!window.confirm(confirmMsg)) return;

    setApproving(major);
    let ok = 0, fail = 0;
    for (const plan of plans) {
      try {
        await api(`/approvals/${plan.d.id}/decide`, {
          method: 'POST',
          body: JSON.stringify({
            action: plan.action,
            reason: plan.action === 'APPROVE' ? '' : '통합 보기 일괄 승인',
            items: plan.payloadItems,
          }),
        });
        ok++;
      } catch {
        fail++;
      }
    }
    setApproving(null);
    setMsg({
      t: fail === 0 ? 'ok' : 'err',
      m: `${ok}건 승인 완료${fail > 0 ? ` · ${fail}건 실패(권한·상태·정책 검토 필요)` : ''}`,
    });
    setEdited(prev => {
      const next = { ...prev };
      for (const plan of plans) delete next[plan.d.id];
      return next;
    });
    onSaved();
  };

  // 한 번에 한 분류만 — 선택값 없거나 사라졌으면 첫 분류
  const curMajor: MajorGroup | undefined = useMemo(
    () => (sections.some(s => s.major === activeMajor) ? (activeMajor as MajorGroup) : sections[0]?.major),
    [sections, activeMajor],
  );
  const curSection = useMemo(() => sections.find(s => s.major === curMajor), [sections, curMajor]);

  // 최근불출 모드로 들어오면 현재 분류(품목×부서)에 대해 벌크 조회 — 분류당 한 번만
  const loadedMajorsRef = useRef<Set<MajorGroup>>(new Set());
  useEffect(() => {
    if (mode !== 'recent' || !curSection) return;
    if (loadedMajorsRef.current.has(curSection.major)) return;
    const itemIds = curSection.items.map(i => i.item_id);
    const deptIds = curSection.depts.map(d => d.id);
    if (itemIds.length === 0 || deptIds.length === 0) return;
    setRecentLoading(true);
    api('/supply-analytics/recent-issues', {
      method: 'POST',
      body: JSON.stringify({ item_ids: itemIds, department_ids: deptIds }),
    })
      .then(res => {
        setRecentData(prev => ({ ...prev, ...(res?.data ?? {}) }));
        loadedMajorsRef.current.add(curSection.major);
      })
      .catch(() => { /* 조용히 무시 — 최근불출은 참조용 */ })
      .finally(() => setRecentLoading(false));
  }, [mode, curSection]);

  // 신청수량 모드에서 가리키던 셀을 기억해뒀다가, 다른 모드(최근불출·재고환자)로 넘어오면 그 품목 행으로 자동 스크롤
  useEffect(() => {
    if (mode === 'qty' || !selectedCell) return;
    const el = rowRefs.current[selectedCell.itemId];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [mode, selectedCell, curMajor]);

  // 다른 모드에서 신청수량 모드로 돌아오면, 기억해둔 셀에 포커스를 다시 걸어줌(안 그러면 포커스가 사라짐)
  useEffect(() => {
    if (mode !== 'qty' || !selectedCell || !curSection) return;
    const ri = curSection.items.findIndex(i => i.item_id === selectedCell.itemId);
    const ci = curSection.depts.findIndex(d => d.id === selectedCell.deptId);
    if (ri < 0 || ci < 0) return;
    const el = inputRefs.current[`${ri}:${ci}`];
    if (el) { el.focus(); el.select(); }
  }, [mode, selectedCell, curSection]);

  // 포인터 이동 — 지금 selectedCell 위치에서 (dRow, dCol) 방향으로 딱 한 칸. 그 칸에 입력창이 있으면
  // 포커스도 옮기고, 빈 칸(신청 자체가 없는 조합)이면 포커스는 못 걸지만 포인터(selectedCell)는 그대로 옮겨가서
  // 표시만 됨 — 그래서 화살표를 계속 누르면 빈 칸을 "지나가며" 다음 입력창까지 이어서 이동할 수 있음.
  const movePointer = (dRow: number, dCol: number) => {
    if (!curSection || !selectedCell) return;
    const ri = curSection.items.findIndex(i => i.item_id === selectedCell.itemId);
    const ci = curSection.depts.findIndex(d => d.id === selectedCell.deptId);
    if (ri < 0 || ci < 0) return;
    const maxR = curSection.items.length - 1;
    const maxC = curSection.depts.length - 1;
    const r = ri + dRow, c = ci + dCol;
    if (r < 0 || r > maxR || c < 0 || c > maxC) return;
    const nextItem = curSection.items[r];
    const nextDept = curSection.depts[c];
    setSelectedCell({ itemId: nextItem.item_id, deptId: nextDept.id });
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) active.blur();
    const el = inputRefs.current[`${r}:${c}`];
    if (el) { el.focus(); el.select(); }
  };

  // 포인터가 빈 칸(입력창 없음)에 있을 땐 아무 것도 focus된 게 없어서, 입력창의 onKeyDown이 못 잡음 —
  // 그런 경우를 위한 전역 방향키 처리(실제 입력창에 포커스가 있을 땐 그쪽 onKeyDown이 처리하므로 여기선 건너뜀)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (mode !== 'qty') return;
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && active.tagName === 'INPUT') return; // 입력창 자체의 onKeyDown이 처리
      if (!selectedCell) return;
      e.preventDefault();
      if (e.key === 'ArrowUp') movePointer(-1, 0);
      else if (e.key === 'ArrowDown') movePointer(1, 0);
      else if (e.key === 'ArrowLeft') movePointer(0, -1);
      else if (e.key === 'ArrowRight') movePointer(0, 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [mode, selectedCell, curSection]);

  if (loading) {
    return <div className="flex items-center justify-center py-16 text-slate-400 text-sm gap-2"><Loader2 className="w-5 h-5 animate-spin" /> 로딩 중...</div>;
  }
  if (!curSection) {
    return <div className="py-12 text-center text-sm text-slate-400">표시할 신청이 없습니다.</div>;
  }

  return (
    <div className="space-y-4">
      {msg && (
        <div className={`px-4 py-2.5 rounded text-sm ${msg.t === 'ok' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {msg.m}
        </div>
      )}

      <div ref={toolbarRef} className="sticky top-0 z-40 -mx-1 px-1 py-2 bg-slate-50/95 backdrop-blur border-b border-slate-200 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-sm">
          <button onClick={() => setMode('qty')}
            className={`px-4 py-1.5 ${mode === 'qty' ? 'bg-teal-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>신청수량</button>
          <button onClick={() => setMode('ref')}
            className={`px-4 py-1.5 ${mode === 'ref' ? 'bg-teal-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>재고·환자</button>
          <button onClick={() => setMode('recent')}
            className={`px-4 py-1.5 ${mode === 'recent' ? 'bg-teal-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>최근불출</button>
        </div>
        <span className="text-slate-300">|</span>
        <div className="flex flex-wrap gap-1.5">
          {sections.map(s => (
            <button
              key={s.major}
              onClick={() => setActiveMajor(s.major)}
              className={`px-3 py-1.5 rounded-full text-sm border ${
                curMajor === s.major
                  ? 'bg-navy-600 text-white border-navy-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {s.label} <span className={curMajor === s.major ? 'text-white/70' : 'text-slate-400'}>{s.items.length}</span>
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-400 ml-auto">
          {mode === 'qty' ? '셀에서 신청수량 직접 수정 · 단가·금액 표시'
            : mode === 'ref' ? '부서별 재고 / 사용환자수 (읽기전용)'
            : recentLoading ? '최근 불출 이력 불러오는 중...' : '부서별 최근 불출일·수량 — 칸 클릭 시 전체 이력'}
        </span>
      </div>

      {/* 한 번에 한 분류만 — 위 분류 버튼으로 전환. 스크롤 압박 줄임 */}
      {[curSection].map(sec => (
        <div key={sec.major} className="card p-0 border-slate-200">
          <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 border-b border-slate-200">
            <div className="font-semibold text-navy-800">
              {sec.label} <span className="text-xs font-normal text-slate-500">· 품목 {sec.items.length} · 부서 {sec.depts.length}{mode === 'qty' && <> · 예상 <b className="text-teal-700">{fmt(amounts.byMajor[sec.major] ?? 0)}</b></>}</span>
            </div>
            {mode === 'qty' && !readOnly && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => save(sec.major)}
                  disabled={saving !== null || approving !== null}
                  className="btn-secondary text-xs inline-flex items-center gap-1"
                >
                  {saving === sec.major ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> 저장 중...</> : <><Save className="w-3.5 h-3.5" /> 이 분류 저장</>}
                </button>
                <button
                  onClick={() => bulkApproveSection(sec.major)}
                  disabled={saving !== null || approving !== null}
                  className="btn-primary text-xs inline-flex items-center gap-1"
                  title="이 분류 품목이 든 신청들을 현재 셀 값 그대로 승인 (사유 자동 채움)"
                >
                  {approving === sec.major ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> 승인 중...</> : <><CheckCircle2 className="w-3.5 h-3.5" /> 이 분류 전체 승인</>}
                </button>
              </div>
            )}
          </div>
          {/* 표 자체 스크롤 패널 — 헤더는 이 패널 맨 위(top:0)에 무조건 고정(엑셀 틀고정).
              분류 한 개씩이라 영역이 짧아 답답하지 않음. 가로 스크롤 없이 폭에 맞춰 줄임. */}
          <div className="overflow-y-auto overflow-x-hidden" style={{ maxHeight: '85vh' }}>
          <table className="w-full text-sm border-separate table-fixed" style={{ borderSpacing: 0 }}>
              <thead>
                <tr className="text-[11px] text-slate-500">
                  <th className="sticky left-0 bg-slate-50 px-3 py-2 text-left font-medium border-r border-slate-200 z-30" style={{ top: 0, width: '14%' }}>품목</th>
                  {mode === 'qty' ? (
                    <>
                      {sec.depts.map(dp => (
                        <th key={dp.id} className="sticky bg-slate-50 px-1 py-2 text-center font-medium z-20 truncate" style={{ top: 0 }} title={dp.name}>{dp.name}</th>
                      ))}
                      <th className="sticky bg-slate-50 px-2 py-2 text-right font-medium border-l border-slate-200 whitespace-nowrap z-20" style={{ top: 0, width: 52 }}>합계</th>
                      <th className="sticky bg-slate-50 px-2 py-2 text-right font-medium whitespace-nowrap z-20" style={{ top: 0, width: 68 }}>단가</th>
                      <th className="sticky bg-slate-50 px-2 py-2 text-right font-medium whitespace-nowrap pr-3 z-20" style={{ top: 0, width: 92 }}>금액</th>
                    </>
                  ) : mode === 'ref' ? (
                    sec.depts.map(dp => (
                      <th key={dp.id} colSpan={2} className="sticky bg-slate-50 px-1 py-1.5 text-center font-medium border-l border-slate-200 z-20" style={{ top: 0 }}>
                        <div className="truncate" title={dp.name}>{dp.name}</div>
                        <div className="flex text-[10px] text-slate-400 font-normal mt-0.5">
                          <span className="flex-1">재고</span>
                          <span className="flex-1">환자</span>
                        </div>
                      </th>
                    ))
                  ) : (
                    sec.depts.map(dp => (
                      <th key={dp.id} className="sticky bg-slate-50 px-1 py-2 text-center font-medium border-l border-slate-200 z-20 truncate" style={{ top: 0 }} title={dp.name}>{dp.name}</th>
                    ))
                  )}
                </tr>
              </thead>
              <tbody>
                {sec.items.map((row, ri) => {
                  let rowQty = 0;   // 금액 산정용(항상 승인 수량 기준)
                  const editable = mode === 'qty' && !readOnly;
                  const rowSelected = selectedCell?.itemId === row.item_id;
                  return (
                    <tr
                      key={row.item_id}
                      ref={el => { rowRefs.current[row.item_id] = el; }}
                      className={`border-t border-slate-100 ${rowSelected ? 'bg-blue-50/50' : ''}`}
                    >
                      <td className="sticky left-0 bg-white px-3 py-1 text-slate-800 border-r border-slate-100 z-10">
                        <div className="truncate" title={`${row.code} · ${row.name}`}>{row.name}</div>
                      </td>
                      {mode === 'qty' ? (
                        <>
                          {sec.depts.map((dp, ci) => {
                            const c = sec.cell.get(`${row.item_id}|${dp.id}`);
                            const pointerHere = selectedCell?.itemId === row.item_id && selectedCell?.deptId === dp.id;
                            if (!c) return (
                              <td
                                key={dp.id}
                                className={`px-1 py-1 text-center text-slate-300 ${pointerHere ? 'ring-2 ring-blue-300 rounded' : ''}`}
                              >
                                ·
                              </td>
                            );
                            const qtyVal = edited[c.reqId]?.[row.item_id] ?? c.draft ?? c.requested;
                            rowQty += Number(qtyVal) || 0;
                            const dirty = edited[c.reqId]?.[row.item_id] !== undefined;
                            return (
                              <td key={dp.id} className="px-0.5 py-1 text-center">
                                {editable ? (
                                  <input
                                    type="number"
                                    min={0}
                                    value={qtyVal}
                                    ref={el => { inputRefs.current[`${ri}:${ci}`] = el; }}
                                    onChange={e => setCell(c.reqId, row.item_id, e.target.value)}
                                    onFocus={e => { setSelectedCell({ itemId: row.item_id, deptId: dp.id }); e.target.select(); }}
                                    onKeyDown={e => {
                                      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
                                      e.preventDefault();
                                      e.stopPropagation(); // 전역 방향키 리스너(빈 칸용 보조 처리)까지 안 넘어가게 — 안 그러면 한 번에 두 칸씩 움직임
                                      if (e.key === 'ArrowUp') movePointer(-1, 0);
                                      else if (e.key === 'ArrowDown') movePointer(1, 0);
                                      else if (e.key === 'ArrowLeft') movePointer(0, -1);
                                      else if (e.key === 'ArrowRight') movePointer(0, 1);
                                    }}
                                    className={`w-full text-center text-sm rounded border px-0.5 py-0.5 ${
                                      c.added ? 'border-blue-400 bg-blue-50 text-blue-700'
                                      : dirty ? 'border-amber-400 bg-amber-50 text-amber-700'
                                      : 'border-slate-200'}`}
                                    title={c.added
                                      ? '검토자 추가 품목(임시저장) — 여기서 수정 가능'
                                      : `신청 ${c.requested} · 재고 ${c.onHand} · 사용환자 ${c.patients}명${c.draft !== undefined ? ` · 임시저장 ${c.draft}` : ''}`}
                                  />
                                ) : (
                                  <span className={c.added ? 'text-blue-600 font-medium' : dirty ? 'text-amber-600 font-medium' : ''}>
                                    {qtyVal}{c.added ? '*' : ''}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                          <td className="px-2 py-1 text-right font-medium text-slate-700 border-l border-slate-100 whitespace-nowrap">{rowQty}</td>
                          <td className="px-2 py-1 text-right text-slate-500 text-xs whitespace-nowrap">{row.unit_price ? fmt(row.unit_price) : '-'}</td>
                          <td className="px-2 py-1 text-right font-medium text-slate-800 whitespace-nowrap pr-3 text-xs">
                            {fmt(ceilToPurchaseQty(rowQty, row.pack_size || 1) * (row.unit_price || 0))}
                          </td>
                        </>
                      ) : mode === 'ref' ? (
                        sec.depts.map(dp => {
                          const c = sec.cell.get(`${row.item_id}|${dp.id}`);
                          const pointerHere = selectedCell?.itemId === row.item_id && selectedCell?.deptId === dp.id;
                          const ring = pointerHere ? 'ring-2 ring-inset ring-blue-300' : '';
                          if (!c) return (
                            <Fragment key={dp.id}>
                              <td className={`px-0.5 py-1 text-center text-slate-300 border-l border-slate-100 ${ring}`}>·</td>
                              <td className={`px-0.5 py-1 text-center text-slate-300 ${ring}`}>·</td>
                            </Fragment>
                          );
                          return (
                            <Fragment key={dp.id}>
                              <td className={`px-0.5 py-1 text-center text-indigo-600 border-l border-slate-100 ${ring}`} title={`${dp.name} 재고 ${c.onHand}`}>{c.onHand}</td>
                              <td className={`px-0.5 py-1 text-center text-emerald-600 ${ring}`} title={`${dp.name} 사용환자 ${c.patients}명`}>{c.patients}</td>
                            </Fragment>
                          );
                        })
                      ) : (
                        sec.depts.map(dp => {
                          const c = sec.cell.get(`${row.item_id}|${dp.id}`);
                          if (!c) return <td key={dp.id} className="px-1 py-1 text-center text-slate-300 border-l border-slate-100">·</td>;
                          const key = `${row.item_id}|${dp.id}`;
                          const events = recentData[key];
                          const last = events?.[0];
                          const cellSelected = selectedCell?.itemId === row.item_id && selectedCell?.deptId === dp.id;
                          return (
                            <td
                              key={dp.id}
                              className={`px-1 py-1 text-center border-l border-slate-100 cursor-pointer ${cellSelected ? 'ring-2 ring-blue-400 rounded' : ''}`}
                              onClick={() => {
                                setSelectedCell({ itemId: row.item_id, deptId: dp.id });
                                if (events && events.length > 0) {
                                  setRecentPopup({ itemId: row.item_id, deptId: dp.id, itemName: row.name, deptName: dp.name });
                                }
                              }}
                            >
                              {!events ? (
                                <span className="text-slate-300">{recentLoading ? '…' : '·'}</span>
                              ) : last ? (
                                <span className="text-slate-600 whitespace-nowrap">
                                  {last.date.slice(5).replace('-', '/')}·{last.qty}
                                </span>
                              ) : (
                                <span className="text-slate-300">-</span>
                              )}
                            </td>
                          );
                        })
                      )}
                    </tr>
                  );
                })}
              </tbody>
              {mode === 'qty' && (
                <tfoot>
                  <tr className="bg-slate-50 border-t-2 border-slate-200 font-semibold text-slate-700">
                    <td className="px-2 py-1.5" colSpan={sec.depts.length + 3}>
                      {sec.label} 합계
                    </td>
                    <td className="px-2 py-1.5 text-right text-teal-700 whitespace-nowrap pr-3 text-xs">{fmt(amounts.byMajor[sec.major] ?? 0)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      ))}

      {mode === 'qty' && !readOnly && (
        <div className="flex items-center justify-end gap-3 sticky bottom-0 bg-white/90 backdrop-blur py-2">
          <span className="text-sm text-slate-600 mr-auto">총 예상 금액 <b className="text-teal-700">{fmt(amounts.grand)}</b></span>
          <span className="text-sm text-slate-500">변경 <b className="text-amber-600">{changedCount}</b>건</span>
          <button
            onClick={() => save('ALL')}
            disabled={saving !== null || changedCount === 0}
            className="btn-primary inline-flex items-center gap-1.5"
          >
            {saving === 'ALL' ? <><Loader2 className="w-4 h-4 animate-spin" /> 저장 중...</> : <><Save className="w-4 h-4" /> 전체 저장</>}
          </button>
        </div>
      )}

      {recentPopup && (() => {
        const events = recentData[`${recentPopup.itemId}|${recentPopup.deptId}`] ?? [];
        return (
          <Modal
            open
            onClose={() => setRecentPopup(null)}
            title={`${recentPopup.itemName} · ${recentPopup.deptName} — 전체 불출 이력`}
            size="sm"
          >
            {events.length === 0 ? (
              <div className="py-6 text-center text-sm text-slate-400">불출 이력이 없습니다.</div>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {events.map((ev, i) => (
                  <li key={i} className="flex items-center justify-between py-1.5">
                    <span className="text-slate-500">{ev.date}</span>
                    <span className="font-medium text-slate-800">{ev.qty}개</span>
                  </li>
                ))}
              </ul>
            )}
          </Modal>
        );
      })()}
    </div>
  );
}
