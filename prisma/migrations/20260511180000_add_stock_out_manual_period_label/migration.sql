-- StockOut 에 수동 주차 라벨 컬럼 추가 (ADHOC 등 ward_request 없는 불출의 그룹화 용)
ALTER TABLE "stock_out" ADD COLUMN "manual_period_label" TEXT;
