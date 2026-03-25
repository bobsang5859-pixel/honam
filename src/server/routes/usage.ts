import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, resolveDeptScope, isCustomMenuUser, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('usage', 'REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN', 'STATS_VIEW'));

const canViewAll = (req: AuthRequest) =>
  isCustomMenuUser(req.user)
    ? resolveDeptScope(req).is_admin
    : (req.user?.permissions.some((p) => ['SYSTEM_ADMIN', 'PURCHASE_MANAGE', 'STATS_VIEW'].includes(p)) ?? false);

async function ensureUsageTable() {
  await (prisma as any).$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      department_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      used_qty REAL NOT NULL DEFAULT 0,
      used_at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      location_id TEXT,
      patient_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    )
  `);
  // 기존 테이블에 patient_id 컬럼 추가 (이미 있으면 무시)
  try {
    await (prisma as any).$executeRawUnsafe(`ALTER TABLE usage_records ADD COLUMN patient_id TEXT`);
  } catch { /* 이미 존재 */ }
  await (prisma as any).$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_usage_records_dept_date ON usage_records(department_id, used_at)`);
  await (prisma as any).$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_usage_records_item_date ON usage_records(item_id, used_at)`);
}

async function pickDeptLocationId(departmentId: string, preferredLocationId?: string | null): Promise<string | null> {
  if (preferredLocationId) {
    const preferred = await prisma.inventoryLocation.findFirst({
      where: { id: preferredLocationId, department_id: departmentId, deleted_at: null, is_active: true },
      select: { id: true },
    });
    if (preferred) return preferred.id;
  }
  const row = await prisma.inventoryLocation.findFirst({
    where: { department_id: departmentId, deleted_at: null, is_active: true },
    orderBy: [{ code: 'asc' }],
    select: { id: true },
  });
  return row?.id ?? null;
}

async function deductDeptInventory(
  tx: any,
  itemId: string,
  departmentId: string,
  qty: number,
): Promise<string> {
  const rows = await tx.inventory.findMany({
    where: {
      item_id: itemId,
      on_hand_qty: { gt: 0 } as any,
      location: { department_id: departmentId, deleted_at: null, is_active: true },
    },
    orderBy: [{ on_hand_qty: 'desc' }],
  });
  const total = rows.reduce((sum: number, r: any) => sum + Number(r.on_hand_qty), 0);
  if (total < qty) throw new Error('재고가 부족합니다.');

  let remain = qty;
  let firstLocationId = rows[0]?.location_id as string | undefined;
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
  return firstLocationId || '';
}

async function addDeptInventory(
  tx: any,
  itemId: string,
  departmentId: string,
  qty: number,
  preferredLocationId?: string | null,
) {
  const locationId = await pickDeptLocationId(departmentId, preferredLocationId);
  if (!locationId) throw new Error('재고 위치가 없어 재고 보정이 불가능합니다.');
  const current = await tx.inventory.findUnique({
    where: { item_id_location_id: { item_id: itemId, location_id: locationId } },
  });
  if (current) {
    await tx.inventory.update({
      where: { item_id_location_id: { item_id: itemId, location_id: locationId } },
      data: { on_hand_qty: Number(current.on_hand_qty) + qty } as any,
    });
  } else {
    await tx.inventory.create({
      data: {
        id: uuidv4(),
        item_id: itemId,
        location_id: locationId,
        on_hand_qty: qty,
        avg_unit_cost: 0,
      } as any,
    });
  }
}

// 공통 헬퍼: 재고 차감 + usage_records INSERT (단건/배치 모두 사용)
async function deductAndInsertUsageRecord(
  tx: any,
  opts: {
    departmentId: string;
    itemId: string;
    usedQty: number;
    usedAt: string;
    note: string;
    patientId: string;
    createdBy: string;
  },
): Promise<{ id: string; location_id: string }> {
  const { departmentId, itemId, usedQty, usedAt, note, patientId, createdBy } = opts;
  const locationId = await deductDeptInventory(tx, itemId, departmentId, usedQty);
  const id = uuidv4();
  await (tx as any).$executeRawUnsafe(
    `INSERT INTO usage_records (id, department_id, item_id, used_qty, used_at, note, location_id, patient_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    id, departmentId, itemId, usedQty, usedAt, note, locationId || '', patientId || null, createdBy,
  );
  return { id, location_id: locationId };
}

