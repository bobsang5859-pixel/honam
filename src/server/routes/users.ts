import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';
import { PERM_HIERARCHY } from '../../shared/permissions';

const router = Router();
router.use(authMiddleware);

// 부서에 재고 위치가 없으면 자동 생성 (하위 부서만)
async function ensureInventoryLocation(departmentId: string) {
  const existing = await prisma.inventoryLocation.findFirst({ where: { department_id: departmentId } });
  if (existing) return;
  const dept = await prisma.department.findUnique({ where: { id: departmentId } });
  if (!dept || !dept.parent_id) return; // 상위 부서는 보관함 생성 안 함
  try {
    await prisma.inventoryLocation.create({
      data: { id: uuidv4(), code: dept.code, name: dept.name + ' 보관함', department_id: departmentId },
    });
  } catch {}
}

// GET /api/users/directory — 인증만 필요 (권한 불필요), 특정사용자 선택 UI용
router.get('/directory', async (req: AuthRequest, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { is_active: true, deleted_at: null },
      select: { id: true, display_name: true, department: { select: { name: true } } },
      orderBy: { display_name: 'asc' },
    });
    res.json(users.map((u: any) => ({
      id: u.id,
      display_name: u.display_name,
      department_name: u.department?.name ?? '',
    })));
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

router.get('/', requirePermission('BASIC_MANAGE'), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { deleted_at: null },
      include: {
        department: true,
        user_roles: { include: { role: true } },
      },
      orderBy: { display_name: 'asc' },
    });
    const result = users.map(u => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      department_id: u.department_id,
      department_name: u.department?.name ?? null,
      is_active: u.is_active,
      last_login_at: u.last_login_at,
      roles: u.user_roles.map(ur => ur.role.name),
      menu_permissions: (u as any).menu_permissions ? JSON.parse((u as any).menu_permissions) : null,
      direct_permissions: (u as any).direct_permissions ? JSON.parse((u as any).direct_permissions) : null,
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

router.post('/', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  const { username, password, display_name, department_id, role_names, role_ids, direct_permissions } = req.body;
  if (!username || !password || !display_name) return res.status(400).json({ error: '필수 항목을 입력하세요.' });
  try {
    const hash = await bcrypt.hash(password, 10);

    // 부서 소속 신규 사용자에게 부서원 기본 권한 자동 부여
    // — UI는 개별 권한(하위 키) 모델을 사용하므로 묶음 키(REQUEST_USE) 대신 하위 4개를 직접 추가
    // — ALL_DEPT_COMMON 메뉴 그룹이 요구하는 최소 권한
    const baseDirectPerms = Array.isArray(direct_permissions) ? [...direct_permissions] : [];
    if (department_id) {
      const requestUseChildren = PERM_HIERARCHY['REQUEST_USE'] ?? [];
      for (const k of requestUseChildren) {
        if (!baseDirectPerms.includes(k)) baseDirectPerms.push(k);
      }
    }

    const user = await prisma.user.create({
      data: {
        id: uuidv4(), username, password_hash: hash, display_name,
        department_id: department_id || null,
        direct_permissions: baseDirectPerms.length > 0 ? JSON.stringify(baseDirectPerms) : null,
      },
    });
    // Support both role_ids (array of IDs) and role_names (array of names)
    if (Array.isArray(role_ids) && role_ids.length > 0) {
      for (const rid of role_ids) {
        const role = await prisma.role.findUnique({ where: { id: rid } });
        if (role) await prisma.userRole.create({ data: { user_id: user.id, role_id: role.id } });
      }
    } else if (Array.isArray(role_names) && role_names.length > 0) {
      for (const rn of role_names) {
        const role = await prisma.role.findFirst({ where: { name: rn } });
        if (role) await prisma.userRole.create({ data: { user_id: user.id, role_id: role.id } });
      }
    }
    if (department_id) await ensureInventoryLocation(department_id);
    await audit({ actor_user_id: req.user!.id, action: 'CREATE', entity_type: 'users', entity_id: user.id, after: { ...user, password_hash: '***' } });
    res.status(201).json({ ...user, password_hash: undefined });
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: '이미 존재하는 아이디입니다.' });
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/:id', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  const { display_name, department_id, is_active, password, role_names, role_ids, menu_permissions, direct_permissions } = req.body;
  try {
    const before = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    const updateData: any = {
      ...(display_name !== undefined && { display_name }),
      ...(department_id !== undefined && { department_id: department_id || null }),
      ...(is_active !== undefined && { is_active }),
      ...('menu_permissions' in req.body && {
        menu_permissions: menu_permissions === null ? null : JSON.stringify(menu_permissions),
      }),
      ...('direct_permissions' in req.body && {
        direct_permissions: direct_permissions === null ? null : JSON.stringify(direct_permissions),
      }),
    };
    if (password) {
      updateData.password_hash = await bcrypt.hash(password, 10);
    }
    const after = await prisma.user.update({ where: { id: req.params.id }, data: updateData });
    // 역할 재설정 (role_ids 또는 role_names)
    if (Array.isArray(role_ids)) {
      await prisma.userRole.deleteMany({ where: { user_id: req.params.id } });
      for (const rid of role_ids) {
        const role = await prisma.role.findUnique({ where: { id: rid } });
        if (role) await prisma.userRole.create({ data: { user_id: req.params.id, role_id: role.id } });
      }
    } else if (Array.isArray(role_names)) {
      await prisma.userRole.deleteMany({ where: { user_id: req.params.id } });
      for (const rn of role_names) {
        const role = await prisma.role.findFirst({ where: { name: rn } });
        if (role) await prisma.userRole.create({ data: { user_id: req.params.id, role_id: role.id } });
      }
    }
    if (department_id) await ensureInventoryLocation(department_id);
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'users', entity_id: after.id, before: { ...before, password_hash: '***' }, after: { ...after, password_hash: '***' } });
    res.json({ ...after, password_hash: undefined });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

