import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import * as XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';
import { ALL_CATEGORIES, ALL_CATEGORY_VALUES, ITEM_EXPENSE_SCOPES, getCategoryLabel, getMajor, getMidCategory, isUserMidCategory, MAJOR_GROUP_LABEL } from '../../shared/types';
import { normalizePackSize } from '../../shared/units';

// 한글 분류 라벨 → 카테고리 코드 역매핑 (소분류 라벨 우선)
const LABEL_TO_CATEGORY: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const c of ALL_CATEGORIES) {
    m[c.label.trim()] = c.value;
    m[c.value.toUpperCase()] = c.value;
  }
  return m;
})();
const EXPENSE_LABEL_TO_VALUE: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const e of ITEM_EXPENSE_SCOPES) {
    m[e.label.trim()] = e.value;
    m[e.value.toUpperCase()] = e.value;
  }
  return m;
})();
function resolveCategory(input: string): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (LABEL_TO_CATEGORY[raw]) return LABEL_TO_CATEGORY[raw];
  const upper = raw.toUpperCase();
  if (LABEL_TO_CATEGORY[upper]) return LABEL_TO_CATEGORY[upper];
  if (upper === 'MEDICAL') return 'MED_OTHER';
  return null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 이미지 업로드용 disk storage
const imageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.join(process.env.USER_DATA_PATH || '.', 'uploads', 'items');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `item-${req.params.id}-${Date.now()}${ext}`);
  },
});
const uploadImage = multer({
  storage: imageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('이미지 파일만 업로드 가능합니다.'));
  },
});

const router = Router();
router.use(authMiddleware);

const VALID_CATEGORIES = [...ALL_CATEGORY_VALUES] as string[];
const VALID_EXPENSE_SCOPES = ITEM_EXPENSE_SCOPES.map(x => x.value);
const normalizeCategory = (value?: string) => {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'MEDICAL') return 'MED_OTHER';
  if (VALID_CATEGORIES.includes(normalized)) return normalized;
  // 사용자가 추가한 중분류 코드도 허용 (레지스트리: 서버 시작/변경 시 적재)
  if (isUserMidCategory(normalized)) return normalized;
  return 'MED_OTHER';
};
const inferExpenseScopeFromCategory = (category: string) => {
  const group = getMajor(category);
  return group === 'OFFICE' ? 'OPS_INDIRECT' : 'PATIENT_DIRECT';
};
const normalizeExpenseScope = (value: any, category: string) => {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (VALID_EXPENSE_SCOPES.includes(normalized as any)) return normalized;
  return inferExpenseScopeFromCategory(category);
};