// ── GET /usage ───────────────────────────────────────────────────────────────
router.get('/', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN', 'STATS_VIEW'), async (req: AuthRequest, res) => {
  try {
    await ensureUsageTable();
    const deptFilter = String(req.query.department_id ?? '').trim();
    const from = String(req.query.date_from ?? '').trim();
    const to = String(req.query.date_to ?? '').trim();
    const scopeDept = canViewAll(req) ? deptFilter : String(req.user?.department_id ?? '');

    const conditions: string[] = ['ur.deleted_at IS NULL'];
    const params: any[] = [];
    if (scopeDept) { conditions.push('ur.department_id = ?'); params.push(scopeDept); }
    if (from) { conditions.push('ur.used_at >= ?'); params.push(from); }
    if (to) { conditions.push('ur.used_at <= ?'); params.push(to); }
    const whereSql = 'WHERE ' + conditions.join(' AND ');

    const rows = await (prisma as any).$queryRawUnsafe(`
      SELECT ur.*, d.name AS department_name, i.name AS item_name, i.item_code, i.uom,
             u.display_name AS creator_name,
             p.name AS patient_name, p.room_no AS patient_room_no
      FROM usage_records ur
      LEFT JOIN departments d ON d.id = ur.department_id
      LEFT JOIN items i ON i.id = ur.item_id
      LEFT JOIN users u ON u.id = ur.created_by
      LEFT JOIN patients p ON p.id = ur.patient_id
      ${whereSql}
      ORDER BY ur.used_at DESC, ur.created_at DESC
      LIMIT 1000
    `, ...params);
    res.json((rows || []).map((r: any) => ({
      id: r.id,
      department_id: r.department_id,
      department_name: r.department_name ?? null,
      item_id: r.item_id,
      item_name: r.item_name ?? null,
      item_code: r.item_code ?? null,
      uom: r.uom ?? null,
      used_qty: Number(r.used_qty ?? 0),
      used_at: r.used_at,
      note: r.note ?? '',
      location_id: r.location_id ?? null,
      patient_id: r.patient_id ?? null,
      patient_name: r.patient_name ?? null,
      patient_room_no: r.patient_room_no ?? null,
      created_by: r.created_by,
      creator_name: r.creator_name ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /usage (단건) ────────────────────────────────────────────────────────
router.post('/', requirePermission('REQUEST_USE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    await ensureUsageTable();
    const requestedDeptId = String(req.body?.department_id ?? '').trim();
    const departmentId = canViewAll(req) && requestedDeptId ? requestedDeptId : String(req.user?.department_id ?? '');
    const itemId = String(req.body?.item_id ?? '').trim();
    const usedQty = Number(req.body?.used_qty ?? 0);
    const usedAt = String(req.body?.used_at ?? new Date().toISOString().slice(0, 10));
    const note = String(req.body?.note ?? '').trim();
    const patientId = String(req.body?.patient_id ?? '').trim();

    if (!departmentId || !itemId) return res.status(400).json({ error: 'department_id, item_id is required.' });
    if (!Number.isFinite(usedQty) || usedQty <= 0) return res.status(400).json({ error: 'used_qty must be > 0.' });

    const created = await prisma.$transaction(async (tx) => {
      const { id, location_id } = await deductAndInsertUsageRecord(tx, {
        departmentId, itemId, usedQty, usedAt, note, patientId,
        createdBy: req.user?.id ?? '',
      });
      return { id, department_id: departmentId, item_id: itemId, used_qty: usedQty, used_at: usedAt, note, location_id, patient_id: patientId || null };
    });

    await audit({
      actor_user_id: req.user?.id ?? null,
      action: 'CREATE',
      entity_type: 'usage_records',
      entity_id: created.id,
      after: created,
      ip: req.ip ?? '',
    });
    res.status(201).json(created);
  } catch (e: any) {
    res.status(400).json({ error: e.message || '등록에 실패했습니다.' });
  }
});

// ── POST /usage/batch (처치 등록 — 여러 품목 일괄) ───────────────────────────
router.post('/batch', requirePermission('REQUEST_USE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    await ensureUsageTable();
    const requestedDeptId = String(req.body?.department_id ?? '').trim();
    const departmentId = canViewAll(req) && requestedDeptId ? requestedDeptId : String(req.user?.department_id ?? '');
    const patientId = String(req.body?.patient_id ?? '').trim();
    const usedAt = String(req.body?.used_at ?? new Date().toISOString().slice(0, 10));
    const items: { item_id: string; used_qty: number; note: string }[] = req.body?.items ?? [];

    if (!departmentId) return res.status(400).json({ error: 'department_id is required.' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '품목이 없습니다.' });

    const results: any[] = [];
    const errors: { item_id: string; message: string }[] = [];

    for (const item of items) {
      const itemId = String(item.item_id ?? '').trim();
      const usedQty = Number(item.used_qty ?? 0);
      const note = String(item.note ?? '').trim();

      if (!itemId || !Number.isFinite(usedQty) || usedQty <= 0) {
        errors.push({ item_id: itemId, message: '품목 또는 수량이 잘못되었습니다.' });
        continue;
      }

      try {
        const created = await prisma.$transaction(async (tx) => {
          const { id, location_id } = await deductAndInsertUsageRecord(tx, {
            departmentId, itemId, usedQty, usedAt, note, patientId,
            createdBy: req.user?.id ?? '',
          });
          return { id, department_id: departmentId, item_id: itemId, used_qty: usedQty, used_at: usedAt, note, location_id, patient_id: patientId || null };
        });
        results.push(created);
      } catch (e: any) {
        errors.push({ item_id: itemId, message: e.message || '등록 실패' });
      }
    }

    if (results.length > 0) {
      await audit({
        actor_user_id: req.user?.id ?? null,
        action: 'BATCH_CREATE',
        entity_type: 'usage_records',
        entity_id: 'batch',
        after: { created: results.length, patient_id: patientId || null, department_id: departmentId },
        ip: req.ip ?? '',
      });
    }

    res.status(results.length > 0 ? 201 : 400).json({
      created: results.length,
      errors,
      records: results,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message || '일괄 등록에 실패했습니다.' });
  }
});

// ── PUT /usage/:id ────────────────────────────────────────────────────────────
router.put('/:id', requirePermission('REQUEST_USE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    await ensureUsageTable();
    const id = String(req.params.id);
    const rows = await (prisma as any).$queryRawUnsafe(
      `SELECT * FROM usage_records WHERE id = ? AND deleted_at IS NULL LIMIT 1`, id,
    );
    const before = rows?.[0];
    if (!before) return res.status(404).json({ error: 'Usage record not found.' });

    const isAll = canViewAll(req);
    if (!isAll && String(before.department_id) !== String(req.user?.department_id ?? '')) {
      return res.status(403).json({ error: 'No permission.' });
    }

    const nextQty = req.body?.used_qty === undefined ? Number(before.used_qty) : Number(req.body.used_qty);
    const nextUsedAt = String(req.body?.used_at ?? before.used_at);
    const nextNote = String(req.body?.note ?? before.note ?? '');
    if (!Number.isFinite(nextQty) || nextQty <= 0) return res.status(400).json({ error: 'used_qty must be > 0.' });

    const delta = Number(nextQty) - Number(before.used_qty);
    await prisma.$transaction(async (tx) => {
      if (delta > 0) {
        await deductDeptInventory(tx, String(before.item_id), String(before.department_id), delta);
      } else if (delta < 0) {
        await addDeptInventory(tx, String(before.item_id), String(before.department_id), Math.abs(delta), String(before.location_id || ''));
      }
      await (tx as any).$executeRawUnsafe(
        `UPDATE usage_records SET used_qty = ?, used_at = ?, note = ?, updated_at = datetime('now') WHERE id = ?`,
        nextQty, nextUsedAt, nextNote, id,
      );
    });

    await audit({
      actor_user_id: req.user?.id ?? null,
      action: 'UPDATE',
      entity_type: 'usage_records',
      entity_id: id,
      before,
      after: { used_qty: nextQty, used_at: nextUsedAt, note: nextNote },
      ip: req.ip ?? '',
    });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message || '수정에 실패했습니다.' });
  }
});

// ── POST /usage/:id/reverse ───────────────────────────────────────────────────
router.post('/:id/reverse', requirePermission('REQUEST_USE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    await ensureUsageTable();
    const id = String(req.params.id);
    const rows = await (prisma as any).$queryRawUnsafe(
      `SELECT * FROM usage_records WHERE id = ? AND deleted_at IS NULL LIMIT 1`, id,
    );
    const row = rows?.[0];
    if (!row) return res.status(404).json({ error: 'Usage record not found.' });

    const isAll = canViewAll(req);
    if (!isAll && String(row.department_id) !== String(req.user?.department_id ?? '')) {
      return res.status(403).json({ error: 'No permission.' });
    }

    await prisma.$transaction(async (tx) => {
      await addDeptInventory(tx, String(row.item_id), String(row.department_id), Number(row.used_qty), String(row.location_id || ''));
      await (tx as any).$executeRawUnsafe(
        `UPDATE usage_records SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, id,
      );
    });
    await audit({
      actor_user_id: req.user?.id ?? null,
      action: 'REVERSE',
      entity_type: 'usage_records',
      entity_id: id,
      before: row,
      ip: req.ip ?? '',
    });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message || '취소에 실패했습니다.' });
  }
});

export default router;
