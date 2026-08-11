-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" TEXT,
    "module_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" DATETIME,
    CONSTRAINT "departments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "departments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL DEFAULT '',
    "department_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" DATETIME,
    "last_logout_at" DATETIME,
    "deleted_at" DATETIME,
    "menu_permissions" TEXT,
    "direct_permissions" TEXT,
    CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "deleted_at" DATETIME
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    PRIMARY KEY ("role_id", "permission_id"),
    CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    PRIMARY KEY ("user_id", "role_id"),
    CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "lead_time_days" INTEGER NOT NULL DEFAULT 3,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" DATETIME
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "item_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'MEDICAL_FIXED',
    "stats_bucket" TEXT NOT NULL DEFAULT 'MEDICAL',
    "expense_scope" TEXT NOT NULL DEFAULT 'PATIENT_DIRECT',
    "uom" TEXT NOT NULL DEFAULT 'EA',
    "pack_size" INTEGER NOT NULL DEFAULT 1,
    "default_vendor_id" TEXT,
    "min_order_qty" INTEGER NOT NULL DEFAULT 1,
    "is_regular_order" BOOLEAN NOT NULL DEFAULT true,
    "reorder_days_threshold" INTEGER NOT NULL DEFAULT 7,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" DATETIME,
    "image_url" TEXT,
    CONSTRAINT "items_default_vendor_id_fkey" FOREIGN KEY ("default_vendor_id") REFERENCES "vendors" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "item_vendor_map" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "item_id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "item_vendor_map_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "item_vendor_map_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "price_history" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "item_id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "price" DECIMAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KRW',
    "effective_from" DATETIME NOT NULL,
    "effective_to" DATETIME,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "price_history_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "price_history_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "patient_stats" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "department_id" TEXT NOT NULL,
    "period_type" TEXT NOT NULL,
    "period_start" DATETIME NOT NULL,
    "period_end" DATETIME NOT NULL,
    "patient_count" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    CONSTRAINT "patient_stats_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patient_no" TEXT NOT NULL DEFAULT '',
    "chart_no" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "department_id" TEXT NOT NULL,
    "room_no" TEXT NOT NULL DEFAULT '',
    "bed_no" INTEGER,
    "gender" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "mobility_type" TEXT NOT NULL DEFAULT 'AMBULATORY',
    "insurance_type" TEXT NOT NULL DEFAULT 'HEALTH',
    "copay_reduction" TEXT NOT NULL DEFAULT 'NONE',
    "patient_group" TEXT NOT NULL DEFAULT 'UNRATED',
    "specializations" TEXT NOT NULL DEFAULT '[]',
    "infection_strain" TEXT NOT NULL DEFAULT '',
    "period_type" TEXT NOT NULL DEFAULT '',
    "period_phase" TEXT NOT NULL DEFAULT '',
    "diaper_state" TEXT NOT NULL DEFAULT '',
    "diaper_price" REAL,
    "diaper_start_date" DATETIME,
    "diaper_end_date" DATETIME,
    "prev_hospital" TEXT NOT NULL DEFAULT '',
    "acquaintance" TEXT NOT NULL DEFAULT '',
    "acquaintance_color" TEXT NOT NULL DEFAULT '',
    "deceased_at" DATETIME,
    "admitted_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discharged_at" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ADMITTED',
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    "disease_code_id" TEXT,
    "disease_code_registered_at" DATETIME,
    "disease_code_expires_at" DATETIME,
    "main_disease_code_id" TEXT,
    "caregiver_type" TEXT NOT NULL DEFAULT '',
    "guardian_name" TEXT NOT NULL DEFAULT '',
    "billing_sms_phone" TEXT NOT NULL DEFAULT '',
    "project_name" TEXT NOT NULL DEFAULT '',
    "project_region" TEXT NOT NULL DEFAULT '',
    "project_sigungu_office" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "referral_source" TEXT NOT NULL DEFAULT '',
    "discharge_type" TEXT NOT NULL DEFAULT '',
    "monthly_medical_fee" REAL NOT NULL DEFAULT 0,
    "monthly_payment" REAL NOT NULL DEFAULT 0,
    "monthly_unpaid" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "patients_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patients_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "disease_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code_type" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME
);

