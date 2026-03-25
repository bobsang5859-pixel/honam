-- Patient: board/detail metadata fields
ALTER TABLE "patients"
  ADD COLUMN "main_disease_code_id" TEXT;

ALTER TABLE "patients"
  ADD COLUMN "caregiver_type" TEXT NOT NULL DEFAULT '';

ALTER TABLE "patients"
  ADD COLUMN "guardian_name" TEXT NOT NULL DEFAULT '';

ALTER TABLE "patients"
  ADD COLUMN "billing_sms_phone" TEXT NOT NULL DEFAULT '';

ALTER TABLE "patients"
  ADD COLUMN "project_name" TEXT NOT NULL DEFAULT '';

ALTER TABLE "patients"
  ADD COLUMN "project_region" TEXT NOT NULL DEFAULT '';

ALTER TABLE "patients"
  ADD COLUMN "project_sigungu_office" TEXT NOT NULL DEFAULT '';

-- WardRoomBoard: board card metadata fields
ALTER TABLE "ward_room_boards"
  ADD COLUMN "main_disease_code_id" TEXT;

ALTER TABLE "ward_room_boards"
  ADD COLUMN "caregiver_type" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ward_room_boards"
  ADD COLUMN "guardian_name" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ward_room_boards"
  ADD COLUMN "billing_sms_phone" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ward_room_boards"
  ADD COLUMN "project_name" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ward_room_boards"
  ADD COLUMN "project_region" TEXT NOT NULL DEFAULT '';

ALTER TABLE "ward_room_boards"
  ADD COLUMN "project_sigungu_office" TEXT NOT NULL DEFAULT '';

-- Legacy gender normalization
UPDATE "patients"
SET "gender" = 'M'
WHERE UPPER(COALESCE("gender", '')) = 'MALE';

UPDATE "patients"
SET "gender" = 'F'
WHERE UPPER(COALESCE("gender", '')) = 'FEMALE';

UPDATE "ward_room_boards"
SET "gender" = 'M'
WHERE UPPER(COALESCE("gender", '')) = 'MALE';

UPDATE "ward_room_boards"
SET "gender" = 'F'
WHERE UPPER(COALESCE("gender", '')) = 'FEMALE';
