-- 입고(GoodsReceipt) 에 수기 등록용 거래처(manual_vendor_id) 컬럼 추가.
-- 발주서 미연결 입고(수기) 시 사용자가 직접 거래처를 지정할 수 있게 함.
-- 발주서 연결 입고는 purchase_order.vendor_id 를 우선 사용.
ALTER TABLE "goods_receipts" ADD COLUMN "manual_vendor_id" TEXT REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX IF NOT EXISTS "goods_receipts_manual_vendor_id_idx" ON "goods_receipts"("manual_vendor_id");
