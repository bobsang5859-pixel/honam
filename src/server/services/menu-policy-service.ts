import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';

const SETTINGS_GROUPS_KEY = 'menu_policy:groups';
const SETTINGS_DEPT_DEFAULTS_KEY = 'menu_policy:dept_defaults';
const SETTINGS_USER_OVERRIDES_KEY = 'menu_policy:user_overrides';
const EXCLUDED_DEPARTMENT_CODES = new Set(['CENTRAL']);

export const ALL_DEPT_COMMON_GROUP_KEY = 'ALL_DEPT_COMMON';

export const ALL_DEPT_COMMON_MENU_KEYS = [
  'ward-requests',
  'equipment-requests',
  'inventory',
  'dept-inventory',
  'loans',
  'my-equipment',
  'receipt-check',
  'management',
  'cost',
  'patient-stats',
  'patient-manage',
  'stats-dashboard',
  'purchase-decisions',
  'order-routing',
  // 사이드바엔 있으나 어느 작업그룹에도 미등록이라 비관리자에게 영구히 숨겨지던 메뉴.
  // 공통 화이트리스트에 추가 — 실제 노출은 메뉴의 anyPerm 이 통제.
  'request-schedules',
  'cost-reconcile',
] as const;

export const HQ_GROUP_KEYS = [
  'HQ_APPROVAL',
  'HQ_PROCUREMENT',
  'HQ_ISSUE',
  'HQ_ANALYTICS',
  'HQ_PATIENT',
  'HQ_MASTER',
  'HQ_SYSTEM',
] as const;

export type WorkGroupPolicy = {
  group_key: string;
  label: string;
  menu_keys: string[];
  permission_keys: string[];
};

export type DeptDefaultPolicy = {
  department_id: string;
  group_keys: string[];
};

export type UserPolicyOverride = {
  user_id: string;
  add_group_keys: string[];
  remove_group_keys: string[];
  include_menu_keys: string[];
  exclude_menu_keys: string[];
};

export type EffectiveMenuPolicy = {
  effective_work_groups: string[];
  menu_permissions: string[];
  required_permission_keys: string[];
  missing_permission_keys: string[];
  is_admin_department: boolean;
};

const DEFAULT_WORK_GROUPS: WorkGroupPolicy[] = [
  {
    group_key: 'HQ_APPROVAL',
    label: '승인 파트',
    menu_keys: ['approvals'],
    permission_keys: ['PURCHASE_MANAGE'],
  },
  {
    group_key: 'HQ_PROCUREMENT',
    label: '발주/입고 파트',
    menu_keys: ['purchase-orders', 'receipts', 'cost-analysis'],
    permission_keys: ['PURCHASE_MANAGE'],
  },
  {
    group_key: 'HQ_ISSUE',
    label: '불출/검수 파트',
    menu_keys: ['stock-out', 'receipt-check'],
    permission_keys: ['PURCHASE_MANAGE'],
  },
  {
    group_key: 'HQ_ANALYTICS',
    label: '분석 파트',
    menu_keys: ['cost', 'cost-analysis', 'patient-stats', 'audit-logs'],
    permission_keys: ['STATS_VIEW', 'PURCHASE_MANAGE', 'BASIC_MANAGE'],
  },
  {
    group_key: 'HQ_PATIENT',
    label: '환자 파트',
    menu_keys: ['patient-manage'],
    permission_keys: ['PATIENT_MANAGE'],
  },
  {
    group_key: 'HQ_MASTER',
    label: '마스터 파트',
    menu_keys: ['items', 'vendors', 'baselines'],
    permission_keys: ['BASIC_MANAGE'],
  },
  {
    group_key: 'HQ_SYSTEM',
    label: '시스템 파트',
    menu_keys: ['users', 'system', 'doc-templates'],
    permission_keys: ['BASIC_MANAGE', 'SYSTEM_ADMIN'],
  },
  {
    group_key: ALL_DEPT_COMMON_GROUP_KEY,
    label: '전 부서 공통',
    menu_keys: [...ALL_DEPT_COMMON_MENU_KEYS],
    permission_keys: ['REQUEST_USE', 'PURCHASE_MANAGE'],
  },
];

function uniqStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((v) => String(v || '').trim()).filter(Boolean)));
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeGroup(raw: any): WorkGroupPolicy | null {
  if (!raw) return null;
  const group_key = String(raw.group_key || '').trim();
  if (!group_key) return null;
  return {
    group_key,
    label: String(raw.label || group_key).trim() || group_key,
    menu_keys: uniqStrings(raw.menu_keys),
    permission_keys: uniqStrings(raw.permission_keys),
  };
}

