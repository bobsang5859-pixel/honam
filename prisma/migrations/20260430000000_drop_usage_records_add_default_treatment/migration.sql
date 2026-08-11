-- 1) Item 모델에 default_treatment_type_id 추가
ALTER TABLE "items" ADD COLUMN "default_treatment_type_id" TEXT;

-- 2) Item.default_treatment_type_id → TreatmentType.id FK 인덱스
CREATE INDEX "items_default_treatment_type_id_idx" ON "items"("default_treatment_type_id");

-- 3) usage_records 테이블 완전 제거 (사용등록 기능 폐지)
--    데이터는 마이그레이션 직전 DB 백업으로 보존됨 (prisma/hospital-supply.db.backup-*).
--    수요 예측은 StockOut(부서 출고) 기반으로 재구현됨.
DROP TABLE IF EXISTS "usage_records";
