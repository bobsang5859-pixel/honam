import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import {
  getMajor, MAJOR_GROUP_LABEL, ALL_CATEGORY_VALUES, setUserMidCategories,
} from '../../shared/types';

// ─── 중분류 마스터 (사용자 추가 중분류) ─────────────────────────────────────────
// 기본 27개 중분류는 shared/types 의 MID_CATEGORIES 로 고정(코드·통계 안정).
// 여기서는 사용자가 "분류 관리"에서 추가한 중분류만 item_category_masters 에 저장.
// code 는 대분류 접두어를 포함(MED_/OFF_/EQUIP_/DIAPER_/GEN_) → getMajor·품목코드
// 접두어 로직 변경 없이 통과. major 는 code 접두어로 도출(별도 컬럼 불요).
const itemCategoriesRouter = Router();
itemCategoriesRouter.use(authMiddleware);

const MAJOR_PREFIX: Record<string, string> = {
  MEDICAL: 'MED_', OFFICE: 'OFF_', EQUIPMENT: 'EQUIP_', DIAPER: 'DIAPER_', GENERAL: 'GEN_',
};
const VALID_MAJORS = Object.keys(MAJOR_PREFIX);

// 서버 전역 레지스트리 재적재 — 서버 시작 시 + 모든 변경 후 호출.
// (shared/types 의 getMidCategory/getCategoryLabel/normalizeCategory 가 이 레지스트리를 참조)
export async function reloadUserMidCategories(): Promise<void> {
  try {
    const rows: any[] = await (prisma as any).$queryRawUnsafe(
      `SELECT code, name FROM item_category_masters WHERE is_active = 1`);
    setUserMidCategories(rows.map(r => ({ code: String(r.code), name: String(r.name) })));
  } catch (e) {
    console.error('[reloadUserMidCategories]', e);
  }
}

// 목록 — 사용자 추가 중분류 전체 + 그 분류로 등록된 품목 수
itemCategoriesRouter.get('/', async (_req, res) => {
  try {
    const rows: any[] = await (prisma as any).$queryRawUnsafe(
      `SELECT m.id, m.code, m.name, m.sort_order, m.is_active, m.created_at,
              (SELECT COUNT(*) FROM items i WHERE i.category = m.code AND i.deleted_at IS NULL) AS item_count
         FROM item_category_masters m
        ORDER BY m.code ASC`);
    res.json(rows.map(r => {
      const major = getMajor(String(r.code));
      return {
        ...r,
        is_active: r.is_active === 1 || r.is_active === true,
        item_count: Number(r.item_count || 0),
        major,
        major_label: MAJOR_GROUP_LABEL[major],
      };
    }));
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// 추가 — { name, major }. 코드는 대분류 접두어 + U#### 자동 채번
itemCategoriesRouter.post('/', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    const major = String(req.body?.major ?? '').trim().toUpperCase();
    if (!name) return res.status(400).json({ error: '중분류명은 필수입니다.' });
    if (!VALID_MAJORS.includes(major)) return res.status(400).json({ error: '대분류를 선택하세요.' });
    const prefix = MAJOR_PREFIX[major];
    const rows: any[] = await (prisma as any).$queryRawUnsafe(
      `SELECT code FROM item_category_masters WHERE code LIKE ?`, `${prefix}U%`);
    let maxN = 0;
    for (const r of rows) { const m = /U(\d+)$/.exec(String(r.code)); if (m) maxN = Math.max(maxN, Number(m[1])); }
    const finalCode = `${prefix}U${String(maxN + 1).padStart(4, '0')}`;
    const id = uuidv4();
    await (prisma as any).$executeRawUnsafe(
      `INSERT INTO item_category_masters (id, code, name, "group", mid_code, sort_order, is_active, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, 1, datetime('now'))`,
      id, finalCode, name, major === 'EQUIPMENT' ? 'EQUIPMENT' : 'CONSUMABLE',
      req.body?.sort_order != null ? Number(req.body.sort_order) : 0,
    );
    await reloadUserMidCategories();
    const row: any[] = await (prisma as any).$queryRawUnsafe(`SELECT * FROM item_category_masters WHERE id = ?`, id);
    res.status(201).json(row[0]);
  } catch (e: any) {
    if (String(e?.message || '').includes('UNIQUE')) return res.status(409).json({ error: '이미 존재하는 코드입니다.' });
    console.error(e); res.status(500).json({ error: '서버 오류' });
  }
});

// 수정 — 이름/정렬/사용여부만. 코드·대분류는 불변(통계·품목코드 안정).
itemCategoriesRouter.put('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { name, sort_order, is_active } = req.body;
    const sets: string[] = [];
    const args: any[] = [];
    if (name !== undefined) { sets.push('name = ?'); args.push(String(name).trim()); }
    if (sort_order !== undefined) { sets.push('sort_order = ?'); args.push(Number(sort_order)); }
    if (is_active !== undefined) { sets.push('is_active = ?'); args.push(is_active ? 1 : 0); }
    if (sets.length === 0) return res.status(400).json({ error: '변경할 값이 없습니다.' });
    args.push(req.params.id);
    await (prisma as any).$executeRawUnsafe(
      `UPDATE item_category_masters SET ${sets.join(', ')} WHERE id = ?`, ...args);
    const row: any[] = await (prisma as any).$queryRawUnsafe(`SELECT * FROM item_category_masters WHERE id = ?`, req.params.id);
    if (!row[0]) return res.status(404).json({ error: '항목 없음' });
    await reloadUserMidCategories();
    res.json(row[0]);
  } catch (e: any) {
    console.error(e); res.status(500).json({ error: '서버 오류' });
  }
});

// 삭제 — 이 분류로 등록된 품목이 있으면 move_to(다른 분류 코드)로 일괄 이동 후 삭제.
// 품목이 0개면 바로 삭제. move_to 미지정 + 품목 존재 → 409 (이동대상필요).
itemCategoriesRouter.delete('/:id', requirePermission('BASIC_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const row: any[] = await (prisma as any).$queryRawUnsafe(
      `SELECT code FROM item_category_masters WHERE id = ?`, req.params.id);
    if (!row[0]) return res.status(404).json({ error: '항목 없음' });
    const code = String(row[0].code);
    const used = await prisma.item.count({ where: { category: code, deleted_at: null } });
    if (used > 0) {
      const moveTo = String(req.body?.move_to ?? '').trim().toUpperCase();
      if (!moveTo) {
        return res.status(409).json({
          error: '이동대상필요', item_count: used,
          message: `이 분류로 등록된 품목 ${used}개가 있습니다. 옮길 분류를 선택하세요.`,
        });
      }
      if (moveTo === code) return res.status(400).json({ error: '같은 분류로는 이동할 수 없습니다.' });
      // move_to 유효성: 하드코딩 분류이거나 다른 사용자 중분류여야 함
      if (!ALL_CATEGORY_VALUES.includes(moveTo as any)) {
        const um: any[] = await (prisma as any).$queryRawUnsafe(
          `SELECT 1 FROM item_category_masters WHERE code = ? LIMIT 1`, moveTo);
        if (!um[0]) return res.status(400).json({ error: '이동 대상 분류가 올바르지 않습니다.' });
      }
      await prisma.item.updateMany({ where: { category: code, deleted_at: null }, data: { category: moveTo } });
    }
    await (prisma as any).$executeRawUnsafe(`DELETE FROM item_category_masters WHERE id = ?`, req.params.id);
    await reloadUserMidCategories();
    res.json({ ok: true, moved: used });
  } catch (e: any) {
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
  expenseScopes:   expenseScopesRouter,
};