function normalizeUserOverride(userId: string, raw: any): UserPolicyOverride {
  const obj = raw ?? {};
  return {
    user_id: userId,
    add_group_keys: uniqStrings(obj.add_group_keys),
    remove_group_keys: uniqStrings(obj.remove_group_keys).filter((k) => k !== ALL_DEPT_COMMON_GROUP_KEY),
    include_menu_keys: uniqStrings(obj.include_menu_keys),
    exclude_menu_keys: uniqStrings(obj.exclude_menu_keys).filter(
      (k) => !ALL_DEPT_COMMON_MENU_KEYS.includes(k as any),
    ),
  };
}

function groupIndex(groups: WorkGroupPolicy[]): Map<string, WorkGroupPolicy> {
  return new Map(groups.map((g) => [g.group_key, g]));
}

function orderGroups(byKey: Map<string, WorkGroupPolicy>): WorkGroupPolicy[] {
  const defaultOrder = DEFAULT_WORK_GROUPS.map((g) => g.group_key);
  const extras = Array.from(byKey.keys()).filter((k) => !defaultOrder.includes(k)).sort();
  return [...defaultOrder, ...extras]
    .map((k) => byKey.get(k))
    .filter((v): v is WorkGroupPolicy => Boolean(v));
}

async function upsertSetting(key: string, value: unknown, description: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    update: { value: JSON.stringify(value), description },
    create: { id: uuidv4(), key, value: JSON.stringify(value), description },
  });
}

async function getAdminDepartmentIds(): Promise<Set<string>> {
  const departments = await prisma.department.findMany({
    where: { deleted_at: null, is_active: true },
    select: { id: true, code: true, parent_id: true },
  });

  const childrenByParent = new Map<string, string[]>();
  for (const dept of departments) {
    const parentId = dept.parent_id || '';
    const arr = childrenByParent.get(parentId) || [];
    arr.push(dept.id);
    childrenByParent.set(parentId, arr);
  }

  const queue = departments.filter((d) => d.code === 'ADMIN').map((d) => d.id);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const children = childrenByParent.get(current) || [];
    for (const childId of children) queue.push(childId);
  }
  return visited;
}

export async function getWorkGroupPolicies(): Promise<WorkGroupPolicy[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_GROUPS_KEY } });
  const parsed = parseJson<any[]>(row?.value, []);
  const normalized = parsed.map(normalizeGroup).filter((g): g is WorkGroupPolicy => Boolean(g));

  const byKey = new Map<string, WorkGroupPolicy>();
  for (const g of normalized) byKey.set(g.group_key, g);
  for (const g of DEFAULT_WORK_GROUPS) {
    if (!byKey.has(g.group_key)) byKey.set(g.group_key, g);
  }

  // Common group is fixed and cannot be weakened.
  byKey.set(ALL_DEPT_COMMON_GROUP_KEY, {
    ...byKey.get(ALL_DEPT_COMMON_GROUP_KEY)!,
    label: byKey.get(ALL_DEPT_COMMON_GROUP_KEY)?.label || '전 부서 공통',
    menu_keys: [...ALL_DEPT_COMMON_MENU_KEYS],
    permission_keys: ['REQUEST_USE', 'PURCHASE_MANAGE'],
  });

  return orderGroups(byKey);
}

export async function setWorkGroupPolicies(input: WorkGroupPolicy[]): Promise<WorkGroupPolicy[]> {
  const normalized = (Array.isArray(input) ? input : [])
    .map(normalizeGroup)
    .filter((g): g is WorkGroupPolicy => Boolean(g));

  const byKey = new Map<string, WorkGroupPolicy>();
  for (const g of normalized) byKey.set(g.group_key, g);
  for (const g of DEFAULT_WORK_GROUPS) {
    if (!byKey.has(g.group_key)) byKey.set(g.group_key, g);
  }

  byKey.set(ALL_DEPT_COMMON_GROUP_KEY, {
    ...byKey.get(ALL_DEPT_COMMON_GROUP_KEY)!,
    menu_keys: [...ALL_DEPT_COMMON_MENU_KEYS],
    permission_keys: ['REQUEST_USE', 'PURCHASE_MANAGE'],
  });

  const groups = orderGroups(byKey);
  await upsertSetting(SETTINGS_GROUPS_KEY, groups, 'Menu work-group policies');
  return groups;
}

