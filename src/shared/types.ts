// ── 품목 카테고리 3단 계층 (대/중/소) ─────────────────────────────────────
// 대(major) 6개 → 중(mid) 21개 → 소(sub): items.sub_category 에 선택적으로 저장
// items.category 필드에는 mid value 저장
// 소분류 (sub category) — items.category 에 저장되는 코드. 50개.
// 카테고리 prefix 로 대분류·중분류가 자동 도출됨 (getMajor / getMidCategory)
export const CATEGORY_HIERARCHY = [
  {
    major: 'MED', major_label: '의료소모품',
    mids: [
      { value: 'MED_INJECTION', label: '주사·수액' },
      { value: 'MED_DRESSING',  label: '드레싱·고정' },
      { value: 'MED_AIRWAY',    label: '호흡·삽관' },
      { value: 'MED_CATHETER',  label: '카테터·튜브' },
      { value: 'MED_SURGICAL',  label: '수술·시술' },
      { value: 'MED_DISINFECT', label: '소독·멸균' },
      { value: 'MED_HANBANG',   label: '한방재료' },
    ],
  },
  {
    major: 'INFECT', major_label: '감염 보호구',
    mids: [
      { value: 'INFECT_GLOVE', label: '일회용 장갑' },
      { value: 'INFECT_GOWN',  label: '일회용 가운·앞치마' },
      { value: 'INFECT_MASK',  label: '마스크' },
    ],
  },
  {
    major: 'PAT', major_label: '위생·생활케어',
    mids: [
      { value: 'PAT_HYGIENE',  label: '환자위생케어' },
      { value: 'PAT_PAPER',    label: '지류·티슈' },
      { value: 'PAT_BAG',      label: '비닐·봉투류' },
      { value: 'PAT_HANDWASH', label: '핸드워시' },
    ],
  },
  {
    major: 'DIAPER', major_label: '기저귀',
    mids: [
      { value: 'DIAPER_MAIN', label: '기저귀' },
    ],
  },
  {
    major: 'FAC', major_label: '청소·주방',
    mids: [
      { value: 'FAC_DETERGENT', label: '세제·세정제' },
      { value: 'FAC_SPONGE',    label: '수세미' },
      { value: 'FAC_TOOL',      label: '청소도구' },
      { value: 'FAC_PEST',      label: '살충·방향' },
      { value: 'FAC_DISH',      label: '일회용 식기' },
      { value: 'FAC_KIT_TOOL',  label: '주방도구' },
    ],
  },
  {
    major: 'OFF', major_label: '사무용품',
    mids: [
      // 필기·문구 sub
      { value: 'OFF_PEN',        label: '펜·마카' },
      { value: 'OFF_CLIP',       label: '클립·스테이플러' },
      { value: 'OFF_CUTTING',    label: '절단·접착' },
      { value: 'OFF_STN_OTHER',  label: '기타 문구' },
      // 용지·인쇄 sub
      { value: 'OFF_BASIC_PAPER',label: '일반 용지·노트' },
      { value: 'OFF_LABEL',      label: '라벨' },
      { value: 'OFF_FORM',       label: '의료 양식지' },
      { value: 'OFF_PRINT',      label: '인쇄물·포스트잇' },
      // 파일·바인더 sub
      { value: 'OFF_CLEARFILE',  label: '클리어화일' },
      { value: 'OFF_GOVFILE',    label: '정부화일' },
      { value: 'OFF_FILE_OTHER', label: '펀치·바인더·기타' },
      // 봉투·포장 sub
      { value: 'OFF_ENVELOPE',   label: '봉투' },
      { value: 'OFF_BOX',        label: '문서함·박스' },
      { value: 'OFF_BAG',        label: '쇼핑백' },
      { value: 'OFF_GIFT',       label: '경조사 봉투' },
      // 전산·전자 sub
      { value: 'OFF_BATTERY',    label: '건전지' },
      { value: 'OFF_STORAGE',    label: '저장매체' },
      { value: 'OFF_CAMERA',     label: '카메라 소모품' },
    ],
  },
  {
    major: 'FOOD', major_label: '식음료',
    mids: [
      { value: 'FOOD_WATER',    label: '생수' },
      { value: 'FOOD_BEVERAGE', label: '음료' },
      { value: 'FOOD_INSTANT',  label: '인스턴트 식품' },
    ],
  },
] as const;

// 중분류 flat 리스트 — 기존 CONSUMABLE_CATEGORIES 호환 형태 유지 ({ value, label, group })
export const CONSUMABLE_CATEGORIES = CATEGORY_HIERARCHY.flatMap(major =>
  major.mids.map(mid => ({
    value: mid.value,
    label: mid.label,
    group: major.major_label,
    major: major.major,
  }))
);

// 헬퍼: 중분류 value 로 대분류 찾기 (소모품 + 비품 모두 지원)
export function getMajorByMid(midValue: string): { major: string; major_label: string } | null {
  for (const m of CATEGORY_HIERARCHY) {
    if (m.mids.some(x => x.value === midValue)) return { major: m.major, major_label: m.major_label };
  }
  if (typeof midValue === 'string' && midValue.startsWith('EQUIP_')) {
    return { major: 'EQUIP', major_label: '비품' };
  }
  return null;
}

