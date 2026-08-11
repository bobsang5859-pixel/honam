import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../index';
import { hasAnyPermission as sharedHasAnyPermission } from '../../shared/permissions';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET 환경변수가 설정되지 않았습니다. 앱을 시작할 수 없습니다.');
  process.exit(1);
}

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    display_name: string;
    department_id: string | null;
    department_name: string | null;
    permissions: string[];
    roles: string[];
    menu_permissions?: string[] | null;
    effective_work_groups?: string[];
    has_custom_menu_permissions?: boolean;
    menu_scopes?: Record<string, boolean>;
  };
}

export function isCustomMenuUser(user?: AuthRequest['user']): boolean {
  if (!user) return false;
  if (typeof user.has_custom_menu_permissions === 'boolean') return user.has_custom_menu_permissions;
  return user.menu_permissions !== null && user.menu_permissions !== undefined;
}

// PERM_HIERARCHY는 src/shared/permissions.ts에서 단일 정의 후 import (서버·클라이언트 동기화)

function hasAnyPermission(user: AuthRequest['user'], perms: string[]): boolean {
  if (!user) return false;
  return sharedHasAnyPermission(user.permissions, perms);
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: '인증이 필요합니다.' });
  }

  const token = authHeader.split(' ')[1];
  let decoded: any;
  try {
    decoded = jwt.verify(token, JWT_SECRET!) as any;
  } catch {
    return res.status(401).json({ error: '토큰이 유효하지 않습니다.' });
  }

  try {
    // 서버사이드 로그아웃 무효화: DB에서 last_logout_at 확인
    const dbUser = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { last_logout_at: true, is_active: true, deleted_at: true },
    });
    if (!dbUser || !dbUser.is_active || dbUser.deleted_at) {
      return res.status(401).json({ error: '비활성 계정입니다.' });
    }
    if (dbUser.last_logout_at &&
        decoded.iat < Math.floor(dbUser.last_logout_at.getTime() / 1000)) {
      return res.status(401).json({ error: '로그아웃된 세션입니다. 다시 로그인하세요.' });
    }
    req.user = {
      id: decoded.id,
      username: decoded.username,
      display_name: decoded.display_name,
      department_id: decoded.department_id ?? null,
      department_name: decoded.department_name ?? null,
      permissions: decoded.permissions ?? [],
      roles: decoded.roles ?? [],
      menu_permissions: decoded.menu_permissions ?? null,
      effective_work_groups: decoded.effective_work_groups ?? [],
      has_custom_menu_permissions: decoded.has_custom_menu_permissions ?? false,
      menu_scopes: decoded.menu_scopes ?? {},
    };
    next();
  } catch {
    return res.status(500).json({ error: '인증 처리 중 오류가 발생했습니다.' });
  }
}

export function requirePermission(...perms: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: '인증이 필요합니다.' });
    if (!hasAnyPermission(req.user, perms)) {
      return res.status(403).json({ error: '권한이 없습니다.', required: perms });
    }
    next();
  };
}

export function requireMenuAccess(menuKey: string, ...fallbackPerms: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: '인증이 필요합니다.' });

    const allowedMenus = req.user.menu_permissions;
    if (Array.isArray(allowedMenus) && !allowedMenus.includes(menuKey)) {
      return res.status(403).json({ error: '권한이 없습니다.', menu_key: menuKey });
    }

    if (fallbackPerms.length > 0 && !hasAnyPermission(req.user, fallbackPerms)) {
      return res.status(403).json({ error: '권한이 없습니다.', required: fallbackPerms });
    }

    next();
  };
}

export type DeptScope = {
  is_admin: boolean;
  is_all: boolean;
  department_id: string | null;
};

// Resolve department scope under mixed policy:
// - custom menu users: admin-only all-scope, otherwise self-department only
// - legacy users: keep old all-scope behavior (SYSTEM_ADMIN or PURCHASE_MANAGE)
export function resolveDeptScope(req: AuthRequest): DeptScope {
  const user = req.user;
  if (!user) return { is_admin: false, is_all: false, department_id: null };

  const isAdmin = user.permissions.includes('SYSTEM_ADMIN');
  if (isCustomMenuUser(user)) {
    return {
      is_admin: isAdmin,
      is_all: isAdmin,
      department_id: user.department_id ?? null,
    };
  }

  const isLegacyAll = isAdmin || user.permissions.includes('PURCHASE_MANAGE');
  return {
    is_admin: isAdmin,
    is_all: isLegacyAll,
    department_id: user.department_id ?? null,
  };
}

export function requireOwnDept(req: AuthRequest, deptId: string): boolean {
  if (!req.user) return false;

  if (isCustomMenuUser(req.user)) {
    if (req.user.permissions.includes('SYSTEM_ADMIN')) return true;
    return req.user.department_id === deptId;
  }

  if (req.user.permissions.includes('SYSTEM_ADMIN')) return true;
  if (req.user.permissions.includes('PURCHASE_MANAGE')) return true;
  return req.user.department_id === deptId;
}

export function generateToken(user: {
  id: string;
  username: string;
  display_name: string;
  department_id: string | null;
  department_name: string | null;
  permissions: string[];
  roles: string[];
  menu_permissions?: string[] | null;
  effective_work_groups?: string[];
  has_custom_menu_permissions?: boolean;
  menu_scopes?: Record<string, boolean>;
}) {
  return jwt.sign(user, JWT_SECRET!, { expiresIn: '4h' });
}