-- CreateTable
CREATE TABLE "patient_disease_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patient_id" TEXT NOT NULL,
    "disease_code_id" TEXT NOT NULL,
    "registered_at" DATETIME NOT NULL,
    "expires_at" DATETIME,
    "note" TEXT NOT NULL DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    CONSTRAINT "patient_disease_codes_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_disease_codes_disease_code_id_fkey" FOREIGN KEY ("disease_code_id") REFERENCES "disease_codes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ward_rooms" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "department_id" TEXT NOT NULL,
    "room_no" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 6,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_hospice" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    CONSTRAINT "ward_rooms_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ward_room_boards" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "board_date" DATETIME NOT NULL,
    "department_id" TEXT NOT NULL,
    "ward_room_id" TEXT NOT NULL,
    "room_no" TEXT NOT NULL,
    "bed_no" INTEGER NOT NULL,
    "patient_id" TEXT,
    "patient_no" TEXT NOT NULL DEFAULT '',
    "chart_no" TEXT NOT NULL DEFAULT '',
    "patient_name" TEXT NOT NULL DEFAULT '',
    "gender" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "mobility_type" TEXT NOT NULL DEFAULT 'AMBULATORY',
    "insurance_type" TEXT NOT NULL DEFAULT 'HEALTH',
    "copay_reduction" TEXT NOT NULL DEFAULT 'NONE',
    "specializations" TEXT NOT NULL DEFAULT '[]',
    "infection_strain" TEXT NOT NULL DEFAULT '',
    "period_type" TEXT NOT NULL DEFAULT '',
    "period_phase" TEXT NOT NULL DEFAULT '',
    "patient_group" TEXT NOT NULL DEFAULT 'UNRATED',
    "diaper_state" TEXT NOT NULL DEFAULT '',
    "diaper_price" REAL,
    "diaper_start_date" DATETIME,
    "diaper_end_date" DATETIME,
    "prev_hospital" TEXT NOT NULL DEFAULT '',
    "acquaintance" TEXT NOT NULL DEFAULT '',
    "acquaintance_color" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ADMITTED',
    "is_manual" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
    "main_disease_code_id" TEXT,
    "caregiver_type" TEXT NOT NULL DEFAULT '',
    "guardian_name" TEXT NOT NULL DEFAULT '',
    "billing_sms_phone" TEXT NOT NULL DEFAULT '',
    "project_name" TEXT NOT NULL DEFAULT '',
    "project_region" TEXT NOT NULL DEFAULT '',
    "project_sigungu_office" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "referral_source" TEXT NOT NULL DEFAULT '',
    "discharge_type" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "ward_room_boards_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ward_room_boards_ward_room_id_fkey" FOREIGN KEY ("ward_room_id") REFERENCES "ward_rooms" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ward_room_boards_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "patient_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patient_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_date" DATETIME NOT NULL,
    "room_no" TEXT NOT NULL DEFAULT '',
    "bed_no" INTEGER,
    "prev_hospital" TEXT NOT NULL DEFAULT '',
    "memo" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    CONSTRAINT "patient_events_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_events_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "usage_baselines" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "item_id" TEXT NOT NULL,
    "department_scope" TEXT NOT NULL DEFAULT 'ALL',
    "period_type" TEXT NOT NULL DEFAULT 'MONTH',
    "qty_per_patient" DECIMAL NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "effective_from" DATETIME NOT NULL,
    "effective_to" DATETIME,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    CONSTRAINT "usage_baselines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "usage_baselines_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ward_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "request_no" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "period_type" TEXT NOT NULL DEFAULT 'MONTH',
    "period_start" DATETIME NOT NULL,
    "period_end" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "request_type" TEXT NOT NULL DEFAULT 'CONSUMABLE_REGULAR',
    "is_emergency" BOOLEAN NOT NULL DEFAULT false,
    "equipment_request_type" TEXT,
    "note" TEXT,
    "attachment_urls" TEXT NOT NULL DEFAULT '[]',
    "equipment_unit_ids" TEXT NOT NULL DEFAULT '[]',
    "source_repair_id" TEXT,
    "submitted_at" DATETIME,
    "deleted_at" DATETIME,
    CONSTRAINT "ward_requests_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ward_requests_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ward_request_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ward_request_id" TEXT NOT NULL,
    "item_id" TEXT,
    "custom_name" TEXT NOT NULL DEFAULT '',
    "custom_spec" TEXT NOT NULL DEFAULT '',
    "custom_link" TEXT NOT NULL DEFAULT '',
    "requested_qty" DECIMAL NOT NULL,
    "baseline_qty" DECIMAL NOT NULL DEFAULT 0,
    "diff_pct" DECIMAL NOT NULL DEFAULT 0,
    "policy_flags" TEXT NOT NULL DEFAULT '[]',
    "note" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "ward_request_items_ward_request_id_fkey" FOREIGN KEY ("ward_request_id") REFERENCES "ward_requests" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ward_request_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "approval_actions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ward_request_id" TEXT NOT NULL,
    "approver_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_actions_ward_request_id_fkey" FOREIGN KEY ("ward_request_id") REFERENCES "ward_requests" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "approval_actions_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "approval_action_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "approval_action_id" TEXT NOT NULL,
    "item_id" TEXT,
    "custom_name" TEXT NOT NULL DEFAULT '',
    "requested_qty" DECIMAL NOT NULL,
    "approved_qty" DECIMAL NOT NULL,
    "baseline_qty" DECIMAL NOT NULL DEFAULT 0,
    "diff_qty" DECIMAL NOT NULL,
    "diff_pct" DECIMAL NOT NULL,
    "diff_amount" DECIMAL NOT NULL DEFAULT 0,
    "policy_flags" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "approval_action_items_approval_action_id_fkey" FOREIGN KEY ("approval_action_id") REFERENCES "approval_actions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "approval_action_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "po_no" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "ordered_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_at" DATETIME,
    "pdf_path" TEXT NOT NULL DEFAULT '',
    "total_amount" DECIMAL NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "deleted_at" DATETIME,
    CONSTRAINT "purchase_orders_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "purchase_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchase_order_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "ordered_qty" DECIMAL NOT NULL,
    "unit_price" DECIMAL NOT NULL,
    "line_amount" DECIMAL NOT NULL,
    CONSTRAINT "purchase_order_items_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "purchase_order_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gr_no" TEXT NOT NULL,
    "purchase_order_id" TEXT,
    "received_by" TEXT NOT NULL,
    "received_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT NOT NULL DEFAULT '',
    "confirmed_at" DATETIME,
    "confirmed_by" TEXT,
    "diff_count" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" DATETIME,
    CONSTRAINT "goods_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "goods_receipts_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "goods_receipts_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stock_in_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "goods_receipt_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "received_qty" DECIMAL NOT NULL,
    "expected_qty" DECIMAL,
    "confirmed_qty" DECIMAL,
    "diff_qty" DECIMAL,
    "diff_note" TEXT NOT NULL DEFAULT '',
    "confirmed_at" DATETIME,
    "confirmed_by" TEXT,
    "unit_price" DECIMAL NOT NULL,
    "location_id" TEXT NOT NULL,
    CONSTRAINT "stock_in_items_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_in_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_in_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_in_items_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "pending_receipt_followups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "goods_receipt_id" TEXT NOT NULL,
    "purchase_order_id" TEXT,
    "vendor_id" TEXT,
    "item_id" TEXT NOT NULL,
    "missing_qty" DECIMAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" DATETIME,
    "resolved_by" TEXT,
    CONSTRAINT "pending_receipt_followups_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "pending_receipt_followups_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "pending_receipt_followups_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "pending_receipt_followups_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "pending_receipt_followups_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stock_out" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "so_no" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "ward_request_id" TEXT,
    "issued_by" TEXT NOT NULL,
    "issued_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'RECEIPT_PENDING',
    "note" TEXT NOT NULL DEFAULT '',
    "receipt_confirmed_at" DATETIME,
    "receipt_confirmed_by" TEXT,
    "receipt_diff_count" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" DATETIME,
    CONSTRAINT "stock_out_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_out_ward_request_id_fkey" FOREIGN KEY ("ward_request_id") REFERENCES "ward_requests" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stock_out_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stock_out_followups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stock_out_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "diff_qty" DECIMAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "resolved_at" DATETIME,
    "resolved_by" TEXT,
    CONSTRAINT "stock_out_followups_stock_out_id_fkey" FOREIGN KEY ("stock_out_id") REFERENCES "stock_out" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_out_followups_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_out_followups_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_out_followups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_out_followups_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stock_out_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stock_out_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "issued_qty" DECIMAL NOT NULL,
    "location_id" TEXT NOT NULL,
    "received_qty" DECIMAL,
    "receipt_note" TEXT NOT NULL DEFAULT '',
    "receipt_confirmed_at" DATETIME,
    "receipt_confirmed_by" TEXT,
    CONSTRAINT "stock_out_items_stock_out_id_fkey" FOREIGN KEY ("stock_out_id") REFERENCES "stock_out" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_out_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_out_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "inventory_locations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" DATETIME,
    CONSTRAINT "inventory_locations_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "inventory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "item_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "on_hand_qty" DECIMAL NOT NULL DEFAULT 0,
    "avg_unit_cost" DECIMAL NOT NULL DEFAULT 0,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "inventory_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "inventory_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "inventory_lots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stock_in_item_id" TEXT NOT NULL,
    "goods_receipt_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "vendor_id" TEXT,
    "received_at" DATETIME NOT NULL,
    "unit_cost" DECIMAL NOT NULL DEFAULT 0,
    "received_qty" DECIMAL NOT NULL DEFAULT 0,
    "remaining_qty" DECIMAL NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    CONSTRAINT "inventory_lots_stock_in_item_id_fkey" FOREIGN KEY ("stock_in_item_id") REFERENCES "stock_in_items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "inventory_lots_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "inventory_lots_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "inventory_lots_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "inventory_lots_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stock_out_lot_allocations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stock_out_id" TEXT NOT NULL,
    "stock_out_item_id" TEXT NOT NULL,
    "inventory_lot_id" TEXT,
    "issued_qty" DECIMAL NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL NOT NULL DEFAULT 0,
    "line_amount" DECIMAL NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_out_lot_allocations_stock_out_id_fkey" FOREIGN KEY ("stock_out_id") REFERENCES "stock_out" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_out_lot_allocations_stock_out_item_id_fkey" FOREIGN KEY ("stock_out_item_id") REFERENCES "stock_out_items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_out_lot_allocations_inventory_lot_id_fkey" FOREIGN KEY ("inventory_lot_id") REFERENCES "inventory_lots" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "occurred_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" TEXT,
    "actor_role_snapshot" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before_json" TEXT NOT NULL DEFAULT '',
    "after_json" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT '',
    "ip" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "cost_statistics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "year_month" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "issued_qty" DECIMAL NOT NULL DEFAULT 0,
    "issued_amount" DECIMAL NOT NULL DEFAULT 0,
    "avg_unit_price" DECIMAL NOT NULL DEFAULT 0,
    "overuse_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "cost_statistics_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "cost_statistics_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "dept_category_permissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "department_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    CONSTRAINT "dept_category_permissions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "dept_item_permissions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "department_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    CONSTRAINT "dept_item_permissions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dept_item_permissions_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "app_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "backup_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "file_path" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "incineration_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entry_date" DATETIME NOT NULL,
    "department_id" TEXT NOT NULL DEFAULT '',
    "weight_kg" DECIMAL NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "incineration_monthly_overrides" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "year_month" TEXT NOT NULL,
    "department_id" TEXT NOT NULL DEFAULT '',
    "final_amount_override" DECIMAL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "request_schedules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "request_type" TEXT NOT NULL,
    "open_from" DATETIME NOT NULL,
    "open_to" DATETIME NOT NULL,
    "period_label" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "purchase_order_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "po_id" TEXT NOT NULL,
    "ward_request_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchase_order_sources_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "purchase_orders" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "purchase_order_sources_ward_request_id_fkey" FOREIGN KEY ("ward_request_id") REFERENCES "ward_requests" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "item_category_masters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL DEFAULT 'CONSUMABLE',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "stats_category_masters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "expense_scope_masters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "dept_calendar_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "department_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "event_date" DATETIME NOT NULL,
    "end_date" DATETIME,
    "color" TEXT NOT NULL DEFAULT '#86efac',
    "event_type" TEXT NOT NULL DEFAULT 'EVENT',
    "visibility" TEXT NOT NULL DEFAULT 'DEPARTMENT',
    "shared_user_ids" TEXT,
    "start_time" TEXT,
    "end_time" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "dept_calendar_events_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "dept_calendar_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "equipment_units" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serial_no" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "stock_out_id" TEXT,
    "location" TEXT NOT NULL DEFAULT '',
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "equipment_units_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "equipment_units_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "equipment_repairs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipment_unit_id" TEXT NOT NULL,
    "requesting_dept_id" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "attachment_urls" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "result_note" TEXT NOT NULL DEFAULT '',
    "disposal_ward_request_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "equipment_repairs_equipment_unit_id_fkey" FOREIGN KEY ("equipment_unit_id") REFERENCES "equipment_units" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "equipment_repairs_requesting_dept_id_fkey" FOREIGN KEY ("requesting_dept_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "treatment_types" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "patient_treatments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patient_id" TEXT NOT NULL,
    "treatment_type_id" TEXT NOT NULL,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" DATETIME,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "patient_treatments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_treatments_treatment_type_id_fkey" FOREIGN KEY ("treatment_type_id") REFERENCES "treatment_types" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "treatment_supply_maps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "treatment_type_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "qty_per_day" DECIMAL NOT NULL DEFAULT 1,
    "qty_per_week" DECIMAL NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "treatment_supply_maps_treatment_type_id_fkey" FOREIGN KEY ("treatment_type_id") REFERENCES "treatment_types" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "treatment_supply_maps_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "patient_charges" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patient_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "amount" REAL NOT NULL DEFAULT 0,
    "charge_month" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "patient_charges_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "patient_payments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patient_id" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "payment_date" DATETIME NOT NULL,
    "payment_method" TEXT NOT NULL,
    "charge_month" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME,
    CONSTRAINT "patient_payments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "file_path" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL DEFAULT 'image/jpeg',
    "memo" TEXT NOT NULL DEFAULT '',
    "uploaded_by" TEXT NOT NULL,
    "patient_name" TEXT NOT NULL DEFAULT '',
    "diagnosis" TEXT NOT NULL DEFAULT '',
    "condition" TEXT NOT NULL DEFAULT '',
    "admission_possible" BOOLEAN NOT NULL DEFAULT false,
    "ai_summary" TEXT NOT NULL DEFAULT '',
    "suggested_ward" TEXT NOT NULL DEFAULT '',
    "suggested_room" TEXT NOT NULL DEFAULT '',
    "room_reason" TEXT NOT NULL DEFAULT '',
    "final_ward" TEXT NOT NULL DEFAULT '',
    "final_room" TEXT NOT NULL DEFAULT '',
    "approved_by" TEXT,
    "approved_at" DATETIME,
    "reject_reason" TEXT NOT NULL DEFAULT '',
    "patient_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "referrals_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "referrals_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "referrals_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "complaints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patient_id" TEXT,
    "department_id" TEXT,
    "complaint_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolved_at" DATETIME,
    "created_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE INDEX "departments_parent_id_idx" ON "departments"("parent_id");

