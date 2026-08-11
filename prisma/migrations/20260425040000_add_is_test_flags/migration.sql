-- 테스트 데이터 표시용 is_test 플래그 — 통계 합산 제외 + 일괄 삭제 식별
ALTER TABLE "ward_requests"   ADD COLUMN "is_test" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "purchase_orders" ADD COLUMN "is_test" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "goods_receipts"  ADD COLUMN "is_test" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stock_out"       ADD COLUMN "is_test" BOOLEAN NOT NULL DEFAULT false;
