-- PurchaseOrder 에 수동 주차 라벨 컬럼 추가
ALTER TABLE "purchase_orders" ADD COLUMN "manual_period_label" TEXT;
