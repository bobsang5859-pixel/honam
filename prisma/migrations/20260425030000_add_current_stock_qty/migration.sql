-- AlterTable: 소모품 신청 시 현재 재고 입력 강제용 필드 (nullable — 비품/긴급 등은 미입력 허용)
ALTER TABLE "ward_request_items" ADD COLUMN "current_stock_qty" DECIMAL;