export async function getDeptDefaultPolicies(): Promise<DeptDefaultPolicy[]> {
  const [groups, row, departments, adminDeptIds] = await Promise.all([
    getWorkGroupPolicies(),
    prisma.appSetting.findUnique({ where: { key: SETTINGS_DEPT_DEFAULTS_KEY } }),
    prisma.department.findMany({
      where: { deleted_at: null, is_active: true },
      select: { id: true, name: true, code: true },
      orderBy: { name: 'asc' },
    }),
    getAdminDepartmentIds(),
  ]);

  const groupKeys = new Set(groups.map((g) => g.group_key));
  const rawMap = parseJson<Record<string, string[]>>(row?.value, {});

  const targetDepartments = departments.filter((dept) => !EXCLUDED_DEPARTMENT_CODES.has(String(dept.code || '').trim()));

  return targetDepartments.map((dept) => {
    const raw = Array.isArray(rawMap[dept.id])
      ? rawMap[dept.id]
      : (adminDeptIds.has(dept.id) ? [...HQ_GROUP_KEYS] : []);

    const group_keys = Array.from(
      new Set(raw.map((k) => String(k || '').trim()).filter((k) => groupKeys.has(k) && k !== ALL_DEPT_COMMON_GROUP_KEY)),
    );

    return { department_id: dept.id, group_keys };
  });
}

export async function setDeptDefaultPolicies(input: DeptDefaultPolicy[]): Promise<DeptDefaultPolicy[]> {
  const [groups, departments] = await Promise.all([
    getWorkGroupPolicies(),
    prisma.department.findMany({
      where: { deleted_at: null, is_active: true },
      select: { id: true, code: true },
    }),
  ]);
  const validGroupKeys = new Set(groups.map((g) => g.group_key));
  const validDepartmentIds = new Set(
    departments
      .filter((dept) => !EXCLUDED_DEPARTMENT_CODES.has(String(dept.code || '').trim()))
      .map((dept) => dept.id),
  );
  const rows = Array.isArray(input) ? input : [];
  const map: Record<string, string[]> = {};

  for (const row of rows) {
    const department_id = String(row?.department_id || '').trim();
    if (!department_id || !validDepartmentIds.has(department_id)) continue;
    const group_keys = uniqStrings(row?.group_keys)
      .filter((k) => validGroupKeys.has(k) && k !== ALL_DEPT_COMMON_GROUP_KEY);
    map[department_id] = group_keys;
  }

  await upsertSetting(SETTINGS_DEPT_DEFAULTS_KEY, map, 'Menu policy department defaults');
  return getDeptDefaultPolicies();
}

async function getUserOverrideMap(): Promise<Record<string, Omit<UserPolicyOverride, 'user_id'>>> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_USER_OVERRIDES_KEY } });
  const parsed = parseJson<Record<string, any>>(row?.value, {});

  const out: Record<string, Omit<UserPolicyOverride, 'user_id'>> = {};
  for (const [userId, raw] of Object.entries(parsed)) {
    const normalized = normalizeUserOverride(userId, raw);
    out[userId] = {
      add_group_keys: normalized.add_group_keys,
      remove_group_keys: normalized.remove_group_keys,
      include_menu_keys: normalized.include_menu_keys,
      exclude_menu_keys: normalized.exclude_menu_keys,
    };
  }
  return out;
}

export async function getUserPolicyOverride(userId: string): Promise<UserPolicyOverride> {
  const map = await getUserOverrideMap();
  return normalizeUserOverride(userId, map[userId] || {});
}

export async function setUserPolicyOverride(userId: string, input: Partial<UserPolicyOverride>): Promise<UserPolicyOverride> {
  const map = await getUserOverrideMap();
  const merged = normalizeUserOverride(userId, { ...(map[userId] || {}), ...(input || {}) });

  map[userId] = {
    add_group_keys: merged.add_group_keys,
    remove_group_keys: merged.remove_group_keys,
    include_menu_keys: merged.include_menu_keys,
    exclude_menu_keys: merged.exclude_menu_keys,
  };

  await upsertSetting(SETTINGS_USER_OVERRIDES_KEY, map, 'Menu policy user overrides');
  return merged;
}