// 헬퍼: 중분류 value → 라벨
export function getMidLabel(midValue: string): string {
  for (const m of CATEGORY_HIERARCHY) {
    const hit = m.mids.find(x => x.value === midValue);
    if (hit) return hit.label;
  }
  return midValue;
}

export const EQUIPMENT_CATEGORIES = [
  { value: 'EQUIP_MEDICAL', label: '의료기기', group: '비품' },
  { value: 'EQUIP_ACCESSORY', label: '의료기기 부속품', group: '비품' },
  { value: 'EQUIP_AID', label: '의료보조장비', group: '비품' },
  { value: 'EQUIP_FURNITURE', label: '사무가구', group: '비품' },
  { value: 'EQUIP_APPLIANCE', label: '가전제품', group: '비품' },
  { value: 'EQUIP_IT', label: '전산/IT장비', group: '비품' },
  { value: 'EQUIP_LIVING', label: '생활', group: '비품' },
  { value: 'EQUIP_SAFETY', label: '안전/위생장비', group: '비품' },
] as const;

export const ALL_CATEGORIES = [...CONSUMABLE_CATEGORIES, ...EQUIPMENT_CATEGORIES];

export const CONSUMABLE_CATEGORY_VALUES = CONSUMABLE_CATEGORIES.map((c) => c.value);
export const EQUIPMENT_CATEGORY_VALUES = EQUIPMENT_CATEGORIES.map((c) => c.value);
export const ALL_CATEGORY_VALUES = ALL_CATEGORIES.map((c) => c.value);

export const ITEM_EXPENSE_SCOPES = [
  { value: 'PATIENT_DIRECT', label: '환자직접비' },
  { value: 'OPS_INDIRECT', label: '운영간접비' },
] as const;

// ── 재활구분 (rehab_type) ────────────────────────────────────────
// CNS  : 뇌신경계 재활 (뇌출혈·뇌경색·파킨슨 등)
// OS   : "CNS 외" — 정형외과·기타 재활 (척추협착·골절·암 등)
//        ※ 값은 'OS' 유지(코드 호환), 라벨은 'CNS 외'
// OUTPATIENT : 외래
// ''  : 해당없음 (요양·일반)
export const REHAB_TYPES = [
  { value: 'CNS', label: 'CNS', badgeClass: 'bg-purple-100 text-purple-700 border-purple-200' },
  { value: 'OS', label: 'CNS 외', badgeClass: 'bg-orange-100 text-orange-700 border-orange-200' },
  { value: 'OUTPATIENT', label: '외래', badgeClass: 'bg-slate-100 text-slate-600 border-slate-200' },
] as const;

export type RehabType = '' | 'CNS' | 'OS' | 'OUTPATIENT';

export function getRehabTypeLabel(value: string | null | undefined): string {
  if (!value) return '-';
  return REHAB_TYPES.find(r => r.value === value)?.label ?? value;
}

export function getRehabBadgeClass(value: string | null | undefined): string {
  if (!value) return '';
  return REHAB_TYPES.find(r => r.value === value)?.badgeClass ?? 'bg-gray-100 text-gray-600 border-gray-200';
}

// ── Onset 경과 기간 버킷 ─────────────────────────────────────────
// 엑셀 4.30 기준 재활 수가 산정용 — ~6m / 6m~1y6m / 1y6m~2y / 2y~5y / 5y~7y / 7y+
// maxDays 는 해당 버킷의 상한 (포함). 미입력은 'NONE'.
export const ONSET_BUCKETS = [
  { key: 'lt6m',     label: '~6m',     maxDays: 183 },   // ~6개월
  { key: '6m_1y6m',  label: '6m~1y6m', maxDays: 547 },   // 6m~1년6개월
  { key: '1y6m_2y',  label: '1y6m~2y', maxDays: 730 },   // 1년6개월~2년
  { key: '2y_5y',    label: '2y~5y',   maxDays: 1825 },  // 2~5년
  { key: '5y_7y',    label: '5y~7y',   maxDays: 2557 },  // 5~7년
  { key: 'gt7y',     label: '7y+',     maxDays: Number.POSITIVE_INFINITY },
] as const;

export type OnsetBucketKey = typeof ONSET_BUCKETS[number]['key'];

// 발병일 → 경과 일수
export function getOnsetDays(onsetDate: string | Date | null | undefined, refDate?: Date): number | null {
  if (!onsetDate) return null;
  const d = onsetDate instanceof Date ? onsetDate : new Date(onsetDate);
  if (Number.isNaN(d.getTime())) return null;
  const ref = refDate ?? new Date();
  const days = Math.floor((ref.getTime() - d.getTime()) / 86400000);
  return days < 0 ? 0 : days;
}

// 발병일 → 버킷 key
export function getOnsetBucketKey(onsetDate: string | Date | null | undefined, refDate?: Date): OnsetBucketKey | null {
  const days = getOnsetDays(onsetDate, refDate);
  if (days === null) return null;
  for (const b of ONSET_BUCKETS) if (days <= b.maxDays) return b.key;
  return 'gt7y';
}

