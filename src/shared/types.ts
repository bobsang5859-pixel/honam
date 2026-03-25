// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧
//  Shared Types v3 (Server ??Client)
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧

// ?? ?덈ぉ 移댄뀒怨좊━ ?????????????????????????????
export const CONSUMABLE_CATEGORIES = [
  { value: 'MEDICAL_FIXED', label: '의료소모품(정액)', group: '의료소모품' },
  { value: 'MEDICAL_ACT', label: '의료소모품(행위코드)', group: '의료소모품' },
  { value: 'GENERAL_PATIENT', label: '일반소모품(환자용)', group: '일반소모품' },
  { value: 'GENERAL_STAFF', label: '일반소모품(직원용)', group: '일반소모품' },
  { value: 'GENERAL_MGMT', label: '일반소모품(관리용)', group: '일반소모품' },
  { value: 'GENERAL_SERVICE', label: '일반소모품(식음료)', group: '일반소모품' },
  { value: 'OFFICE_SUPPLY', label: '사무용품(소모품)', group: '사무용품' },
  { value: 'OFFICE_SEMI', label: '사무용품(사무기기)', group: '사무용품' },
] as const;

export const EQUIPMENT_CATEGORIES = [
  { value: 'EQUIP_MEDICAL', label: '의료기기', group: '비품' },
  { value: 'EQUIP_AID', label: '의료보조장비', group: '비품' },
  { value: 'EQUIP_FURNITURE', label: '사무가구', group: '비품' },
  { value: 'EQUIP_APPLIANCE', label: '가전제품', group: '비품' },
  { value: 'EQUIP_IT', label: '전산/IT장비', group: '비품' },
  { value: 'EQUIP_SAFETY', label: '안전/위생장비', group: '비품' },
] as const;

export const ALL_CATEGORIES = [...CONSUMABLE_CATEGORIES, ...EQUIPMENT_CATEGORIES];

export const CONSUMABLE_CATEGORY_VALUES = CONSUMABLE_CATEGORIES.map((c) => c.value);
export const EQUIPMENT_CATEGORY_VALUES = EQUIPMENT_CATEGORIES.map((c) => c.value);
export const ALL_CATEGORY_VALUES = ALL_CATEGORIES.map((c) => c.value);

export const ITEM_STATS_BUCKETS = [
  { value: 'MEDICAL', label: '의료소모품' },
  { value: 'GENERAL', label: '일반소모품' },
  { value: 'OFFICE', label: '사무용품' },
  { value: 'DIAPER_CARE', label: '기저귀케어' },
  { value: 'FOOD', label: '식음료' },
] as const;

export const ITEM_EXPENSE_SCOPES = [
  { value: 'PATIENT_DIRECT', label: '환자직접비' },
  { value: 'OPS_INDIRECT', label: '운영간접비' },
] as const;

export function getCategoryLabel(value: string): string {
  return ALL_CATEGORIES.find(c => c.value === value)?.label ?? value;
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
  stats_bucket: string;
  expense_scope: string;
  uom: string;
  pack_size: number;
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
  baseline_qty: number;
  diff_pct: number;
  policy_flags: string[];
  note: string;
  approved_qty?: number;
  latest_price?: number;
  on_hand_qty?: number;
}

export interface WardRequest {
  id: string;
  request_no: string;
  department_id: string;
  department_name?: string;
  requester_id: string;
  requester_name?: string;
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

export interface UsageRecord {
  id: string;
  department_id: string;
  department_name?: string | null;
  item_id: string;
  item_name?: string | null;
  item_code?: string | null;
  uom?: string | null;
  used_qty: number;
  used_at: string;
  note: string;
  location_id?: string | null;
  created_by: string;
  creator_name?: string | null;
  created_at: string;
  updated_at: string;
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




