-- RequestSchedule table
CREATE TABLE IF NOT EXISTS "request_schedules" (
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

CREATE INDEX IF NOT EXISTS "request_schedules_request_type_open_from_open_to_idx"
ON "request_schedules"("request_type", "open_from", "open_to");

-- PurchaseOrderSource table
CREATE TABLE IF NOT EXISTS "purchase_order_sources" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "po_id" TEXT NOT NULL,
  "ward_request_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "purchase_order_sources_po_id_fkey"
    FOREIGN KEY ("po_id") REFERENCES "purchase_orders" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "purchase_order_sources_ward_request_id_fkey"
    FOREIGN KEY ("ward_request_id") REFERENCES "ward_requests" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "purchase_order_sources_po_id_ward_request_id_key"
ON "purchase_order_sources"("po_id", "ward_request_id");

CREATE INDEX IF NOT EXISTS "purchase_order_sources_po_id_idx"
ON "purchase_order_sources"("po_id");

CREATE INDEX IF NOT EXISTS "purchase_order_sources_ward_request_id_idx"
ON "purchase_order_sources"("ward_request_id");

-- Data migration: legacy request type normalization
UPDATE "ward_requests"
SET "request_type" = 'CONSUMABLE_REGULAR'
WHERE "request_type" = 'CONSUMABLE';

