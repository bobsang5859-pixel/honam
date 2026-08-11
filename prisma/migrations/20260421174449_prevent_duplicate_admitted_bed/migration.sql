-- 같은 부서+방+침대에 ADMITTED 상태 환자가 2명 이상 생기는 것을 DB 레벨에서 차단
-- SQLite partial unique index: WHERE 절 매칭되는 행끼리만 유니크 제약 적용
CREATE UNIQUE INDEX "idx_patients_active_bed"
ON "patients"("department_id", "room_no", "bed_no")
WHERE "status" = 'ADMITTED' AND "deleted_at" IS NULL;
