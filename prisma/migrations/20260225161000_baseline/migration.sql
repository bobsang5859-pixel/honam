-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" TEXT,
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
    "deleted_at" DATETIME,
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
    "patient_no" TEXT NOT NULL,
    "chart_no" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT '',
    "department_id" TEXT NOT NULL,
    "room_no" TEXT NOT NULL DEFAULT '',
    "bed_no" INTEGER,
    "gender" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "mobility_type" TEXT NOT NULL DEFAULT 'AMBULATORY',
    "insurance_type" TEXT NOT NULL DEFAULT 'HEALTH',
    "patient_group" TEXT NOT NULL DEFAULT 'UNRATED',
    "specializations" TEXT NOT NULL DEFAULT '[]',
    "infection_strain" TEXT NOT NULL DEFAULT '',
    "period_type" TEXT NOT NULL DEFAULT '',
    "period_phase" TEXT NOT NULL DEFAULT '',
    "diaper_state" TEXT NOT NULL DEFAULT '',
    "diaper_amount" INTEGER,
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
    CONSTRAINT "patients_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patients_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ward_rooms" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "department_id" TEXT NOT NULL,
    "room_no" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 6,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
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
    "specializations" TEXT NOT NULL DEFAULT '[]',
    "infection_strain" TEXT NOT NULL DEFAULT '',
    "period_type" TEXT NOT NULL DEFAULT '',
    "period_phase" TEXT NOT NULL DEFAULT '',
    "patient_group" TEXT NOT NULL DEFAULT 'UNRATED',
    "diaper_state" TEXT NOT NULL DEFAULT '',
    "diaper_amount" INTEGER,
    "prev_hospital" TEXT NOT NULL DEFAULT '',
    "acquaintance" TEXT NOT NULL DEFAULT '',
    "acquaintance_color" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ADMITTED',
    "is_manual" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
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
    "request_type" TEXT NOT NULL DEFAULT 'CONSUMABLE',
    "is_emergency" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" DATETIME,
    "deleted_at" DATETIME,
    CONSTRAINT "ward_requests_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ward_requests_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ward_request_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ward_request_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "requested_qty" DECIMAL NOT NULL,
    "baseline_qty" DECIMAL NOT NULL DEFAULT 0,
    "diff_pct" DECIMAL NOT NULL DEFAULT 0,
    "policy_flags" TEXT NOT NULL DEFAULT '[]',
    "note" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "ward_request_items_ward_request_id_fkey" FOREIGN KEY ("ward_request_id") REFERENCES "ward_requests" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ward_request_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
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
    "item_id" TEXT NOT NULL,
    "requested_qty" DECIMAL NOT NULL,
    "approved_qty" DECIMAL NOT NULL,
    "baseline_qty" DECIMAL NOT NULL DEFAULT 0,
    "diff_qty" DECIMAL NOT NULL,
    "diff_pct" DECIMAL NOT NULL,
    "diff_amount" DECIMAL NOT NULL DEFAULT 0,
    "policy_flags" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "approval_action_items_approval_action_id_fkey" FOREIGN KEY ("approval_action_id") REFERENCES "approval_actions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "approval_action_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
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
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "note" TEXT NOT NULL DEFAULT '',
    "deleted_at" DATETIME,
    CONSTRAINT "goods_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "goods_receipts_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stock_in_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "goods_receipt_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "received_qty" DECIMAL NOT NULL,
    "unit_price" DECIMAL NOT NULL,
    "location_id" TEXT NOT NULL,
    CONSTRAINT "stock_in_items_goods_receipt_id_fkey" FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_in_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_in_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stock_out" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "so_no" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "ward_request_id" TEXT,
    "issued_by" TEXT NOT NULL,
    "issued_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "note" TEXT NOT NULL DEFAULT '',
    "deleted_at" DATETIME,
    CONSTRAINT "stock_out_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "stock_out_ward_request_id_fkey" FOREIGN KEY ("ward_request_id") REFERENCES "ward_requests" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stock_out_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stock_out_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stock_out_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "issued_qty" DECIMAL NOT NULL,
    "location_id" TEXT NOT NULL,
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
CREATE UNIQUE INDEX "patients_patient_no_key" ON "patients"("patient_no");

-- CreateIndex
CREATE INDEX "patients_department_id_status_idx" ON "patients"("department_id", "status");

-- CreateIndex
CREATE INDEX "patients_department_id_room_no_bed_no_idx" ON "patients"("department_id", "room_no", "bed_no");

-- CreateIndex
CREATE INDEX "patients_admitted_at_idx" ON "patients"("admitted_at");

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
CREATE INDEX "ward_request_items_item_id_idx" ON "ward_request_items"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "ward_request_items_ward_request_id_item_id_key" ON "ward_request_items"("ward_request_id", "item_id");

-- CreateIndex
CREATE INDEX "approval_actions_ward_request_id_created_at_idx" ON "approval_actions"("ward_request_id", "created_at");

-- CreateIndex
CREATE INDEX "approval_actions_approver_id_created_at_idx" ON "approval_actions"("approver_id", "created_at");

-- CreateIndex
CREATE INDEX "approval_action_items_item_id_idx" ON "approval_action_items"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_action_items_approval_action_id_item_id_key" ON "approval_action_items"("approval_action_id", "item_id");

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
CREATE UNIQUE INDEX "stock_out_so_no_key" ON "stock_out"("so_no");

-- CreateIndex
CREATE INDEX "stock_out_department_id_issued_at_idx" ON "stock_out"("department_id", "issued_at");

-- CreateIndex
CREATE INDEX "stock_out_ward_request_id_idx" ON "stock_out"("ward_request_id");

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

