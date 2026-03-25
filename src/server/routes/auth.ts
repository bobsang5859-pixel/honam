import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../index';
import { generateToken, authMiddleware, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';
import { buildMenuScopesForUser } from '../utils/menu-scope';
import { computeEffectiveMenuPolicyForUser } from '../services/menu-policy-service';

const router = Router();

function parseMenuPermissions(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((v) => String(v || '').trim()).filter(Boolean);
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((v) => String(v || '').trim()).filter(Boolean);
  } catch {
    return null;
  }
}

async function buildAuthPayload(user: any) {
  const permissions = new Set<string>();
  const roles: string[] = [];
  for (const ur of user.user_roles) {
    roles.push(ur.role.name);
    for (const rp of ur.role.role_permissions) permissions.add(rp.permission.key);
  }

  // direct_permissions (사용자별 직접 부여 권한) 병합
  const directPermsRaw = (user as any).direct_permissions;
  if (directPermsRaw) {
    try { (JSON.parse(directPermsRaw) as string[]).forEach(p => permissions.add(p)); } catch {}
  }

  const permissionList = Array.from(permissions);
  const directPermsList: string[] | null = directPermsRaw ? (() => { try { return JSON.parse(directPermsRaw); } catch { return null; } })() : null;
  const legacyMenuPermissions = parseMenuPermissions((user as any).menu_permissions);

  const computedPolicy = await computeEffectiveMenuPolicyForUser({
    user_id: user.id,
    department_id: user.department_id ?? null,
    permissions: permissionList,
    has_custom_menu_permissions: legacyMenuPermissions !== null,
    legacy_menu_permissions: legacyMenuPermissions,
  });

  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    department_id: user.department_id,
    department_name: user.department?.name ?? null,
    department_module_id: (user.department as any)?.module_id ?? null,
    permissions: permissionList,
    direct_permissions: directPermsList,
    roles,
    menu_permissions: computedPolicy.menu_permissions,
    effective_work_groups: computedPolicy.effective_work_groups,
    has_custom_menu_permissions: legacyMenuPermissions !== null,
    menu_scopes: await buildMenuScopesForUser({
      department_id: user.department_id,
      permissions: permissionList,
    }),
  };
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });

  try {
    const user = await prisma.user.findFirst({
      where: { username, is_active: true, deleted_at: null },
      include: {
        department: true,
        user_roles: {
          include: {
            role: { include: { role_permissions: { include: { permission: true } } } },
          },
        },
      },
    });
    if (!user) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });

    await prisma.user.update({ where: { id: user.id }, data: { last_login_at: new Date() } });

    const payload = await buildAuthPayload(user);

    await audit({ actor_user_id: user.id, actor_role_snapshot: payload.roles.join(','), action: 'LOGIN', entity_type: 'users', entity_id: user.id, ip: req.ip ?? '' });
    res.json({ token: generateToken(payload), user: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/logout', authMiddleware, async (req: AuthRequest, res) => {
  if (req.user) {
    // 서버사이드 세션 무효화: last_logout_at 갱신으로 이 토큰 이후 발급분만 유효하게 처리
    await prisma.user.update({
      where: { id: req.user.id },
      data: { last_logout_at: new Date() },
    });
    await audit({ actor_user_id: req.user.id, action: 'LOGOUT', entity_type: 'users', entity_id: req.user.id });
  }
  res.json({ message: '로그아웃 되었습니다.' });
});

// POST /api/auth/refresh — 유효한 토큰으로 새 토큰 재발급 (별도 Refresh Token 없이 구현)
router.post('/refresh', authMiddleware, async (req: AuthRequest, res) => {
  const sessionUser = req.user;
  if (!sessionUser) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const user = await prisma.user.findFirst({
      where: { id: sessionUser.id, is_active: true, deleted_at: null },
      include: {
        department: true,
        user_roles: {
          include: {
            role: { include: { role_permissions: { include: { permission: true } } } },
          },
        },
      },
    });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const payload = await buildAuthPayload(user);
    res.json({ token: generateToken(payload), user: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/me', authMiddleware, async (req: AuthRequest, res) => {
  const sessionUser = req.user;
  if (!sessionUser) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const user = await prisma.user.findFirst({
      where: { id: sessionUser.id, is_active: true, deleted_at: null },
      include: {
        department: true,
        user_roles: {
          include: {
            role: { include: { role_permissions: { include: { permission: true } } } },
          },
        },
      },
    });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const payload = await buildAuthPayload(user);
    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;
