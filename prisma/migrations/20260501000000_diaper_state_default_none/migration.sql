-- diaper_state 정규화 강화
-- 1. 기존 빈 문자열 → 'NONE' 일괄 정리 (referral 승인 우회 경로로 들어온 환자들)
-- 2. 컬럼 default 'NONE' 으로 변경 (스키마 변경은 Prisma 가 자동 적용)
--
-- 원인: referral.ts:160 의 patient.create 가 normalizePatient 우회 + diaper_state 필드 누락
--      → schema default '' 적용되어 빈 문자열 저장
-- 방어: referral.ts 에 명시 추가(코드 fix) + schema default 'NONE' (구조적 안전망)

UPDATE patients SET diaper_state = 'NONE' WHERE diaper_state = '' OR diaper_state IS NULL;
UPDATE ward_room_boards SET diaper_state = 'NONE' WHERE diaper_state = '' OR diaper_state IS NULL;
