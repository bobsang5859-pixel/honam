import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';

// ─── 분류 (ItemCategoryMaster) ────────────────────────────────────────────────
const itemCategoriesRouter = Router();
itemCategoriesRouter.use(authMiddleware);

itemCategoriesRouter.get('/', async (_req, res) => {
  try {
    const rows = await (prisma as any).itemCategoryMaster.findMany({
      orderBy: [{ sort_order: 'asc' }, { code: 'asc' }],
    });
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

itemCategoriesRouter.post('/', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { code, name, group, sort_order, is_active } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code, name 필수' });
    const row = await (prisma as any).itemCategoryMaster.create({
      data: {
        id: uuidv4(),
        code: String(code).trim().toUpperCase(),
        name: String(name).trim(),
        group: group ?? 'CONSUMABLE',
        sort_order: sort_order != null ? Number(sort_order) : 0,
        is_active: is_active !== false,
      },
    });
    res.status(201).json(row);
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 코드입니다.' });
    console.error(e); res.status(500).json({ error: '서버 오류' });
  }
});

itemCategoriesRouter.put('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { name, group, sort_order, is_active } = req.body;
    const row = await (prisma as any).itemCategoryMaster.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(group !== undefined && { group }),
        ...(sort_order !== undefined && { sort_order: Number(sort_order) }),
        ...(is_active !== undefined && { is_active }),
      },
    });
    res.json(row);
  } catch (e: any) {
    if (e.code === 'P2025') return res.status(404).json({ error: '항목 없음' });
    console.error(e); res.status(500).json({ error: '서버 오류' });
  }
});

itemCategoriesRouter.delete('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    await (prisma as any).itemCategoryMaster.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e: any) {
    if (e.code === 'P2025') return res.status(404).json({ error: '항목 없음' });
    console.error(e); res.status(500).json({ error: '서버 오류' });
  }
});

// ─── 통계카테고리 (StatsCategoryMaster) ──────────────────────────────────────
const statsCategoriesRouter = Router();
statsCategoriesRouter.use(authMiddleware);

statsCategoriesRouter.get('/', async (_req, res) => {
  try {
    const rows = await (prisma as any).statsCategoryMaster.findMany({
      orderBy: [{ sort_order: 'asc' }, { code: 'asc' }],
    });
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

statsCategoriesRouter.post('/', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { code, name, sort_order, is_active } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code, name 필수' });
    const row = await (prisma as any).statsCategoryMaster.create({
      data: {
        id: uuidv4(),
        code: String(code).trim().toUpperCase(),
        name: String(name).trim(),
        sort_order: sort_order != null ? Number(sort_order) : 0,
        is_active: is_active !== false,
      },
    });
    res.status(201).json(row);
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 코드입니다.' });
    console.error(e); res.status(500).json({ error: '서버 오류' });
  }
});

statsCategoriesRouter.put('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { name, sort_order, is_active } = req.body;
    const row = await (prisma as any).statsCategoryMaster.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(sort_order !== undefined && { sort_order: Number(sort_order) }),
        ...(is_active !== undefined && { is_active }),
      },
    });
    res.json(row);
  } catch (e: any) {
    if (e.code === 'P2025') return res.status(404).json({ error: '항목 없음' });
    console.error(e); res.status(500).json({ error: '서버 오류' });
  }
});

statsCategoriesRouter.delete('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    await (prisma as any).statsCategoryMaster.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e: any) {
    if (e.code === 'P2025') return res.status(404).json({ error: '항목 없음' });
    console.error(e); res.status(500).json({ error: '서버 오류' });
  }
});

// ─── 비용구분 (ExpenseScopeMaster) ───────────────────────────────────────────
const expenseScopesRouter = Router();
expenseScopesRouter.use(authMiddleware);

expenseScopesRouter.get('/', async (_req, res) => {
  try {
    const rows = await (prisma as any).expenseScopeMaster.findMany({
      orderBy: [{ sort_order: 'asc' }, { code: 'asc' }],
    });
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

expenseScopesRouter.post('/', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { code, name, sort_order, is_active } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code, name 필수' });
    const row = await (prisma as any).expenseScopeMaster.create({
      data: {
        id: uuidv4(),
        code: String(code).trim().toUpperCase(),
        name: String(name).trim(),
        sort_order: sort_order != null ? Number(sort_order) : 0,
        is_active: is_active !== false,
      },
    });
    res.status(201).json(row);
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 코드입니다.' });
    console.error(e); res.status(500).json({ error: '서버 오류' });
  }
});

expenseScopesRouter.put('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { name, sort_order, is_active } = req.body;
    const row = await (prisma as any).expenseScopeMaster.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(sort_order !== undefined && { sort_order: Number(sort_order) }),
        ...(is_active !== undefined && { is_active }),
      },
    });
    res.json(row);
  } catch (e: any) {
    if (e.code === 'P2025') return res.status(404).json({ error: '항목 없음' });
    console.error(e); res.status(500).json({ error: '서버 오류' });
  }
});

expenseScopesRouter.delete('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    await (prisma as any).expenseScopeMaster.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e: any) {
    if (e.code === 'P2025') return res.status(404).json({ error: '항목 없음' });
    console.error(e); res.status(500).json({ error: '서버 오류' });
  }
});

export default {
  itemCategories:  itemCategoriesRouter,
  statsCategories: statsCategoriesRouter,
  expenseScopes:   expenseScopesRouter,
};
