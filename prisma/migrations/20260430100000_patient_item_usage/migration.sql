-- 환자×품목 사용 매핑 테이블 (호흡·삽관, 카테터·튜브 등)
CREATE TABLE "patient_item_usage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patient_id" TEXT NOT NULL,
    "usage_kind" TEXT NOT NULL,
    "size" TEXT NOT NULL DEFAULT '',
    "group_key" TEXT NOT NULL,
    "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" DATETIME,
    "created_by" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "patient_item_usage_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "patient_item_usage_patient_id_usage_kind_size_key"
    ON "patient_item_usage"("patient_id", "usage_kind", "size");

CREATE INDEX "patient_item_usage_usage_kind_size_idx"
    ON "patient_item_usage"("usage_kind", "size");

CREATE INDEX "patient_item_usage_group_key_patient_id_idx"
    ON "patient_item_usage"("group_key", "patient_id");
