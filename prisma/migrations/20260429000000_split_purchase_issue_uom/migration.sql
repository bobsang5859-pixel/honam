-- 발주 단위(purchase_uom)와 불출 단위(issue_uom) 분리
-- 기존 uom 값을 두 신규 컬럼에 그대로 복사하여 동작 변화 없이 시작
-- pack_size 의미를 "1 purchase_uom = pack_size issue_uom"으로 명확화 (값 자체는 그대로 유지)

ALTER TABLE "items" ADD COLUMN "purchase_uom" TEXT NOT NULL DEFAULT 'EA';
ALTER TABLE "items" ADD COLUMN "issue_uom" TEXT NOT NULL DEFAULT 'EA';

UPDATE "items"
SET "purchase_uom" = COALESCE(NULLIF("uom", ''), 'EA'),
    "issue_uom"    = COALESCE(NULLIF("uom", ''), 'EA');