router.get('/', async (req, res) => {
  try {
    const { category, search } = req.query;
    const items = await prisma.item.findMany({
      where: {
        deleted_at: null,
        is_active: true,
        ...(category && { category: String(category) }),
        ...(search && { name: { contains: String(search) } }),
      },
      include: {
        default_vendor: true,
        default_treatment: { select: { id: true, name: true } },
        price_history: { orderBy: { effective_from: 'desc' }, take: 1 },
        inventory: { include: { location: true } },
      },
      orderBy: { item_code: 'asc' },
    });

    const result = items.map(it => ({
      id: it.id,
      item_code: it.item_code,
      name: it.name,
      category: it.category,
      major: getMajor(it.category),
      mid_category: getMidCategory(it.category)?.value ?? null,
      mid_label: getMidCategory(it.category)?.label ?? '',
      expense_scope: (it as any).expense_scope ?? inferExpenseScopeFromCategory(it.category),
      uom: it.uom,
      purchase_uom: (it as any).purchase_uom ?? it.uom,
      issue_uom: (it as any).issue_uom ?? it.uom,
      pack_size: it.pack_size,
      sub_category: (it as any).sub_category ?? '',
      default_vendor_id: it.default_vendor_id,
      default_vendor_name: it.default_vendor?.name ?? null,
      default_treatment_type_id: (it as any).default_treatment_type_id ?? null,
      default_treatment_name: (it as any).default_treatment?.name ?? null,
      diaper_companion_for_wards: (it as any).diaper_companion_for_wards ?? false,
      min_order_qty: it.min_order_qty,
      is_regular_order: it.is_regular_order,
      reorder_days_threshold: it.reorder_days_threshold,
      is_active: it.is_active,
      latest_price: it.price_history[0] ? Number(it.price_history[0].price) : 0,
      on_hand_qty: it.inventory.filter((inv: any) => inv.location?.is_asset_tracked).reduce((s, inv) => s + Number(inv.on_hand_qty), 0),
      image_url: (it as any).image_url ?? null,
    }));
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// 엑셀 내보내기
router.get('/export', requirePermission('BASIC_MANAGE'), async (_req, res) => {
  try {
    const items = await prisma.item.findMany({
      where: { deleted_at: null },
      include: {
        default_vendor: true,
        price_history: { orderBy: { effective_from: 'desc' }, take: 1 },
        inventory: { include: { location: true } },
      },
      orderBy: { item_code: 'asc' },
    });

    // 한글 라벨 매핑
    const EXPENSE_LABEL = Object.fromEntries(ITEM_EXPENSE_SCOPES.map(x => [x.value, x.label]));

    const headers = ['품목코드', '품목명', '발주단위', '불출단위', '대분류', '중분류', '소분류', '비용구분', '포장변환비율', '최소발주수량', '재주문기준일', '정기여부', '기본업체코드', '최신단가', '재고수량', '상태'];
    const rows = items.map(it => {
      const expenseScope = (it as any).expense_scope ?? inferExpenseScopeFromCategory(it.category);
      const major = getMajor(it.category);
      const mid = getMidCategory(it.category);
      const subLabel = getCategoryLabel(it.category);
      return [
        it.item_code,
        it.name,
        (it as any).purchase_uom ?? it.uom,
        (it as any).issue_uom ?? it.uom,
        MAJOR_GROUP_LABEL[major],
        mid?.label ?? '-',
        subLabel,
        EXPENSE_LABEL[expenseScope] ?? expenseScope,
        it.pack_size,
        it.min_order_qty,
        it.reorder_days_threshold,
        it.is_regular_order ? '정기' : '비정기',
        (it.default_vendor as any)?.code ?? '',
        it.price_history[0] ? Number(it.price_history[0].price) : '',
        it.inventory.filter((inv: any) => inv.location?.is_asset_tracked).reduce((s: number, inv: any) => s + Number(inv.on_hand_qty), 0),
        it.is_active ? '활성' : '비활성',
      ];
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = [16, 24, 10, 10, 12, 10, 18, 12, 12, 12, 12, 10, 14, 12, 10, 8].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, '품목목록');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    // 파일명 한글 — filename* (RFC 5987) 만 제공해 한글이 우선 적용되도록
    const filename = `품목목록_${today}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// 관리자용 — 품목 대량 재분류 (category + sub_category)
// body: { updates: [{ id, category, sub_category? }] }
router.patch('/bulk-categorize', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const updates: Array<{ id: string; category: string; sub_category?: string }> = req.body?.updates ?? [];
    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: '수정할 항목이 없습니다.' });
    }
    const valid = new Set(VALID_CATEGORIES);
    let updated = 0;
    const errors: Array<{ id: string; reason: string }> = [];
    for (const u of updates) {
      if (!u.id || !u.category) continue;
      if (!valid.has(u.category)) {
        errors.push({ id: u.id, reason: `unknown category: ${u.category}` });
        continue;
      }
      try {
        await prisma.item.update({
          where: { id: u.id },
          data: {
            category: u.category,
            ...(u.sub_category !== undefined && { sub_category: String(u.sub_category) }),
          },
        });
        updated++;
      } catch (e) {
        errors.push({ id: u.id, reason: (e as Error).message });
      }
    }
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'items', entity_id: 'bulk', after: { updated, errors: errors.length } });
    res.json({ updated, errors });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// 일괄 필드 업데이트 — 카테고리/비용구분/기본업체 등 여러 필드 동시 적용
// body: { ids: [string], patch: { category?, expense_scope?, default_vendor_id? } }
router.patch('/bulk-update', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const ids: string[] = req.body?.ids ?? [];
    const patch = req.body?.patch ?? {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '대상이 없습니다.' });

    const data: any = {};
    if (patch.category) {
      if (!VALID_CATEGORIES.includes(patch.category)) return res.status(400).json({ error: `알 수 없는 분류: ${patch.category}` });
      data.category = patch.category;
    }
    if (patch.expense_scope) {
      data.expense_scope = patch.expense_scope;
    }
    if (patch.default_vendor_id !== undefined) {
      data.default_vendor_id = patch.default_vendor_id || null;
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: '변경할 필드가 없습니다.' });

    const result = await prisma.item.updateMany({
      where: { id: { in: ids }, deleted_at: null },
      data,
    });
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'items', entity_id: 'bulk', after: { count: result.count, patch: data } });
    res.json({ updated: result.count });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message || '서버 오류' });
  }
});

// 일괄 삭제 (soft-delete)
// body: { ids: [string] }
router.delete('/bulk', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const ids: string[] = req.body?.ids ?? [];
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '대상이 없습니다.' });
    const result = await prisma.item.updateMany({
      where: { id: { in: ids }, deleted_at: null },
      data: { deleted_at: new Date(), is_active: false },
    });
    await audit({ actor_user_id: req.user!.id, action: 'SOFT_DELETE', entity_type: 'items', entity_id: 'bulk', after: { count: result.count } });
    res.json({ deleted: result.count });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message || '서버 오류' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const item = await prisma.item.findUnique({
      where: { id: req.params.id },
      include: {
        default_vendor: true,
        default_treatment: { select: { id: true, name: true } },
        vendor_maps: { include: { vendor: true } },
        price_history: { include: { vendor: true }, orderBy: { effective_from: 'desc' }, take: 10 },
        inventory: { include: { location: true } },
      },
    });
    if (!item) return res.status(404).json({ error: '품목을 찾을 수 없습니다.' });
    res.json(item);
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

router.post('/', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  const { item_code, name, category, expense_scope, uom, purchase_uom, issue_uom, pack_size, default_vendor_id, default_treatment_type_id, diaper_companion_for_wards, min_order_qty, is_regular_order, reorder_days_threshold } = req.body;
  if (!name) return res.status(400).json({ error: '품목명은 필수입니다.' });
  try {
    const normalizedCategory = normalizeCategory(category);

    // 품목코드 자동 채번 — 미입력 시 카테고리별 접두어 + 다음 일련번호(4자리)
    //   의료(MED_/INFECT_)=MED · 사무(OFF_)=OFF · 비품(EQUIP_)=EQP · 그 외=GEN(일반)
    const codeBucket = (c: string) => {
      const u = String(c || '').toUpperCase();
      if (u.startsWith('EQUIP_')) return 'EQP';
      if (u.startsWith('OFF_')) return 'OFF';
      if (u.startsWith('MED_') || u.startsWith('INFECT_')) return 'MED';
      return 'GEN';
    };
    let finalItemCode = String(item_code ?? '').trim();
    if (!finalItemCode) {
      const prefix = codeBucket(normalizedCategory);
      const rows = await prisma.item.findMany({
        where: { item_code: { startsWith: `${prefix}-` } },
        select: { item_code: true },
      });
      let maxN = 0;
      for (const r of rows) {
        const m = /-(\d+)$/.exec(r.item_code);
        if (m) maxN = Math.max(maxN, Number(m[1]));
      }
      finalItemCode = `${prefix}-${String(maxN + 1).padStart(4, '0')}`;
    }
    const normalizedExpenseScope = normalizeExpenseScope(expense_scope, normalizedCategory);
    const finalPurchaseUom = String(purchase_uom ?? uom ?? 'EA').trim() || 'EA';
    const finalIssueUom = String(issue_uom ?? uom ?? 'EA').trim() || 'EA';
    const finalUom = String(uom ?? finalIssueUom).trim() || 'EA';
    const finalPackSize = normalizePackSize(pack_size ?? 1);
    const item = await prisma.item.create({
      data: {
        id: uuidv4(),
        item_code: finalItemCode,
        name,
        category: normalizedCategory,
        sub_category: String(req.body?.sub_category ?? '').trim(),
        expense_scope: normalizedExpenseScope as any,
        uom: finalUom,
        purchase_uom: finalPurchaseUom,
        issue_uom: finalIssueUom,
        pack_size: finalPackSize,
        default_vendor_id: default_vendor_id || null,
        default_treatment_type_id: default_treatment_type_id || null,
        diaper_companion_for_wards: !!diaper_companion_for_wards,
        min_order_qty: min_order_qty ?? 1,
        is_regular_order: is_regular_order ?? true,
        reorder_days_threshold: reorder_days_threshold ?? 7,
      } as any,
    });
    await audit({ actor_user_id: req.user!.id, action: 'CREATE', entity_type: 'items', entity_id: item.id, after: item });
    res.status(201).json(item);
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 품목코드입니다.' });
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const before = await prisma.item.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: '품목을 찾을 수 없습니다.' });
    const { name, category, sub_category, expense_scope, uom, purchase_uom, issue_uom, pack_size, default_vendor_id, default_treatment_type_id, diaper_companion_for_wards, min_order_qty, is_regular_order, reorder_days_threshold, is_active } = req.body;
    const nextCategory = category !== undefined ? normalizeCategory(category) : before.category;
    const nextExpenseScope = expense_scope !== undefined
      ? normalizeExpenseScope(expense_scope, nextCategory)
      : ((before as any).expense_scope ?? inferExpenseScopeFromCategory(nextCategory));
    if (pack_size !== undefined) {
      const ps = Number(pack_size);
      if (!Number.isFinite(ps) || ps < 1 || !Number.isInteger(ps)) {
        return res.status(400).json({ error: '포장변환비율은 1 이상의 정수여야 합니다.' });
      }
    }
    const after = await prisma.item.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(category !== undefined && { category: nextCategory }),
        ...(sub_category !== undefined && { sub_category: String(sub_category ?? '').trim() }),
        ...(expense_scope !== undefined && { expense_scope: nextExpenseScope as any }),
        ...(uom !== undefined && { uom }),
        ...(purchase_uom !== undefined && { purchase_uom: String(purchase_uom).trim() || 'EA' }),
        ...(issue_uom !== undefined && { issue_uom: String(issue_uom).trim() || 'EA' }),
        ...(pack_size !== undefined && { pack_size: normalizePackSize(pack_size) }),
        ...(default_vendor_id !== undefined && { default_vendor_id: default_vendor_id || null }),
        ...(default_treatment_type_id !== undefined && { default_treatment_type_id: default_treatment_type_id || null }),
        ...(diaper_companion_for_wards !== undefined && { diaper_companion_for_wards: !!diaper_companion_for_wards }),
        ...(min_order_qty !== undefined && { min_order_qty }),
        ...(is_regular_order !== undefined && { is_regular_order }),
        ...(reorder_days_threshold !== undefined && { reorder_days_threshold }),
        ...(is_active !== undefined && { is_active }),
      } as any,
    });
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'items', entity_id: after.id, before, after });
    res.json(after);
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

router.delete('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const before = await prisma.item.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: '품목을 찾을 수 없습니다.' });
    await prisma.item.update({ where: { id: req.params.id }, data: { deleted_at: new Date(), is_active: false } });
    await audit({ actor_user_id: req.user!.id, action: 'SOFT_DELETE', entity_type: 'items', entity_id: req.params.id, before });
    res.json({ message: '삭제되었습니다.' });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// 이미지 업로드
router.post('/:id/image', requirePermission('BASIC_MANAGE'), uploadImage.single('image'), async (req: AuthRequest, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '이미지가 없습니다.' });
    const image_url = `/uploads/items/${req.file.filename}`;
    await prisma.item.update({ where: { id: req.params.id }, data: { image_url } as any });
    res.json({ image_url });
  } catch (e: any) { console.error(e); res.status(500).json({ error: e.message || '서버 오류' }); }
});

// 이미지 삭제
router.delete('/:id/image', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const item = await prisma.item.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: '품목을 찾을 수 없습니다.' });
    const oldUrl = (item as any).image_url;
    if (oldUrl) {
      const baseDir = path.resolve(process.env.USER_DATA_PATH || '.');
      const filePath = path.resolve(baseDir, oldUrl);
      if (filePath.startsWith(baseDir) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await prisma.item.update({ where: { id: req.params.id }, data: { image_url: null } as any });
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: '서버 오류' }); }
});

// 업체 매핑
router.put('/:id/vendors', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  const { vendor_maps } = req.body; // [{ vendor_id, priority }]
  try {
    await prisma.itemVendorMap.deleteMany({ where: { item_id: req.params.id } });
    if (Array.isArray(vendor_maps)) {
      for (const vm of vendor_maps) {
        await prisma.itemVendorMap.create({
          data: { id: uuidv4(), item_id: req.params.id, vendor_id: vm.vendor_id, priority: vm.priority ?? 1 },
        });
      }
    }
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'item_vendor_map', entity_id: req.params.id, after: { vendor_maps } });
    res.json({ message: '업체 매핑이 저장되었습니다.' });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// 가격 이력
router.post('/:id/price', requirePermission('BASIC_MANAGE', 'PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { vendor_id, price, effective_from, source } = req.body;
  if (!vendor_id || !price) return res.status(400).json({ error: '업체와 단가는 필수입니다.' });
  try {
    // 이전 가격 이력의 effective_to 마감
    await prisma.priceHistory.updateMany({
      where: { item_id: req.params.id, vendor_id, effective_to: null },
      data: { effective_to: new Date(effective_from ?? new Date()) },
    });
    const ph = await prisma.priceHistory.create({
      data: {
        id: uuidv4(),
        item_id: req.params.id,
        vendor_id,
        price,
        effective_from: effective_from ? new Date(effective_from) : new Date(),
        source: source ?? 'MANUAL',
      },
    });
    await audit({ actor_user_id: req.user!.id, action: 'CREATE', entity_type: 'price_history', entity_id: ph.id, after: ph });
    res.status(201).json(ph);
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: '해당 날짜의 가격 이력이 이미 존재합니다.' });
    res.status(500).json({ error: '서버 오류' });
  }
});

// 엑셀 템플릿 다운로드 — export와 동일한 컬럼 구조 (그대로 import 가능)
router.get('/import/template', requirePermission('BASIC_MANAGE'), (_req, res) => {
  const wb = XLSX.utils.book_new();
  const headers = [['품목코드*', '품목명*', '발주단위*', '불출단위*', '대분류', '중분류', '소분류*', '비용구분', '포장변환비율', '최소발주수량', '재주문기준일', '정기여부', '기본업체코드', '최신단가', '재고수량', '상태']];
  const sample = [['MED-100', '예시품목', '박스', '개', '의료소모품', '주사·수액', '주사·수액', '환자직접비', 100, 1, 7, '정기', 'V001', '', '', '활성']];
  const ws = XLSX.utils.aoa_to_sheet([...headers, ...sample]);
  ws['!cols'] = [16,24,10,10,12,14,18,12,12,12,12,10,14,12,10,8].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, '품목등록양식');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="item_import_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// 엑셀 대량 등록
router.post('/import', requirePermission('BASIC_MANAGE'), upload.single('file'), async (req: AuthRequest, res) => {
  if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    // 헤더 행(0번) 제외하고 데이터 행 처리
    const dataRows = rows.slice(1).filter(r => r.some((c: any) => c !== ''));

    // 업체코드/업체명 → ID 매칭 미리 로드 (이름은 중복 가능 → 배열로)
    const vendors = await prisma.vendor.findMany({ where: { deleted_at: null } });
    const vendorByCode: Record<string, string> = {};
    const vendorByName: Record<string, string[]> = {};
    for (const v of vendors) {
      vendorByCode[v.code] = v.id;
      const key = v.name.trim();
      if (key) (vendorByName[key] ||= []).push(v.id);
    }
    const resolveVendor = (input: string): { id: string | null; error?: string } => {
      if (!input) return { id: null };
      if (vendorByCode[input]) return { id: vendorByCode[input] };
      const matches = vendorByName[input] ?? [];
      if (matches.length === 1) return { id: matches[0] };
      if (matches.length > 1) return { id: null, error: `업체명 중복: "${input}" (${matches.length}개) — 업체코드로 입력하세요` };
      return { id: null, error: `업체를 찾을 수 없음: "${input}"` };
    };

    // 헤더 자동 감지 — export 양식 또는 구 import 양식 모두 지원
    // export: 품목코드 | 품목명 | 발주단위 | 불출단위 | 대분류 | 중분류 | 소분류 | 비용구분 | 포장변환비율 | 최소발주수량 | 재주문기준일 | 정기여부 | 기본업체코드 | 최신단가 | 재고수량 | 상태
    const headerRow = (rows[0] ?? []).map((c: any) => String(c ?? '').trim());
    const idx = (...labels: string[]): number => {
      for (const label of labels) {
        const i = headerRow.findIndex(h => h === label || h === label + '*' || h.replace(/\*$/, '') === label);
        if (i >= 0) return i;
      }
      return -1;
    };
    const COL = {
      code: idx('품목코드'),
      name: idx('품목명'),
      purchase_uom: idx('발주단위'),
      issue_uom: idx('불출단위'),
      uom_legacy: idx('단위'),
      sub: idx('소분류', '분류'),
      mid: idx('중분류'),
      major: idx('대분류'),
      expense: idx('비용구분'),
      pack_size: idx('포장변환비율', '포장단위'),
      min_order: idx('최소발주수량'),
      reorder_days: idx('재주문기준일'),
      regular: idx('정기여부'),
      vendor: idx('기본업체코드', '기본업체명', '기본업체'),
      price: idx('최신단가', '단가'),
      status: idx('상태'),
    };
    if (COL.code < 0 || COL.name < 0) {
      return res.status(400).json({ error: '엑셀 헤더에 "품목코드"·"품목명" 컬럼이 필요합니다.' });
    }

    const get = (row: any[], i: number) => (i >= 0 ? row[i] : undefined);

    const created: string[] = [];
    const updated: string[] = [];
    const errors: { row: number; message: string }[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNum = i + 2; // 엑셀 행 번호 (헤더=1행)
      const item_code  = String(get(row, COL.code) ?? '').trim();
      const name       = String(get(row, COL.name) ?? '').trim();

      // 단위: 발주/불출 우선, 없으면 단일 단위
      const legacyUom = String(get(row, COL.uom_legacy) ?? '').trim();
      const purchase_uom = String(get(row, COL.purchase_uom) ?? '').trim() || legacyUom;
      const issue_uom    = String(get(row, COL.issue_uom) ?? '').trim() || legacyUom || purchase_uom;
      const uom = issue_uom || purchase_uom;

      // 분류: 소분류 라벨/코드 우선 → 중분류 → 실패 시 오류
      const subRaw = String(get(row, COL.sub) ?? '').trim();
      const midRaw = String(get(row, COL.mid) ?? '').trim();
      const category = resolveCategory(subRaw) ?? resolveCategory(midRaw);

      // 비용구분: 라벨/코드 모두 허용. 없으면 카테고리에서 추정
      const expenseRaw = String(get(row, COL.expense) ?? '').trim();
      const expense_scope = EXPENSE_LABEL_TO_VALUE[expenseRaw] ?? EXPENSE_LABEL_TO_VALUE[expenseRaw.toUpperCase()] ?? (category ? inferExpenseScopeFromCategory(category) : 'PATIENT_DIRECT');

      const packSizeRaw = parseInt(String(get(row, COL.pack_size) ?? '1'));
      const pack_size = normalizePackSize(Number.isFinite(packSizeRaw) ? packSizeRaw : 1);
      const min_order_qty = parseInt(String(get(row, COL.min_order) ?? '1')) || 1;
      const reorder_days_threshold = parseInt(String(get(row, COL.reorder_days) ?? '7')) || 7;
      const regularRaw = String(get(row, COL.regular) ?? 'Y').trim().toUpperCase();
      const is_regular = regularRaw !== 'N' && regularRaw !== '비정기' && regularRaw !== 'NO';
      const vendor_code = String(get(row, COL.vendor) ?? '').trim();
      const priceRaw = String(get(row, COL.price) ?? '').trim().replace(/[,\s원]/g, '');
      const priceNum = priceRaw ? Number(priceRaw) : 0;
      const hasPrice = Number.isFinite(priceNum) && priceNum > 0;
      const statusRaw = String(get(row, COL.status) ?? '').trim();
      const is_active = statusRaw === '' ? true : (statusRaw !== '비활성' && statusRaw.toUpperCase() !== 'N' && statusRaw.toUpperCase() !== 'INACTIVE');

      if (!item_code || !name || !purchase_uom) {
        errors.push({ row: rowNum, message: `필수 항목 누락 (품목코드: ${item_code || '없음'})` });
        continue;
      }
      if (!category) {
        errors.push({ row: rowNum, message: `분류 매칭 실패: "${subRaw || midRaw || '없음'}" — 소분류 라벨 또는 카테고리 코드 필요` });
        continue;
      }

      const vendorResolved = resolveVendor(vendor_code);
      if (vendor_code && !vendorResolved.id) {
        errors.push({ row: rowNum, message: vendorResolved.error ?? `업체 매칭 실패: ${vendor_code}` });
        continue;
      }
      const default_vendor_id = vendorResolved.id;

      try {
        const existing = await prisma.item.findUnique({ where: { item_code } });
        const data = {
          name, category, uom,
          purchase_uom, issue_uom,
          expense_scope: expense_scope as any,
          pack_size, min_order_qty, reorder_days_threshold,
          is_regular_order: is_regular,
          is_active,
          default_vendor_id,
        };
        let itemId: string;
        if (existing) {
          await prisma.item.update({
            where: { id: existing.id },
            data: { ...data, deleted_at: null } as any,
          });
          itemId = existing.id;
          updated.push(item_code);
        } else {
          const newId = uuidv4();
          await prisma.item.create({
            data: { id: newId, item_code, ...data } as any,
          });
          itemId = newId;
          created.push(item_code);
        }

        // 단가 이력 등록 (업체+단가 모두 있을 때만)
        if (hasPrice) {
          if (!default_vendor_id) {
            errors.push({ row: rowNum, message: `단가(${priceNum})는 입력했지만 기본업체코드가 비어 있어 단가이력 등록을 건너뜀` });
          } else {
            const latest = await prisma.priceHistory.findFirst({
              where: { item_id: itemId, vendor_id: default_vendor_id, effective_to: null },
              orderBy: { effective_from: 'desc' },
            });
            // 동일 업체의 현재 유효 단가와 다를 때만 신규 이력 생성
            if (!latest || Number(latest.price) !== priceNum) {
              const now = new Date();
              if (latest) {
                await prisma.priceHistory.updateMany({
                  where: { item_id: itemId, vendor_id: default_vendor_id, effective_to: null },
                  data: { effective_to: now },
                });
              }
              await prisma.priceHistory.create({
                data: {
                  id: uuidv4(),
                  item_id: itemId,
                  vendor_id: default_vendor_id,
                  price: priceNum,
                  effective_from: now,
                  source: 'MANUAL',
                },
              });
            }
          }
        }
      } catch (e: any) {
        errors.push({ row: rowNum, message: e.message });
      }
    }

    await audit({
      actor_user_id: req.user!.id,
      action: 'IMPORT',
      entity_type: 'items',
      entity_id: 'bulk',
      after: { created: created.length, updated: updated.length, errors: errors.length },
    });

    res.json({ created: created.length, updated: updated.length, skipped: 0, errors });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: '파일 처리 중 오류가 발생했습니다.' });
  }
});

export default router;
