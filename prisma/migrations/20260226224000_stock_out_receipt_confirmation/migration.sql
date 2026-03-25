-- StockOut receipt confirmation fields
ALTER TABLE "stock_out"
  ADD COLUMN "receipt_confirmed_at" DATETIME;

ALTER TABLE "stock_out"
  ADD COLUMN "receipt_confirmed_by" TEXT;

ALTER TABLE "stock_out"
  ADD COLUMN "receipt_diff_count" INTEGER NOT NULL DEFAULT 0;

-- StockOutItem receipt confirmation fields
ALTER TABLE "stock_out_items"
  ADD COLUMN "received_qty" DECIMAL;

ALTER TABLE "stock_out_items"
  ADD COLUMN "receipt_note" TEXT NOT NULL DEFAULT '';

ALTER TABLE "stock_out_items"
  ADD COLUMN "receipt_confirmed_at" DATETIME;

ALTER TABLE "stock_out_items"
  ADD COLUMN "receipt_confirmed_by" TEXT;

-- Backfill legacy posted records to confirmed state
UPDATE "stock_out"
SET "status" = 'RECEIPT_CONFIRMED',
    "receipt_confirmed_at" = COALESCE("receipt_confirmed_at", "issued_at"),
    "receipt_diff_count" = 0
WHERE "status" = 'POSTED';

-- Backfill legacy items as fully received
UPDATE "stock_out_items"
SET "received_qty" = "issued_qty",
    "receipt_confirmed_at" = COALESCE("receipt_confirmed_at", CURRENT_TIMESTAMP)
WHERE "received_qty" IS NULL;
