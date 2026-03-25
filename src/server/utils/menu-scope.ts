import { prisma } from '../index';
import { v4 as uuidv4 } from 'uuid';

export type MenuScopeMap = Record<string, boolean>;

function keyOf(menuKey: string): string {
  return `menu_scope:${menuKey}`;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function getMenuScopeDepartments(menuKey: string): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: keyOf(menuKey) } });
  return parseJsonArray(row?.value);
}

export async function setMenuScopeDepartments(menuKey: string, departmentIds: string[], actorId?: string) {
  const value = JSON.stringify(Array.from(new Set((departmentIds || []).map((d) => String(d)).filter(Boolean))));
  await prisma.appSetting.upsert({
    where: { key: keyOf(menuKey) },
    create: {
      id: uuidv4(),
      key: keyOf(menuKey),
      value,
      description: `${menuKey} allowed departments`,
    },
    update: {
      value,
      ...(actorId ? { description: `${menuKey} allowed departments (updated by ${actorId})` } : {}),
    },
  });
}

export async function isMenuAllowedForUser(
  menuKey: string,
  user: { department_id?: string | null; permissions?: string[] } | null | undefined,
): Promise<boolean> {
  if (!user) return false;
  const perms = user.permissions ?? [];
  if (perms.includes('SYSTEM_ADMIN')) return true;
  if (!user.department_id) return false;
  const deptIds = await getMenuScopeDepartments(menuKey);
  if (!deptIds.length) return false; // whitelist mode default deny
  return deptIds.includes(String(user.department_id));
}

export async function buildMenuScopesForUser(
  user: { department_id?: string | null; permissions?: string[] } | null | undefined,
): Promise<MenuScopeMap> {
  return {
    'patient-manage': await isMenuAllowedForUser('patient-manage', user),
  };
}
