-- Phase A: 품목 3단 계층 재설계 — 중분류(category) 값이 곧 변경될 예정이고, 소분류(sub_category) 필드를 신규 추가
-- 기본값은 빈 문자열 — 기존 품목엔 소분류 없음, 필요시 재분류 스크립트가 채움
ALTER TABLE "items" ADD COLUMN "sub_category" TEXT NOT NULL DEFAULT '';
