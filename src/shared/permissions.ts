// 권한 계층 — 서버와 클라이언트가 공유하는 단일 진실 출처
// 양방향 인정:
//   - 정방향: 묶음 권한 보유 → 모든 하위 권한 자동 인정
//   - 역방향: 모든 하위 권한 보유 → 묶음 권한 자동 인정
// 사용자 관리 UI는 하위 권한만 토글하므로, 역방향 검사로 묶음 권한 라우트도 통과시킨다.
// 참고: STATS_VIEW는 PERM_TABS에서 단순 권한("내 부서만")으로 정의되어 묶음에서 제외.

export const PERM_HIERARCHY: Record<string, readonly string[]> = {
  BASIC_MANAGE: ['ITEM_MANAGE', 'VENDOR_MANAGE', 'BASELINE_MANAGE', 'SCHEDULE_MANAGE', 'AUDIT_VIEW'],
  REQUEST_USE: ['REQUEST_CREATE', 'USAGE_MANAGE', 'LOAN_MANAGE', 'RECEIPT_CHECK_VIEW'],
  PURCHASE_MANAGE: ['APPROVAL_MANAGE', 'PO_MANAGE', 'STOCK_IN_MANAGE', 'STOCK_OUT_MANAGE', 'INVENTORY_MANAGE'],
  PATIENT_MANAGE: ['PATIENT_VIEW', 'PATIENT_STATS_VIEW'],
};

// *_ALL 권한은 그 상위 의미 — 보유자에게 일반 권한도 자동 부여 (정방향만, 역방향은 권한 상승 위험으로 막음).
// 예: PATIENT_STATS_VIEW_ALL 보유자는 PATIENT_STATS_VIEW 도 자동 보유 인정.
//     반대로 PATIENT_STATS_VIEW(내 부서만) → PATIENT_STATS_VIEW_ALL 자동 인정은 X.
const ALL_TO_BASE: Record<string, string> = {
  STATS_VIEW_ALL: 'STATS_VIEW',
  PATIENT_STATS_VIEW_ALL: 'PATIENT_STATS_VIEW',
};

// 하위 → 상위 역참조 (한 번만 빌드)
export const PERM_PARENT: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [parent, children] of Object.entries(PERM_HIERARCHY)) {
    for (const child of children) m[child] = parent;
  }
  return m;
})();

// 사용자 권한을 양방향으로 펼친 Set 반환
//   - 정방향(_ALL → 일반): _ALL 권한 보유 → 그 일반 권한 자동 보유 (예: PATIENT_STATS_VIEW_ALL → PATIENT_STATS_VIEW)
//   - 정방향(묶음 → 하위): 묶음 보유 → 하위 추가
//   - 역방향: 모든 하위 보유 → 묶음 추가 (UI는 하위만 토글하므로 묶음 라우트 검사를 위해 필수)
export function expandPermissions(userPerms: readonly string[]): Set<string> {
  const expanded = new Set<string>(userPerms);

  // 정방향(_ALL → 일반): 묶음 역방향 인정 전에 먼저 적용해야 한다 (묶음 하위에 일반 권한이 있는 경우 인정 가능하도록)
  for (const p of userPerms) {
    const base = ALL_TO_BASE[p];
    if (base) expanded.add(base);
  }

  // 정방향(묶음 → 하위)
  for (const p of userPerms) {
    const children = PERM_HIERARCHY[p];
    if (children) {
      for (const c of children) expanded.add(c);
    }
  }

  // 역방향: 모든 하위 보유 시 묶음 인정
  for (const [bundle, children] of Object.entries(PERM_HIERARCHY)) {
    if (children.length > 0 && children.every((c) => expanded.has(c))) {
      expanded.add(bundle);
    }
  }

  return expanded;
}

// 권한 체크: SYSTEM_ADMIN이면 무조건 통과, 아니면 PERM_HIERARCHY 적용
// required: 단일 권한 (있으면 반드시 보유)
// anyOf: 권한 목록 (하나라도 보유하면 통과)
export function checkPermission(
  userPerms: readonly string[],
  required?: string,
  anyOf?: readonly string[],
): boolean {
  if (userPerms.includes('SYSTEM_ADMIN')) return true;
  const expanded = expandPermissions(userPerms);
  if (required && !expanded.has(required)) return false;
  if (anyOf && anyOf.length > 0 && !anyOf.some((p) => expanded.has(p))) return false;
  return true;
}

// 여러 권한 중 하나라도 보유하는지 (서버 미들웨어용)
export function hasAnyPermission(userPerms: readonly string[], required: readonly string[]): boolean {
  if (userPerms.includes('SYSTEM_ADMIN')) return true;
  if (required.length === 0) return true;
  const expanded = expandPermissions(userPerms);
  return required.some((r) => expanded.has(r));
}
