/**
 * 구매결의서 (PurchaseDecision) CRUD + PDF 출력.
 *
 * 정책: 결재 워크플로우 X (사용자가 종이로 결재 받음).
 *  - 시스템은 작성·저장·인쇄까지만.
 *  - 발주에 사용되면 status=LOCKED 로 잠김 (재사용 시 경고/막기).
 *
 * 권한: PURCHASE_MANAGE / SYSTEM_ADMIN
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit, generateNo, nextSeq } from '../utils/audit';
import { loadSchedulesByType, resolveScheduleLabel, monthLabel } from '../utils/period-label';
import { getFonts } from '../services/pdf';
// (resolved: 자동 불출 흐름 제거 — 재고 차감은 별도 불출 화면에서)

const router = Router();
router.use(authMiddleware);

const SEQ_KEY = 'purchase_decisions';

// 품명/규격 정리 — 결의서 표시 시 중복 제거
//
// 케이스 1) "Air Way HS-AW-300 (WHITE 7cm)" 처럼 품번+규격이 품명에 다 들어감
//          → 품명="Air Way", 규격="HS-AW-300 (WHITE 7cm)"
//
// 케이스 2) "Guaze (2*2)" / 규격="2*2" 처럼 품명 끝의 괄호 안 내용이 규격과 동일
//          → 품명="Guaze", 규격="2*2" (괄호 제거)
//          → "탄력붕대(E/B) (4*12's)" / 규격="4*12's" 도 마지막 괄호만 제거: "탄력붕대(E/B)"
//          → "Biopore (실리콘)" / 규격="천(1*12's)" 처럼 다르면 그대로 유지
//
// 케이스 3) 그 외엔 그대로
export function splitItemName(name: string, originalSpec: string): { name: string; spec: string } {
  const trimmed = (name ?? '').trim();
  const specTrim = (originalSpec ?? '').trim();

  // Air Way 특수 케이스
  const air = trimmed.match(/^Air\s*Way\s+(.+)$/i);
  if (air) return { name: 'Air Way', spec: air[1].trim() };

  // 일반 케이스: 품명 끝에 (괄호) 가 있고 그 내용이 규격과 같으면 괄호 제거
  // 비탐욕 .*? + 마지막 괄호 한 쌍 매칭
  const paren = trimmed.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (paren) {
    const baseName = paren[1].trim();
    const parenContent = paren[2].trim();
    if (baseName.length > 0 && parenContent === specTrim && specTrim.length > 0) {
      return { name: baseName, spec: specTrim };
    }
  }

  return { name: trimmed, spec: specTrim };
}

// nextSeq 가 'purchase_decisions' 를 모르므로 직접 — 마지막 번호 + 1
export async function nextDecisionSeq(): Promise<number> {
  const result = await (prisma as any).$queryRawUnsafe(
    `SELECT MAX(CAST(SUBSTR(decision_no, LENGTH(decision_no) - 4) AS INTEGER)) as max_seq FROM purchase_decisions WHERE decision_no IS NOT NULL`,
  ) as any[];
  return Number(result[0]?.max_seq ?? 0) + 1;
}

// 대분류 추론 — shared/types getMajor 와 동일 로직 (서버 직접 inline)
function inferMajor(category: string): string {
  const c = String(category || '').toUpperCase();
  if (c.startsWith('EQUIP_')) return 'EQUIPMENT';
  if (c.startsWith('OFF_')) return 'OFFICE';
  if (c.startsWith('MED_') || c.startsWith('INFECT_')) return 'MEDICAL';
  if (c.startsWith('DIAPER')) return 'DIAPER';
  return 'GENERAL';
}

export function format(d: any) {
  if (!d) return null;
  // 표시 시 품명/규격 중복 정리 (기존 결의서도 깔끔하게 보이도록).
  // DB 의 items_json 은 변경하지 않음 — 사용자가 결의서 편집에서 "저장" 누르면 정리된 값이 영구 반영됨.
  const rawItems: any[] = (() => { try { return JSON.parse(d.items_json ?? '[]'); } catch { return []; } })();
  const items = rawItems.map((it: any) => {
    const split = splitItemName(it.name ?? '', it.spec ?? '');
    return { ...it, name: split.name, spec: split.spec };
  });
  // 대분류 분포 + 총 금액
  const breakdown: Record<string, number> = {};
  let totalAmount = 0;
  for (const it of items) {
    const major = inferMajor(String(it.category ?? ''));
    breakdown[major] = (breakdown[major] ?? 0) + 1;
    totalAmount += Number(it.qty ?? 0) * Number(it.unit_price ?? 0);
  }
  return {
    id: d.id,
    decision_no: d.decision_no,
    title: d.title,
    vendor_id: d.vendor_id,
    vendor_name: d.vendor?.name ?? '',
    doc_date: d.doc_date,
    period_label: d.period_label,
    period_from: d.period_from,
    period_to: d.period_to,
    dept_label: d.dept_label,
    approver_lines: (() => { try { return JSON.parse(d.approver_lines ?? '[]'); } catch { return []; } })(),
    comment: d.comment,
    items,
    source_po_ids: (() => { try { return JSON.parse(d.source_po_ids ?? '[]'); } catch { return []; } })(),
    used_in_po_id: d.used_in_po_id,
    used_in_po_no: d.used_in_po?.po_no ?? null,
    status: d.status,
    creator_name: d.creator?.display_name ?? '',
    created_at: d.created_at,
    updated_at: d.updated_at,
    category_breakdown: breakdown,
    total_amount: Math.round(totalAmount),
  };
}

export const INCLUDE = {
  vendor: { select: { id: true, name: true, phone: true, email: true } },
  creator: { select: { display_name: true } },
  used_in_po: { select: { id: true, po_no: true, status: true, deleted_at: true } },
};

// GET /api/purchase-decisions
router.get('/', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const status = String(req.query.status ?? '');
    const where: any = { deleted_at: null };
    if (status) where.status = status;
    const rows = await (prisma as any).purchaseDecision.findMany({
      where,
      include: INCLUDE,
      orderBy: { created_at: 'desc' },
    });
    res.json(rows.map(format));
  } catch (e: any) {
    console.error('[GET /purchase-decisions] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// POST /api/purchase-decisions — 신규 작성 (수동)
router.post('/', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const body = req.body ?? {};
    if (!body.vendor_id) return res.status(400).json({ error: '거래처(vendor_id)가 필요합니다.' });

    const seq = await nextDecisionSeq();
    const decision_no = generateNo('PD', seq);

    const created = await (prisma as any).purchaseDecision.create({
      data: {
        id: uuidv4(),
        decision_no,
        title: String(body.title ?? ''),
        vendor_id: String(body.vendor_id),
        doc_date: body.doc_date ? new Date(body.doc_date) : new Date(),
        period_label: String(body.period_label ?? ''),
        period_from: body.period_from ? new Date(body.period_from) : null,
        period_to: body.period_to ? new Date(body.period_to) : null,
        dept_label: String(body.dept_label ?? ''),
        approver_lines: JSON.stringify(Array.isArray(body.approver_lines) ? body.approver_lines : []),
        comment: String(body.comment ?? ''),
        items_json: JSON.stringify(Array.isArray(body.items) ? body.items : []),
        source_po_ids: JSON.stringify(Array.isArray(body.source_po_ids) ? body.source_po_ids : []),
        status: 'DRAFT',
        created_by: req.user!.id,
      },
      include: INCLUDE,
    });
    await audit({
      actor_user_id: req.user!.id,
      action: 'CREATE',
      entity_type: 'purchase_decisions',
      entity_id: created.id,
      after: { decision_no, vendor_id: body.vendor_id },
    });
    res.status(201).json(format(created));
  } catch (e: any) {
    console.error('[POST /purchase-decisions] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// POST /api/purchase-decisions/from-pos — 발주서 ID 들에서 자동 prefill
router.post('/from-pos', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const ids: string[] = Array.isArray(req.body?.po_ids) ? req.body.po_ids : [];
    if (ids.length === 0) return res.status(400).json({ error: 'po_ids 가 필요합니다.' });

    const pos = await (prisma as any).purchaseOrder.findMany({
      where: { id: { in: ids }, deleted_at: null },
      include: {
        vendor: true,
        po_items: { include: { item: true } },
        sources: { include: { ward_request: { include: { department: true, items: true, approval_actions: { include: { items: true }, orderBy: { created_at: 'desc' as const }, take: 1 } } } } },
      },
    });
    if (pos.length === 0) return res.status(404).json({ error: '발주서를 찾을 수 없습니다.' });

    // 신청주기 매핑용 — 승인 화면과 동일한 단일 진실원(period-label.ts)
    const schedulesByType = await loadSchedulesByType(prisma);

    // 거래처별로 묶음 — 한 결의서 = 한 거래처
    const byVendor = new Map<string, any[]>();
    for (const po of pos) {
      const vid = po.vendor_id;
      if (!byVendor.has(vid)) byVendor.set(vid, []);
      byVendor.get(vid)!.push(po);
    }

    const created: any[] = [];
    for (const [vendor_id, vpos] of byVendor) {
      // 결의서 본문 라인 — 품목별로 합산
      const itemMap = new Map<string, any>();
      for (const po of vpos) {
        for (const it of po.po_items ?? []) {
          const iid = it.item_id;
          if (!itemMap.has(iid)) {
            const origSpec = it.item?.sub_category ?? it.item?.purchase_uom ?? it.item?.uom ?? '';
            const split = splitItemName(it.item?.name ?? '', origSpec);
            itemMap.set(iid, {
              item_id: iid,
              item_code: it.item?.item_code ?? '',
              name: split.name,
              spec: split.spec,
              unit: it.item?.purchase_uom ?? it.item?.uom ?? '',
              pack_size: Number(it.item?.pack_size ?? 1),
              category: String(it.item?.category ?? ''),
              qty: 0,
              unit_price: Number(it.unit_price),
              comment: '',
            });
          }
          itemMap.get(iid)!.qty += Number(it.ordered_qty);
        }
      }

      const seq = await nextDecisionSeq();
      const decision_no = generateNo('PD', seq);
      const vpo = vpos[0];
      const minDate = vpos.reduce((min: any, p: any) => p.ordered_at < min ? p.ordered_at : min, vpos[0].ordered_at);
      // 주차/기간 라벨 — 승인과 동일하게 신청주기(신청기간) 매핑 수동 라벨 사용.
      // 한 결의서에 여러 신청이 묶이면 가장 이른 신청기간의 라벨을 대표로.
      const periodCands: { label: string; start: Date }[] = [];
      for (const p of vpos) {
        for (const src of (p.sources ?? [])) {
          const wr = src?.ward_request;
          if (!wr) continue;
          const ps = wr.period_start ? new Date(wr.period_start) : null;
          const { period_label } = resolveScheduleLabel(String(wr.request_type ?? ''), ps, schedulesByType);
          if (period_label && ps) periodCands.push({ label: period_label, start: ps });
        }
      }
      periodCands.sort((a, b) => a.start.getTime() - b.start.getTime());
      const resolvedPeriodLabel = periodCands[0]?.label || monthLabel(minDate);

      const sortedLines = Array.from(itemMap.values()).sort((a: any, b: any) =>
        (a.item_code ?? '').localeCompare(b.item_code ?? '', 'ko', { numeric: true }),
      );

      const row = await (prisma as any).purchaseDecision.create({
        data: {
          id: uuidv4(),
          decision_no,
          title: `${vpo.vendor?.name ?? ''} 구매결의서`,
          vendor_id,
          doc_date: new Date(),
          period_label: resolvedPeriodLabel,
          period_from: minDate,
          period_to: minDate,
          dept_label: '',
          approver_lines: JSON.stringify(['담당', '부서장', '행정원장', '상임이사', '이사장']),
          comment: '',
          items_json: JSON.stringify(sortedLines),
          source_po_ids: JSON.stringify(vpos.map((p: any) => p.id)),
          status: 'DRAFT',
          created_by: req.user!.id,
        },
        include: INCLUDE,
      });
      created.push(format(row));
    }

    await audit({
      actor_user_id: req.user!.id,
      action: 'CREATE',
      entity_type: 'purchase_decisions',
      entity_id: 'BULK',
      after: { from_po_ids: ids, created: created.length },
    });

    res.status(201).json({ created });
  } catch (e: any) {
    console.error('[POST /purchase-decisions/from-pos] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// 헬퍼: 기존 결의서들에 들어간 (wr_id, item_id) 쌍 집합 — "이미 처리된 라인" 추적용.
// 한 wr 의 일부 품목만 결의서로 들어갔으면, 나머지 품목들은 여전히 미처리 상태.
export async function getProcessedWrItemPairs(): Promise<Set<string>> {
  // 삭제된 결의서도 포함 — 사용자가 결의서 삭제 후 다음 "신규 작성" 눌러도 해당 (wr, item) 페어가
  // 다시 후보로 안 뜨게 하기 위함. 즉 한 번 결의서에 들어간 페어는 영구 처리됨으로 인식.
  const decisions = await (prisma as any).purchaseDecision.findMany({
    select: { source_ward_request_ids: true, items_json: true, excluded_items_json: true },
  });
  const used = new Set<string>();
  for (const d of decisions) {
    let wrIds: string[] = [];
    let items: any[] = [];
    let excluded: any[] = [];
    try { wrIds = JSON.parse(d.source_ward_request_ids ?? '[]'); } catch {}
    try { items = JSON.parse(d.items_json ?? '[]'); } catch {}
    try { excluded = JSON.parse(d.excluded_items_json ?? '[]'); } catch {}

    // 1) 현재 결의서에 들어있는 라인 — 카르테시안 (모든 source_wr × item_id)
    const itemIds = items.map((i: any) => i.item_id).filter(Boolean);
    for (const wrId of wrIds) {
      for (const itemId of itemIds) used.add(`${wrId}::${itemId}`);
    }

    // 2) X 로 뺀 라인 (excluded) — 사용자가 "처리 완료(발주 안 함)" 결정한 페어
    //    excluded 항목의 source_wr_ids 가 명시되어 있으면 그것만, 없으면 결의서 source 전체
    for (const ex of excluded) {
      if (!ex.item_id) continue;
      const exWrIds: string[] = Array.isArray(ex.source_wr_ids) && ex.source_wr_ids.length > 0
        ? ex.source_wr_ids
        : wrIds;
      for (const wrId of exWrIds) used.add(`${wrId}::${ex.item_id}`);
    }
  }
  return used;
}

// GET /api/purchase-decisions/pending-vendor-items
// 현재 시점에 "거래처 미지정인 품목 + 승인됐지만 결의서로 묶이지 않은 신청" 의 교집합.
// 페이지 새로고침해도 다시 가져올 수 있게 — DB 변경 없음, 단순 계산.
router.get('/pending-vendor-items', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (_req: AuthRequest, res) => {
  try {
    const usedPairs = await getProcessedWrItemPairs();

    // 모든 APPROVED 신청 가져옴 (wr 전체 제외 X — 라인 단위로 비교)
    const wrs = await prisma.wardRequest.findMany({
      where: {
        status: { in: ['APPROVED', 'PARTIAL_APPROVED'] },
        deleted_at: null,
      },
      include: {
        approval_actions: { orderBy: { created_at: 'desc' as const }, take: 1, include: { items: true } },
        department: { select: { name: true } },
      },
    });

    const allItemIds = new Set<string>();
    for (const wr of wrs) {
      const action = (wr as any).approval_actions[0];
      if (!action) continue;
      for (const ai of action.items) if (ai.item_id) allItemIds.add(ai.item_id);
    }
    const items = await prisma.item.findMany({
      where: { id: { in: Array.from(allItemIds) } },
      select: { id: true, item_code: true, name: true, category: true, pack_size: true, default_vendor_id: true },
    });
    const itemById = new Map(items.map((i: any) => [i.id, i]));

    const skippedByItem = new Map<string, any>();
    for (const wr of wrs) {
      const action = (wr as any).approval_actions[0];
      if (!action) continue;
      const deptName: string = (wr as any).department?.name ?? '';
      for (const ai of action.items) {
        if (!ai.item_id) continue;
        // 이 (wr, item) 쌍이 이미 결의서에 들어갔으면 스킵
        if (usedPairs.has(`${wr.id}::${ai.item_id}`)) continue;
        const item = itemById.get(ai.item_id);
        if (!item || item.default_vendor_id) continue; // 거래처 있으면 스킵 (자동 prefill 대상)
        const qty = Number(ai.approved_qty);
        if (qty <= 0) continue;
        let s = skippedByItem.get(ai.item_id);
        if (!s) {
          s = {
            item_id: ai.item_id,
            item_code: item.item_code,
            name: item.name,
            category: String(item.category ?? ''),
            pack_size: Math.max(1, Number(item.pack_size ?? 1)),
            qty: 0,
            depts: new Set<string>(),
          };
          skippedByItem.set(ai.item_id, s);
        }
        s.qty += qty;
        if (deptName) s.depts.add(deptName);
      }
    }

    const result = Array.from(skippedByItem.values())
      .map((s: any) => ({
        item_id: s.item_id,
        item_code: s.item_code,
        name: s.name,
        category: s.category,
        pack_size: s.pack_size,
        qty: s.qty,
        depts: Array.from(s.depts),
      }))
      .sort((a: any, b: any) =>
        (a.item_code ?? '').localeCompare(b.item_code ?? '', 'ko', { numeric: true }),
      );

    res.json({ items: result });
  } catch (e: any) {
    console.error('[GET /purchase-decisions/pending-vendor-items] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// POST /api/purchase-decisions/from-approved
// 승인된(APPROVED) 신청들 중 아직 결의서로 묶이지 않은 것들을 거래처별로 자동 prefill하여 결의서 N개 생성.
router.post('/from-approved', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    // 1) 이미 결의서에 들어간 (wr_id, item_id) 쌍 — 라인 단위 중복 방지
    const usedPairs = await getProcessedWrItemPairs();

    // 2) 모든 APPROVED 신청 — 라인 단위로 처리됐는지 비교 (wr 전체를 제외하지 않음)
    const wrs = await prisma.wardRequest.findMany({
      where: {
        status: { in: ['APPROVED', 'PARTIAL_APPROVED'] },
        deleted_at: null,
      },
      include: {
        approval_actions: { orderBy: { created_at: 'desc' as const }, take: 1, include: { items: true } },
        department: { select: { name: true } },
      },
    });
    if (wrs.length === 0) {
      return res.status(200).json({ created: [], message: '결의서로 만들 새 승인 신청이 없습니다.' });
    }

    // 3) 등장하는 모든 item_id 의 마스터 (default_vendor + pack_size)
    const allItemIds = new Set<string>();
    for (const wr of wrs) {
      const action = (wr as any).approval_actions[0];
      if (!action) continue;
      for (const ai of action.items) if (ai.item_id) allItemIds.add(ai.item_id);
    }
    const items = await prisma.item.findMany({
      where: { id: { in: Array.from(allItemIds) } },
      include: { default_vendor: true },
    });
    const itemById = new Map(items.map((i: any) => [i.id, i]));

    // 4) 최근 단가 (item × vendor)
    const priceRows = await prisma.priceHistory.findMany({
      where: { item_id: { in: Array.from(allItemIds) }, effective_to: null },
      orderBy: { effective_from: 'desc' },
    });
    const lastPrice = new Map<string, number>();
    for (const p of priceRows) {
      const k = `${p.item_id}::${p.vendor_id}`;
      if (!lastPrice.has(k)) lastPrice.set(k, Number(p.price));
    }

    // 5) 거래처별 그룹핑 (item.default_vendor_id 기준)
    type Bucket = {
      vendor_id: string;
      vendor_name: string;
      items: Map<string, { item: any; qty: number }>;  // itemId → 누적 팩수
      wr_ids: Set<string>;
      dept_names: Set<string>;
    };
    const byVendor = new Map<string, Bucket>();
    // 거래처 미지정 품목 — itemId 단위로 합산 + 부서명 누적
    type SkippedItem = {
      item_id: string;
      item_code: string;
      name: string;
      category: string;
      pack_size: number;
      qty: number;            // 누적 팩수
      depts: Set<string>;
    };
    const skippedByItem = new Map<string, SkippedItem>();

    for (const wr of wrs) {
      const action = (wr as any).approval_actions[0];
      if (!action) continue;
      const deptName: string = (wr as any).department?.name ?? '';
      for (const ai of action.items) {
        if (!ai.item_id) continue;
        // 이미 결의서에 들어간 (wr, item) 쌍은 스킵 — 라인 단위 중복 방지
        if (usedPairs.has(`${wr.id}::${ai.item_id}`)) continue;
        const item = itemById.get(ai.item_id);
        if (!item) continue;
        const vendorId = item.default_vendor_id;
        const qty = Number(ai.approved_qty);
        if (qty <= 0) continue;
        if (!vendorId) {
          let s = skippedByItem.get(ai.item_id);
          if (!s) {
            s = {
              item_id: ai.item_id,
              item_code: item.item_code,
              name: item.name,
              category: String(item.category ?? ''),
              pack_size: Math.max(1, Number(item.pack_size ?? 1)),
              qty: 0,
              depts: new Set(),
            };
            skippedByItem.set(ai.item_id, s);
          }
          s.qty += qty;
          if (deptName) s.depts.add(deptName);
          continue;
        }
        let bucket = byVendor.get(vendorId);
        if (!bucket) {
          bucket = {
            vendor_id: vendorId,
            vendor_name: item.default_vendor?.name ?? '거래처',
            items: new Map(),
            wr_ids: new Set(),
            dept_names: new Set(),
          };
          byVendor.set(vendorId, bucket);
        }
        bucket.wr_ids.add(wr.id);
        if (deptName) bucket.dept_names.add(deptName);
        const existing = bucket.items.get(ai.item_id);
        if (existing) existing.qty += qty;
        else bucket.items.set(ai.item_id, { item, qty });
      }
    }

    // 6) 거래처별 결의서 생성 — 팩수 → 박스수 환산하여 라인 구성
    const created: any[] = [];
    const skippedReasons: { vendor_name: string; reason: string }[] = [];
    const now = new Date();
    // 주차/기간 라벨 — 승인과 동일한 신청주기 매핑(단일 진실원). 묶인 신청 중 가장 이른 신청기간의 라벨을 대표로.
    const schedulesByType = await loadSchedulesByType(prisma);
    const plCands: { label: string; start: Date }[] = [];
    for (const wr of wrs) {
      const ps = (wr as any).period_start ? new Date((wr as any).period_start) : null;
      const { period_label } = resolveScheduleLabel(String((wr as any).request_type ?? ''), ps, schedulesByType);
      if (period_label && ps) plCands.push({ label: period_label, start: ps });
    }
    plCands.sort((a, b) => a.start.getTime() - b.start.getTime());
    const periodLabel = plCands[0]?.label || monthLabel(now);

    // 같은 주기·거래처에 LOCKED(발주됨) 결의서가 이미 있으면 그 거래처는 새로 안 만듦.
    const existingLocked: any[] = await (prisma as any).purchaseDecision.findMany({
      where: { deleted_at: null, status: 'LOCKED', period_label: periodLabel },
      select: { vendor_id: true, decision_no: true, vendor: { select: { name: true } } },
    });
    const lockedVendorIds = new Set(existingLocked.map((d: any) => d.vendor_id));

    for (const bucket of byVendor.values()) {
      const lines = Array.from(bucket.items.values())
        .map(({ item, qty }) => {
          const ps = Math.max(1, Number(item.pack_size ?? 1));
          const boxQty = Math.ceil(qty / ps);
          const price = lastPrice.get(`${item.id}::${bucket.vendor_id}`) ?? 0;
          const origSpec = item.sub_category || item.purchase_uom || item.uom || '';
          const split = splitItemName(item.name ?? '', origSpec);
          return {
            item_id: item.id,
            item_code: item.item_code,
            name: split.name,
            spec: split.spec,
            unit: item.purchase_uom || item.uom || '',
            pack_size: ps,
            category: String(item.category ?? ''),
            qty: boxQty,
            unit_price: price,
            comment: '',
          };
        })
        // 정렬: 코드번호순 (숫자 인식 — 예: 'A002' < 'A010')
        .sort((a, b) =>
          (a.item_code ?? '').localeCompare(b.item_code ?? '', 'ko', { numeric: true }),
        );

      // (A1) 빈 결의서 안 만들기 — 라인 0개면 skip
      if (lines.length === 0) {
        skippedReasons.push({ vendor_name: bucket.vendor_name, reason: '결의서로 묶을 라인이 없음 (모두 이미 발주된 라인)' });
        continue;
      }
      // (A2) 단가 정보 없는 거래처는 skip — priceHistory 비어있어서 모든 라인이 unit_price=0
      const totalAmount = lines.reduce((s, ln) => s + Number(ln.qty ?? 0) * Number(ln.unit_price ?? 0), 0);
      if (totalAmount === 0) {
        skippedReasons.push({ vendor_name: bucket.vendor_name, reason: `단가 정보 없음 (라인 ${lines.length}개) — 품목관리에서 단가 등록 후 다시 시도` });
        continue;
      }
      // (D) 같은 주기에 LOCKED 결의서가 있는 거래처는 skip
      if (lockedVendorIds.has(bucket.vendor_id)) {
        const lockedNo = existingLocked.find(d => d.vendor_id === bucket.vendor_id)?.decision_no ?? '';
        skippedReasons.push({ vendor_name: bucket.vendor_name, reason: `이미 발주됨 (${lockedNo})` });
        continue;
      }

      const seq = await nextDecisionSeq();
      const decision_no = generateNo('PD', seq);
      const decision = await (prisma as any).purchaseDecision.create({
        data: {
          id: uuidv4(),
          decision_no,
          title: `${bucket.vendor_name} 구매결의서`,
          vendor_id: bucket.vendor_id,
          doc_date: now,
          period_label: periodLabel,
          period_from: now,
          period_to: now,
          dept_label: Array.from(bucket.dept_names).join(', '),
          approver_lines: JSON.stringify(['담당', '부서장', '행정원장', '상임이사', '이사장']),
          items_json: JSON.stringify(lines),
          source_ward_request_ids: JSON.stringify(Array.from(bucket.wr_ids)),
          status: 'DRAFT',
          created_by: req.user!.id,
        },
        include: INCLUDE,
      });
      created.push(format(decision));
    }

    await audit({
      actor_user_id: req.user!.id,
      action: 'CREATE',
      entity_type: 'purchase_decisions',
      entity_id: 'BULK',
      after: { from_wr_count: wrs.length, decisions_created: created.length, vendors: created.length },
    });

    // 거래처 미지정 품목 객체 배열 (UI 인라인 거래처 지정용)
    const skippedItems = Array.from(skippedByItem.values()).map(s => ({
      item_id: s.item_id,
      item_code: s.item_code,
      name: s.name,
      category: s.category,
      pack_size: s.pack_size,
      qty: s.qty, // 팩 단위 합산
      depts: Array.from(s.depts),
    })).sort((a, b) =>
      (a.item_code ?? '').localeCompare(b.item_code ?? '', 'ko', { numeric: true }),
    );

    res.status(201).json({
      created,
      source_wr_count: wrs.length,
      skipped_no_vendor: skippedItems.length,
      skipped_items: skippedItems,
      skipped_vendors: skippedReasons,  // 빈/LOCKED 로 건너뛴 거래처 사유
    });
  } catch (e: any) {
    console.error('[POST /purchase-decisions/from-approved] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// POST /api/purchase-decisions/move-item
// 결의서에서 한 품목을 다른 거래처의 결의서로 옮긴다.
//   - 같은 period_label 의 DRAFT 결의서가 대상 거래처에 이미 있으면 거기에 추가
//   - 없으면 새로 생성
//   - 정렬은 코드번호순 유지
router.post('/move-item', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  const { from_decision_id, item_index, to_vendor_id } = req.body ?? {};
  if (!from_decision_id || typeof item_index !== 'number' || !to_vendor_id) {
    return res.status(400).json({ error: 'from_decision_id, item_index, to_vendor_id 가 필요합니다.' });
  }
  try {
    const src = await (prisma as any).purchaseDecision.findUnique({
      where: { id: String(from_decision_id) },
    });
    if (!src || src.deleted_at) return res.status(404).json({ error: '원 결의서를 찾을 수 없습니다.' });
    if (src.status === 'LOCKED') return res.status(400).json({ error: '발주에 사용된 결의서는 수정할 수 없습니다.' });
    if (src.vendor_id === to_vendor_id) return res.status(400).json({ error: '같은 거래처입니다.' });

    const items: any[] = (() => { try { return JSON.parse(src.items_json ?? '[]'); } catch { return []; } })();
    if (item_index < 0 || item_index >= items.length) {
      return res.status(400).json({ error: '품목 인덱스가 범위를 벗어났습니다.' });
    }
    const movedItem = items[item_index];

    const targetVendor = await prisma.vendor.findUnique({ where: { id: String(to_vendor_id) } });
    if (!targetVendor) return res.status(404).json({ error: '대상 거래처를 찾을 수 없습니다.' });

    // 대상 결의서: 같은 period_label 의 DRAFT 결의서 찾기
    let dst = await (prisma as any).purchaseDecision.findFirst({
      where: {
        vendor_id: to_vendor_id,
        period_label: src.period_label,
        status: 'DRAFT',
        deleted_at: null,
      },
    });

    // 없으면 새로 생성
    let createdDst = false;
    if (!dst) {
      const seq = await nextDecisionSeq();
      const decision_no = generateNo('PD', seq);
      dst = await (prisma as any).purchaseDecision.create({
        data: {
          id: uuidv4(),
          decision_no,
          title: `${targetVendor.name} 구매결의서`,
          vendor_id: to_vendor_id,
          doc_date: src.doc_date,
          period_label: src.period_label,
          period_from: src.period_from,
          period_to: src.period_to,
          dept_label: '',
          approver_lines: src.approver_lines,
          comment: '',
          items_json: '[]',
          source_po_ids: '[]',
          source_ward_request_ids: src.source_ward_request_ids,
          status: 'DRAFT',
          created_by: req.user!.id,
        },
      });
      createdDst = true;
    }

    // 옮기기
    const newSrcItems = items.filter((_, i) => i !== item_index);
    const dstItems: any[] = (() => { try { return JSON.parse(dst.items_json ?? '[]'); } catch { return []; } })();
    dstItems.push(movedItem);
    // 코드번호순 정렬
    dstItems.sort((a: any, b: any) =>
      (a.item_code ?? '').localeCompare(b.item_code ?? '', 'ko', { numeric: true }),
    );

    await prisma.$transaction([
      (prisma as any).purchaseDecision.update({
        where: { id: src.id },
        data: { items_json: JSON.stringify(newSrcItems) },
      }),
      (prisma as any).purchaseDecision.update({
        where: { id: dst.id },
        data: { items_json: JSON.stringify(dstItems) },
      }),
    ]);

    await audit({
      actor_user_id: req.user!.id,
      action: 'UPDATE',
      entity_type: 'purchase_decisions',
      entity_id: src.id,
      after: { moved_item: movedItem.name, to_decision_no: dst.decision_no, to_vendor: targetVendor.name },
    });

    res.json({
      ok: true,
      from_decision_id: src.id,
      to_decision_id: dst.id,
      to_decision_no: dst.decision_no,
      to_vendor_name: targetVendor.name,
      created_target: createdDst,
    });
  } catch (e: any) {
    console.error('[POST /purchase-decisions/move-item] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// GET /api/purchase-decisions/:id/line-stock?index=N
// 결의서의 N번째 라인에 대해 총무구매 창고 재고 + 원본 신청 부서 정보 반환.
// 사용자가 라인을 빼기 전에 "창고에 재고 있나?" 확인 용도.
router.get('/:id/line-stock', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const idx = parseInt(String(req.query.index ?? ''), 10);
    if (Number.isNaN(idx) || idx < 0) return res.status(400).json({ error: 'index 가 유효하지 않습니다.' });

    const dec: any = await (prisma as any).purchaseDecision.findUnique({ where: { id: String(req.params.id) } });
    if (!dec || dec.deleted_at) return res.status(404).json({ error: '결의서를 찾을 수 없습니다.' });

    const items: any[] = (() => { try { return JSON.parse(dec.items_json ?? '[]'); } catch { return []; } })();
    if (idx >= items.length) return res.status(400).json({ error: 'index 가 범위를 벗어남' });
    const line = items[idx];
    if (!line.item_id) {
      return res.json({ has_stock: false, central_stock_pack: 0, central_stock_box: 0, source_depts: [], reason: 'free_input' });
    }

    // 총무구매 창고 위치
    const central = await (prisma as any).inventoryLocation.findFirst({ where: { code: 'CENTRAL', deleted_at: null } });
    if (!central) return res.json({ has_stock: false, central_stock_pack: 0, central_stock_box: 0, source_depts: [], reason: 'no_central_warehouse' });

    const inv = await prisma.inventory.findFirst({ where: { item_id: line.item_id, location_id: central.id } });
    const stockPack = Number(inv?.on_hand_qty ?? 0);
    const ps = Math.max(1, Number(line.pack_size ?? 1));
    const stockBox = Math.floor(stockPack / ps);

    // 원본 신청 부서 + 그 신청에서 이 품목의 승인량
    const wrIds: string[] = (() => { try { return JSON.parse(dec.source_ward_request_ids ?? '[]'); } catch { return []; } })();
    const sourceDepts: { dept_id: string; dept_name: string; wr_id: string; wr_no: string; approved_qty_pack: number }[] = [];
    if (wrIds.length > 0) {
      const wrs = await prisma.wardRequest.findMany({
        where: { id: { in: wrIds } },
        include: {
          department: { select: { name: true } },
          approval_actions: { orderBy: { created_at: 'desc' as const }, take: 1, include: { items: true } },
        },
      });
      for (const wr of wrs as any[]) {
        const action = wr.approval_actions[0];
        if (!action) continue;
        const totalApproved = action.items
          .filter((ai: any) => ai.item_id === line.item_id)
          .reduce((s: number, ai: any) => s + Number(ai.approved_qty), 0);
        if (totalApproved <= 0) continue;
        sourceDepts.push({
          dept_id: wr.department_id,
          dept_name: wr.department?.name ?? '',
          wr_id: wr.id,
          wr_no: wr.request_no,
          approved_qty_pack: totalApproved,
        });
      }
    }

    res.json({
      has_stock: stockPack > 0,
      central_stock_pack: stockPack,
      central_stock_box: stockBox,
      pack_size: ps,
      line_qty_box: Number(line.qty ?? 0),
      line_qty_pack: Number(line.qty ?? 0) * ps,
      item_name: line.name ?? '',
      source_depts: sourceDepts,
    });
  } catch (e: any) {
    console.error('[GET /purchase-decisions/:id/line-stock] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// POST /api/purchase-decisions/:id/exclude-line
// 결의서 라인을 X 로 빼면서 "처리됨(발주 안 함)" 으로 영구 마킹.
// 해당 (source_wr × item_id) 페어가 다음 from-approved 의 used_pairs 에 포함되어
// "신규 작성" 시 또 새 결의서로 만들어지지 않게 함.
//
// 입력: { item_index, reason? }
// 동작: items_json[item_index] 제거 + excluded_items_json 에 추가
router.post('/:id/exclude-line', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const decId = String(req.params.id);
    const { item_index, reason } = req.body ?? {};
    const idx = Number(item_index);
    if (Number.isNaN(idx) || idx < 0) return res.status(400).json({ error: 'item_index 가 유효하지 않습니다.' });

    const dec: any = await (prisma as any).purchaseDecision.findUnique({ where: { id: decId } });
    if (!dec || dec.deleted_at) return res.status(404).json({ error: '결의서를 찾을 수 없습니다.' });
    if (dec.status === 'LOCKED') return res.status(400).json({ error: '발주에 사용된 결의서는 변경할 수 없습니다.' });

    const items: any[] = (() => { try { return JSON.parse(dec.items_json ?? '[]'); } catch { return []; } })();
    if (idx >= items.length) return res.status(400).json({ error: 'index 범위 초과' });
    const line = items[idx];

    const excluded: any[] = (() => { try { return JSON.parse(dec.excluded_items_json ?? '[]'); } catch { return []; } })();
    const wrIds: string[] = (() => { try { return JSON.parse(dec.source_ward_request_ids ?? '[]'); } catch { return []; } })();

    // item_id 가 있을 때만 excluded 에 기록 (자유입력은 from-approved 추적 대상이 아니므로 그냥 제거)
    if (line.item_id) {
      excluded.push({
        item_id: line.item_id,
        item_code: line.item_code ?? '',
        name: line.name ?? '',
        spec: line.spec ?? '',
        qty: Number(line.qty ?? 0),
        source_wr_ids: wrIds,
        removed_at: new Date().toISOString(),
        reason: String(reason ?? '재고 있음'),
      });
    }
    items.splice(idx, 1);

    await (prisma as any).purchaseDecision.update({
      where: { id: decId },
      data: {
        items_json: JSON.stringify(items),
        excluded_items_json: JSON.stringify(excluded),
      },
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'EXCLUDE_LINE',
      entity_type: 'purchase_decisions',
      entity_id: decId,
      after: { item_id: line.item_id, item_name: line.name, reason: reason ?? '재고 있음' },
    });

    res.json({ ok: true, excluded_count: excluded.length, items_count: items.length });
  } catch (e: any) {
    console.error('[POST /purchase-decisions/:id/exclude-line] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// GET /api/purchase-decisions/:id — 단건 조회
// (/pending-vendor-items, /from-approved 같은 명시 경로보다 뒤에 둠 — :id 가 가로채지 않게)
router.get('/:id', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const d = await (prisma as any).purchaseDecision.findUnique({
      where: { id: req.params.id },
      include: INCLUDE,
    });
    if (!d || d.deleted_at) return res.status(404).json({ error: '결의서를 찾을 수 없습니다.' });
    res.json(format(d));
  } catch (e: any) { res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` }); }
});

// PATCH /api/purchase-decisions/:id/period-label — 주차 라벨만 수정 (LOCKED 상태에서도 허용)
router.patch('/:id/period-label', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.id);
    const raw = req.body?.period_label;
    const label = raw == null ? '' : String(raw).trim();

    const d = await (prisma as any).purchaseDecision.findUnique({ where: { id } });
    if (!d || d.deleted_at) return res.status(404).json({ error: '결의서를 찾을 수 없습니다.' });

    await (prisma as any).purchaseDecision.update({
      where: { id },
      data: { period_label: label },
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'PATCH',
      entity_type: 'purchase_decisions',
      entity_id: id,
      before: { period_label: d.period_label ?? '' },
      after: { period_label: label },
      reason: '회차 라벨 수동 지정',
    });

    res.json({ ok: true, period_label: label });
  } catch (e) {
    console.error('[PATCH /purchase-decisions/:id/period-label]', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// PUT /api/purchase-decisions/:id — 편집 (LOCKED 는 차단)
router.put('/:id', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const existing = await (prisma as any).purchaseDecision.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deleted_at) return res.status(404).json({ error: '결의서를 찾을 수 없습니다.' });
    if (existing.status === 'LOCKED') return res.status(400).json({ error: '발주에 사용된 결의서는 수정할 수 없습니다.' });

    const body = req.body ?? {};
    const updated = await (prisma as any).purchaseDecision.update({
      where: { id: req.params.id },
      data: {
        ...(body.title !== undefined && { title: String(body.title) }),
        ...(body.vendor_id !== undefined && { vendor_id: String(body.vendor_id) }),
        ...(body.doc_date !== undefined && { doc_date: body.doc_date ? new Date(body.doc_date) : null }),
        ...(body.period_label !== undefined && { period_label: String(body.period_label) }),
        ...(body.period_from !== undefined && { period_from: body.period_from ? new Date(body.period_from) : null }),
        ...(body.period_to !== undefined && { period_to: body.period_to ? new Date(body.period_to) : null }),
        ...(body.dept_label !== undefined && { dept_label: String(body.dept_label) }),
        ...(body.approver_lines !== undefined && { approver_lines: JSON.stringify(Array.isArray(body.approver_lines) ? body.approver_lines : []) }),
        ...(body.comment !== undefined && { comment: String(body.comment) }),
        ...(body.items !== undefined && { items_json: JSON.stringify(Array.isArray(body.items) ? body.items : []) }),
      },
      include: INCLUDE,
    });
    await audit({
      actor_user_id: req.user!.id,
      action: 'UPDATE',
      entity_type: 'purchase_decisions',
      entity_id: String(req.params.id),
    });
    res.json(format(updated));
  } catch (e: any) {
    console.error('[PUT /purchase-decisions/:id] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// POST /api/purchase-decisions/:id/revert-to-routing
// 서류작성(DRAFT) 결의서를 발주대기(라우팅 풀)로 되돌린다.
// 동작:
//   1) 이 결의서에 연결된 ACTIVE DECISION 라우팅을 RELEASED 로 전환
//   2) 결의서는 소프트 삭제 (서류작성 목록에서 숨김)
router.post('/:id/revert-to-routing', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.id);
    const reasonText = String(req.body?.reason ?? '').trim();
    if (!reasonText) return res.status(400).json({ error: '되돌리기 사유는 필수입니다.' });
    if (reasonText.length < 5) return res.status(400).json({ error: '되돌리기 사유는 5자 이상 입력해주세요.' });

    const decision: any = await (prisma as any).purchaseDecision.findUnique({ where: { id } });
    if (!decision || decision.deleted_at) return res.status(404).json({ error: '결의서를 찾을 수 없습니다.' });
    if (decision.status === 'LOCKED' || decision.used_in_po_id) {
      return res.status(400).json({ error: '발주에 사용된 결의서는 이 방식으로 되돌릴 수 없습니다. 기존 "되돌리기(발주 취소)"를 사용하세요.' });
    }

    const activeRoutings: any[] = await (prisma as any).orderRouting.findMany({
      where: { decision_id: id, route: 'DECISION', status: 'ACTIVE' },
      select: { id: true },
    });
    if (activeRoutings.length === 0) {
      return res.status(400).json({ error: '발주대기로 되돌릴 라우팅 항목이 없습니다. (수동 결의서이거나 이미 처리됨)' });
    }

    const routingIds = activeRoutings.map((r: any) => String(r.id));
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await (tx as any).orderRouting.updateMany({
        where: { id: { in: routingIds } },
        data: { status: 'RELEASED', released_at: now },
      });
      await (tx as any).purchaseDecision.update({
        where: { id },
        data: { deleted_at: now },
      });
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'REVERT_TO_ROUTING',
      entity_type: 'purchase_decisions',
      entity_id: id,
      before: { status: decision.status, deleted_at: decision.deleted_at ?? null },
      after: { status: decision.status, deleted_at: now.toISOString(), released_routing_count: routingIds.length },
      reason: reasonText,
    });

    res.json({
      ok: true,
      decision_no: decision.decision_no,
      released_routing_count: routingIds.length,
    });
  } catch (e: any) {
    console.error('[POST /purchase-decisions/:id/revert-to-routing] error:', e);
    res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// DELETE /api/purchase-decisions/:id (소프트 삭제)
router.delete('/:id', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const existing = await (prisma as any).purchaseDecision.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.deleted_at) return res.status(404).json({ error: '결의서를 찾을 수 없습니다.' });
    if (existing.status === 'LOCKED') return res.status(400).json({ error: '발주에 사용된 결의서는 삭제할 수 없습니다.' });

    await (prisma as any).purchaseDecision.update({
      where: { id: req.params.id },
      data: { deleted_at: new Date() },
    });
    await audit({
      actor_user_id: req.user!.id,
      action: 'DELETE',
      entity_type: 'purchase_decisions',
      entity_id: String(req.params.id),
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` }); }
});

// GET /api/purchase-decisions/:id/pdf — 인쇄용 PDF
router.get('/:id/pdf', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const d = await (prisma as any).purchaseDecision.findUnique({
      where: { id: req.params.id },
      include: INCLUDE,
    });
    if (!d || d.deleted_at) return res.status(404).json({ error: '결의서를 찾을 수 없습니다.' });

    const setting = await (prisma as any).appSetting.findUnique({ where: { key: 'HOSPITAL_NAME' } });
    const hospitalName = (setting?.value as string) ?? '병원';
    const fonts = getFonts();

    const items: any[] = (() => { try { return JSON.parse(d.items_json ?? '[]'); } catch { return []; } })();
    const approverLabels: string[] = (() => { try { return JSON.parse(d.approver_lines ?? '[]'); } catch { return []; } })();

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${d.decision_no}.pdf"`);
    doc.pipe(res);
    doc.registerFont('K', fonts.regular).registerFont('KB', fonts.bold);

    // ── 페이지 상수 ──
    const LX = 50;                    // 좌 여백
    const RX = 545;                   // 우 경계
    const TW = RX - LX;               // 본문 폭 = 495
    const PAGE_BOTTOM = 800;          // 본문 하단 한도

    // ── 결재란 (우측 상단) ──
    const labels = approverLabels.length > 0 ? approverLabels : ['담당', '부서장', '행정원장', '상임이사', '이사장'];
    const bW = 53, bH = 58, bStartY = 50;
    const bStartX = RX - labels.length * bW;
    labels.forEach((label, i) => {
      const x = bStartX + i * bW;
      doc.rect(x, bStartY, bW, bH).stroke('#888');
      doc.moveTo(x, bStartY + 20).lineTo(x + bW, bStartY + 20).stroke('#999');
      doc.font('KB').fontSize(9).fillColor('#000').text(label, x, bStartY + 5, { width: bW, align: 'center', lineBreak: false });
    });

    // ── 제목 ──
    let y = bStartY + bH + 14;
    doc.font('KB').fontSize(22).fillColor('#000')
      .text('구  매  결  의  서', LX, y, { width: TW, align: 'center', lineBreak: false });
    y += 30;
    doc.font('K').fontSize(9).fillColor('#666').text(`결의서번호: ${d.decision_no}`, LX, y, { width: TW, align: 'center', lineBreak: false });
    y += 18;

    // ── 메타 표 (편집 화면과 동일한 형식) ──
    const docDate = d.doc_date ? new Date(d.doc_date) : new Date();
    const dateStr = `${docDate.getFullYear()}년 ${String(docDate.getMonth() + 1).padStart(2, '0')}월 ${String(docDate.getDate()).padStart(2, '0')}일`;
    const periodFrom = d.period_from ? new Date(d.period_from) : null;
    const periodTo = d.period_to ? new Date(d.period_to) : null;
    const fmtPeriodDate = (dt: Date) => `${dt.getFullYear()}.${String(dt.getMonth() + 1).padStart(2, '0')}.${String(dt.getDate()).padStart(2, '0')}`;
    const periodStr = periodFrom && periodTo ? `${fmtPeriodDate(periodFrom)} ~ ${fmtPeriodDate(periodTo)}` : '-';

    // 메타 행 헬퍼: [라벨1, 값1, 라벨2?, 값2?] — 한 줄에 1쌍 또는 2쌍
    const metaLabelW1 = 70;           // 1열 라벨
    const metaLabelW2 = 70;           // 2열 라벨
    const metaH = 22;                 // 메타 행 높이
    function drawMetaRow(rowY: number, label1: string, value1: string, label2?: string, value2?: string): number {
      // 외곽
      doc.lineWidth(0.5).rect(LX, rowY, TW, metaH).stroke('#000');
      // 라벨1 셀 (회색 배경)
      doc.rect(LX, rowY, metaLabelW1, metaH).fillAndStroke('#f1f5f9', '#000');
      doc.font('KB').fontSize(9).fillColor('#000')
        .text(label1, LX + 4, rowY + (metaH - 9) / 2, { width: metaLabelW1 - 8, align: 'center', lineBreak: false, baseline: 'top' });
      if (label2 !== undefined) {
        // 두 쌍 — 가운데 분리선 + 라벨2 셀
        const half = TW / 2;
        const v1Right = LX + half;
        // 라벨2 위치: 우측 절반의 시작
        doc.lineWidth(0.5).moveTo(v1Right, rowY).lineTo(v1Right, rowY + metaH).stroke('#000');
        doc.rect(v1Right, rowY, metaLabelW2, metaH).fillAndStroke('#f1f5f9', '#000');
        doc.font('KB').fontSize(9).fillColor('#000')
          .text(label2, v1Right + 4, rowY + (metaH - 9) / 2, { width: metaLabelW2 - 8, align: 'center', lineBreak: false, baseline: 'top' });
        // 값1
        doc.font('K').fontSize(9).fillColor('#000')
          .text(value1, LX + metaLabelW1 + 6, rowY + (metaH - 9) / 2, { width: half - metaLabelW1 - 12, align: 'left', lineBreak: false, baseline: 'top' });
        // 값2
        doc.font('K').fontSize(9).fillColor('#000')
          .text(value2 ?? '', v1Right + metaLabelW2 + 6, rowY + (metaH - 9) / 2, { width: half - metaLabelW2 - 12, align: 'left', lineBreak: false, baseline: 'top' });
      } else {
        // 한 쌍 전체 폭
        doc.font('K').fontSize(9).fillColor('#000')
          .text(value1, LX + metaLabelW1 + 6, rowY + (metaH - 9) / 2, { width: TW - metaLabelW1 - 12, align: 'left', lineBreak: false, baseline: 'top' });
      }
      return rowY + metaH;
    }

    y = drawMetaRow(y, '제목', d.title || '');
    y = drawMetaRow(y, '거래처', d.vendor?.name ?? '', '청구부서', d.dept_label ?? '');
    y = drawMetaRow(y, '작성일자', dateStr, '회차', d.period_label ?? '');
    y = drawMetaRow(y, '사용기간', periodStr);
    y += 8;

    // ── 품목 표 (편집 화면과 동일한 컬럼 비율) ──
    // 편집 비율: NO 36 / 품명 가변 / 규격 110 / 수량 70 / 단가 100 / 금액 110 / 비고 130
    // PDF 폭 495 에 맞춰 비율 적용. NO 26 / 품명 132 / 규격 70 / 수량 50 / 단가 75 / 금액 90 / 비고 52
    const cols = [26, 132, 70, 50, 75, 90, 52];
    const headers = ['NO', '품 명', '규 격', '수 량', '단 가', '금 액', '비 고'];
    const totalW = cols.reduce((a, b) => a + b, 0);

    function drawRow(cells: string[], rowY: number, isHeader: boolean): number {
      let rowH = isHeader ? 22 : 19;
      if (!isHeader) {
        const bigo = cells[6] ?? '';
        const lines = bigo.split('\n').length;
        if (lines > 1) rowH = Math.max(rowH, lines * 11 + 6);
      }
      // 헤더 배경
      if (isHeader) doc.rect(LX, rowY, totalW, rowH).fillAndStroke('#e8edf5', '#000');
      let x = LX;
      for (let i = 0; i < cols.length; i++) {
        doc.lineWidth(0.5);
        // 우측 셀 분리선 (마지막 컬럼은 외곽)
        if (i < cols.length - 1) {
          doc.moveTo(x + cols[i], rowY).lineTo(x + cols[i], rowY + rowH).stroke('#000');
        }
        const fs = isHeader ? 10 : 9;
        const align: 'left' | 'center' | 'right' =
          isHeader ? 'center'
          : i === 1 ? 'left'   // 품명 좌측
          : (i === 4 || i === 5) ? 'right'  // 단가/금액 우측
          : 'center';
        const padL = align === 'left' ? 6 : 4, padR = align === 'right' ? 6 : 4;
        const allowWrap = !isHeader && (i === 1 || i === 6);
        doc.font(isHeader ? 'KB' : 'K').fontSize(fs).fillColor('#000')
          .text(cells[i] ?? '', x + padL, rowY + (rowH - fs) / 2, {
            width: cols[i] - padL - padR,
            align,
            lineBreak: allowWrap,
            baseline: 'top',
          });
        x += cols[i];
      }
      // 외곽 (얇음)
      doc.lineWidth(0.7).rect(LX, rowY, totalW, rowH).stroke('#000');
      return rowY + rowH;
    }

    y = drawRow(headers, y, true);
    let total = 0;
    const TABLE_BOTTOM_RESERVE = 60; // 합계금액 + 하단 여백
    for (let idx = 0; idx < items.length; idx++) {
      if (y + 19 + (idx === items.length - 1 ? TABLE_BOTTOM_RESERVE : 0) > PAGE_BOTTOM) {
        doc.addPage();
        y = 50;
        y = drawRow(headers, y, true);
      }
      const it = items[idx];
      const qty = Number(it.qty ?? 0);
      const price = Number(it.unit_price ?? 0);
      const amt = qty * price;
      total += amt;
      y = drawRow([
        String(idx + 1),
        String(it.name ?? ''),
        String(it.spec ?? ''),
        qty.toLocaleString('ko-KR'),
        price.toLocaleString('ko-KR'),
        amt.toLocaleString('ko-KR'),
        String(it.comment ?? ''),
      ], y, false);
    }

    // ── 합계금액 행 ──
    const sH = 24;
    if (y + sH + 30 > PAGE_BOTTOM) { doc.addPage(); y = 50; }
    const labelW = cols[0] + cols[1] + cols[2] + cols[3] + cols[4];
    const amountW = cols[5] + cols[6];
    // 강조: 두꺼운 테두리 + 옅은 배경
    doc.rect(LX, y, totalW, sH).fillAndStroke('#f1f5f9', '#000');
    doc.lineWidth(0.5).moveTo(LX + labelW, y).lineTo(LX + labelW, y + sH).stroke('#000');
    const totalFs = 11;
    const totalY = y + (sH - totalFs) / 2;
    doc.font('KB').fontSize(totalFs).fillColor('#000')
      .text('합  계  금  액', LX, totalY, { width: labelW, align: 'center', lineBreak: false, baseline: 'top' });
    doc.font('KB').fontSize(totalFs).fillColor('#000')
      .text(total.toLocaleString('ko-KR'), LX + labelW, totalY, { width: amountW - 8, align: 'right', lineBreak: false, baseline: 'top' });
    doc.lineWidth(1).rect(LX, y, totalW, sH).stroke('#000'); // 외곽 한 번 더 (살짝 굵게)
    y += sH + 12;

    // 비고
    if (d.comment) {
      doc.font('K').fontSize(9).fillColor('#000').text(`비  고:  ${d.comment}`, 50, y, { width: 495, lineBreak: false });
      y += 18;
    }

    // 병원명 (우하단)
    y += 16;
    const LOGO_PATH = path.join(process.env.FONTS_DIR || path.join(__dirname, '..', '..', '..', 'fonts'), 'logo.png');
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, 545 - 150, y, { width: 150 });
    } else {
      doc.font('KB').fontSize(11).fillColor('#000').text(hospitalName, 50, y, { width: 495, align: 'right', lineBreak: false });
    }

    doc.end();
  } catch (e: any) {
    console.error('[GET /purchase-decisions/:id/pdf] error:', e);
    if (!res.headersSent) res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

// GET /api/purchase-decisions/:id/excel — 사내 양식 그대로 .xlsx 다운로드
//
// 양식 파일: 구매결의서양식/구매결의서 양식.xlsx
//   - 시트1 "표지": A7=회차, A10=사용기간, A28=담당자
//   - 시트2 (날짜): A1=`(업체)구매 결의서`, C6=청구부서, A7=병원명
//                   품목 슬롯: 10~46행(NO 1~37) + 57~78행(NO 38~59) = 59칸
//                   합계 행: 79~82 (SUM 수식 포함)
// 슬롯 59개 초과 시: 78행을 N번 복제해 78~78+N 영역으로 확장하고 SUM 범위 갱신.
router.get('/:id/excel', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const d = await (prisma as any).purchaseDecision.findUnique({
      where: { id: req.params.id },
      include: INCLUDE,
    });
    if (!d || d.deleted_at) return res.status(404).json({ error: '결의서를 찾을 수 없습니다.' });

    let items: any[] = (() => { try { return JSON.parse(d.items_json ?? '[]'); } catch { return []; } })();

    const tplPath = path.resolve(__dirname, '..', '..', '..', '구매결의서양식', '구매결의서 양식.xlsx');
    if (!fs.existsSync(tplPath)) {
      return res.status(500).json({ error: `엑셀 양식 파일을 찾을 수 없습니다: ${tplPath}` });
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(tplPath);

    const coverSheet = wb.worksheets[0];           // "구매결의서표지"
    const itemSheet = wb.worksheets[1];            // 품목 시트 (날짜명)
    if (!itemSheet) return res.status(500).json({ error: '템플릿에 품목 시트가 없습니다.' });

    // 시트2 이름을 작성일자로 변경 (양식 관행)
    const docDate = d.doc_date ? new Date(d.doc_date) : new Date();
    const sheetName = `${docDate.getFullYear()}.${String(docDate.getMonth() + 1).padStart(2, '0')}.${String(docDate.getDate()).padStart(2, '0')}`;
    try { itemSheet.name = sheetName; } catch { /* 중복명일 수 있음 — 무시 */ }

    // 페이지 레이아웃 — 인쇄 시 9행(표 헤더) 을 모든 페이지 상단에 반복
    if (!itemSheet.pageSetup) (itemSheet as any).pageSetup = {};
    (itemSheet.pageSetup as any).printTitlesRow = '9:9';

    // ── 메타 갱신 ──
    const vendorName = d.vendor?.name ?? '업체';
    itemSheet.getCell('A1').value = `${vendorName} 구매 결의서`;

    // 작성일자(A4) / 납품일자(H7) — 셀의 사용자 정의 표시형식(yyyy"년" mm"월" dd"일")을 보존하려면 Date 객체로 설정
    // 작성일자(A4) / 납품일자(H7) — 한글 "yyyy년 mm월 dd일" 형식 강제
    const KOREAN_DATE_FMT = 'yyyy"년" mm"월" dd"일"';
    itemSheet.getCell('A4').value = docDate;
    itemSheet.getCell('A4').numFmt = KOREAN_DATE_FMT;
    const deliveryDate = new Date(docDate);
    deliveryDate.setDate(deliveryDate.getDate() + 2);
    itemSheet.getCell('H7').value = deliveryDate;
    itemSheet.getCell('H7').numFmt = KOREAN_DATE_FMT;

    // 청구부서 — 양식 관행상 항상 "총 무 부" (auto-prefill 의 ward 라벨이 들어오면 양식이 깨짐)
    // 사용자가 결의서 편집에서 다른 값을 명시했고, 콤마(,)가 없는 단일 부서명이면 그 값을 사용
    const cleanDept = (d.dept_label && !d.dept_label.includes(',') && d.dept_label.trim().length > 0)
      ? d.dept_label.trim()
      : '총 무 부';
    itemSheet.getCell('C6').value = cleanDept;

    // 표지: 회차/사용기간
    if (coverSheet) {
      if (d.period_label) coverSheet.getCell('A7').value = d.period_label;
      if (d.period_from && d.period_to) {
        const fromDate = new Date(d.period_from);
        const toDate = new Date(d.period_to);
        const fmt = (dt: Date) =>
          `${String(dt.getMonth() + 1).padStart(2, '0')}월 ${String(dt.getDate()).padStart(2, '0')}일`;
        coverSheet.getCell('A10').value = `(물품사용기간:  ${fmt(fromDate)} ~ ${fmt(toDate)})`;
      }
    }

    // ── 품목 영역 — 클린 재구축 ──
    //
    // 양식의 페이지 분할 구조(10~46 + 57~78 = 59칸 + 47~56 빈칸) 를 무시하고 row 10부터 연속 채움.
    // 이유: insertRows / duplicateRow 가 신규 행의 병합/스타일을 일관성 없이 처리해서
    //       어떤 행은 정렬이 어긋남. 대신 양식의 row 10 / row 79~82 스타일을 스냅샷
    //       떠놓고 새 행에 명시 복제하는 결정적 방식.
    // 레퍼런스 (D:\재고관리\2. 구매결의서\1. 유한메디칼 구매결의서(의료소모품).xlsx) 도
    // 동일하게 row 10 부터 연속 + 합계 4행이 항목 끝 바로 다음에 위치.

    const ITEM_START = 10;          // 첫 품목 행
    const TPL_TOTALS_START = 79;    // 양식 합계 시작 행 (스냅샷 출처)

    // 1. 스타일 스냅샷 — 클론으로 이후 변경에 영향받지 않게
    const cloneStyle = (s: any) => JSON.parse(JSON.stringify(s ?? {}));
    function snapshotRow(rowNum: number) {
      const profile: any[] = [];
      for (let c = 1; c <= 10; c++) {
        const cell = itemSheet.getCell(rowNum, c);
        profile[c] = { style: cloneStyle(cell.style), numFmt: cell.numFmt };
      }
      return profile;
    }
    function applyRowProfile(rowNum: number, profile: any) {
      for (let c = 1; c <= 10; c++) {
        const cell = itemSheet.getCell(rowNum, c);
        if (profile[c]) {
          cell.style = cloneStyle(profile[c].style);
          if (profile[c].numFmt) cell.numFmt = profile[c].numFmt;
        }
      }
    }

    const itemRowProfile = snapshotRow(ITEM_START);             // row 10 = 품목 스타일 원본
    const totalsProfile  = snapshotRow(TPL_TOTALS_START);       // row 79
    const blankProfile   = snapshotRow(TPL_TOTALS_START + 1);   // row 80 (빈 줄)
    const subtotalProfile = snapshotRow(TPL_TOTALS_START + 2);  // row 81 (합계)
    const grandTotalProfile = snapshotRow(TPL_TOTALS_START + 3); // row 82 (합계금액)

    // 2. row 10~82 의 모든 병합 풀고 값 초기화
    const allMerges: string[] = (((itemSheet as any).model?.merges as string[] | undefined) ?? []).slice();
    for (const range of allMerges) {
      const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if (!m) continue;
      const startR = parseInt(m[2], 10);
      const endR = parseInt(m[4], 10);
      if (startR >= ITEM_START && endR <= TPL_TOTALS_START + 3) {
        try { itemSheet.unMergeCells(range); } catch { /* 이미 풀린 상태 */ }
      }
    }
    for (let r = ITEM_START; r <= TPL_TOTALS_START + 3; r++) {
      for (let c = 1; c <= 10; c++) {
        try { itemSheet.getCell(r, c).value = null; } catch {}
      }
    }

    // 3. 정렬 명시 (레퍼런스 파일 기반)
    //    - 수량(D:E) / 단가(F:G): center, vertical:middle, shrinkToFit
    //    - 금액(H:I): right, vertical:middle, shrinkToFit
    //    - 품명(B) / 규격(C): center, vertical:middle, shrinkToFit
    //    - NO(A) / 비고(J): center, vertical:middle, wrapText
    function setItemAlignment(rowNum: number) {
      const a = (h: any, opts: any) => { itemSheet.getCell(rowNum, h).alignment = { vertical: 'middle', ...opts }; };
      a(1, { horizontal: 'center', wrapText: true });
      a(2, { horizontal: 'center', shrinkToFit: true });
      a(3, { horizontal: 'center', shrinkToFit: true });
      a(4, { horizontal: 'center', shrinkToFit: true });
      a(5, { horizontal: 'center', shrinkToFit: true });
      a(6, { horizontal: 'center', shrinkToFit: true });
      a(7, { horizontal: 'center', shrinkToFit: true });
      a(8, { horizontal: 'right', shrinkToFit: true });
      a(9, { horizontal: 'right', shrinkToFit: true });
      a(10, { horizontal: 'center', wrapText: true });
    }

    // 4. 품목 쓰기 — row 10 부터 연속.
    // 빈 라인(품명/규격/수량/단가 모두 비어있음) 제거 — SheetEditor 의 trailing empty 가 끼어들면 빈 행 그려짐
    items = items.filter((it: any) =>
      String(it.name ?? '').trim() ||
      String(it.spec ?? '').trim() ||
      Number(it.qty ?? 0) > 0 ||
      Number(it.unit_price ?? 0) > 0,
    );
    items.forEach((it, idx) => {
      const r = ITEM_START + idx;
      applyRowProfile(r, itemRowProfile);
      // 양식 row 10 의 fill (수량·금액 칸 노란색 배경 등) 잔존 제거 — 본문은 흰색 고정
      for (let c = 1; c <= 10; c++) {
        const cell = itemSheet.getCell(r, c);
        cell.fill = { type: 'pattern', pattern: 'none' } as any;
      }
      setItemAlignment(r);
      try { itemSheet.mergeCells(r, 4, r, 5); } catch {} // D:E
      try { itemSheet.mergeCells(r, 6, r, 7); } catch {} // F:G
      try { itemSheet.mergeCells(r, 8, r, 9); } catch {} // H:I
      const qty = Number(it.qty ?? 0);
      const price = Number(it.unit_price ?? 0);
      itemSheet.getCell(r, 1).value = idx + 1;
      itemSheet.getCell(r, 2).value = it.name ?? '';
      itemSheet.getCell(r, 3).value = it.spec ?? '';
      itemSheet.getCell(r, 4).value = qty || null;
      itemSheet.getCell(r, 6).value = price || null;
      if (qty && price) {
        itemSheet.getCell(r, 8).value = { formula: `F${r}*D${r}`, result: qty * price } as any;
      }
      itemSheet.getCell(r, 10).value = it.comment ?? '';
    });

    // 5. 합계 영역 — 품목 끝 다음부터
    //   prevSummary (선택): 같은 거래처의 직전 LOCKED 결의서 — 노란색으로 비교 참조
    //   summary: 이번 결의서 = 흰색 강조 = 결재 대상
    //   blank / 합계 / 합계금액: 이번 주 기준
    const lastItemRow = items.length > 0 ? (ITEM_START + items.length - 1) : (ITEM_START - 1);

    // 같은 거래처의 직전 LOCKED 결의서 (= 지난 주 결재된 것) 조회 — 비교용
    const prevDecision: any = await (prisma as any).purchaseDecision.findFirst({
      where: {
        vendor_id: d.vendor_id,
        status: 'LOCKED',
        deleted_at: null,
        id: { not: d.id },
        doc_date: { lt: d.doc_date },
      },
      orderBy: { doc_date: 'desc' },
    });
    const prevItems: any[] = prevDecision
      ? (() => { try { return JSON.parse(prevDecision.items_json ?? '[]'); } catch { return []; } })()
      : [];
    const prevTotal = prevItems.reduce(
      (s: number, it: any) => s + Number(it.qty ?? 0) * Number(it.unit_price ?? 0),
      0,
    );

    let curRow = lastItemRow + 1;
    const prevSummaryRow: number | null = prevDecision ? curRow++ : null;
    const summaryRow    = curRow++;       // 이번 주 — 흰색 (결재 대상)
    const blankRow      = curRow++;
    const subtotalRow   = curRow++;       // 합계 (이번 주만)
    const grandTotalRow = curRow++;       // 합계 금액 (이번 주만)

    // 5-0. 직전 결의서 비교 행 (노란색 참조)
    if (prevSummaryRow !== null && prevDecision) {
      applyRowProfile(prevSummaryRow, totalsProfile);  // 노란 fill 그대로 — 참조 표시
      try { itemSheet.mergeCells(prevSummaryRow, 3, prevSummaryRow, 7); } catch {}
      try { itemSheet.mergeCells(prevSummaryRow, 8, prevSummaryRow, 9); } catch {}
      itemSheet.getCell(prevSummaryRow, 2).value = prevDecision.period_label || '직전';
      itemSheet.getCell(prevSummaryRow, 2).alignment = { horizontal: 'center', vertical: 'middle', shrinkToFit: true };
      const prevFirstName = prevItems[0]?.name ?? '';
      const prevLabel = prevItems.length === 0 ? '(품목 없음)'
        : prevItems.length === 1 ? prevFirstName
        : `${prevFirstName} 외 ${prevItems.length - 1}개 물품`;
      itemSheet.getCell(prevSummaryRow, 3).value = prevLabel;
      itemSheet.getCell(prevSummaryRow, 3).alignment = { horizontal: 'center', vertical: 'middle', shrinkToFit: true };
      itemSheet.getCell(prevSummaryRow, 8).value = Math.round(prevTotal);
      itemSheet.getCell(prevSummaryRow, 8).alignment = { horizontal: 'center', vertical: 'middle', shrinkToFit: true };
    }

    // 5-1. 이번 주 summary — 흰색으로 강조 (결재 대상 색 의미론)
    applyRowProfile(summaryRow, totalsProfile);
    // 이번 주 행은 노란색 제거 → 흰색 (지난 주 노랑 / 이번 주 흰색 대비)
    for (let c = 1; c <= 10; c++) {
      itemSheet.getCell(summaryRow, c).fill = { type: 'pattern', pattern: 'none' } as any;
    }
    try { itemSheet.mergeCells(summaryRow, 3, summaryRow, 7); } catch {} // C:G
    try { itemSheet.mergeCells(summaryRow, 8, summaryRow, 9); } catch {} // H:I
    itemSheet.getCell(summaryRow, 2).value = d.period_label || '';
    itemSheet.getCell(summaryRow, 2).alignment = { horizontal: 'center', vertical: 'middle', shrinkToFit: true };
    if (items.length > 0) {
      const firstName = items[0].name ?? '';
      const summaryLabel = items.length === 1 ? firstName : `${firstName} 외 ${items.length - 1}개 물품`;
      itemSheet.getCell(summaryRow, 3).value = summaryLabel;
      itemSheet.getCell(summaryRow, 3).alignment = { horizontal: 'center', vertical: 'middle', shrinkToFit: true };
      itemSheet.getCell(summaryRow, 8).value = { formula: `SUM(H${ITEM_START}:I${lastItemRow})` } as any;
      itemSheet.getCell(summaryRow, 8).alignment = { horizontal: 'center', vertical: 'middle', shrinkToFit: true };
    }

    // 5-2. blank
    applyRowProfile(blankRow, blankProfile);

    // 5-3. 합계
    applyRowProfile(subtotalRow, subtotalProfile);
    try { itemSheet.mergeCells(subtotalRow, 8, subtotalRow, 9); } catch {}
    itemSheet.getCell(subtotalRow, 2).value = '합계';
    itemSheet.getCell(subtotalRow, 2).alignment = { horizontal: 'center', vertical: 'middle' };
    itemSheet.getCell(subtotalRow, 8).value = { formula: `SUM(H${summaryRow}:I${blankRow})` } as any;
    itemSheet.getCell(subtotalRow, 8).alignment = { horizontal: 'center', vertical: 'middle', shrinkToFit: true };

    // 5-4. 합계 금액
    applyRowProfile(grandTotalRow, grandTotalProfile);
    try { itemSheet.mergeCells(grandTotalRow, 1, grandTotalRow, 4); } catch {} // A:D
    try { itemSheet.mergeCells(grandTotalRow, 8, grandTotalRow, 10); } catch {} // H:J
    itemSheet.getCell(grandTotalRow, 1).value = '합  계  금  액  :';
    itemSheet.getCell(grandTotalRow, 1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    // G27 ₩ 제거 — H:J 의 회계 numFmt 가 자동으로 ₩ 붙임 (이전엔 G + H 가 같이 ₩ 표시되어 중복)
    itemSheet.getCell(grandTotalRow, 7).value = null;
    itemSheet.getCell(grandTotalRow, 8).value = { formula: `SUM(H${summaryRow}:I${blankRow})` } as any;
    itemSheet.getCell(grandTotalRow, 8).alignment = { horizontal: 'right', vertical: 'middle' };

    // ── 우측 테두리 보정 (합계 영역 — 굵게) ──
    // 합계 행들의 금액 셀(병합) 우측은 굵은 medium 테두리로 강조 — 양식 관행
    function ensureRightBorder(rowNum: number, col: number, style: 'thin' | 'medium' | 'thick' = 'medium') {
      const cell = itemSheet.getCell(rowNum, col);
      cell.border = {
        ...(cell.border ?? {}),
        right: { style, color: { argb: 'FF000000' } },
      };
    }
    if (prevSummaryRow !== null) ensureRightBorder(prevSummaryRow, 9, 'medium'); // 지난주 비교 행도 같이
    ensureRightBorder(summaryRow, 9, 'medium');     // I (H:I 병합 우측)
    ensureRightBorder(subtotalRow, 9, 'medium');
    ensureRightBorder(grandTotalRow, 10, 'medium'); // J (H:J 병합 우측)

    // ── 합계금액 행 다음의 미사용 행 통째로 제거 ──
    // 양식이 82행까지 격자/노란 fill 이 있어서 결의서가 짧으면 본문 아래에 잔존.
    // cell.style = {} 로 부분 클리어하면 ExcelJS 가 styles.xml 에 빈 엔트리를 남겨
    // Excel 이 "내용에 문제가 있습니다 → 복구" 경고 띄움.
    // → spliceRows 로 행 자체를 제거하면 스타일 흔적이 깨끗하게 사라짐.
    const totalRowsInSheet = itemSheet.rowCount;
    if (totalRowsInSheet > grandTotalRow) {
      itemSheet.spliceRows(grandTotalRow + 1, totalRowsInSheet - grandTotalRow);
    }

    const safeName = String(d.decision_no || `decision_${d.id}`).replace(/[\\/:*?"<>|]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e: any) {
    console.error('[GET /purchase-decisions/:id/excel] error:', e);
    if (!res.headersSent) res.status(500).json({ error: `서버 오류: ${e?.message ?? e}` });
  }
});

export default router;
