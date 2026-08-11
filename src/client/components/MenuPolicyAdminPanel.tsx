import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import type {
  WorkGroupPolicy,
  DeptDefaultPolicy,
  UserPolicyOverride,
  UserInfo,
  Department,
} from '@shared/types';

type PreviewResponse = {
  user: {
    id: string;
    username: string;
    display_name: string;
    department_name: string | null;
    permissions: string[];
    roles: string[];
    has_custom_menu_permissions: boolean;
  };
  override: UserPolicyOverride;
  effective: {
    effective_work_groups: string[];
    menu_permissions: string[];
    required_permission_keys: string[];
    missing_permission_keys: string[];
    is_admin_department: boolean;
  };
};

const MENU_LABELS: Record<string, string> = {
  'ward-requests': '소모품 신청',
  'equipment-requests': '비품 신청',
  inventory: '재고 현황',
  loans: '부서간 대여',
  approvals: '승인 처리',
  'order-routing': '발주 준비',
  'purchase-decisions': '구매결의서',
  'purchase-orders': '발주 관리',
  receipts: '입고 처리',
  'stock-out': '불출 처리',
  'receipt-check': '수령검수',
  cost: '비용 통계',
  'patient-manage': '환자 관리',
  'patient-stats': '환자 통계',
  'audit-logs': '감사 로그',
  items: '품목 관리',
  vendors: '업체 관리',
  baselines: '사용량 기준',
  users: '사용자 관리',
  system: '시스템 설정',
};
const SYSTEM_GROUP_KEYS = new Set([
  'HQ_APPROVAL',
  'HQ_PROCUREMENT',
  'HQ_ISSUE',
  'HQ_ANALYTICS',
  'HQ_PATIENT',
  'HQ_MASTER',
  'HQ_SYSTEM',
  'ALL_DEPT_COMMON',
]);

function toCsv(values: string[]) {
  return values.join(', ');
}

function fromCsv(raw: string): string[] {
  return Array.from(new Set(raw.split(',').map((v) => v.trim()).filter(Boolean)));
}

