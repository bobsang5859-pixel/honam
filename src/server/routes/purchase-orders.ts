import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, resolveDeptScope, isCustomMenuUser, AuthRequest } from '../middleware/auth';
import { audit, generateNo, nextSeq } from '../utils/audit';
import { getFonts } from '../services/pdf';

const LOGO_PATH = path.join(__dirname, '..', '..', '..', 'assets', 'logo.png');
const HOSPITAL_PHONE = '062-717-6018 / 010-9259-5859';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('purchase-orders', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'));
const SCHEDULED_REQUEST_TYPES = new Set(['CONSUMABLE_REGULAR', 'DIAPER', 'NIGHT_SNACK']);
const PO_ACTIVE_STATUSES = ['SENT', 'PARTIAL_RECEIVED'] as const;
const PO_COMPLETED_STATUSES = ['CLOSED', 'CANCELLED'] as const;

function isScopedToSelfDepartment(req: AuthRequest): boolean {
  return isCustomMenuUser(req.user) && !resolveDeptScope(req).is_admin;
}

type ScheduleLite = {
  request_type: string;
  open_from: Date;
  open_to: Date;
  period_label: string;
};

// Source type detection:
// 1) Prefer explicit ward-request linkage (sources)
// 2) Fallback to note prefix for backward compatibility
function inferSourceType(note: string, sourceTypes?: string[]): string {
  if (Array.isArray(sourceTypes) && sourceTypes.length > 0) {
    const unique = Array.from(new Set(sourceTypes.filter(Boolean)));
    if (unique.length === 1) return unique[0];
  }
  if (note.includes('[AUTO]')) {
    if (note.includes('기저귀') || note.toUpperCase().includes('DIAPER')) return 'DIAPER';
    if (note.includes('야간당직') || note.toUpperCase().includes('NIGHT_SNACK')) return 'NIGHT_SNACK';
    if (note.includes('비정기') || note.toUpperCase().includes('ADHOC')) return 'ADHOC';
    return 'CONSUMABLE_REGULAR';
  }
  return 'MANUAL';
}

function formatMonthLabel(dateLike: Date | string | null | undefined): string {
  const d = dateLike ? new Date(dateLike) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function normalizeDate(value: Date | string | null | undefined): Date | null {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d;
}

function computeSchedulePeriodMeta(
  po: any,
  schedulesByType: Map<string, ScheduleLite[]>
): {
  schedule_period_label?: string;
  schedule_period_start?: string;
  schedule_period_matched: boolean;
  has_mixed_period_labels?: boolean;
} {
  const candidates: { label: string; start: Date; matched: boolean }[] = [];
  for (const src of po.sources ?? []) {
    const wrType = src?.ward_request?.request_type ? String(src.ward_request.request_type) : '';
    const periodStart = normalizeDate(src?.ward_request?.period_start);
    const orderedAt = normalizeDate(po?.ordered_at);
    if (!wrType && !periodStart) continue;

    let label = '';
    let matched = false;
    if (wrType && periodStart && SCHEDULED_REQUEST_TYPES.has(wrType)) {
      const schedules = schedulesByType.get(wrType) ?? [];
      const matchedSchedule = schedules.find((s) => s.open_from <= periodStart && periodStart <= s.open_to);
      if (matchedSchedule) {
        label = matchedSchedule.period_label || formatMonthLabel(periodStart);
        matched = true;
      }
    }
    if (!label) {
      label = periodStart ? formatMonthLabel(periodStart) : formatMonthLabel(orderedAt);
    }
    const start = periodStart ?? orderedAt;
    if (!label || !start) continue;
    candidates.push({ label, start, matched });
  }

  if (candidates.length === 0) {
    const fallbackStart = normalizeDate(po?.ordered_at);
    return {
      schedule_period_label: formatMonthLabel(fallbackStart),
      schedule_period_start: fallbackStart ? fallbackStart.toISOString() : undefined,
      schedule_period_matched: false,
      has_mixed_period_labels: false,
    };
  }

  candidates.sort((a, b) => a.start.getTime() - b.start.getTime());
  const labels = new Set(candidates.map((c) => c.label));
  const representative = candidates[0];

  return {
    schedule_period_label: representative.label,
    schedule_period_start: representative.start.toISOString(),
    schedule_period_matched: representative.matched,
    has_mixed_period_labels: labels.size > 1,
  };
}

router.get('/', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req, res) => {
  try {
    const { status, source_type, status_scope } = req.query;
    const statusVal = status ? String(status) : '';
    const statusScope = String(status_scope ?? 'ALL').toUpperCase();
    const statusWhere =
      statusVal && statusVal !== 'ALL'
        ? { status: statusVal }
        : statusScope === 'ACTIVE'
          ? { status: { in: [...PO_ACTIVE_STATUSES] } }
          : statusScope === 'COMPLETED'
            ? { status: { in: [...PO_COMPLETED_STATUSES] } }
            : statusScope === 'DRAFT'
              ? { status: 'DRAFT' }
              : {};
    const deptScope = resolveDeptScope(req as AuthRequest);
    const scopedDeptId = isScopedToSelfDepartment(req as AuthRequest) ? (deptScope.department_id ?? '') : '';
    const pos = await prisma.purchaseOrder.findMany({
      where: {
        deleted_at: null,
        ...statusWhere,
        ...(scopedDeptId ? { sources: { some: { ward_request: { department_id: scopedDeptId } } } } : {}),
      },
      include: {
        vendor: true,
        creator: true,
        po_items: { include: { item: true } },
        sources: { include: { ward_request: { select: { request_type: true, period_start: true } } } } as any,
      },
      orderBy: { ordered_at: 'desc' },
    });
    const neededTypes = Array.from(
      new Set(
        pos
          .flatMap((po: any) => (po.sources ?? []).map((s: any) => s?.ward_request?.request_type))
          .filter((t: any) => typeof t === 'string' && SCHEDULED_REQUEST_TYPES.has(t))
      )
    );
    const schedules =
      neededTypes.length > 0
        ? await prisma.requestSchedule.findMany({
            where: { request_type: { in: neededTypes as string[] } },
            orderBy: { open_from: 'asc' },
          })
        : [];
    const schedulesByType = new Map<string, ScheduleLite[]>();
    for (const s of schedules) {
      if (!schedulesByType.has(s.request_type)) schedulesByType.set(s.request_type, []);
      schedulesByType.get(s.request_type)!.push({
        request_type: s.request_type,
        open_from: s.open_from,
        open_to: s.open_to,
        period_label: s.period_label,
      });
    }

    const mapped = pos.map((po: any) => ({
      id: po.id,
      po_no: po.po_no,
      vendor_id: po.vendor_id,
      vendor_name: po.vendor?.name,
      creator_name: po.creator?.display_name,
      status: po.status,
      ordered_at: po.ordered_at,
      expected_at: po.expected_at,
      total_amount: Number(po.total_amount),
      note: po.note,
      item_count: po.po_items.length,
      source_type: inferSourceType(
        po.note ?? '',
        (po.sources ?? []).map((s: any) => s.ward_request?.request_type).filter(Boolean)
      ),
      ...computeSchedulePeriodMeta(po, schedulesByType),
    }));

    const filtered = source_type
      ? mapped.filter((po: any) => po.source_type === String(source_type))
      : mapped;

    res.json(filtered);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req, res) => {
  try {
    const poId = String(req.params.id);
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: {
        vendor: true,
        creator: true,
        po_items: { include: { item: { include: { default_vendor: true } } } },
        sources: {
          include: {
            ward_request: {
              include: {
                department: true,
                items: { include: { item: true } },
              },
            },
          },
        } as any,
      },
    });
    if (!po) return res.status(404).json({ error: 'Purchase order not found.' });
    if (isScopedToSelfDepartment(req as AuthRequest)) {
      const scopedDeptId = String((req as AuthRequest).user?.department_id ?? '');
      const canRead = ((po as any).sources ?? []).some(
        (src: any) => String(src?.ward_request?.department_id ?? '') === scopedDeptId
      );
      if (!canRead) return res.status(403).json({ error: '다른 부서의 발주서는 조회할 수 없습니다.' });
    }

    const mappedItems = (po as any).po_items.map((it: any) => ({
      id: it.id,
      item_id: it.item_id,
      item_code: it.item?.item_code,
      item_name: it.item?.name,
      uom: it.item?.uom,
      ordered_qty: Number(it.ordered_qty),
      unit_price: Number(it.unit_price),
      line_amount: Number(it.line_amount),
    }));

    const sources = ((po as any).sources ?? []).map((src: any) => ({
      ward_request_id: src.ward_request_id,
      request_no: src.ward_request?.request_no,
      department_id: src.ward_request?.department_id,
      department_name: src.ward_request?.department?.name,
      request_type: src.ward_request?.request_type,
      items: (src.ward_request?.items ?? []).map((it: any) => ({
        item_id: it.item_id,
        item_name: it.item?.name,
        requested_qty: Number(it.requested_qty),
      })),
    }));
    const detailNeededTypes = Array.from(
      new Set(
        ((po as any).sources ?? [])
          .map((s: any) => s?.ward_request?.request_type)
          .filter((t: any) => typeof t === 'string' && SCHEDULED_REQUEST_TYPES.has(t))
      )
    );
    const detailSchedules =
      detailNeededTypes.length > 0
        ? await prisma.requestSchedule.findMany({
            where: { request_type: { in: detailNeededTypes as string[] } },
            orderBy: { open_from: 'asc' },
          })
        : [];
    const detailSchedulesByType = new Map<string, ScheduleLite[]>();
    for (const s of detailSchedules) {
      if (!detailSchedulesByType.has(s.request_type)) detailSchedulesByType.set(s.request_type, []);
      detailSchedulesByType.get(s.request_type)!.push({
        request_type: s.request_type,
        open_from: s.open_from,
        open_to: s.open_to,
        period_label: s.period_label,
      });
    }

    res.json({
      ...po,
      vendor_name: (po as any).vendor?.name,
      creator_name: (po as any).creator?.display_name,
      total_amount: Number(po.total_amount),
      source_type: inferSourceType(po.note ?? '', sources.map((s: any) => s.request_type).filter(Boolean)),
      ...computeSchedulePeriodMeta(po, detailSchedulesByType),
      po_items: mappedItems,
      items: mappedItems,
      sources,
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { vendor_id, expected_at, note, items } = req.body;
  if (!vendor_id) return res.status(400).json({ error: 'vendor_id is required.' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item is required.' });

  try {
    const seq = await nextSeq('purchase_orders');
    const po_no = generateNo('PO', seq);
    const totalAmount = items.reduce((s: number, it: any) => s + Number(it.ordered_qty) * Number(it.unit_price), 0);

    const po = await prisma.purchaseOrder.create({
      data: {
        id: uuidv4(),
        po_no,
        vendor_id,
        created_by: req.user!.id,
        expected_at: expected_at ? new Date(expected_at) : null,
        note: note ?? '',
        total_amount: totalAmount,
        po_items: {
          create: items.map((it: any) => ({
            id: uuidv4(),
            item_id: it.item_id,
            ordered_qty: it.ordered_qty,
            unit_price: it.unit_price,
            line_amount: Number(it.ordered_qty) * Number(it.unit_price),
          })),
        },
      },
    });

    for (const it of items) {
      try {
        await prisma.priceHistory.updateMany({
          where: { item_id: it.item_id, vendor_id, effective_to: null },
          data: { effective_to: new Date() },
        });
        await prisma.priceHistory.create({
          data: {
            id: uuidv4(),
            item_id: it.item_id,
            vendor_id,
            price: it.unit_price,
            effective_from: new Date(),
            source: 'PO',
          },
        });
      } catch {
        // keep PO flow resilient when price-history update fails
      }
    }

    await audit({
      actor_user_id: req.user!.id,
      action: 'CREATE',
      entity_type: 'purchase_orders',
      entity_id: po.id,
      after: { po_no, vendor_id, total_amount: totalAmount },
    });
    res.status(201).json(po);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const poId = String(req.params.id);
    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po) return res.status(404).json({ error: 'Purchase order not found.' });
    if (po.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT can be edited.' });

    const { expected_at, note, items } = req.body;
    const totalAmount = Array.isArray(items)
      ? items.reduce((s: number, it: any) => s + Number(it.ordered_qty) * Number(it.unit_price), 0)
      : Number(po.total_amount);

    if (Array.isArray(items)) {
      await prisma.purchaseOrderItem.deleteMany({ where: { purchase_order_id: poId } });
      await prisma.purchaseOrderItem.createMany({
        data: items.map((it: any) => ({
          id: uuidv4(),
          purchase_order_id: poId,
          item_id: it.item_id,
          ordered_qty: it.ordered_qty,
          unit_price: it.unit_price,
          line_amount: Number(it.ordered_qty) * Number(it.unit_price),
        })),
      });
    }

    const updated = await prisma.purchaseOrder.update({
      where: { id: poId },
      data: {
        ...(expected_at !== undefined && { expected_at: expected_at ? new Date(expected_at) : null }),
        ...(note !== undefined && { note }),
        total_amount: totalAmount,
      },
    });
    await audit({
      actor_user_id: req.user!.id,
      action: 'UPDATE',
      entity_type: 'purchase_orders',
      entity_id: poId,
      before: po,
      after: updated,
    });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/send', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const poId = String(req.params.id);
    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po) return res.status(404).json({ error: 'Purchase order not found.' });
    if (po.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT can be sent.' });
    const updated = await prisma.purchaseOrder.update({ where: { id: poId }, data: { status: 'SENT' } });
    await audit({
      actor_user_id: req.user!.id,
      action: 'UPDATE',
      entity_type: 'purchase_orders',
      entity_id: poId,
      before: { status: 'DRAFT' },
      after: { status: 'SENT' },
      reason: 'PO sent',
    });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const poId = String(req.params.id);
    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
    if (!po) return res.status(404).json({ error: 'Purchase order not found.' });
    if (!['DRAFT'].includes(po.status)) return res.status(400).json({ error: 'Only DRAFT can be deleted.' });
    await prisma.purchaseOrder.update({ where: { id: poId }, data: { deleted_at: new Date(), status: 'CANCELLED' } });
    await audit({
      actor_user_id: req.user!.id,
      action: 'SOFT_DELETE',
      entity_type: 'purchase_orders',
      entity_id: poId,
      before: po,
    });
    res.json({ message: 'Deleted.' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /gumae-result-pdf — 구매결의서 PDF (선택한 발주서 기반) ─────
router.post('/gumae-result-pdf', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: '발주서를 선택해주세요.' });

    const poList = await (prisma as any).purchaseOrder.findMany({
      where: { id: { in: ids }, deleted_at: null },
      include: {
        vendor: true,
        po_items: { include: { item: true } },
        sources: { include: { ward_request: { include: { department: true, items: true } } } },
      },
      orderBy: { ordered_at: 'asc' },
    });
    if (poList.length === 0) return res.status(400).json({ error: '조회된 발주서가 없습니다.' });

    // Build item_id → department names mapping from PO sources
    const itemDeptMap = new Map<string, Set<string>>();
    for (const po of poList) {
      for (const src of po.sources ?? []) {
        const deptName: string = src.ward_request?.department?.name ?? '';
        if (!deptName) continue;
        for (const ri of src.ward_request?.items ?? []) {
          if (!itemDeptMap.has(ri.item_id)) itemDeptMap.set(ri.item_id, new Set());
          itemDeptMap.get(ri.item_id)!.add(deptName);
        }
      }
    }

    const setting = await (prisma as any).appSetting.findUnique({ where: { key: 'HOSPITAL_NAME' } });
    const hospitalName = (setting?.value as string) ?? '병원';
    const fonts = getFonts();
    const userName: string = (req.user as any)?.display_name ?? '';

    // Group by vendor
    const vendorMap = new Map<string, { vendor: any; pos: any[] }>();
    for (const po of poList) {
      const vid = po.vendor_id;
      if (!vendorMap.has(vid)) vendorMap.set(vid, { vendor: po.vendor, pos: [] });
      vendorMap.get(vid)!.pos.push(po);
    }
    const vendors = Array.from(vendorMap.values());

    // Label / 물품사용기간 — 사용자 입력 우선, 없으면 ordered_at 범위로 fallback
    const labelInput: string = String(req.body?.label || '').trim();
    const fromInput: string = String(req.body?.from || '').trim();
    const toInput: string = String(req.body?.to || '').trim();

    const dates = poList.map((p: any) => new Date(p.ordered_at).getTime());
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    const m = minDate.getMonth() + 1;
    const w = Math.ceil(minDate.getDate() / 7);
    const docLabel = labelInput || `${String(m).padStart(2, '0')}월${w}주`;
    const displayFrom = fromInput ? new Date(fromInput) : minDate;
    const displayTo = toInput ? new Date(toInput) : maxDate;

    // Comparison periods
    const comparePeriods: { label: string; from: string; to: string }[] =
      Array.isArray(req.body?.comparePeriods) ? req.body.comparePeriods.slice(0, 2) : [];

    function periodLabel(d: Date) {
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const ww = Math.ceil(d.getDate() / 7);
      return `${mm}월${ww}주`;
    }

    const compareData: { label: string; totals: Map<string, number> }[] = [];
    for (const cp of comparePeriods) {
      if (!cp.from || !cp.to) continue;
      const cpFrom = new Date(cp.from);
      const cpTo = new Date(cp.to); cpTo.setHours(23, 59, 59, 999);
      const cpPos = await (prisma as any).purchaseOrder.findMany({
        where: { ordered_at: { gte: cpFrom, lte: cpTo }, status: { notIn: ['DRAFT', 'CANCELLED'] }, deleted_at: null },
        select: { vendor_id: true, total_amount: true },
      });
      const totals = new Map<string, number>();
      for (const p of cpPos) totals.set(p.vendor_id, (totals.get(p.vendor_id) ?? 0) + Number(p.total_amount));
      compareData.push({ label: cp.label || periodLabel(cpFrom), totals });
    }

    // PDF setup
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="gumae-result.pdf"`);
    doc.pipe(res);
    doc.registerFont('K', fonts.regular).registerFont('KB', fonts.bold);

    const pageH = 841.89;
    // ── PAGE 1: 표지 ─────────────────────────────────────────────────
    doc.font('KB').fontSize(22).fillColor('#000')
      .text(`${docLabel} 업체별 물품 구매 결의서`, 50, pageH / 2 - 60, { width: 495, align: 'center', lineBreak: false });
    doc.font('K').fontSize(13).fillColor('#444')
      .text(`물품사용기간:  ${displayFrom.toLocaleDateString('ko-KR')}  ~  ${displayTo.toLocaleDateString('ko-KR')}`, 50, pageH / 2 - 14, { width: 495, align: 'center', lineBreak: false });
    doc.font('K').fontSize(13).fillColor('#444')
      .text(`담  당  자:  ${userName}`, 50, pageH / 2 + 16, { width: 495, align: 'center', lineBreak: false });

    // ── PAGE 2: 업체별 구매 금액 요약 ────────────────────────────────
    doc.addPage();
    let y = 50;
    doc.font('KB').fontSize(14).fillColor('#000').text(`${docLabel} 업체별 구매 금액`, 50, y);
    y += 26;

    const sX = 50;
    const numExtra = compareData.length;
    const vendorColW = numExtra === 0 ? 350 : numExtra === 1 ? 230 : 175;
    const amtColW = numExtra > 0 ? 105 : 120;
    const sCols = [vendorColW, ...compareData.map(() => amtColW), amtColW];
    const sHeaders = ['업  체  명', ...compareData.map(cd => cd.label), docLabel];

    function drawSummaryRow(cells: string[], rowY: number, isHeader: boolean, isTotals: boolean): number {
      const rowH = isHeader ? 24 : 20;
      const totalW = sCols.reduce((a, b) => a + b, 0);
      if (isHeader) { doc.rect(sX, rowY, totalW, rowH).fill('#e8edf5'); doc.rect(sX, rowY, totalW, rowH).stroke('#555'); }
      else if (isTotals) { doc.rect(sX, rowY, totalW, rowH).fill('#e8e8e8'); doc.rect(sX, rowY, totalW, rowH).stroke('#555'); }
      let x = sX;
      for (let i = 0; i < sCols.length; i++) {
        doc.rect(x, rowY, sCols[i], rowH).stroke(isHeader || isTotals ? '#555' : '#bbb');
        const align: 'left' | 'center' | 'right' = i === 0 ? 'left' : 'right';
        const fontSize = 9;
        const pad = i === 0 ? 6 : 4;
        doc.font(isHeader || isTotals ? 'KB' : 'K').fontSize(fontSize).fillColor('#000')
          .text(cells[i] ?? '', x + pad, rowY + (rowH - fontSize) / 2 - 1, {
            width: sCols[i] - pad - (align === 'right' ? 6 : pad), align, lineBreak: false,
          });
        x += sCols[i];
      }
      return rowY + rowH;
    }

    y = drawSummaryRow(sHeaders, y, true, false);
    let grandTotal = 0;
    const grandCompare = compareData.map(() => 0);
    for (const { vendor, pos: vpos } of vendors) {
      const curTotal = vpos.reduce((s: number, p: any) => s + Number(p.total_amount), 0);
      grandTotal += curTotal;
      const compareCells = compareData.map((cd, ci) => {
        const t = cd.totals.get(vendor.id) ?? 0;
        grandCompare[ci] += t;
        return t > 0 ? t.toLocaleString('ko-KR') : '-';
      });
      y = drawSummaryRow([vendor.name, ...compareCells, curTotal.toLocaleString('ko-KR')], y, false, false);
    }
    drawSummaryRow(['총    액', ...grandCompare.map(t => t > 0 ? t.toLocaleString('ko-KR') : '-'), grandTotal.toLocaleString('ko-KR')], y, false, true);

    // ── PAGE 3~N: 업체별 상세 ─────────────────────────────────────────
    const APPROVAL_LABELS = ['담당', '부서장', '행정원장', '상임이사', '이사장'];
    const bW = 53, bH = 58, bStartY = 50;
    const bStartX = 545 - APPROVAL_LABELS.length * bW;
    const dCols = [25, 165, 55, 50, 75, 85, 40];
    const dHdrs = ['NO', '품  명', '규격', '수량', '단가', '금액', '비고'];

    function drawDetailRow(cells: string[], rowY: number, isHeader: boolean): number {
      const rowH = isHeader ? 22 : 18;
      if (isHeader) { doc.rect(50, rowY, 495, rowH).fill('#e8edf5'); doc.rect(50, rowY, 495, rowH).stroke('#555'); }
      let x = 50;
      for (let i = 0; i < dCols.length; i++) {
        doc.rect(x, rowY, dCols[i], rowH).stroke(isHeader ? '#555' : '#bbb');
        const align: 'left' | 'center' | 'right' = (i >= 3 && i <= 5) ? 'right' : (i === 1 ? 'left' : 'center');
        const fs = isHeader ? 9 : 8;
        const padL = i === 1 ? 4 : 2;
        const padR = (i >= 3 && i <= 5) ? 5 : 3;
        doc.font(isHeader ? 'KB' : 'K').fontSize(fs).fillColor('#000')
          .text(cells[i] ?? '', x + padL, rowY + (rowH - fs) / 2 - 1, {
            width: dCols[i] - padL - padR, align, lineBreak: false,
          });
        x += dCols[i];
      }
      return rowY + rowH;
    }

    for (const { vendor, pos: vpos } of vendors) {
      doc.addPage();

      // 결재란
      APPROVAL_LABELS.forEach((label, i) => {
        const x = bStartX + i * bW;
        doc.rect(x, bStartY, bW, bH).stroke('#555');
        doc.moveTo(x, bStartY + 20).lineTo(x + bW, bStartY + 20).stroke('#555');
        doc.font('KB').fontSize(9).fillColor('#000')
          .text(label, x, bStartY + 5, { width: bW, align: 'center', lineBreak: false });
      });

      y = bStartY + bH + 14;
      doc.font('KB').fontSize(18).fillColor('#000')
        .text(`${vendor.name} 구매 결의서`, 50, y, { width: 270, align: 'center', lineBreak: false });
      y += 28;
      doc.moveTo(50, y).lineTo(545, y).stroke('#bbb');
      y += 10;

      doc.font('KB').fontSize(9).fillColor('#000').text('청 구 부 서:', 50, y, { width: 80, lineBreak: false });
      doc.font('K').fontSize(9).text('총 무 부', 132, y, { width: 168, lineBreak: false });
      doc.font('KB').fontSize(9).text('연  락  처:', 310, y, { width: 70, lineBreak: false });
      doc.font('K').fontSize(9).text(HOSPITAL_PHONE, 382, y, { width: 163, lineBreak: false });
      y += 16;
      doc.font('KB').fontSize(9).fillColor('#000').text('구매 담당자:', 50, y, { width: 80, lineBreak: false });
      doc.font('K').fontSize(9).text(userName, 132, y, { lineBreak: false });
      y += 16;

      const earliestDate = vpos.reduce((min: any, p: any) => {
        const d = p.expected_at ?? p.ordered_at;
        return new Date(d) < new Date(min) ? d : min;
      }, vpos[0].expected_at ?? vpos[0].ordered_at);
      doc.font('KB').fontSize(9).fillColor('#000').text('납  품  일:', 50, y, { width: 80, lineBreak: false });
      doc.font('K').fontSize(9).text(new Date(earliestDate).toLocaleDateString('ko-KR'), 132, y, { lineBreak: false });
      y += 18;
      doc.moveTo(50, y).lineTo(545, y).stroke('#bbb');
      y += 10;

      const itemMap = new Map<string, { name: string; uom: string; qty: number; price: number; itemId: string }>();
      for (const po of vpos) {
        for (const it of po.po_items ?? []) {
          const iid = it.item_id;
          if (!itemMap.has(iid)) itemMap.set(iid, { name: it.item?.name ?? '', uom: it.item?.uom ?? '', qty: 0, price: Number(it.unit_price), itemId: iid });
          itemMap.get(iid)!.qty += Number(it.ordered_qty);
        }
      }

      y = drawDetailRow(dHdrs, y, true);
      let vendorTotal = 0;
      let rowIdx = 1;
      for (const [, it] of itemMap) {
        if (y > 750) { doc.addPage(); y = 50; y = drawDetailRow(dHdrs, y, true); }
        const amt = it.qty * it.price;
        vendorTotal += amt;
        const depts = itemDeptMap.get(it.itemId);
        const bigoStr = depts ? Array.from(depts).join(',') : '';
        y = drawDetailRow([String(rowIdx++), it.name, it.uom, it.qty.toLocaleString('ko-KR'), it.price.toLocaleString('ko-KR'), amt.toLocaleString('ko-KR'), bigoStr], y, false);
      }

      const sH = 18;
      const labelW = dCols[0] + dCols[1] + dCols[2] + dCols[3] + dCols[4];
      doc.rect(50, y, labelW, sH).stroke('#555');
      doc.rect(50 + labelW, y, dCols[5], sH).stroke('#555');
      doc.rect(50 + labelW + dCols[5], y, dCols[6], sH).stroke('#555');
      doc.font('KB').fontSize(9).fillColor('#000')
        .text('합  계', 50, y + (sH - 9) / 2, { width: labelW - 4, align: 'right', lineBreak: false });
      doc.font('KB').fontSize(9)
        .text(vendorTotal.toLocaleString('ko-KR'), 50 + labelW + 3, y + (sH - 9) / 2, { width: dCols[5] - 7, align: 'right', lineBreak: false });
      y += sH;

      // 합 계 금 액 행
      const totalRowW = dCols.reduce((a, b) => a + b, 0);
      doc.rect(50, y, totalRowW, sH).stroke('#555');
      doc.font('KB').fontSize(9).fillColor('#000')
        .text(`합 계 금 액:  ${vendorTotal.toLocaleString('ko-KR')} 원`, 50 + 6, y + (sH - 9) / 2, { width: totalRowW - 12, align: 'center', lineBreak: false });
      y += sH + 20;
      if (fs.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, 545 - 150, y - 2, { width: 150 });
      } else {
        doc.font('KB').fontSize(10).fillColor('#000').text(hospitalName, 50, y, { width: 495, align: 'right', lineBreak: false });
      }
    }

    doc.end();
  } catch (err) {
    console.error('구매결의서 PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'PDF 생성 실패' });
  }
});

// ── POST /gian-pdf — 기안서 PDF (실제 양식 기반) ──────────────────
router.post('/gian-pdf', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.status(400).json({ error: '발주서를 선택해주세요.' });

    const poList = await (prisma as any).purchaseOrder.findMany({
      where: { id: { in: ids }, deleted_at: null },
      include: { vendor: true, po_items: { include: { item: true } } },
      orderBy: { ordered_at: 'asc' },
    });
    if (poList.length === 0) return res.status(400).json({ error: '조회된 발주서가 없습니다.' });

    const setting = await (prisma as any).appSetting.findUnique({ where: { key: 'HOSPITAL_NAME' } });
    const hospitalName = (setting?.value as string) ?? '병원';
    const fonts = getFonts();
    const userName: string = (req.user as any)?.display_name ?? '';

    // Form inputs
    const docType = String(req.body?.doc_type || 'poomui');
    const docNo = String(req.body?.doc_no || '').trim();
    const docDateInput = String(req.body?.doc_date || '').trim();
    const enforceDate = String(req.body?.enforce_date || '재가 후 즉시').trim();
    const coopDept = String(req.body?.coop_dept || '').trim();
    const retention = String(req.body?.retention || '1년').trim();
    const titleInput = String(req.body?.title || '').trim() || '물품 구매의 건';
    const contentInput = String(req.body?.content || '').trim();
    const paymentMethod = String(req.body?.payment_method || '').trim();
    const attachment = String(req.body?.attachment || '').trim();

    const docDate = docDateInput ? new Date(docDateInput) : new Date();
    const docDateStr = `${docDate.getFullYear()}년 ${String(docDate.getMonth() + 1).padStart(2, '0')}월 ${String(docDate.getDate()).padStart(2, '0')}일`;

    // Merge items grouped by vendor
    const vendorItemMap = new Map<string, { vendorName: string; items: { name: string; uom: string; qty: number; price: number }[] }>();
    for (const po of poList) {
      const vid = po.vendor_id;
      if (!vendorItemMap.has(vid)) vendorItemMap.set(vid, { vendorName: po.vendor?.name ?? '', items: [] });
      for (const it of po.po_items ?? []) {
        const existing = vendorItemMap.get(vid)!.items.find(x => x.name === (it.item?.name ?? ''));
        if (existing) { existing.qty += Number(it.ordered_qty); }
        else { vendorItemMap.get(vid)!.items.push({ name: it.item?.name ?? '', uom: it.item?.uom ?? '', qty: Number(it.ordered_qty), price: Number(it.unit_price) }); }
      }
    }

    // PDF setup
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="gian.pdf"`);
    doc.pipe(res);
    doc.registerFont('K', fonts.regular).registerFont('KB', fonts.bold);

    const LX = 40;            // left margin
    const RX = 555;           // right edge
    const TW = RX - LX;      // total width
    const STROKE = '#555';

    // ── "기 안 서" 제목 ──
    doc.font('KB').fontSize(22).fillColor('#000')
      .text('기  안  서', LX, 40, { width: TW, align: 'center', lineBreak: false });

    // ── 상단 정보 테이블 + 결재란 ──
    const tblTop = 80;
    const leftLabelW = 70;    // 기안구분, 문서번호 등 라벨 칸
    const leftValW = 140;     // 값 칸
    const leftW = leftLabelW + leftValW;  // 210
    const rightW = TW - leftW;            // 305
    const rowH = 22;
    const infoRows = 6;       // 기안구분, 문서번호, 기안일자, 시행일자, 기안부서, 기안자
    const infoH = infoRows * rowH;        // 132

    // 결재란 dimensions
    const APPROVAL_LABELS = ['담당', '부서장', '행정원장', '상임이사', '이사장'];
    const apprLabelW = 28;    // "결재" 세로 라벨
    const apprCellW = (rightW - apprLabelW) / APPROVAL_LABELS.length;
    const apprHeaderH = 20;
    const apprBodyH = 3 * rowH - apprHeaderH; // 결재란 = 상단 3행과 높이 맞춤

    // Draw info rows (left side)
    const infoLabels = ['기안구분', '문서번호', '기안일자', '시행일자', '기안부서', '기 안 자'];
    const docTypeLabel = docType === 'bogo' ? '■보고  □품의  □협조' : docType === 'hyupjo' ? '■협조  □품의  □보고' : '■품의  □보고  □협조';
    const infoValues = [docTypeLabel, docNo || '-', docDateStr, enforceDate, '총 무 부', userName];

    for (let i = 0; i < infoRows; i++) {
      const ry = tblTop + i * rowH;
      // label cell
      doc.rect(LX, ry, leftLabelW, rowH).stroke(STROKE);
      doc.font('KB').fontSize(9).fillColor('#000')
        .text(infoLabels[i], LX + 4, ry + (rowH - 9) / 2, { width: leftLabelW - 8, align: 'center', lineBreak: false });
      // value cell
      doc.rect(LX + leftLabelW, ry, leftValW, rowH).stroke(STROKE);
      doc.font('K').fontSize(9).fillColor('#000')
        .text(infoValues[i], LX + leftLabelW + 6, ry + (rowH - 9) / 2, { width: leftValW - 12, lineBreak: false });
    }

    // Draw approval area (right side, top portion)
    const apprTop = tblTop;
    // "결재" vertical label
    doc.rect(LX + leftW, apprTop, apprLabelW, apprHeaderH + apprBodyH).stroke(STROKE);
    doc.font('KB').fontSize(9).fillColor('#000')
      .text('결', LX + leftW + 2, apprTop + 10, { width: apprLabelW - 4, align: 'center', lineBreak: false });
    doc.font('KB').fontSize(9)
      .text('재', LX + leftW + 2, apprTop + 24, { width: apprLabelW - 4, align: 'center', lineBreak: false });

    // Approval header + body cells
    for (let i = 0; i < APPROVAL_LABELS.length; i++) {
      const ax = LX + leftW + apprLabelW + i * apprCellW;
      // header
      doc.rect(ax, apprTop, apprCellW, apprHeaderH).stroke(STROKE);
      doc.font('KB').fontSize(8).fillColor('#000')
        .text(APPROVAL_LABELS[i], ax, apprTop + (apprHeaderH - 8) / 2, { width: apprCellW, align: 'center', lineBreak: false });
      // body (signature space)
      doc.rect(ax, apprTop + apprHeaderH, apprCellW, apprBodyH).stroke(STROKE);
    }

    // Draw 협조부서 area (right side, below approval)
    const coopTop = apprTop + apprHeaderH + apprBodyH;
    const coopH = infoH - apprHeaderH - apprBodyH; // remaining height
    const coopLabelW = apprLabelW;  // 28
    const retLabelW = 60;
    const retValW = rightW - coopLabelW - retLabelW;

    // "협조부서" vertical label
    doc.rect(LX + leftW, coopTop, coopLabelW, coopH).stroke(STROKE);
    const coopChars = ['협', '조', '부', '서'];
    coopChars.forEach((ch, ci) => {
      doc.font('KB').fontSize(9).fillColor('#000')
        .text(ch, LX + leftW + 2, coopTop + 4 + ci * 12, { width: coopLabelW - 4, align: 'center', lineBreak: false });
    });

    // Coop dept content area
    doc.rect(LX + leftW + coopLabelW, coopTop, rightW - coopLabelW, coopH).stroke(STROKE);
    if (coopDept) {
      doc.font('K').fontSize(9).fillColor('#000')
        .text(coopDept, LX + leftW + coopLabelW + 6, coopTop + 6, { width: rightW - coopLabelW - 12 });
    }

    // 보존연한 (inside coop area, top-right)
    const retTop = coopTop;
    const retX = RX - retLabelW - retValW;
    doc.font('KB').fontSize(8).fillColor('#555')
      .text('보존년한', retX, retTop + 4, { width: retLabelW, align: 'right', lineBreak: false });
    doc.font('K').fontSize(9).fillColor('#000')
      .text(retention, retX + retLabelW + 4, retTop + 4, { width: retValW - 8, lineBreak: false });

    // ── 제목 행 (전체 너비) ──
    const titleRowY = tblTop + infoH;
    doc.rect(LX, titleRowY, leftLabelW, rowH).stroke(STROKE);
    doc.font('KB').fontSize(9).fillColor('#000')
      .text('제  목', LX + 4, titleRowY + (rowH - 9) / 2, { width: leftLabelW - 8, align: 'center', lineBreak: false });
    doc.rect(LX + leftLabelW, titleRowY, TW - leftLabelW, rowH).stroke(STROKE);
    doc.font('K').fontSize(9).fillColor('#000')
      .text(titleInput, LX + leftLabelW + 8, titleRowY + (rowH - 9) / 2, { width: TW - leftLabelW - 16, lineBreak: false });

    // ── 본문 영역 (외곽선) ──
    let y = titleRowY + rowH;
    const bodyTop = y;

    // 본문 내용
    y += 16;
    if (contentInput) {
      const contentOpts = { width: TW - 40, lineGap: 4 };
      doc.font('K').fontSize(9).fillColor('#000').text(contentInput, LX + 20, y, contentOpts);
      y += doc.font('K').fontSize(9).heightOfString(contentInput, contentOpts) + 12;
    }

    // "- 아 래 -"
    y += 8;
    doc.font('KB').fontSize(9).fillColor('#000')
      .text('-  아  래  -', LX, y, { width: TW, align: 'center', lineBreak: false });
    y += 22;

    // "1. 구매내용"  + "(단위: 원)"
    doc.font('KB').fontSize(9).fillColor('#000').text('1. 구매내용', LX + 16, y, { lineBreak: false });
    doc.font('K').fontSize(8).fillColor('#555').text('(단위: 원)', RX - 60, y + 1, { width: 50, align: 'right', lineBreak: false });
    y += 18;

    // ── 품목 테이블 ──
    const tCols = [25, 80, 120, 55, 75, 100];  // No, 업체, 내용, 수량, 단가, 금액
    const tHdrs = ['No', '업체', '내용', '수량', '단가', '금액'];
    const tblLX = LX + 16;
    const tblW = tCols.reduce((a, b) => a + b, 0);
    const tRowH = 20;

    function drawTblRow(cells: string[], rowY: number, isHeader: boolean): number {
      const rh = isHeader ? 22 : tRowH;
      if (isHeader) { doc.rect(tblLX, rowY, tblW, rh).fill('#e8edf5'); }
      let x = tblLX;
      for (let i = 0; i < tCols.length; i++) {
        doc.rect(x, rowY, tCols[i], rh).stroke(isHeader ? '#555' : '#bbb');
        // 헤더: 전체 가운데, 데이터: No/업체/내용/수량 = 가운데, 단가/금액 = 오른쪽
        const align: 'left' | 'center' | 'right' = isHeader ? 'center' : (i >= 4 ? 'right' : 'center');
        const fs = isHeader ? 9 : 8;
        const padL = 4;
        const padR = i >= 4 ? 6 : 4;
        doc.font(isHeader ? 'KB' : 'K').fontSize(fs).fillColor('#000')
          .text(cells[i] ?? '', x + padL, rowY + (rh - fs) / 2 - 1, { width: tCols[i] - padL - padR, align, lineBreak: false });
        x += tCols[i];
      }
      return rowY + rh;
    }

    y = drawTblRow(tHdrs, y, true);
    let grandTotal = 0;
    let rowNo = 1;
    for (const [, vg] of vendorItemMap) {
      for (const it of vg.items) {
        if (y > 720) { doc.addPage(); y = 40; y = drawTblRow(tHdrs, y, true); }
        const amt = it.qty * it.price;
        grandTotal += amt;
        y = drawTblRow([String(rowNo++), vg.vendorName, it.name, it.qty.toLocaleString('ko-KR'), it.price.toLocaleString('ko-KR'), amt.toLocaleString('ko-KR')], y, false);
      }
    }

    // 합계 row
    {
      const rh = tRowH;
      const sumLabelW = tCols[0] + tCols[1] + tCols[2] + tCols[3] + tCols[4];
      doc.rect(tblLX, y, sumLabelW, rh).stroke('#555');
      doc.rect(tblLX + sumLabelW, y, tCols[5], rh).stroke('#555');
      doc.font('KB').fontSize(9).fillColor('#000')
        .text('합계(VAT포함)', tblLX, y + (rh - 9) / 2, { width: sumLabelW, align: 'center', lineBreak: false });
      doc.font('KB').fontSize(9)
        .text(grandTotal.toLocaleString('ko-KR'), tblLX + sumLabelW + 4, y + (rh - 9) / 2, { width: tCols[5] - 10, align: 'right', lineBreak: false });
      y += rh;
    }

    y += 16;

    // "2. 결제방법"
    if (paymentMethod) {
      doc.font('KB').fontSize(9).fillColor('#000').text(`2. 결제방법: `, LX + 16, y, { continued: true, lineBreak: false });
      doc.font('K').fontSize(9).text(paymentMethod, { lineBreak: false });
      y += 20;
    }

    y += 12;

    // 붙임
    if (attachment) {
      doc.font('KB').fontSize(9).fillColor('#000').text('붙  임: ', LX + 4, y, { continued: true, lineBreak: false });
      doc.font('K').fontSize(9).text(`${attachment}.  끝`, { lineBreak: false });
      y += 20;
    }

    // 본문 영역 외곽선 (bodyTop ~ y+10)
    const bodyBottom = Math.max(y + 20, 700);
    doc.rect(LX, bodyTop, TW, bodyBottom - bodyTop).stroke(STROKE);

    // ── 로고 (우하단) ──
    y = bodyBottom + 10;
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, RX - 150, y - 2, { width: 150 });
    } else {
      doc.font('KB').fontSize(10).fillColor('#000')
        .text(hospitalName, LX, y, { width: TW, align: 'right', lineBreak: false });
    }

    doc.end();
  } catch (err) {
    console.error('기안서 PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'PDF 생성 실패' });
  }
});

// ── GET /:id/pdf — 발주서 PDF 생성 ──────────────────────────────────
router.get('/:id/pdf', requirePermission('PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const poId = String(req.params.id);
    const po = await (prisma as any).purchaseOrder.findUnique({
      where: { id: poId },
      include: { vendor: true, creator: true, po_items: { include: { item: true } } },
    });
    if (!po) return res.status(404).json({ error: 'Purchase order not found.' });

    const setting = await (prisma as any).appSetting.findUnique({ where: { key: 'HOSPITAL_NAME' } });
    const hospitalName = (setting?.value as string) ?? '병원';
    const fonts = getFonts();

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${po.po_no}.pdf"`);
    doc.pipe(res);

    doc.registerFont('K', fonts.regular).registerFont('KB', fonts.bold);

    // ── 결재란 (우측 상단) ────────────────────────────────────────────
    const APPROVAL_LABELS = ['담당', '부서장', '행정원장', '상임이사', '이사장'];
    const bW2 = 53, bH2 = 58, bStartY2 = 50;
    const bStartX2 = 545 - APPROVAL_LABELS.length * bW2;
    APPROVAL_LABELS.forEach((label, i) => {
      const x = bStartX2 + i * bW2;
      doc.rect(x, bStartY2, bW2, bH2).stroke('#888888');
      doc.moveTo(x, bStartY2 + 20).lineTo(x + bW2, bStartY2 + 20).stroke('#999999');
      doc.font('KB').fontSize(9).fillColor('#000')
        .text(label, x, bStartY2 + 5, { width: bW2, align: 'center', lineBreak: false });
    });

    // ── 제목 ─────────────────────────────────────────────────────────
    let y = bStartY2 + bH2 + 14;
    doc.font('KB').fontSize(20).fillColor('#000')
      .text('발  주  서', 50, y, { width: 495, align: 'center', lineBreak: false });
    y += 28;
    doc.font('K').fontSize(10)
      .text(`발주번호: ${po.po_no}`, 50, y, { width: 495, align: 'center', lineBreak: false });
    y += 18;

    doc.moveTo(50, y).lineTo(545, y).stroke('#cccccc');
    y += 12;

    // ── 수신 / 발주일 / 납기일 / 담당자 ─────────────────────────────
    const ordered = new Date(po.ordered_at).toLocaleDateString('ko-KR');
    const expected = po.expected_at ? new Date(po.expected_at).toLocaleDateString('ko-KR') : '-';
    const vendorName: string = po.vendor?.name ?? '';
    const creatorName: string = po.creator?.display_name ?? '';

    doc.font('K').fontSize(10).fillColor('#000')
      .text(`수  신:  ${vendorName}`, 50, y, { width: 260, lineBreak: false });
    doc.font('K').fontSize(10)
      .text(`발  주  일:  ${ordered}`, 330, y, { width: 215, lineBreak: false });
    y += 16;
    doc.font('K').fontSize(10).fillColor('#000')
      .text(`납  기  일:  ${expected}`, 50, y, { width: 260, lineBreak: false });
    doc.font('K').fontSize(10)
      .text(`담  당  자:  ${creatorName}`, 330, y, { width: 215, lineBreak: false });
    y += 20;

    doc.moveTo(50, y).lineTo(545, y).stroke('#cccccc');
    y += 12;

    doc.font('K').fontSize(10).fillColor('#000')
      .text('아래와 같이 발주합니다.', 50, y, { lineBreak: false });
    y += 18;

    // ── 품목 테이블 ──────────────────────────────────────────────────
    // 컬럼: 번호(30) + 품목명(195) + 단위(45) + 수량(55) + 단가(80) + 금액(90) = 495
    const cols = [30, 195, 45, 55, 80, 90];
    const hdrs = ['번호', '품목명', '단위', '수량', '단가', '금액'];

    function drawRow(cells: string[], rowY: number, isHeader: boolean): number {
      const rowH = isHeader ? 20 : 16;
      if (isHeader) {
        doc.rect(50, rowY, 495, rowH).fill('#f0f0f0');
        doc.rect(50, rowY, 495, rowH).stroke('#999999');
      }
      let x = 50;
      for (let i = 0; i < cols.length; i++) {
        doc.rect(x, rowY, cols[i], rowH).stroke(isHeader ? '#999999' : '#cccccc');
        const align: 'left' | 'center' | 'right' = i >= 3 ? 'right' : i === 1 ? 'left' : 'center';
        const padL = 3, padR = i >= 3 ? 5 : 3;
        doc.font(isHeader ? 'KB' : 'K').fontSize(8).fillColor('#000')
          .text(cells[i] ?? '', x + padL, rowY + (rowH - 9) / 2, {
            width: cols[i] - padL - padR,
            align,
            lineBreak: false,
          });
        x += cols[i];
      }
      return rowY + rowH;
    }

    y = drawRow(hdrs, y, true);

    const items: any[] = po.po_items ?? [];
    let totalAmt = 0;
    for (let idx = 0; idx < items.length; idx++) {
      if (y > 750) { doc.addPage(); y = 50; y = drawRow(hdrs, y, true); }
      const it = items[idx];
      const qty = Number(it.ordered_qty);
      const price = Number(it.unit_price);
      const amt = qty * price;
      totalAmt += amt;
      y = drawRow([
        String(idx + 1),
        it.item?.name ?? '',
        it.item?.uom ?? '',
        qty.toLocaleString('ko-KR'),
        price.toLocaleString('ko-KR'),
        amt.toLocaleString('ko-KR'),
      ], y, false);
    }

    // 합계 행
    const sumH = 18;
    const labelEndX = 50 + cols[0] + cols[1] + cols[2] + cols[3]; // 325
    const priceEndX = labelEndX + cols[4]; // 405
    doc.rect(50, y, labelEndX - 50, sumH).stroke('#999999');
    doc.rect(labelEndX, y, cols[4], sumH).stroke('#999999');
    doc.rect(priceEndX, y, cols[5], sumH).stroke('#999999');
    doc.font('KB').fontSize(8).fillColor('#000')
      .text('합  계', 50, y + (sumH - 9) / 2, { width: labelEndX - 54, align: 'right', lineBreak: false });
    doc.font('KB').fontSize(8).fillColor('#000')
      .text(totalAmt.toLocaleString('ko-KR'), priceEndX + 3, y + (sumH - 9) / 2, { width: cols[5] - 8, align: 'right', lineBreak: false });
    y += sumH;

    // ── 비고 ─────────────────────────────────────────────────────────
    if (po.note) {
      y += 12;
      doc.font('K').fontSize(9).fillColor('#000')
        .text(`비  고:  ${po.note}`, 50, y, { width: 495, lineBreak: false });
      y += 16;
    }

    // ── 병원명 (우측) ────────────────────────────────────────────────
    y += 24;
    doc.font('KB').fontSize(11).fillColor('#000')
      .text(hospitalName, 50, y, { width: 495, align: 'right', lineBreak: false });

    doc.end();
  } catch (err) {
    console.error('PDF generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'PDF 생성 실패' });
  }
});

export default router;