-- CreateIndex
CREATE INDEX "departments_is_active_idx" ON "departments"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_department_id_idx" ON "users"("department_id");

-- CreateIndex
CREATE INDEX "users_is_active_idx" ON "users"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_code_key" ON "vendors"("code");

-- CreateIndex
CREATE UNIQUE INDEX "items_item_code_key" ON "items"("item_code");

-- CreateIndex
CREATE INDEX "items_category_idx" ON "items"("category");

-- CreateIndex
CREATE INDEX "items_stats_bucket_idx" ON "items"("stats_bucket");

-- CreateIndex
CREATE INDEX "items_expense_scope_idx" ON "items"("expense_scope");

-- CreateIndex
CREATE INDEX "items_default_vendor_id_idx" ON "items"("default_vendor_id");

-- CreateIndex
CREATE INDEX "items_is_regular_order_idx" ON "items"("is_regular_order");

-- CreateIndex
CREATE UNIQUE INDEX "item_vendor_map_item_id_vendor_id_key" ON "item_vendor_map"("item_id", "vendor_id");

-- CreateIndex
CREATE INDEX "price_history_item_id_vendor_id_idx" ON "price_history"("item_id", "vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_history_item_id_vendor_id_effective_from_key" ON "price_history"("item_id", "vendor_id", "effective_from");

-- CreateIndex
CREATE INDEX "patient_stats_department_id_period_start_idx" ON "patient_stats"("department_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "patient_stats_department_id_period_type_period_start_key" ON "patient_stats"("department_id", "period_type", "period_start");

-- CreateIndex
CREATE INDEX "patients_department_id_status_idx" ON "patients"("department_id", "status");

-- CreateIndex
CREATE INDEX "patients_department_id_room_no_bed_no_idx" ON "patients"("department_id", "room_no", "bed_no");

-- CreateIndex
CREATE INDEX "patients_admitted_at_idx" ON "patients"("admitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "disease_codes_code_key" ON "disease_codes"("code");

-- CreateIndex
CREATE INDEX "disease_codes_code_type_is_active_idx" ON "disease_codes"("code_type", "is_active");

-- CreateIndex
CREATE INDEX "patient_disease_codes_patient_id_idx" ON "patient_disease_codes"("patient_id");

-- CreateIndex
CREATE INDEX "patient_disease_codes_disease_code_id_idx" ON "patient_disease_codes"("disease_code_id");

-- CreateIndex
CREATE INDEX "ward_rooms_department_id_is_active_idx" ON "ward_rooms"("department_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "ward_rooms_department_id_room_no_key" ON "ward_rooms"("department_id", "room_no");

-- CreateIndex
CREATE INDEX "ward_room_boards_department_id_board_date_idx" ON "ward_room_boards"("department_id", "board_date");

-- CreateIndex
CREATE INDEX "ward_room_boards_patient_id_board_date_idx" ON "ward_room_boards"("patient_id", "board_date");

-- CreateIndex
CREATE UNIQUE INDEX "ward_room_boards_board_date_department_id_ward_room_id_bed_no_key" ON "ward_room_boards"("board_date", "department_id", "ward_room_id", "bed_no");

-- CreateIndex
CREATE INDEX "patient_events_department_id_event_date_event_type_idx" ON "patient_events"("department_id", "event_date", "event_type");

-- CreateIndex
CREATE INDEX "patient_events_patient_id_event_date_idx" ON "patient_events"("patient_id", "event_date");

-- CreateIndex
CREATE INDEX "usage_baselines_item_id_department_scope_idx" ON "usage_baselines"("item_id", "department_scope");

-- CreateIndex
CREATE UNIQUE INDEX "usage_baselines_item_id_department_scope_period_type_version_key" ON "usage_baselines"("item_id", "department_scope", "period_type", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ward_requests_request_no_key" ON "ward_requests"("request_no");

-- CreateIndex
CREATE INDEX "ward_requests_department_id_submitted_at_idx" ON "ward_requests"("department_id", "submitted_at");

-- CreateIndex
CREATE INDEX "ward_requests_status_idx" ON "ward_requests"("status");

-- CreateIndex
CREATE INDEX "ward_requests_is_emergency_idx" ON "ward_requests"("is_emergency");

-- CreateIndex
CREATE INDEX "ward_request_items_ward_request_id_idx" ON "ward_request_items"("ward_request_id");

-- CreateIndex
CREATE INDEX "ward_request_items_item_id_idx" ON "ward_request_items"("item_id");

-- CreateIndex
CREATE INDEX "approval_actions_ward_request_id_created_at_idx" ON "approval_actions"("ward_request_id", "created_at");

-- CreateIndex
CREATE INDEX "approval_actions_approver_id_created_at_idx" ON "approval_actions"("approver_id", "created_at");

-- CreateIndex
CREATE INDEX "approval_action_items_approval_action_id_idx" ON "approval_action_items"("approval_action_id");

-- CreateIndex
CREATE INDEX "approval_action_items_item_id_idx" ON "approval_action_items"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_po_no_key" ON "purchase_orders"("po_no");

-- CreateIndex
CREATE INDEX "purchase_orders_vendor_id_ordered_at_idx" ON "purchase_orders"("vendor_id", "ordered_at");

-- CreateIndex
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders"("status");

-- CreateIndex
CREATE INDEX "purchase_order_items_item_id_idx" ON "purchase_order_items"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_items_purchase_order_id_item_id_key" ON "purchase_order_items"("purchase_order_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_gr_no_key" ON "goods_receipts"("gr_no");

-- CreateIndex
CREATE INDEX "goods_receipts_purchase_order_id_received_at_idx" ON "goods_receipts"("purchase_order_id", "received_at");

-- CreateIndex
CREATE INDEX "goods_receipts_received_at_idx" ON "goods_receipts"("received_at");

-- CreateIndex
CREATE INDEX "stock_in_items_item_id_idx" ON "stock_in_items"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_in_items_goods_receipt_id_item_id_key" ON "stock_in_items"("goods_receipt_id", "item_id");

-- CreateIndex
CREATE INDEX "pending_receipt_followups_goods_receipt_id_idx" ON "pending_receipt_followups"("goods_receipt_id");

-- CreateIndex
CREATE INDEX "pending_receipt_followups_purchase_order_id_idx" ON "pending_receipt_followups"("purchase_order_id");

-- CreateIndex
CREATE INDEX "pending_receipt_followups_vendor_id_idx" ON "pending_receipt_followups"("vendor_id");

-- CreateIndex
CREATE INDEX "pending_receipt_followups_item_id_idx" ON "pending_receipt_followups"("item_id");

-- CreateIndex
CREATE INDEX "pending_receipt_followups_status_created_at_idx" ON "pending_receipt_followups"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stock_out_so_no_key" ON "stock_out"("so_no");

-- CreateIndex
CREATE INDEX "stock_out_department_id_issued_at_idx" ON "stock_out"("department_id", "issued_at");

-- CreateIndex
CREATE INDEX "stock_out_ward_request_id_idx" ON "stock_out"("ward_request_id");

-- CreateIndex
CREATE INDEX "stock_out_followups_status_created_at_idx" ON "stock_out_followups"("status", "created_at");

-- CreateIndex
CREATE INDEX "stock_out_followups_department_id_status_idx" ON "stock_out_followups"("department_id", "status");

-- CreateIndex
CREATE INDEX "stock_out_followups_stock_out_id_idx" ON "stock_out_followups"("stock_out_id");

-- CreateIndex
CREATE INDEX "stock_out_followups_item_id_idx" ON "stock_out_followups"("item_id");

-- CreateIndex
CREATE INDEX "stock_out_items_item_id_idx" ON "stock_out_items"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_out_items_stock_out_id_item_id_key" ON "stock_out_items"("stock_out_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_locations_code_key" ON "inventory_locations"("code");

-- CreateIndex
CREATE INDEX "inventory_item_id_location_id_idx" ON "inventory"("item_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_id_location_id_key" ON "inventory"("item_id", "location_id");

-- CreateIndex
CREATE INDEX "inventory_lots_item_id_location_id_received_at_idx" ON "inventory_lots"("item_id", "location_id", "received_at");

-- CreateIndex
CREATE INDEX "inventory_lots_vendor_id_idx" ON "inventory_lots"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_lots_stock_in_item_id_key" ON "inventory_lots"("stock_in_item_id");

-- CreateIndex
CREATE INDEX "stock_out_lot_allocations_stock_out_id_idx" ON "stock_out_lot_allocations"("stock_out_id");

-- CreateIndex
CREATE INDEX "stock_out_lot_allocations_stock_out_item_id_idx" ON "stock_out_lot_allocations"("stock_out_item_id");

-- CreateIndex
CREATE INDEX "stock_out_lot_allocations_inventory_lot_id_idx" ON "stock_out_lot_allocations"("inventory_lot_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_occurred_at_idx" ON "audit_logs"("entity_type", "entity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_occurred_at_idx" ON "audit_logs"("actor_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs"("occurred_at");

-- CreateIndex
CREATE INDEX "cost_statistics_year_month_department_id_idx" ON "cost_statistics"("year_month", "department_id");

-- CreateIndex
CREATE INDEX "cost_statistics_item_id_year_month_idx" ON "cost_statistics"("item_id", "year_month");

-- CreateIndex
CREATE UNIQUE INDEX "cost_statistics_year_month_department_id_item_id_key" ON "cost_statistics"("year_month", "department_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "dept_category_permissions_department_id_category_key" ON "dept_category_permissions"("department_id", "category");

-- CreateIndex
CREATE INDEX "dept_item_permissions_department_id_idx" ON "dept_item_permissions"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "dept_item_permissions_department_id_item_id_key" ON "dept_item_permissions"("department_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_settings_key_key" ON "app_settings"("key");

-- CreateIndex
CREATE INDEX "incineration_entries_entry_date_idx" ON "incineration_entries"("entry_date");

-- CreateIndex
CREATE UNIQUE INDEX "incineration_entries_entry_date_department_id_key" ON "incineration_entries"("entry_date", "department_id");

-- CreateIndex
CREATE INDEX "incineration_monthly_overrides_year_month_idx" ON "incineration_monthly_overrides"("year_month");

-- CreateIndex
CREATE UNIQUE INDEX "incineration_monthly_overrides_year_month_department_id_key" ON "incineration_monthly_overrides"("year_month", "department_id");

-- CreateIndex
CREATE INDEX "request_schedules_request_type_open_from_open_to_idx" ON "request_schedules"("request_type", "open_from", "open_to");

-- CreateIndex
CREATE INDEX "purchase_order_sources_po_id_idx" ON "purchase_order_sources"("po_id");

-- CreateIndex
CREATE INDEX "purchase_order_sources_ward_request_id_idx" ON "purchase_order_sources"("ward_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_sources_po_id_ward_request_id_key" ON "purchase_order_sources"("po_id", "ward_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "item_category_masters_code_key" ON "item_category_masters"("code");

-- CreateIndex
CREATE UNIQUE INDEX "stats_category_masters_code_key" ON "stats_category_masters"("code");

-- CreateIndex
CREATE UNIQUE INDEX "expense_scope_masters_code_key" ON "expense_scope_masters"("code");

-- CreateIndex
CREATE INDEX "dept_calendar_events_department_id_event_date_idx" ON "dept_calendar_events"("department_id", "event_date");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_units_serial_no_key" ON "equipment_units"("serial_no");

-- CreateIndex
CREATE INDEX "equipment_units_department_id_idx" ON "equipment_units"("department_id");

-- CreateIndex
CREATE INDEX "equipment_units_status_idx" ON "equipment_units"("status");

-- CreateIndex
CREATE INDEX "equipment_repairs_equipment_unit_id_idx" ON "equipment_repairs"("equipment_unit_id");

-- CreateIndex
CREATE INDEX "equipment_repairs_status_idx" ON "equipment_repairs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "treatment_types_code_key" ON "treatment_types"("code");

-- CreateIndex
CREATE INDEX "patient_treatments_patient_id_idx" ON "patient_treatments"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_treatments_patient_id_treatment_type_id_started_at_key" ON "patient_treatments"("patient_id", "treatment_type_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "treatment_supply_maps_treatment_type_id_item_id_key" ON "treatment_supply_maps"("treatment_type_id", "item_id");

-- CreateIndex
CREATE INDEX "patient_charges_patient_id_charge_month_idx" ON "patient_charges"("patient_id", "charge_month");

-- CreateIndex
CREATE INDEX "patient_charges_category_charge_month_idx" ON "patient_charges"("category", "charge_month");

-- CreateIndex
CREATE INDEX "patient_payments_patient_id_charge_month_idx" ON "patient_payments"("patient_id", "charge_month");

-- CreateIndex
CREATE INDEX "patient_payments_charge_month_idx" ON "patient_payments"("charge_month");

-- CreateIndex
CREATE INDEX "referrals_status_idx" ON "referrals"("status");

-- CreateIndex
CREATE INDEX "referrals_created_at_idx" ON "referrals"("created_at");

-- CreateIndex
CREATE INDEX "complaints_department_id_created_at_idx" ON "complaints"("department_id", "created_at");

-- CreateIndex
CREATE INDEX "complaints_complaint_type_status_idx" ON "complaints"("complaint_type", "status");

