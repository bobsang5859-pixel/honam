-- CreateTable
CREATE TABLE "patient_charge_plans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patient_id" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "monthly_rate" REAL NOT NULL DEFAULT 0,
    "start_date" DATETIME NOT NULL,
    "end_date" DATETIME,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "patient_charge_plans_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "patient_charge_plans_patient_id_item_name_start_date_idx" ON "patient_charge_plans"("patient_id", "item_name", "start_date");