router.put('/:id/password', async (req: AuthRequest, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: '새 비밀번호는 6자 이상이어야 합니다.' });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    const isSelf = req.user?.id === req.params.id;
    const isAdmin = req.user?.permissions.includes('BASIC_MANAGE');
    if (!isSelf && !isAdmin) return res.status(403).json({ error: '권한이 없습니다.' });
    if (isSelf && current_password) {
      const valid = await bcrypt.compare(current_password, user.password_hash);
      if (!valid) return res.status(400).json({ error: '현재 비밀번호가 올바르지 않습니다.' });
    }
    const hash = await bcrypt.hash(new_password, 10);
    await prisma.user.update({ where: { id: req.params.id }, data: { password_hash: hash } });
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'users', entity_id: req.params.id, reason: '비밀번호 변경' });
    res.json({ message: '비밀번호가 변경되었습니다.' });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

router.delete('/:id', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const before = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    if (req.user?.id === req.params.id) return res.status(400).json({ error: '자기 자신을 삭제할 수 없습니다.' });
    const targetPerms: string[] = (() => { try { return JSON.parse((before as any).direct_permissions ?? '[]'); } catch { return []; } })();
    if (targetPerms.includes('SYSTEM_ADMIN')) return res.status(403).json({ error: '시스템 관리자는 삭제할 수 없습니다.' });
    await prisma.user.update({ where: { id: req.params.id }, data: { deleted_at: new Date(), is_active: false } });
    await audit({ actor_user_id: req.user!.id, action: 'SOFT_DELETE', entity_type: 'users', entity_id: req.params.id });
    res.json({ message: '삭제되었습니다.' });
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

router.get('/roles', async (req, res) => {
  try {
    const roles = await prisma.role.findMany({ where: { deleted_at: null }, orderBy: { name: 'asc' } });
    res.json(roles);
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

export default router;
