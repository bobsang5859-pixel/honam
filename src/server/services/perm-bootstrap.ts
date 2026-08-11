// 묶음 권한 키(REQUEST_USE 등)를 하위 개별 키로 펼치는 일회성 정리
// — 사용자 관리 UI는 개별 권한 모델만 표시하므로, 묶음 키가 DB에 남아 있으면 화면에서 편집 불가
// — 이 함수는 서버 시작 시 1회 호출되며, 묶음 키가 없는 사용자는 건드리지 않음 (idempotent)
//
// 처리 규칙
//   1. direct_permissions JSON에서 묶음 키(REQUEST_USE/PURCHASE_MANAGE/BASIC_MANAGE/STATS_VIEW/PATIENT_MANAGE)를 찾음
//   2. 해당 묶음의 하위 권한들을 추가
//   3. 묶음 키 자체는 제거 (UI에서 토글 가능한 키만 남김)
//   4. SYSTEM_ADMIN 같은 단일 권한은 그대로 보존

import { PERM_HIERARCHY } from '../../shared/permissions';

const BUNDLE_KEYS = Object.keys(PERM_HIERARCHY);

export async function flattenLegacyBundlePermissions(prisma: any): Promise<number> {
  const users = await prisma.user.findMany({
    where: {
      direct_permissions: { not: null },
      deleted_at: null,
    },
    select: { id: true, direct_permissions: true },
  });

  let updated = 0;
  for (const user of users) {
    let perms: unknown;
    try {
      perms = JSON.parse((user as any).direct_permissions);
    } catch {
      continue;
    }
    if (!Array.isArray(perms)) continue;

    const original = perms as string[];
    const hasBundleKey = original.some((p) => BUNDLE_KEYS.includes(p));
    if (!hasBundleKey) continue;

    const next = new Set<string>();
    for (const p of original) {
      const children = PERM_HIERARCHY[p];
      if (children) {
        for (const c of children) next.add(c);
        // 묶음 키 자체는 제거
      } else {
        next.add(p);
      }
    }

    const nextArray = Array.from(next);
    if (
      nextArray.length === original.length &&
      nextArray.every((k) => original.includes(k))
    ) {
      // 변화 없음 (이론상 도달 안 함, 안전장치)
      continue;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { direct_permissions: JSON.stringify(nextArray) },
    });
    updated++;
  }

  return updated;
}
