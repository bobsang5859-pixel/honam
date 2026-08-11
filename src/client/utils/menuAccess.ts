import type { AuthUser } from '@shared/types';
import { checkPermission } from '@shared/permissions';

export type MenuRule = {
  key: string;
  perm?: string;
  anyPerm?: string[];
  requiresScope?: string;
};

// 권한 체크 — PERM_HIERARCHY 적용 (BASIC_MANAGE → ITEM_MANAGE 등 자동 통과)
export function hasPermission(user: AuthUser | null | undefined, perm?: string, anyPerm?: string[]) {
  if (!user) return false;
  return checkPermission(user.permissions, perm, anyPerm);
}

// 메뉴 표시 여부 — 메뉴 정책(menu_permissions)과 권한을 모두 확인
// 1) SYSTEM_ADMIN은 항상 통과
// 2) 서버에서 계산해 보낸 menu_permissions에 메뉴 키가 있어야 함 (정책 시스템)
// 3) 메뉴 정의의 perm/anyPerm 권한도 보유해야 함 (PERM_HIERARCHY 적용)
export function canAccessMenu(user: AuthUser | null | undefined, rule: MenuRule): boolean {
  if (!user) return false;
  if (rule.key === 'dashboard') return true;
  if (user.permissions.includes('SYSTEM_ADMIN')) return true;

  // 메뉴 정책: 서버가 부서·역할·사용자 override를 합쳐 계산한 메뉴 키 화이트리스트
  const menuKeys = (user as any).menu_permissions;
  if (Array.isArray(menuKeys) && menuKeys.length > 0) {
    if (!menuKeys.includes(rule.key)) return false;
  }

  return hasPermission(user, rule.perm, rule.anyPerm);
}
