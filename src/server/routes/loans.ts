import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, resolveDeptScope, isCustomMenuUser, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('loans', 'REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'));

const canViewAll = (req: AuthRequest) =>
  isCustomMenuUser(req.user)
    ? resolveDeptScope(req).is_admin
    : (req.user?.permissions.some((p) => ['SYSTEM_ADMIN', 'PURCHASE_MANAGE'].includes(p)) ?? false);

async function ensureLoanTable() {
  await (prisma as any).$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS department_loans (
      id TEXT PRIMARY KEY,
      from_department_id TEXT NOT NULL,
      to_department_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      loaned_at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reversed_at TEXT,
      reversed_by TEXT,
      deleted_at TEXT
    )
  `);
  await (prisma as any).$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_department_loans_date ON department_loans(loaned_at)`);
  await (prisma as any).$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_department_loans_depts ON department_loans(from_department_id, to_department_id)`);
}

async function pickDeptLocationId(departmentId: string): Promise<string | null> {
  const row = await prisma.inventoryLocation.findFirst({
    where: { department_id: departmentId, deleted_at: null, is_active: true },
    orderBy: [{ code: 'asc' }],
    select: { id: true },
  });
  if (row) return row.id;

  // 보관함 없으면 자동 생성
  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { name: true },
  });
  const loc = await prisma.inventoryLocation.create({
    data: {
      id: uuidv4(),
      code: `DEPT-${departmentId.slice(0, 8).toUpperCase()}`,
      name: `${dept?.name ?? '부서'} 보관함`,
      department_id: departmentId,
      is_active: true,
    } as any,
  });
  return loc.id;
}

async function moveOutFromDepartment(tx: any, itemId: string, departmentId: string, qty: number) {
  const rows = await tx.inventory.findMany({
    where: {
      item_id: itemId,
      on_hand_qty: { gt: 0 } as any,
      location: { department_id: departmentId, deleted_at: null, is_active: true },
    },
    orderBy: [{ on_hand_qty: 'desc' }],
  });
  const total = rows.reduce((sum: number, r: any) => sum + Number(r.on_hand_qty), 0);
  if (total < qty) throw new Error('출발 부서 재고가 부족합니다.');
  let remain = qty;
  for (const row of rows) {
    if (remain <= 0) break;
    const current = Number(row.on_hand_qty);
    const take = Math.min(current, remain);
    if (take <= 0) continue;
    await tx.inventory.update({
      where: { item_id_location_id: { item_id: itemId, location_id: row.location_id } },
      data: { on_hand_qty: current - take } as any,
    });
    remain -= take;
  }
}

async function moveInToDepartment(tx: any, itemId: string, departmentId: string, qty: number) {
  const locationId = await pickDeptLocationId(departmentId);
  if (!locationId) throw new Error('도착 부서 재고 위치가 없습니다.');
  // 정책: 빌려가는 부서의 재고는 "빌린 수량으로 절대값 set" 한다.
  // (B는 부족해서 빌리는 것이므로 시스템상 기존 값은 신뢰하지 않고 빌린 수량으로 덮어씀)
  // 가산(+qty) 이 아닌 set 이라는 점이 일반 입고와 다름.
  await tx.inventory.upsert({
    where: { item_id_location_id: { item_id: itemId, location_id: locationId } },
    update: { on_hand_qty: qty } as any,
    create: {
      id: uuidv4(),
      item_id: itemId,
      location_id: locationId,
      on_hand_qty: qty,
      avg_unit_cost: 0,
    } as any,
  });
}

router.get('/', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    await ensureLoanTable();
    const status = String(req.query.status ?? '').trim();
    const scopeDept = String(req.user?.department_id ?? '');
    const all = canViewAll(req);
    const conditions: string[] = ['dl.deleted_at IS NULL'];
    const params: any[] = [];
    if (status) { conditions.push('dl.status = ?'); params.push(status); }
    if (!all) { conditions.push('(dl.from_department_id = ? OR dl.to_department_id = ?)'); params.push(scopeDept, scopeDept); }
    const whereSql = 'WHERE ' + conditions.join(' AND ');

    const rows = await (prisma as any).$queryRawUnsafe(`
      SELECT dl.*, fi.name AS from_department_name, ti.name AS to_department_name,
             i.name AS item_name, i.item_code, i.uom, i.purchase_uom, i.issue_uom, i.pack_size,
             u.display_name AS creator_name
      FROM department_loans dl
      LEFT JOIN departments fi ON fi.id = dl.from_department_id
      LEFT JOIN departments ti ON ti.id = dl.to_department_id
      LEFT JOIN items i ON i.id = dl.item_id
      LEFT JOIN users u ON u.id = dl.created_by
      ${whereSql}
      ORDER BY dl.loaned_at DESC, dl.created_at DESC
      LIMIT 1000
    `, ...params);
    res.json((rows || []).map((r: any) => ({
      id: r.id,
      from_department_id: r.from_department_id,
      from_department_name: r.from_department_name ?? null,
      to_department_id: r.to_department_id,
      to_department_name: r.to_department_name ?? null,
      item_id: r.item_id,
      item_name: r.item_name ?? null,
      item_code: r.item_code ?? null,
      uom: r.uom ?? null,
      purchase_uom: r.purchase_uom ?? r.uom ?? null,
      issue_uom: r.issue_uom ?? r.uom ?? null,
      pack_size: Number(r.pack_size ?? 1),
      qty: Number(r.qty ?? 0),
      loaned_at: r.loaned_at,
      note: r.note ?? '',
      status: r.status,
      created_by: r.created_by,
      creator_name: r.creator_name ?? null,
      created_at: r.created_at,
      reversed_at: r.reversed_at ?? null,
      reversed_by: r.reversed_by ?? null,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', requirePermission('REQUEST_USE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    await ensureLoanTable();
    const fromDepartmentId = String(req.body?.from_department_id ?? '').trim();
    const toDepartmentId = String(req.body?.to_department_id ?? '').trim();
    const itemId = String(req.body?.item_id ?? '').trim();
    const qty = Number(req.body?.qty ?? 0);
    const loanedAt = String(req.body?.loaned_at ?? new Date().toISOString().slice(0, 10));
    const note = String(req.body?.note ?? '').trim();
    if (!fromDepartmentId || !toDepartmentId || !itemId) return res.status(400).json({ error: '필수값이 누락되었습니다' });
    if (fromDepartmentId === toDepartmentId) return res.status(400).json({ error: '같은 부서끼리는 등록할 수 없습니다' });
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty must be > 0.' });

    const all = canViewAll(req);
    const userDept = String(req.user?.department_id ?? '');
    // 빌려주는 쪽(from)에서만 등록 가능 — 받는 쪽 등록은 차단
    if (!all && userDept !== fromDepartmentId) {
      return res.status(403).json({ error: '내 부서가 빌려주는 경우만 등록할 수 있습니다.' });
    }

    const id = uuidv4();
    await prisma.$transaction(async (tx) => {
      await moveOutFromDepartment(tx, itemId, fromDepartmentId, qty);
      await moveInToDepartment(tx, itemId, toDepartmentId, qty);
      await (tx as any).$executeRawUnsafe(
        `INSERT INTO department_loans (id, from_department_id, to_department_id, item_id, qty, loaned_at, note, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, datetime('now'))`,
        id, fromDepartmentId, toDepartmentId, itemId, qty, loanedAt, note, String(req.user?.id ?? ''),
      );
    });
    await audit({
      actor_user_id: req.user?.id ?? null,
      action: 'CREATE',
      entity_type: 'department_loans',
      entity_id: id,
      after: { from_department_id: fromDepartmentId, to_department_id: toDepartmentId, item_id: itemId, qty, loaned_at: loanedAt },
      ip: req.ip ?? '',
    });
    res.status(201).json({ id });
  } catch (e: any) {
    res.status(400).json({ error: e.message || '대여 등록에 실패했습니다.' });
  }
});

// ── POST /loans/batch — 한 부서에 여러 품목 일괄 대여 ─────────────────────
// body: { from_department_id, to_department_id, loaned_at?, items: [{ item_id, qty, note? }] }
router.post('/batch', requirePermission('REQUEST_USE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    await ensureLoanTable();
    const fromDepartmentId = String(req.body?.from_department_id ?? '').trim();
    const toDepartmentId = String(req.body?.to_department_id ?? '').trim();
    const loanedAt = String(req.body?.loaned_at ?? new Date().toISOString().slice(0, 10));
    const items: Array<{ item_id: string; qty: number; note?: string }> = req.body?.items ?? [];

    if (!fromDepartmentId || !toDepartmentId) return res.status(400).json({ error: '필수값이 누락되었습니다' });
    if (fromDepartmentId === toDepartmentId) return res.status(400).json({ error: '같은 부서끼리는 등록할 수 없습니다' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '등록할 품목이 없습니다' });

    const all = canViewAll(req);
    const userDept = String(req.user?.department_id ?? '');
    // 빌려주는 쪽(from)에서만 등록 가능
    if (!all && userDept !== fromDepartmentId) {
      return res.status(403).json({ error: '내 부서가 빌려주는 경우만 등록할 수 있습니다.' });
    }

    const results: any[] = [];
    const errors: Array<{ item_id: string; message: string }> = [];

    for (const it of items) {
      const itemId = String(it.item_id ?? '').trim();
      const qty = Number(it.qty ?? 0);
      const note = String(it.note ?? '').trim();
      if (!itemId || !Number.isFinite(qty) || qty <= 0) {
        errors.push({ item_id: itemId, message: '품목 또는 수량이 잘못되었습니다.' });
        continue;
      }
      try {
        const id = uuidv4();
        await prisma.$transaction(async (tx) => {
          await moveOutFromDepartment(tx, itemId, fromDepartmentId, qty);
          await moveInToDepartment(tx, itemId, toDepartmentId, qty);
          await (tx as any).$executeRawUnsafe(
            `INSERT INTO department_loans (id, from_department_id, to_department_id, item_id, qty, loaned_at, note, status, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, datetime('now'))`,
            id, fromDepartmentId, toDepartmentId, itemId, qty, loanedAt, note, String(req.user?.id ?? ''),
          );
        });
        results.push({ id, item_id: itemId, qty });
      } catch (e: any) {
        errors.push({ item_id: itemId, message: e.message || '등록 실패' });
      }
    }

    if (results.length > 0) {
      await audit({
        actor_user_id: req.user?.id ?? null,
        action: 'BATCH_CREATE',
        entity_type: 'department_loans',
        entity_id: 'batch',
        after: { created: results.length, from_department_id: fromDepartmentId, to_department_id: toDepartmentId },
        ip: req.ip ?? '',
      });
    }

    res.status(results.length > 0 ? 201 : 400).json({
      created: results.length,
      errors,
      records: results,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message || '일괄 대여에 실패했습니다.' });
  }
});

router.post('/:id/reverse', requirePermission('REQUEST_USE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    await ensureLoanTable();
    const id = String(req.params.id);
    const rows = await (prisma as any).$queryRawUnsafe(
      `SELECT * FROM department_loans WHERE id = ? AND deleted_at IS NULL LIMIT 1`, id,
    );
    const row = rows?.[0];
    if (!row) return res.status(404).json({ error: 'Loan not found.' });
    if (String(row.status) !== 'ACTIVE') return res.status(400).json({ error: '이미 반납되었거나 비활성 상태입니다' });

    const all = canViewAll(req);
    const userDept = String(req.user?.department_id ?? '');
    if (!all && userDept && userDept !== String(row.from_department_id) && userDept !== String(row.to_department_id)) {
      return res.status(403).json({ error: 'No permission.' });
    }

    await prisma.$transaction(async (tx) => {
      await moveOutFromDepartment(tx, String(row.item_id), String(row.to_department_id), Number(row.qty));
      await moveInToDepartment(tx, String(row.item_id), String(row.from_department_id), Number(row.qty));
      await (tx as any).$executeRawUnsafe(
        `UPDATE department_loans SET status = 'REVERSED', reversed_at = datetime('now'), reversed_by = ? WHERE id = ?`,
        String(req.user?.id ?? ''), id,
      );
    });

    await audit({
      actor_user_id: req.user?.id ?? null,
      action: 'REVERSE',
      entity_type: 'department_loans',
      entity_id: id,
      before: row,
      ip: req.ip ?? '',
    });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message || '반납에 실패했습니다.' });
  }
});

export default router;


