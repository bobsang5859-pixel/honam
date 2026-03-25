CREATE TABLE IF NOT EXISTS "stock_out_followups" (
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
  CONSTRAINT "stock_out_followups_stock_out_id_fkey"
    FOREIGN KEY ("stock_out_id") REFERENCES "stock_out" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_out_followups_department_id_fkey"
    FOREIGN KEY ("department_id") REFERENCES "departments" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_out_followups_item_id_fkey"
    FOREIGN KEY ("item_id") REFERENCES "items" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_out_followups_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_out_followups_resolved_by_fkey"
    FOREIGN KEY ("resolved_by") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "stock_out_followups_status_created_at_idx"
ON "stock_out_followups"("status", "created_at");

CREATE INDEX IF NOT EXISTS "stock_out_followups_department_id_status_idx"
ON "stock_out_followups"("department_id", "status");

CREATE INDEX IF NOT EXISTS "stock_out_followups_stock_out_id_idx"
ON "stock_out_followups"("stock_out_id");

CREATE INDEX IF NOT EXISTS "stock_out_followups_item_id_idx"
ON "stock_out_followups"("item_id");