export async function computeEffectiveMenuPolicyForUser(input: {
  user_id: string;
  department_id: string | null;
  permissions: string[];
  has_custom_menu_permissions: boolean;
  legacy_menu_permissions: string[] | null;
}): Promise<EffectiveMenuPolicy> {
  const [groups, deptDefaults, userOverride, adminDeptIds] = await Promise.all([
    getWorkGroupPolicies(),
    getDeptDefaultPolicies(),
    getUserPolicyOverride(input.user_id),
    getAdminDepartmentIds(),
  ]);

  const groupMap = groupIndex(groups);
  const isAdminDepartment = input.department_id ? adminDeptIds.has(input.department_id) : false;
  const deptDefault = deptDefaults.find((d) => d.department_id === input.department_id);

  const baseGroups = new Set<string>([ALL_DEPT_COMMON_GROUP_KEY]);
  for (const key of deptDefault?.group_keys || []) {
    if (groupMap.has(key)) baseGroups.add(key);
  }
  if (isAdminDepartment) {
    for (const key of HQ_GROUP_KEYS) {
      if (groupMap.has(key)) baseGroups.add(key);
    }
  }

  for (const key of userOverride.add_group_keys) {
    if (groupMap.has(key)) baseGroups.add(key);
  }
  for (const key of userOverride.remove_group_keys) {
    if (key !== ALL_DEPT_COMMON_GROUP_KEY) baseGroups.delete(key);
  }

  const effective_work_groups = Array.from(baseGroups);

  const menuSet = new Set<string>();
  if (input.has_custom_menu_permissions && Array.isArray(input.legacy_menu_permissions)) {
    for (const key of input.legacy_menu_permissions) menuSet.add(key);
  } else {
    for (const groupKey of effective_work_groups) {
      const group = groupMap.get(groupKey);
      for (const menuKey of group?.menu_keys || []) menuSet.add(menuKey);
    }
  }

  for (const key of userOverride.include_menu_keys) menuSet.add(key);
  for (const key of userOverride.exclude_menu_keys) menuSet.delete(key);
  for (const key of ALL_DEPT_COMMON_MENU_KEYS) menuSet.add(key);

  const requiredPermissionSet = new Set<string>();
  for (const groupKey of effective_work_groups) {
    const group = groupMap.get(groupKey);
    for (const key of group?.permission_keys || []) requiredPermissionSet.add(key);
  }

  const required_permission_keys = Array.from(requiredPermissionSet);
  const missing_permission_keys = required_permission_keys.filter((k) => !(input.permissions || []).includes(k));

  return {
    effective_work_groups,
    menu_permissions: Array.from(menuSet),
    required_permission_keys,
    missing_permission_keys,
    is_admin_department: isAdminDepartment,
  };
}

export async function previewUserMenuPolicy(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      department: { select: { id: true, name: true, code: true } },
      user_roles: {
        include: {
          role: {
            include: {
              role_permissions: {
                include: { permission: true },
              },
            },
          },
        },
      },
    },
  });

  if (!user) {
    throw new Error('USER_NOT_FOUND');
  }

  const permissions = new Set<string>();
  const roles: string[] = [];
  for (const ur of user.user_roles) {
    roles.push(ur.role.name);
    for (const rp of ur.role.role_permissions) permissions.add(rp.permission.key);
  }

  // direct_permissions (사용자별 직접 부여 권한) 병합 — buildAuthPayload(로그인 경로)와 일치시켜
  // 미리보기/권한진단이 실제 로그인 권한과 동일하게 나오도록 한다.
  // (이전: 역할 권한만 봐서 직접권한 사용자를 "권한 부족"으로 잘못 표시)
  const directPermsRaw = (user as any).direct_permissions;
  if (directPermsRaw) {
    try { (JSON.parse(directPermsRaw) as string[]).forEach((p) => permissions.add(p)); } catch { /* malformed → skip */ }
  }

  const legacy_menu_permissions = (user as any).menu_permissions
    ? parseJson<string[]>((user as any).menu_permissions, [])
    : null;

  const computed = await computeEffectiveMenuPolicyForUser({
    user_id: user.id,
    department_id: user.department_id,
    permissions: Array.from(permissions),
    has_custom_menu_permissions: legacy_menu_permissions !== null,
    legacy_menu_permissions,
  });

  const userOverride = await getUserPolicyOverride(user.id);

  return {
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      department_id: user.department_id,
      department_name: user.department?.name ?? null,
      department_code: user.department?.code ?? null,
      roles,
      permissions: Array.from(permissions),
      has_custom_menu_permissions: legacy_menu_permissions !== null,
      legacy_menu_permissions,
    },
    override: userOverride,
    effective: computed,
  };
}

