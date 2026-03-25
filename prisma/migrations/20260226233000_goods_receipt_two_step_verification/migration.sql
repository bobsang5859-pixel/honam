-- GoodsReceipt: two-step verification fields
ALTER TABLE "goods_receipts"
  ADD COLUMN "confirmed_at" DATETIME;

ALTER TABLE "goods_receipts"
  ADD COLUMN "confirmed_by" TEXT;

ALTER TABLE "goods_receipts"
  ADD COLUMN "diff_count" INTEGER NOT NULL DEFAULT 0;

-- StockInItem: verification fields
ALTER TABLE "stock_in_items"
  ADD COLUMN "expected_qty" DECIMAL;

ALTER TABLE "stock_in_items"
  ADD COLUMN "confirmed_qty" DECIMAL;

ALTER TABLE "stock_in_items"
  ADD COLUMN "diff_qty" DECIMAL;

ALTER TABLE "stock_in_items"
  ADD COLUMN "diff_note" TEXT NOT NULL DEFAULT '';

ALTER TABLE "stock_in_items"
  ADD COLUMN "confirmed_at" DATETIME;

ALTER TABLE "stock_in_items"
  ADD COLUMN "confirmed_by" TEXT;

-- Pending receipt follow-up table
CREATE TABLE IF NOT EXISTS "pending_receipt_followups" (
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
  CONSTRAINT "pending_receipt_followups_goods_receipt_id_fkey"
    FOREIGN KEY ("goods_receipt_id") REFERENCES "goods_receipts" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pending_receipt_followups_purchase_order_id_fkey"
    FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pending_receipt_followups_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "vendors" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pending_receipt_followups_item_id_fkey"
    FOREIGN KEY ("item_id") REFERENCES "items" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pending_receipt_followups_resolved_by_fkey"
    FOREIGN KEY ("resolved_by") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "pending_receipt_followups_goods_receipt_id_idx"
ON "pending_receipt_followups"("goods_receipt_id");

CREATE INDEX IF NOT EXISTS "pending_receipt_followups_purchase_order_id_idx"
ON "pending_receipt_followups"("purchase_order_id");

CREATE INDEX IF NOT EXISTS "pending_receipt_followups_vendor_id_idx"
ON "pending_receipt_followups"("vendor_id");

CREATE INDEX IF NOT EXISTS "pending_receipt_followups_item_id_idx"
ON "pending_receipt_followups"("item_id");

CREATE INDEX IF NOT EXISTS "pending_receipt_followups_status_created_at_idx"
ON "pending_receipt_followups"("status", "created_at");

-- Backfill legacy posted receipts as confirmed to preserve history consistency
UPDATE "goods_receipts"
SET "status" = 'CONFIRMED',
    "confirmed_at" = COALESCE("confirmed_at", "received_at"),
    "diff_count" = COALESCE("diff_count", 0)
WHERE "status" = 'POSTED';

UPDATE "stock_in_items"
SET "expected_qty" = COALESCE("expected_qty", "received_qty"),
    "confirmed_qty" = COALESCE("confirmed_qty", "received_qty"),
    "diff_qty" = COALESCE("diff_qty", 0),
    "confirmed_at" = COALESCE("confirmed_at", CURRENT_TIMESTAMP)
WHERE "confirmed_qty" IS NULL;