export function getOnsetBucketLabel(key: string | null | undefined): string {
  if (!key) return '-';
  return ONSET_BUCKETS.find(b => b.key === key)?.label ?? '-';
}

// 일수 → "n개월" / "n년 n개월" 형식 (UI 표시)
export function formatOnsetDuration(days: number | null): string {
  if (days === null || days < 0) return '-';
  if (days < 30) return `${days}일`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}개월`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem > 0 ? `${years}년 ${rem}개월` : `${years}년`;
}

// ── 3단 분류 체계 (저장하지 않고 소분류 카테고리 prefix 에서 자동 도출) ─────────
// 대분류 (4): 의료소모품 / 일반소모품 / 사무용품 / 비품
// 중분류 (24): 쇼핑몰 스타일 — 제품 유형/기능 중심
// 소분류 (33): items.category (DB 저장)
// 환자/직원 구분은 비용구분(expense_scope: PATIENT_DIRECT / OPS_INDIRECT)으로 별도 관리

export type MajorGroup = 'MEDICAL' | 'GENERAL' | 'DIAPER' | 'OFFICE' | 'EQUIPMENT';
export const MAJOR_GROUP_LABEL: Record<MajorGroup, string> = {
  MEDICAL: '의료소모품',
  GENERAL: '일반소모품',
  DIAPER: '기저귀',
  OFFICE: '사무용품',
  EQUIPMENT: '비품',
};
export function getMajor(category: string): MajorGroup {
  const c = String(category || '').toUpperCase();
  if (c.startsWith('EQUIP_')) return 'EQUIPMENT';
  if (c.startsWith('OFF_')) return 'OFFICE';
  if (c.startsWith('MED_') || c.startsWith('INFECT_')) return 'MEDICAL';
  if (c.startsWith('DIAPER')) return 'DIAPER';
  return 'GENERAL';
}

// 중분류 정의 — 24개. 각 중분류는 1개 이상의 소분류(category) 코드를 묶음
export const MID_CATEGORIES = [
  // 의료소모품 (8)
  { value: 'MED_INJECTION_M', label: '주사·수액',     major: 'MEDICAL',   subs: ['MED_INJECTION'] },
  { value: 'MED_DRESSING_M',  label: '드레싱·고정',   major: 'MEDICAL',   subs: ['MED_DRESSING'] },
  { value: 'MED_AIRWAY_M',    label: '호흡·삽관',     major: 'MEDICAL',   subs: ['MED_AIRWAY'] },
  { value: 'MED_CATHETER_M',  label: '카테터·튜브',   major: 'MEDICAL',   subs: ['MED_CATHETER'] },
  { value: 'MED_SURGICAL_M',  label: '수술·시술',     major: 'MEDICAL',   subs: ['MED_SURGICAL'] },
  { value: 'MED_DISINFECT_M', label: '소독·멸균',     major: 'MEDICAL',   subs: ['MED_DISINFECT'] },
  { value: 'INFECT_M',        label: '감염보호구',     major: 'MEDICAL',   subs: ['INFECT_GLOVE','INFECT_GOWN','INFECT_MASK'] },
  { value: 'MED_HANBANG_M',   label: '한방재료',       major: 'MEDICAL',   subs: ['MED_HANBANG'] },

  // 일반소모품 (3)
  { value: 'GEN_HYGIENE', label: '위생·생활케어', major: 'GENERAL', subs: ['PAT_HYGIENE','PAT_PAPER','PAT_BAG','PAT_HANDWASH'] },
  { value: 'GEN_FOOD',    label: '식음료',         major: 'GENERAL', subs: ['FOOD_WATER','FOOD_BEVERAGE','FOOD_INSTANT'] },
  { value: 'GEN_CLEAN',   label: '청소·주방',      major: 'GENERAL', subs: ['FAC_DETERGENT','FAC_SPONGE','FAC_TOOL','FAC_PEST','FAC_DISH','FAC_KIT_TOOL'] },

  // 기저귀 (1)
  { value: 'DIAPER_M',    label: '기저귀',         major: 'DIAPER',  subs: ['DIAPER_MAIN'] },

  // 사무용품 (6) — 각 중분류 안에 세분화된 sub 들
  { value: 'OFF_STATIONERY_M', label: '필기·문구',    major: 'OFFICE', subs: ['OFF_PEN','OFF_CLIP','OFF_CUTTING','OFF_STN_OTHER'] },
  { value: 'OFF_PAPER_M',      label: '용지·인쇄',    major: 'OFFICE', subs: ['OFF_BASIC_PAPER','OFF_LABEL','OFF_FORM','OFF_PRINT'] },
  { value: 'OFF_FILE_M',       label: '파일·바인더',  major: 'OFFICE', subs: ['OFF_CLEARFILE','OFF_GOVFILE','OFF_FILE_OTHER'] },
  { value: 'OFF_PACK',         label: '봉투·포장',    major: 'OFFICE', subs: ['OFF_ENVELOPE','OFF_BOX','OFF_BAG','OFF_GIFT'] },
  { value: 'OFF_ELEC',         label: '전산·전자',    major: 'OFFICE', subs: ['OFF_BATTERY','OFF_STORAGE','OFF_CAMERA'] },

  // 비품 (6)
  { value: 'EQUIP_MEDICAL_M', label: '의료기기',        major: 'EQUIPMENT', subs: ['EQUIP_MEDICAL'] },
  { value: 'EQUIP_ACC_M',     label: '의료기기 부속품', major: 'EQUIPMENT', subs: ['EQUIP_ACCESSORY'] },
  { value: 'EQUIP_AID_M',     label: '의료보조장비',    major: 'EQUIPMENT', subs: ['EQUIP_AID'] },
  { value: 'EQUIP_FURN_M',    label: '가구·집기',       major: 'EQUIPMENT', subs: ['EQUIP_FURNITURE'] },
  { value: 'EQUIP_APPL_M',    label: '가전제품',        major: 'EQUIPMENT', subs: ['EQUIP_APPLIANCE'] },
  { value: 'EQUIP_IT_M',      label: '전산/IT장비',     major: 'EQUIPMENT', subs: ['EQUIP_IT'] },
  { value: 'EQUIP_LIVING_M',  label: '생활',            major: 'EQUIPMENT', subs: ['EQUIP_LIVING'] },
] as const;

export type MidCategoryValue = typeof MID_CATEGORIES[number]['value'];

// 소분류 → 중분류 매핑 (역참조 캐시)
const SUB_TO_MID: Record<string, { value: string; label: string }> = (() => {
  const m: Record<string, { value: string; label: string }> = {};
  for (const mid of MID_CATEGORIES) {
    for (const sub of mid.subs) m[sub] = { value: mid.value, label: mid.label };
  }
  return m;
})();

// ── 사용자 추가 중분류 레지스트리 ───────────────────────────────────────────
// 기본 27개 중분류는 위 MID_CATEGORIES 로 고정. 사용자가 "분류 관리"에서 추가한
// 중분류는 런타임에 주입한다 (클라이언트: 부팅 시 / 서버: 시작·변경 시).
// code 는 대분류 접두어를 포함하므로(MED_/OFF_/EQUIP_/DIAPER_/GEN_)
// getMajor·품목코드 접두어 로직은 변경 없이 그대로 통과한다.
export interface UserMidCategory { code: string; name: string }
let USER_MID_MAP: Record<string, string> = {};
let USER_MID_LIST: UserMidCategory[] = [];
export function setUserMidCategories(list: UserMidCategory[] | null | undefined): void {
  USER_MID_LIST = Array.isArray(list)
    ? list.map(x => ({ code: String(x.code || '').toUpperCase(), name: String(x.name || '') }))
         .filter(x => x.code && x.name)
    : [];
  USER_MID_MAP = {};
  for (const c of USER_MID_LIST) USER_MID_MAP[c.code] = c.name;
}
export function getUserMidCategories(): UserMidCategory[] { return USER_MID_LIST; }
export function isUserMidCategory(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(USER_MID_MAP, String(code || '').toUpperCase());
}

// 소분류(category code) → 중분류 정보 (없으면 사용자 추가 중분류로 폴백)
export function getMidCategory(category: string): { value: string; label: string } | null {
  const hit = SUB_TO_MID[category];
  if (hit) return hit;
  const up = String(category || '').toUpperCase();
  const name = USER_MID_MAP[up];
  return name ? { value: up, label: name } : null;
}

// 중분류 라벨 단축
export function getMidLabel2(category: string): string {
  return getMidCategory(category)?.label ?? '';
}

// 레거시 호환 — getStatsGroup/STATS_GROUP_LABEL 사용 코드용
export const getStatsGroup = getMajor;
export type StatsGroup = MajorGroup;
export const STATS_GROUP_LABEL = MAJOR_GROUP_LABEL;

export function getCategoryLabel(value: string): string {
  const found = ALL_CATEGORIES.find(c => c.value === value);
  if (found) return found.label;
  const up = String(value || '').toUpperCase();
  return USER_MID_MAP[up] ?? value;
}

export function isEquipmentCategory(value: string): boolean {
  return EQUIPMENT_CATEGORY_VALUES.includes(value as any);
}

export interface AuthUser {
  id: string;
  username: string;
  display_name: string;
  department_id: string | null;
  department_name: string | null;
  permissions: string[];
  roles: string[];
  menu_permissions: string[] | null;
  direct_permissions: string[] | null;
  effective_work_groups?: string[];
  has_custom_menu_permissions?: boolean;
  menu_scopes?: Record<string, boolean>;
}

export const PERMS = {
  WARD_REQUEST_CREATE:   'WARD_REQUEST_CREATE',
  WARD_REQUEST_VIEW_ALL: 'WARD_REQUEST_VIEW_ALL',
  APPROVAL_DECIDE:       'APPROVAL_DECIDE',
  PO_CREATE:             'PO_CREATE',
  PO_SEND:               'PO_SEND',
  STOCK_IN_EXECUTE:      'STOCK_IN_EXECUTE',
  STOCK_OUT_EXECUTE:     'STOCK_OUT_EXECUTE',
  INVENTORY_VIEW:        'INVENTORY_VIEW',
  INVENTORY_WRITE:       'INVENTORY_WRITE',
  MASTER_WRITE:          'MASTER_WRITE',
  BASELINE_WRITE:        'BASELINE_WRITE',
  STATS_WRITE:           'STATS_WRITE',
  ACCOUNTING_VIEW:       'ACCOUNTING_VIEW',
  ACCOUNTING_CLOSE:      'ACCOUNTING_CLOSE',
  AUDIT_VIEW:            'AUDIT_VIEW',
  USER_MANAGE:           'USER_MANAGE',
  SYSTEM_ADMIN:          'SYSTEM_ADMIN',
  // 관리과 / 원무부 전용 권한
  REPAIR_MANAGE:         'REPAIR_MANAGE',
  PATIENT_MANAGE:        'PATIENT_MANAGE',
} as const;

export type Permission = typeof PERMS[keyof typeof PERMS];

export type WardRequestStatus =
  | 'DRAFT' | 'SUBMITTED' | 'APPROVED'
  | 'PARTIAL_APPROVED' | 'REJECTED' | 'CANCELLED';

export type POStatus =
  | 'DRAFT' | 'SENT' | 'PARTIAL_RECEIVED' | 'CLOSED' | 'CANCELLED';

// ?? Domain interfaces ????????????????????????

export interface Department {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  is_active: boolean;
  children?: Department[];
}

export interface Role {
  id: string;
  name: string;
  description: string;
}

export interface UserInfo {
  id: string;
  username: string;
  display_name: string;
  department_id: string | null;
  department_name: string | null;
  is_active: boolean;
  roles: string[];
  permissions: string[];
  last_login_at: string | null;
  menu_permissions: string[] | null;
  direct_permissions: string[] | null;
  effective_work_groups?: string[];
  has_custom_menu_permissions?: boolean;
  menu_scopes?: Record<string, boolean>;
}

export interface MenuScope {
  menu_key: string;
  department_ids: string[];
}

export interface WorkGroupPolicy {
  group_key: string;
  label: string;
  menu_keys: string[];
  permission_keys: string[];
}

export interface DeptDefaultPolicy {
  department_id: string;
  group_keys: string[];
}

export interface UserPolicyOverride {
  user_id: string;
  add_group_keys: string[];
  remove_group_keys: string[];
  include_menu_keys: string[];
  exclude_menu_keys: string[];
}

export interface Vendor {
  id: string;
  code: string;
  name: string;
  phone: string;
  email: string;
  lead_time_days: number;
  is_active: boolean;
}

export interface Item {
  id: string;
  item_code: string;
  name: string;
  category: string;
  expense_scope: string;
  uom: string;            // @deprecated — purchase_uom/issue_uom 사용
  purchase_uom: string;   // 발주 단위 (예: 박스)
  issue_uom: string;      // 불출/재고 단위 (예: 개)
  pack_size: number;      // 1 purchase_uom = pack_size issue_uom
  sub_category?: string;  // 사이즈/규격 (예: "14Fr", "5cc/23G", "3호/450g")
  default_vendor_id: string | null;
  default_vendor_name?: string;
  min_order_qty: number;
  is_regular_order: boolean;
  reorder_days_threshold: number;
  is_active: boolean;
  latest_price?: number;
  on_hand_qty?: number;
  image_url?: string | null;
}

export interface HiraItemResult {
  itmNm: string;       // 품목명
  mxUnprc: number | null; // 상한가
  unit: string;        // 단위
  mnfEntpNm: string;   // 제조업체
  impEntpNm: string;   // 수입업체
  nomNm: string;       // 규격명
  payTpNm: string;     // 급여유형
  mcatCd: string;      // 재료대코드
  mdivCdNm: string;    // 중분류명
  ldgrpCdNm: string;   // 대분류명
}

export interface HiraDiseaseCodeResult {
  sickCd: string;     // 질병코드
  sickNm: string;     // 질병명
  sickEngNm: string;  // 질병 영문명
}

export interface HiraDiseaseStatBase {
  sickCd: string;
  sickNm: string;
  ptntCnt: number;       // 환자수
  vstDdcnt: number;      // 내원일수
  specCnt: number;       // 명세서건수
  rvdRpeTamtAmt: number; // 요양급여총액
  rvdInsupBrdnAmt: number; // 보험자부담금
}

export interface HiraInpatientStat extends HiraDiseaseStatBase {
  sex: string;
  inpatOpat: string; // 입원/외래
}

export interface HiraGenderAgeStat extends HiraDiseaseStatBase {
  sex: string;
  age: string;
}

export interface HiraInstitutionStat extends HiraDiseaseStatBase {
  grade: string; // 기관종별
}

export interface HiraRegionStat extends HiraDiseaseStatBase {
  lcName: string; // 지역명
}

export interface ItemVendorMap {
  id: string;
  item_id: string;
  vendor_id: string;
  vendor_name?: string;
  priority: number;
  is_active: boolean;
}

export interface PriceHistory {
  id: string;
  item_id: string;
  vendor_id: string;
  vendor_name?: string;
  price: number;
  effective_from: string;
  effective_to: string | null;
  source: string;
  created_at: string;
}

export interface UsageBaseline {
  id: string;
  item_id: string;
  item_name?: string;
  item_code?: string;
  department_scope: string;
  period_type: string;
  qty_per_patient: number;
  version: number;
  effective_from: string;
  effective_to: string | null;
  creator_name?: string;
}

export interface PatientStat {
  id: string;
  department_id: string;
  department_name?: string;
  period_type: string;
  period_start: string;
  period_end: string;
  patient_count: number;
}

export interface WardRequestItem {
  id?: string;
  item_id: string;
  item_name?: string;
  item_code?: string;
  uom?: string;
  requested_qty: number;
  current_stock_qty?: number | null; // 정기 소모품 신청 시 필수 — 신청 시점의 부서 재고
  baseline_qty: number;
  diff_pct: number;
  policy_flags: string[];
  note: string;
  approved_qty?: number;
  latest_price?: number;
  on_hand_qty?: number;
}

export type RecommendationSource = 'BASELINE' | 'HISTORY' | 'HYBRID' | 'NONE';
export type RecommendationConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RequestRecommendationItem {
  item_id: string;
  on_hand_qty: number;
  baseline_per_patient: number;
  baseline_qty: number;
  history_avg_monthly: number;
  history_trend_pct: number;
  history_monthly?: Array<{ month: string; total: number }>;
  confidence?: RecommendationConfidence;
  recommended_qty: number;
  source: RecommendationSource;
}

export interface RequestRecommendationResponse {
  current_patient_count: number;
  items: RequestRecommendationItem[];
}

export interface WardRequest {
  id: string;
  request_no: string;
  department_id: string;
  department_name?: string;
  requester_id: string;
  requester_name?: string;
  is_test?: boolean;
  period_type: string;
  period_start: string;
  period_end: string;
  status: WardRequestStatus;
  request_type: string;
  is_emergency: boolean;
  submitted_at: string | null;
  items: WardRequestItem[];
  total_amount?: number;
  last_action?: {
    action: string;
    reason: string;
    approver_name: string;
    created_at: string;
  };
}

export interface ApprovalDecidePayload {
  action: 'APPROVE' | 'ADJUST' | 'REJECT';
  reason: string;
  items: { item_id: string; approved_qty: number }[];
}

export interface PurchaseOrderItem {
  id?: string;
  item_id: string;
  item_name?: string;
  item_code?: string;
  uom?: string;
  ordered_qty: number;
  unit_price: number;
  line_amount: number;
}

export interface PurchaseOrder {
  id: string;
  po_no: string;
  vendor_id: string;
  vendor_name?: string;
  status: POStatus;
  is_test?: boolean;
  ordered_at: string;
  expected_at: string | null;
  pdf_path: string;
  total_amount: number;
  note: string;
  creator_name?: string;
  source_type?: string;
  schedule_period_label?: string;
  schedule_period_start?: string;
  schedule_period_matched?: boolean;
  has_mixed_period_labels?: boolean;
  item_count?: number;
  category_breakdown?: Record<string, number>;
  items: PurchaseOrderItem[];
  sources?: {
    ward_request_id: string;
    request_no?: string;
    department_id?: string;
    department_name?: string;
    request_type?: string;
    items: { item_id: string; item_name?: string; requested_qty: number }[];
  }[];
}

export interface DashboardDeptRequestSummaryRow {
  department_id: string;
  department_name: string;
  by_type: Record<string, string[]>;
}

export interface GoodsReceiptItem {
  id?: string;
  item_id: string;
  item_name?: string;
  item_code?: string;
  uom?: string;
  issue_uom?: string;
  pack_size?: number;
  received_qty: number;
  expected_qty?: number | null;
  confirmed_qty?: number | null;
  diff_qty?: number | null;
  diff_note?: string;
  confirmed_at?: string | null;
  unit_price: number;
  location_id: string;
  location_name?: string;
}

export interface GoodsReceipt {
  id: string;
  gr_no: string;
  purchase_order_id: string | null;
  po_no?: string;
  vendor_id?: string | null;        // 발주서 vendor 또는 manual_vendor_id 중 유효한 것
  vendor_name?: string | null;
  manual_vendor_id?: string | null; // 발주서 미연결 입고에서 사용자가 직접 지정한 거래처
  is_test?: boolean;
  receiver_name?: string;
  received_at: string;
  status: 'PENDING' | 'CONFIRMED' | 'DIFF_CONFIRMED' | 'REVERSED' | 'POSTED';
  note: string;
  confirmed_at?: string | null;
  confirmed_by?: string | null;
  diff_count?: number;
  items: GoodsReceiptItem[];
}

export interface PendingReceiptFollowUp {
  id: string;
  goods_receipt_id: string;
  purchase_order_id?: string | null;
  po_no?: string | null;
  vendor_id?: string | null;
  vendor_name?: string;
  item_id: string;
  item_code?: string;
  item_name?: string;
  uom?: string;
  missing_qty: number;
  status: 'OPEN' | 'RESOLVED' | 'CANCELLED';
  note: string;
  created_at: string;
  resolved_at?: string | null;
  resolved_by?: string | null;
}

export interface StockOutItem {
  id?: string;
  item_id: string;
  item_name?: string;
  item_code?: string;
  uom?: string;
  issued_qty: number;
  location_id: string;
  location_name?: string;
  received_qty?: number | null;
  receipt_note?: string;
  receipt_confirmed_at?: string | null;
  receipt_confirmed_by?: string | null;
}

export interface StockOut {
  id: string;
  so_no: string;
  department_id: string;
  department_name?: string;
  is_test?: boolean;
  ward_request_id: string | null;
  request_no?: string;
  issuer_name?: string;
  issued_at: string;
  status: 'RECEIPT_PENDING' | 'RECEIPT_CONFIRMED' | 'RECEIPT_DIFF' | 'REVERSED' | 'POSTED';
  note: string;
  receipt_confirmed_at?: string | null;
  receipt_confirmed_by?: string | null;
  receipt_diff_count?: number;
  items: StockOutItem[];
}

export interface StockOutReceiptDetail {
  id: string;
  so_no: string;
  department_id: string;
  department_name?: string;
  issued_at: string;
  status: StockOut['status'];
  receipt_confirmed_at?: string | null;
  receipt_diff_count?: number;
  items: Array<{
    id: string;
    item_id: string;
    item_name?: string;
    item_code?: string;
    uom?: string;
    location_id: string;
    location_name?: string;
    issued_qty: number;
    received_qty: number | null;
    diff_qty: number;
    receipt_note: string;
    receipt_confirmed_at?: string | null;
    // FIFO 비용 정보 — 어느 단가가 적용됐는지 사용자가 확인할 수 있도록
    fifo_total_amount?: number;        // 라인 총 비용 (모든 lot 분할 합산)
    fifo_avg_unit_cost?: number;       // 가중평균 단가 (=총비용/총수량)
    fifo_is_multi_lot?: boolean;       // 2개 이상 lot 분할 여부
    fifo_has_fallback?: boolean;       // 음수재고 fallback 단가 사용 여부
    fifo_allocations?: Array<{
      lot_id: string | null;
      is_base: boolean;                // 기초재고 lot 여부
      received_at: string | null;
      issued_qty: number;
      unit_cost: number;
      line_amount: number;
    }>;
  }>;
}

export interface StockOutReceiptConfirmResponse {
  message: string;
  status: StockOut['status'];
  receipt_diff_count: number;
  follow_up_count: number;
  follow_up_ids: string[];
}

export interface StockOutReceiptQueueRow {
  id: string;
  so_no: string;
  department_id: string;
  department_name?: string;
  issued_at: string;
  status: StockOut['status'];
  receipt_confirmed_at?: string | null;
  receipt_diff_count: number;
  item_count: number;
  sla_due_at: string;
  is_overdue: boolean;
  // 신청 정보 — 주차/유형별 그룹화 용
  ward_request_id?: string | null;
  request_type?: string | null;
  period_label?: string | null;
  period_start?: string | null;
  // 품목 카테고리 분포 (대분류별 개수)
  category_breakdown?: Partial<Record<MajorGroup, number>>;
}

export interface StockOutReceiptQueueResponse {
  meta: {
    pending_count: number;
    overdue_count: number;
    total_count: number;
  };
  rows: StockOutReceiptQueueRow[];
}

export interface StockOutFollowUpLite {
  id: string;
  stock_out_id: string;
  item_id: string;
  item_name?: string;
  item_code?: string;
  uom?: string;
  action_type: 'ISSUE_ADD' | 'COLLECT_BACK';
  diff_qty: number;
  status: 'OPEN' | 'RESOLVED' | 'CANCELLED';
  note: string;
  created_at: string;
  resolved_at?: string | null;
}

export interface StockOutWorkboardRow {
  ward_request_id: string;
  request_no: string;
  request_type: string;
  request_type_label: string;
  period_label: string;
  period_start: string | null;
  is_emergency: boolean;
  department_id: string;
  department_name: string;
  item_id: string;
  item_name: string;
  item_code: string;
  uom: string;
  pack_size: number;
  approved_qty: number;
  issued_qty_sum: number;
  remaining_qty: number;
  on_hand_qty: number;
  recommended_box_qty: number;
  recommended_location_id: string;
  recommended_location_name: string;
}

export interface StockOutWorkboardDepartmentGroup {
  department_id: string;
  department_name: string;
  request_count: number;
  item_count: number;
  total_remaining_qty: number;
  lines: StockOutWorkboardRow[];
}

export interface StockOutWorkboardItemTotal {
  item_id: string;
  item_name: string;
  item_code: string;
  uom: string;
  pack_size: number;
  total_approved_qty: number;
  total_issued_qty: number;
  total_remaining_qty: number;
  on_hand_qty: number;
  recommended_box_qty: number;
  recommended_location_id: string;
  recommended_location_name: string;
}

export interface StockOutWorkboardResponse {
  summary: {
    department_count: number;
    request_count: number;
    line_count: number;
    total_approved_qty: number;
    total_issued_qty: number;
    total_remaining_qty: number;
  };
  department_groups: StockOutWorkboardDepartmentGroup[];
  item_totals: StockOutWorkboardItemTotal[];
  rows: StockOutWorkboardRow[];
}

export interface StockOutFollowUp {
  id: string;
  stock_out_id: string;
  so_no?: string;
  ward_request_id?: string | null;
  department_id: string;
  department_name?: string;
  item_id: string;
  item_name?: string;
  item_code?: string;
  uom?: string;
  action_type: 'ISSUE_ADD' | 'COLLECT_BACK';
  diff_qty: number;
  status: 'OPEN' | 'RESOLVED' | 'CANCELLED';
  note: string;
  created_at: string;
  created_by: string;
  created_by_name?: string;
  resolved_at?: string | null;
  resolved_by?: string | null;
  resolved_by_name?: string;
}

export interface InventoryItem {
  id: string;
  item_id: string;
  item_code: string;
  item_name: string;
  category: string;
  uom: string;
  pack_size?: number;
  location_id: string;
  location_code: string;
  location_name: string;
  on_hand_qty: number;
  avg_unit_cost: number;
  total_value: number;
  updated_at: string;
  is_low_stock?: boolean;
  reorder_days?: number;
  default_vendor_name?: string;
}

export interface ItemInventorySummary {
  item_id: string;
  on_hand_qty_total: number;
}

export interface DeptCalendarEvent {
  id: string;
  department_id: string;
  department_name?: string;
  title: string;
  event_date: string;
  end_date?: string | null;
  color: string;
  created_by: string;
  creator_name?: string;
  event_type: string;           // TASK | MEETING | EVENT | OTHER
  visibility: string;           // PRIVATE | DEPARTMENT | ALL | SPECIFIC
  shared_user_ids?: string | null; // JSON string of user ID array
  start_time?: string | null;   // "09:00" 24h format
  end_time?: string | null;     // "10:30" 24h format
}

export interface DepartmentLoan {
  id: string;
  from_department_id: string;
  from_department_name?: string | null;
  to_department_id: string;
  to_department_name?: string | null;
  item_id: string;
  item_name?: string | null;
  item_code?: string | null;
  uom?: string | null;
  qty: number;
  loaned_at: string;
  note: string;
  status: 'ACTIVE' | 'REVERSED';
  created_by: string;
  creator_name?: string | null;
  created_at: string;
  reversed_at?: string | null;
  reversed_by?: string | null;
}

export interface VendorOrderSummary {
  vendor_id: string;
  vendor_name: string;
  order_amount_current: number;
  order_amount_previous: number;
  diff_pct: number;
}

export interface VendorInventorySummary {
  vendor_id: string;
  vendor_name: string;
  inventory_amount_fifo: number;
  lot_count: number;
  item_count: number;
}

export interface VendorSummaryResponse {
  period: {
    current: { date_from: string; date_to: string };
    previous: { date_from: string; date_to: string };
  };
  vendor_order_amounts: VendorOrderSummary[];
  vendor_inventory_amounts: VendorInventorySummary[];
  totals: {
    order_total_current: number;
    order_total_previous: number;
    order_diff_pct: number;
    inventory_total_fifo: number;
  };
}

export interface InventoryLocation {
  id: string;
  code: string;
  name: string;
  department_id: string | null;
  department_name?: string;
  is_active: boolean;
}

export interface CostStatistic {
  id: string;
  year_month: string;
  department_id: string;
  department_name?: string;
  item_id: string;
  item_name?: string;
  item_code?: string;
  issued_qty: number;
  issued_amount: number;
  avg_unit_price: number;
  overuse_count: number;
}

export interface DashboardSummary {
  month_issued_amount: number;
  month_request_count: number;
  pending_approval_count: number;
  low_stock_count: number;
  monthly_trend: { month: string; amount: number }[];
  top_items: { item_name: string; amount: number }[];
  dept_comparison: { dept_name: string; amount: number }[];
  recent_requests: {
    id: string;
    request_no: string;
    department_name: string;
    status: string;
    submitted_at: string | null;
  }[];
  request_status_counts?: Record<string, number>;
  upcoming_schedules?: {
    id: string;
    request_type: string;
    period_label: string;
    open_from: string;
    open_to: string;
  }[];
  supply_pipeline?: SupplyPipeline | null;
  alerts?: { id: string; severity: string; title: string; description: string; entity_type: string; entity_id?: string; link?: string; detected_at: string }[];
  alert_summary?: { critical: number; warning: number; info: number };
  alerts_last_checked_at?: string | null;
}

export interface SupplyPipeline {
  main: {
    pending_approval: number;
    vendor_ordering: number;
    warehouse_receiving: number;
    issue_pending: number;
    completed: number;
  };
  shortage: {
    receipt_diff: number;
    followup_open: number;
    followup_resolved: number;
  };
}

export interface AuditLog {
  id: string;
  occurred_at: string;
  actor_name: string;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json: string;
  after_json: string;
  reason: string;
  ip: string;
}




