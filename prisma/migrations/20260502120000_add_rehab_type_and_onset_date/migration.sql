-- 재활구분(rehab_type) + 발병일(onset_date) 추가
-- CNS(뇌신경계 재활) / OS(정형·기타 재활) / OUTPATIENT(외래) / '' (해당없음)
-- onset_date 는 재활 환자의 발병일 — onset 경과 기간으로 수가 단계 결정

-- patients
ALTER TABLE "patients" ADD COLUMN "rehab_type" TEXT NOT NULL DEFAULT '';
ALTER TABLE "patients" ADD COLUMN "onset_date" DATETIME;
CREATE INDEX "patients_rehab_type_idx" ON "patients"("rehab_type");

-- ward_room_boards (병실현황판 표시·필터용)
ALTER TABLE "ward_room_boards" ADD COLUMN "rehab_type" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ward_room_boards" ADD COLUMN "onset_date" DATETIME;
