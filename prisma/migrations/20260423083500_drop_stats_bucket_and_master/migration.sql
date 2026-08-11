-- 통계카테고리 제거: items.stats_bucket 컬럼 + stats_category_masters 테이블 폐기
-- 통계 그룹은 category prefix 로 자동 도출 (getStatsGroup 헬퍼)

-- 1) stats_category_masters 테이블 삭제
DROP TABLE IF EXISTS "stats_category_masters";

-- 2) items.stats_bucket 컬럼 + 인덱스 삭제 (SQLite 는 컬럼 DROP 위해 테이블 재구성 필요)
PRAGMA foreign_keys=OFF;

CREATE TABLE "items_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "item_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'MED_OTHER',
    "sub_category" TEXT NOT NULL DEFAULT '',
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

INSERT INTO "items_new" ("id","item_code","name","category","sub_category","expense_scope","uom","pack_size","default_vendor_id","min_order_qty","is_regular_order","reorder_days_threshold","is_active","deleted_at","image_url")
SELECT "id","item_code","name","category","sub_category","expense_scope","uom","pack_size","default_vendor_id","min_order_qty","is_regular_order","reorder_days_threshold","is_active","deleted_at","image_url"
FROM "items";

DROP TABLE "items";
ALTER TABLE "items_new" RENAME TO "items";

CREATE UNIQUE INDEX "items_item_code_key" ON "items"("item_code");
CREATE INDEX "items_category_idx" ON "items"("category");
CREATE INDEX "items_expense_scope_idx" ON "items"("expense_scope");
CREATE INDEX "items_default_vendor_id_idx" ON "items"("default_vendor_id");
CREATE INDEX "items_is_regular_order_idx" ON "items"("is_regular_order");

PRAGMA foreign_keys=ON;
