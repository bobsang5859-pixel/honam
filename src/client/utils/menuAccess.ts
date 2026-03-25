import type { AuthUser } from '@shared/types';

export type MenuRule = {
  key: string;
  perm?: string;
  anyPerm?: string[];
  requiresScope?: string;
};

export function hasPermission(user: AuthUser | null | undefined, perm?: string, anyPerm?: string[]) {
  if (!user) return false;
  if (perm && !user.permissions.includes(perm)) return false;
  if (anyPerm && anyPerm.length > 0 && !anyPerm.some((p) => user.permissions.includes(p))) return false;
  return true;
}

export function canAccessMenu(user: AuthUser | null | undefined, rule: MenuRule): boolean {
  if (!user) return false;
  if (rule.key === 'dashboard') return true;
  return hasPermission(user, rule.perm, rule.anyPerm);
}
