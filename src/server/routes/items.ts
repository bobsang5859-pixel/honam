import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import * as XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';
import { ALL_CATEGORY_VALUES, ITEM_EXPENSE_SCOPES, ITEM_STATS_BUCKETS } from '../../shared/types';

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
const VALID_STATS_BUCKETS = ITEM_STATS_BUCKETS.map(x => x.value);
const VALID_EXPENSE_SCOPES = ITEM_EXPENSE_SCOPES.map(x => x.value);
const normalizeCategory = (value?: string) => {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'MEDICAL') return 'MEDICAL_FIXED';
  return VALID_CATEGORIES.includes(normalized) ? normalized : 'MEDICAL_FIXED';
};
const inferStatsBucket = (category: string, name?: string) => {
  const cat = String(category || '').toUpperCase();
  const text = String(name ?? '').toLowerCase();
  if (cat === 'GENERAL_SERVICE') return 'FOOD';
  if (cat === 'OFFICE_SUPPLY' || cat === 'OFFICE_SEMI') return 'OFFICE';
  if (/기저귀|diaper/i.test(text)) return 'DIAPER_CARE';
  if (cat.startsWith('GENERAL_')) return 'GENERAL';
  if (cat.startsWith('MEDICAL_')) return 'MEDICAL';
  return 'MEDICAL';
};
const inferExpenseScope = (statsBucket: string) => {
  if (statsBucket === 'OFFICE' || statsBucket === 'FOOD') return 'OPS_INDIRECT';
  return 'PATIENT_DIRECT';
};
const normalizeStatsBucket = (value: any, category: string, name?: string) => {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (VALID_STATS_BUCKETS.includes(normalized as any)) return normalized;
  return inferStatsBucket(category, name);
};
const normalizeExpenseScope = (value: any, statsBucket: string) => {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (VALID_EXPENSE_SCOPES.includes(normalized as any)) return normalized;
  return inferExpenseScope(statsBucket);
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
      stats_bucket: (it as any).stats_bucket ?? inferStatsBucket(it.category, it.name),
      expense_scope: (it as any).expense_scope ?? inferExpenseScope((it as any).stats_bucket ?? inferStatsBucket(it.category, it.name)),
      uom: it.uom,
      pack_size: it.pack_size,
      default_vendor_id: it.default_vendor_id,
      default_vendor_name: it.default_vendor?.name ?? null,
      min_order_qty: it.min_order_qty,
      is_regular_order: it.is_regular_order,
      reorder_days_threshold: it.reorder_days_threshold,
      is_active: it.is_active,
      latest_price: it.price_history[0] ? Number(it.price_history[0].price) : 0,
      on_hand_qty: it.inventory.reduce((s, inv) => s + Number(inv.on_hand_qty), 0),
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
        inventory: true,
      },
      orderBy: { item_code: 'asc' },
    });

    const headers = ['품목코드', '품목명', '단위', '분류', '통계카테고리', '비용구분', '포장단위', '최소발주수량', '재주문기준일', '정기여부', '기본업체코드', '최신단가', '재고수량', '상태'];
    const rows = items.map(it => {
      const statsBucket = (it as any).stats_bucket ?? inferStatsBucket(it.category, it.name);
      const expenseScope = (it as any).expense_scope ?? inferExpenseScope(statsBucket);
      return [
        it.item_code,
        it.name,
        it.uom,
        it.category,
        statsBucket,
        expenseScope,
        it.pack_size,
        it.min_order_qty,
        it.reorder_days_threshold,
        it.is_regular_order ? 'Y' : 'N',
        (it.default_vendor as any)?.code ?? '',
        it.price_history[0] ? Number(it.price_history[0].price) : '',
        it.inventory.reduce((s: number, inv: any) => s + Number(inv.on_hand_qty), 0),
        it.is_active ? '활성' : '비활성',
      ];
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = [16, 24, 8, 16, 16, 14, 10, 12, 12, 10, 14, 12, 10, 8].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, '품목목록');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="items_${today}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const item = await prisma.item.findUnique({
      where: { id: req.params.id },
      include: {
        default_vendor: true,
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
  const { item_code, name, category, stats_bucket, expense_scope, uom, pack_size, default_vendor_id, min_order_qty, is_regular_order, reorder_days_threshold } = req.body;
  if (!item_code || !name) return res.status(400).json({ error: '품목코드와 이름은 필수입니다.' });
  try {
    const normalizedCategory = normalizeCategory(category);
    const normalizedStatsBucket = normalizeStatsBucket(stats_bucket, normalizedCategory, name);
    const normalizedExpenseScope = normalizeExpenseScope(expense_scope, normalizedStatsBucket);
    const item = await prisma.item.create({
      data: {
        id: uuidv4(),
        item_code,
        name,
        category: normalizedCategory,
        stats_bucket: normalizedStatsBucket as any,
        expense_scope: normalizedExpenseScope as any,
        uom: uom ?? 'EA',
        pack_size: pack_size ?? 1,
        default_vendor_id: default_vendor_id || null,
        min_order_qty: min_order_qty ?? 1,
        is_regular_order: is_regular_order ?? true,
        reorder_days_threshold: reorder_days_threshold ?? 7,
      },
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
    const { name, category, stats_bucket, expense_scope, uom, pack_size, default_vendor_id, min_order_qty, is_regular_order, reorder_days_threshold, is_active } = req.body;
    const nextCategory = category !== undefined ? normalizeCategory(category) : before.category;
    const nextName = name !== undefined ? name : before.name;
    const nextStatsBucket = stats_bucket !== undefined
      ? normalizeStatsBucket(stats_bucket, nextCategory, nextName)
      : ((before as any).stats_bucket ?? inferStatsBucket(nextCategory, nextName));
    const nextExpenseScope = expense_scope !== undefined
      ? normalizeExpenseScope(expense_scope, nextStatsBucket)
      : ((before as any).expense_scope ?? inferExpenseScope(nextStatsBucket));
    const after = await prisma.item.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name }),
        ...(category !== undefined && { category: nextCategory }),
        ...(stats_bucket !== undefined && { stats_bucket: nextStatsBucket as any }),
        ...(expense_scope !== undefined && { expense_scope: nextExpenseScope as any }),
        ...(uom !== undefined && { uom }),
        ...(pack_size !== undefined && { pack_size }),
        ...(default_vendor_id !== undefined && { default_vendor_id: default_vendor_id || null }),
        ...(min_order_qty !== undefined && { min_order_qty }),
        ...(is_regular_order !== undefined && { is_regular_order }),
        ...(reorder_days_threshold !== undefined && { reorder_days_threshold }),
        ...(is_active !== undefined && { is_active }),
      },
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

// 엑셀 템플릿 다운로드
router.get('/import/template', requirePermission('BASIC_MANAGE'), (_req, res) => {
  const wb = XLSX.utils.book_new();
  const headers = [['품목코드*', '품목명*', '단위*', '분류', '포장단위', '최소발주수량', '재주문기준일', '정기여부(Y/N)', '기본업체코드']];
  const sample = [['MED-100', '예시품목', 'EA', 'MEDICAL_FIXED', 1, 1, 7, 'Y', 'V001']];
  const ws = XLSX.utils.aoa_to_sheet([...headers, ...sample]);
  ws['!cols'] = [16,24,8,12,10,12,12,14,14].map(w => ({ wch: w }));
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

    // 업체코드 → ID 맵 미리 로드
    const vendors = await prisma.vendor.findMany({ where: { deleted_at: null } });
    const vendorMap: Record<string, string> = {};
    for (const v of vendors) vendorMap[v.code] = v.id;

    const created: string[] = [];
    const skipped: string[] = [];
    const errors: { row: number; message: string }[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNum = i + 2; // 엑셀 행 번호 (헤더=1행)
      const item_code  = String(row[0] ?? '').trim();
      const name       = String(row[1] ?? '').trim();
      const uom        = String(row[2] ?? '').trim();
      const rawCategory = String(row[3] ?? '').trim().toUpperCase();
      const category = rawCategory === 'MEDICAL'
        ? 'MEDICAL_FIXED'
        : (rawCategory || 'MEDICAL_FIXED');
      const stats_bucket = inferStatsBucket(category, name);
      const expense_scope = inferExpenseScope(stats_bucket);
      const pack_size  = parseInt(row[4]) || 1;
      const min_order_qty = parseInt(row[5]) || 1;
      const reorder_days_threshold = parseInt(row[6]) || 7;
      const is_regular = String(row[7] ?? 'Y').trim().toUpperCase() !== 'N';
      const vendor_code = String(row[8] ?? '').trim();

      if (!item_code || !name || !uom) {
        errors.push({ row: rowNum, message: `필수 항목 누락 (품목코드: ${item_code || '없음'})` });
        continue;
      }
      if (!VALID_CATEGORIES.includes(category)) {
        errors.push({ row: rowNum, message: `분류 오류: ${category} (유효한 카테고리 코드 필요)` });
        continue;
      }

      const default_vendor_id = vendor_code ? (vendorMap[vendor_code] ?? null) : null;
      if (vendor_code && !default_vendor_id) {
        errors.push({ row: rowNum, message: `업체코드 없음: ${vendor_code}` });
        continue;
      }

      try {
        await prisma.item.create({
          data: {
            id: uuidv4(), item_code, name, category, uom,
            stats_bucket: stats_bucket as any,
            expense_scope: expense_scope as any,
            pack_size, min_order_qty, reorder_days_threshold,
            is_regular_order: is_regular,
            default_vendor_id,
          },
        });
        created.push(item_code);
      } catch (e: any) {
        if (e.code === 'P2002') {
          skipped.push(item_code);
        } else {
          errors.push({ row: rowNum, message: e.message });
        }
      }
    }

    await audit({
      actor_user_id: req.user!.id,
      action: 'IMPORT',
      entity_type: 'items',
      entity_id: 'bulk',
      after: { created: created.length, skipped: skipped.length, errors: errors.length },
    });

    res.json({ created: created.length, skipped: skipped.length, errors });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: '파일 처리 중 오류가 발생했습니다.' });
  }
});

export default router;