export default function MenuPolicyAdminPanel() {
  const [groups, setGroups] = useState<WorkGroupPolicy[]>([]);
  const [deptDefaults, setDeptDefaults] = useState<DeptDefaultPolicy[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [users, setUsers] = useState<UserInfo[]>([]);

  const [selectedUserId, setSelectedUserId] = useState('');
  const [userOverride, setUserOverride] = useState<UserPolicyOverride | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);

  const [loading, setLoading] = useState(false);
  const [savingGroups, setSavingGroups] = useState(false);
  const [savingDeptDefaults, setSavingDeptDefaults] = useState(false);
  const [savingOverride, setSavingOverride] = useState(false);
  const [showAllDepartments, setShowAllDepartments] = useState(false);
  const [msg, setMsg] = useState<string>('');

  const hqGroupKeys = useMemo(
    () => groups.map((g) => g.group_key).filter((k) => k.startsWith('HQ_')),
    [groups],
  );

  const loadBase = async () => {
    setLoading(true);
    try {
      const [groupRows, deptRows, deptList, userList] = await Promise.all([
        api('/menu-policies/groups'),
        api('/menu-policies/dept-defaults'),
        api('/departments'),
        api('/users'),
      ]);
      setGroups(Array.isArray(groupRows) ? groupRows : []);
      setDeptDefaults(Array.isArray(deptRows) ? deptRows : []);
      setDepartments(Array.isArray(deptList) ? (deptList as Department[]).filter((d) => d.code !== 'CENTRAL') : []);
      setUsers(Array.isArray(userList) ? userList : []);
      if (!selectedUserId && Array.isArray(userList) && userList[0]?.id) {
        setSelectedUserId(userList[0].id);
      }
    } catch (e: any) {
      setMsg(e.message || '정책 데이터를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const loadUserPolicy = async (userId: string) => {
    if (!userId) return;
    try {
      const [override, previewRes] = await Promise.all([
        api(`/menu-policies/users/${userId}`),
        api(`/menu-policies/preview/${userId}`),
      ]);
      setUserOverride(override as UserPolicyOverride);
      setPreview(previewRes as PreviewResponse);
    } catch (e: any) {
      setMsg(e.message || '사용자 정책을 불러오지 못했습니다.');
    }
  };

  useEffect(() => {
    loadBase();
  }, []);

  useEffect(() => {
    if (selectedUserId) loadUserPolicy(selectedUserId);
  }, [selectedUserId]);

  const updateGroupField = (groupKey: string, field: 'label' | 'menu_keys' | 'permission_keys', value: string) => {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.group_key !== groupKey) return g;
        if (field === 'label') return { ...g, label: value };
        return { ...g, [field]: fromCsv(value) } as WorkGroupPolicy;
      }),
    );
  };

  const saveGroups = async () => {
    setSavingGroups(true);
    try {
      const result = await api('/menu-policies/groups', {
        method: 'PUT',
        body: JSON.stringify({ groups }),
      });
      setGroups(Array.isArray(result) ? result : groups);
      setMsg('업무그룹 정책을 저장했습니다.');
    } catch (e: any) {
      setMsg(e.message || '업무그룹 저장에 실패했습니다.');
    } finally {
      setSavingGroups(false);
    }
  };

  const toggleDeptGroup = (departmentId: string, groupKey: string) => {
    setDeptDefaults((prev) => {
      const exists = prev.find((r) => r.department_id === departmentId);
      if (!exists) {
        return [...prev, { department_id: departmentId, group_keys: [groupKey] }];
      }
      const has = exists.group_keys.includes(groupKey);
      return prev.map((r) =>
        r.department_id !== departmentId
          ? r
          : {
              ...r,
              group_keys: has ? r.group_keys.filter((k) => k !== groupKey) : [...r.group_keys, groupKey],
            },
      );
    });
  };

  const saveDeptDefaults = async () => {
    setSavingDeptDefaults(true);
    try {
      const result = await api('/menu-policies/dept-defaults', {
        method: 'PUT',
        body: JSON.stringify({ defaults: deptDefaults }),
      });
      setDeptDefaults(Array.isArray(result) ? result : deptDefaults);
      setMsg('부서 기본할당을 저장했습니다.');
    } catch (e: any) {
      setMsg(e.message || '부서 기본할당 저장에 실패했습니다.');
    } finally {
      setSavingDeptDefaults(false);
    }
  };

  const toggleUserGroup = (field: 'add_group_keys' | 'remove_group_keys', groupKey: string) => {
    setUserOverride((prev) => {
      if (!prev) return prev;
      const has = prev[field].includes(groupKey);
      return {
        ...prev,
        [field]: has ? prev[field].filter((k) => k !== groupKey) : [...prev[field], groupKey],
      };
    });
  };

  const saveUserOverride = async () => {
    if (!selectedUserId || !userOverride) return;
    setSavingOverride(true);
    try {
      const result = await api(`/menu-policies/users/${selectedUserId}`, {
        method: 'PUT',
        body: JSON.stringify(userOverride),
      });
      setUserOverride(result as UserPolicyOverride);
      await loadUserPolicy(selectedUserId);
      setMsg('사용자 예외를 저장했습니다.');
    } catch (e: any) {
      setMsg(e.message || '사용자 예외 저장에 실패했습니다.');
    } finally {
      setSavingOverride(false);
    }
  };


  const deptDefaultMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of deptDefaults) map.set(row.department_id, row.group_keys || []);
    return map;
  }, [deptDefaults]);

  const wardDepartments = useMemo(
    () => departments.filter((d) => String(d.name || '').includes('병동')),
    [departments],
  );
  const displayedDepartments = useMemo(() => {
    if (showAllDepartments) return departments;
    if (wardDepartments.length > 0) return wardDepartments;
    return departments;
  }, [showAllDepartments, wardDepartments, departments]);

  return (
    <div className="space-y-4">
      <div className="card">
        <h3 className="section-title">업무그룹 정책</h3>
        {loading ? (
          <div className="text-sm text-gray-500">불러오는 중...</div>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.group_key} className="border border-gray-200 rounded-lg p-3 bg-white">
                <div className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <span>{g.group_key}</span>
                  {SYSTEM_GROUP_KEYS.has(g.group_key) && (
                    <span className="badge-gray text-[10px]">고정</span>
                  )}
                </div>
                <div className="grid md:grid-cols-3 gap-2">
                  <input
                    className="input"
                    value={g.label}
                    onChange={(e) => updateGroupField(g.group_key, 'label', e.target.value)}
                    placeholder="그룹명"
                    disabled={SYSTEM_GROUP_KEYS.has(g.group_key)}
                  />
                  <input
                    className="input md:col-span-2"
                    value={toCsv(g.menu_keys)}
                    onChange={(e) => updateGroupField(g.group_key, 'menu_keys', e.target.value)}
                    placeholder="menu keys (comma separated)"
                    disabled={SYSTEM_GROUP_KEYS.has(g.group_key)}
                  />
                  <input
                    className="input md:col-span-3"
                    value={toCsv(g.permission_keys)}
                    onChange={(e) => updateGroupField(g.group_key, 'permission_keys', e.target.value)}
                    placeholder="permission keys (comma separated)"
                    disabled={SYSTEM_GROUP_KEYS.has(g.group_key)}
                  />
                </div>
                <div className="text-xs text-gray-400 mt-1">
                  {g.menu_keys.map((k) => MENU_LABELS[k] || k).join(', ')}
                </div>
              </div>
            ))}
            <div className="flex justify-end">
              <button className="btn-primary" onClick={saveGroups} disabled={savingGroups}>
                {savingGroups ? '저장 중...' : '업무그룹 저장'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h3 className="section-title">부서 기본할당</h3>
          <button
            type="button"
            onClick={() => setShowAllDepartments((v) => !v)}
            className="btn-secondary text-xs"
            style={{ padding: '6px 10px' }}
          >
            {showAllDepartments ? '병동만 보기' : '전체 부서 보기'}
          </button>
        </div>
        {!showAllDepartments && (
          <p className="text-xs text-gray-500 mb-2">기본은 병동만 표시합니다. 필요 시 전체 부서 보기로 전환하세요.</p>
        )}
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>부서</th>
                {hqGroupKeys.map((k) => (
                  <th key={k}>{k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayedDepartments.map((dept) => {
                const selected = deptDefaultMap.get(dept.id) || [];
                return (
                  <tr key={dept.id}>
                    <td>{dept.name}</td>
                    {hqGroupKeys.map((k) => (
                      <td key={k}>
                        <input
                          type="checkbox"
                          checked={selected.includes(k)}
                          onChange={() => toggleDeptGroup(dept.id, k)}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex justify-end">
          <button className="btn-primary" onClick={saveDeptDefaults} disabled={savingDeptDefaults}>
            {savingDeptDefaults ? '저장 중...' : '부서 기본할당 저장'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3 className="section-title">사용자 예외 + 프리뷰</h3>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <select
              className="input"
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
            >
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name} ({u.username})
                </option>
              ))}
            </select>

            {userOverride && (
              <>
                <div>
                  <div className="text-xs font-semibold text-gray-500 mb-1">추가 그룹</div>
                  <div className="flex flex-wrap gap-2">
                    {hqGroupKeys.map((k) => (
                      <label key={`add-${k}`} className="text-xs flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={userOverride.add_group_keys.includes(k)}
                          onChange={() => toggleUserGroup('add_group_keys', k)}
                        />
                        {k}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold text-gray-500 mb-1">제외 그룹</div>
                  <div className="flex flex-wrap gap-2">
                    {hqGroupKeys.map((k) => (
                      <label key={`remove-${k}`} className="text-xs flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={userOverride.remove_group_keys.includes(k)}
                          onChange={() => toggleUserGroup('remove_group_keys', k)}
                        />
                        {k}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="label">메뉴 추가(include)</label>
                  <input
                    className="input"
                    value={toCsv(userOverride.include_menu_keys)}
                    onChange={(e) =>
                      setUserOverride((prev) => (prev ? { ...prev, include_menu_keys: fromCsv(e.target.value) } : prev))
                    }
                  />
                </div>
                <div>
                  <label className="label">메뉴 제외(exclude)</label>
                  <input
                    className="input"
                    value={toCsv(userOverride.exclude_menu_keys)}
                    onChange={(e) =>
                      setUserOverride((prev) => (prev ? { ...prev, exclude_menu_keys: fromCsv(e.target.value) } : prev))
                    }
                  />
                </div>
                <div className="flex justify-end">
                  <button className="btn-primary" onClick={saveUserOverride} disabled={savingOverride}>
                    {savingOverride ? '저장 중...' : '사용자 예외 저장'}
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="bg-gray-50 rounded-xl p-3 border border-gray-200">
            {preview ? (
              <div className="space-y-2 text-sm">
                <div>
                  <span className="font-semibold">사용자:</span> {preview.user.display_name} / {preview.user.department_name || '-'}
                </div>
                <div>
                  <span className="font-semibold">최종 그룹:</span> {preview.effective.effective_work_groups.join(', ') || '-'}
                </div>
                <div>
                  <span className="font-semibold">최종 메뉴:</span>{' '}
                  {preview.effective.menu_permissions.map((k) => MENU_LABELS[k] || k).join(', ') || '-'}
                </div>
                <div>
                  <span className="font-semibold">권한 누락:</span>{' '}
                  {preview.effective.missing_permission_keys.join(', ') || '없음'}
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-500">프리뷰 없음</div>
            )}
          </div>
        </div>
      </div>

      {msg && <div className="text-xs text-teal-700">{msg}</div>}
      <div className="text-xs text-gray-400">
        공통 6개 메뉴(소모품/비품/재고/사용/대여/수령검수)는 정책상 자동 포함됩니다.
      </div>
      <div className="text-xs text-gray-400">
        중앙창고(CENTRAL)는 정책 대상 부서에서 제외됩니다.
      </div>
      <div className="text-xs text-gray-400">
        부서명/조직 변경 시에도 부서 ID 기준 매핑이 유지되며, 신규 부서는 저장 전까지 기본값으로 계산됩니다.
      </div>
      <div className="text-xs text-gray-400">
        부서명: {departments.length}개 / 사용자: {users.length}명 / 정책그룹: {groups.length}개
      </div>

    </div>
  );
}


