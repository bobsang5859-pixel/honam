/**
 * 환자 일괄 교체 — 기존 환자 hard delete + 신규 import
 *
 * 입력: 전체 병실현황.xlsx (헤더: 차트번호, 이름, 성별, 병동-병실-자리, 입원일자)
 *
 * 동작 (--apply 시):
 *   1. 기존 환자 + cascade(events, charges, payments, disease_codes, treatments,
 *      complaints.patient_id, referrals.patient_id, ward_room_boards) 삭제
 *   2. 엑셀 파싱: "0201" → "201호" 변환, bed_no 정수
 *   3. 환자 insert + ward_room_boards 신규 보드 생성 (오늘 날짜 기준)
 *
 * 매핑 실패 (병동/병실 DB에 없음 등) 시 그 행 skip + 보고
 */
import { PrismaClient } from '@prisma/client';
import XLSX from 'xlsx';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();
const XLSX_PATH = path.resolve('전체 병실현황.xlsx');

interface RawRow {
  chart_no: string;
  name: string;
  gender: string;
  ward: string;       // "2병동"
  room_no: string;    // "201호" (변환 후)
  bed_no: number;
  admitted_at: Date;
  rawLocation: string; // 원본 "2병동-0201-01"
}

function parseRows(): RawRow[] {
  const wb = XLSX.readFile(XLSX_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }).slice(1) as any[][];
  const out: RawRow[] = [];
  for (const r of rows) {
    const [chart, name, gender, location, admit] = r;
    if (!chart || !name || !location) continue; // 빈 침대 skip
    const parts = String(location).split('-');
    if (parts.length !== 3) continue;
    const ward = String(parts[0]).trim();
    const rawRoom = String(parts[1]).trim(); // "0201"
    const rawBed = String(parts[2]).trim();  // "01"
    // "0201" → "201호"
    const roomNum = rawRoom.replace(/^0+/, '') || rawRoom; // 앞 0 제거
    const room_no = `${roomNum}호`;
    const bed_no = parseInt(rawBed, 10);
    if (!Number.isFinite(bed_no)) continue;
    let admittedAt: Date;
    if (admit instanceof Date) admittedAt = admit;
    else if (typeof admit === 'number') {
      // Excel serial date
      admittedAt = new Date(Date.UTC(1900, 0, admit - 1));
    } else if (typeof admit === 'string' && admit) {
      admittedAt = new Date(admit);
    } else {
      admittedAt = new Date();
    }
    if (isNaN(admittedAt.getTime())) admittedAt = new Date();
    out.push({
      chart_no: String(chart).trim(),
      name: String(name).trim(),
      gender: String(gender || 'UNKNOWN').toUpperCase(),
      ward,
      room_no,
      bed_no,
      admitted_at: admittedAt,
      rawLocation: String(location),
    });
  }
  return out;
}

async function deleteAllPatients() {
  console.log('🗑️  기존 환자 + cascade 삭제 시작...');
  const ids = (await prisma.patient.findMany({ select: { id: true } })).map(p => p.id);
  console.log('   대상:', ids.length, '명');

  // 자식 레코드 삭제 (FK 순서)
  await (prisma as any).complaint.updateMany({
    where: { patient_id: { in: ids } }, data: { patient_id: null },
  }).catch(() => {});
  await (prisma as any).referral.updateMany({
    where: { patient_id: { in: ids } }, data: { patient_id: null },
  }).catch(() => {});

  const deletes = await Promise.all([
    prisma.$executeRawUnsafe('DELETE FROM patient_events WHERE patient_id IN (SELECT id FROM patients)'),
    prisma.$executeRawUnsafe('DELETE FROM patient_disease_codes WHERE patient_id IN (SELECT id FROM patients)'),
    prisma.$executeRawUnsafe('DELETE FROM patient_treatments WHERE patient_id IN (SELECT id FROM patients)'),
    prisma.$executeRawUnsafe('DELETE FROM patient_charges WHERE patient_id IN (SELECT id FROM patients)'),
    prisma.$executeRawUnsafe('DELETE FROM patient_payments WHERE patient_id IN (SELECT id FROM patients)'),
  ]);
  console.log('   patient_events/disease_codes/treatments/charges/payments 삭제');

  // ward_room_boards 의 patient_id 도 정리 (보드 자체는 유지하되 환자 연결만 끊음)
  await prisma.$executeRawUnsafe(`
    UPDATE ward_room_boards SET patient_id=NULL, patient_no='', chart_no='', patient_name='',
      gender='UNKNOWN', insurance_type='HEALTH', copay_reduction='NONE',
      patient_group='UNRATED', specializations='[]', infection_strain='',
      period_type='', period_phase='', diaper_state='', status='DISCHARGED'
    WHERE patient_id IS NOT NULL
  `);
  console.log('   ward_room_boards 환자 연결 해제');

  // 환자 본체
  const del = await prisma.$executeRawUnsafe('DELETE FROM patients');
  console.log('   patients:', del, '건 삭제');
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`[import-patients] Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);

  // 1. 파싱
  const rows = parseRows();
  console.log(`[import-patients] 파싱: ${rows.length} 행`);

  // 2. 부서/병실 매핑 사전 로드
  const depts = await prisma.department.findMany({
    where: { deleted_at: null },
    select: { id: true, name: true },
  });
  const deptByName: Record<string, string> = {};
  for (const d of depts) deptByName[d.name] = d.id;

  const rooms = await prisma.wardRoom.findMany({
    where: { deleted_at: null },
    select: { id: true, room_no: true, department_id: true },
  });
  const roomMap: Record<string, { id: string }> = {};
  for (const r of rooms) roomMap[`${r.department_id}|${r.room_no}`] = { id: r.id };

  // 3. 매핑 검사
  const valid: Array<RawRow & { department_id: string; ward_room_id: string }> = [];
  const errors: Array<{ row: RawRow; reason: string }> = [];
  for (const r of rows) {
    const deptId = deptByName[r.ward];
    if (!deptId) { errors.push({ row: r, reason: `병동 '${r.ward}' DB 없음` }); continue; }
    const roomKey = `${deptId}|${r.room_no}`;
    const room = roomMap[roomKey];
    if (!room) { errors.push({ row: r, reason: `병실 '${r.ward} ${r.room_no}' DB 없음` }); continue; }
    valid.push({ ...r, department_id: deptId, ward_room_id: room.id });
  }
  console.log(`[import-patients] 매핑 완료: 성공 ${valid.length} / 실패 ${errors.length}`);
  if (errors.length > 0) {
    console.log('실패 샘플 (최대 10개):');
    errors.slice(0, 10).forEach(e => console.log(`  - ${e.row.chart_no} ${e.row.name} (${e.row.rawLocation}) → ${e.reason}`));
  }

  if (!apply) {
    console.log('\n⚠️  DRY-RUN — DB 변경 없음. --apply 로 실제 실행');
    await prisma.$disconnect();
    return;
  }

  // 4. 기존 환자 삭제
  await deleteAllPatients();

  // 5. 신규 환자 + 보드 생성
  console.log('\n📥 신규 환자 import 시작...');
  let created = 0;
  let boardsCreated = 0;
  const today = new Date();
  const todayDateOnly = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const insertErrors: Array<{ row: any; reason: string }> = [];

  // 시스템 사용자 (created_by)
  const sysUser = await prisma.user.findFirst({ where: { is_active: true } });
  if (!sysUser) throw new Error('시스템 사용자가 없습니다');

  for (const r of valid) {
    try {
      const patient = await (prisma as any).patient.create({
        data: {
          id: uuidv4(),
          patient_no: r.chart_no,
          chart_no: r.chart_no,
          name: r.name,
          department_id: r.department_id,
          room_no: r.room_no,
          bed_no: r.bed_no,
          admitted_at: r.admitted_at,
          status: 'ADMITTED',
          gender: ['F', 'M'].includes(r.gender) ? r.gender : 'UNKNOWN',
          mobility_type: 'AMBULATORY',
          insurance_type: 'HEALTH',
          copay_reduction: 'NONE',
          patient_group: 'UNRATED',
          specializations: '[]',
          infection_strain: '',
          period_type: '',
          period_phase: '',
          diaper_state: '',
          prev_hospital: '',
          acquaintance: '',
          acquaintance_color: '',
          caregiver_type: '',
          guardian_name: '',
          billing_sms_phone: '',
          project_name: '',
          project_region: '',
          project_sigungu_office: '',
          address: '',
          referral_source: '',
          discharge_type: '',
          monthly_medical_fee: 0,
          monthly_payment: 0,
          monthly_unpaid: 0,
          note: '',
          created_by: sysUser.id,
        },
      });
      created++;

      // ward_room_boards 신규 (오늘 날짜) — upsert로 충돌 방지
      try {
        await (prisma as any).wardRoomBoard.upsert({
          where: {
            board_date_department_id_ward_room_id_bed_no: {
              board_date: todayDateOnly,
              department_id: r.department_id,
              ward_room_id: r.ward_room_id,
              bed_no: r.bed_no,
            },
          },
          create: {
            id: uuidv4(),
            board_date: todayDateOnly,
            department_id: r.department_id,
            ward_room_id: r.ward_room_id,
            room_no: r.room_no,
            bed_no: r.bed_no,
            patient_id: patient.id,
            patient_no: r.chart_no,
            chart_no: r.chart_no,
            patient_name: r.name,
            gender: patient.gender,
            mobility_type: 'AMBULATORY',
            insurance_type: 'HEALTH',
            copay_reduction: 'NONE',
            patient_group: 'UNRATED',
            specializations: '[]',
            infection_strain: '',
            period_type: '',
            period_phase: '',
            diaper_state: '',
            prev_hospital: '',
            acquaintance: '',
            acquaintance_color: '',
            caregiver_type: '',
            guardian_name: '',
            billing_sms_phone: '',
            project_name: '',
            project_region: '',
            project_sigungu_office: '',
            address: '',
            referral_source: '',
            discharge_type: '',
            status: 'ADMITTED',
            is_manual: false,
          },
          update: {
            patient_id: patient.id,
            patient_no: r.chart_no,
            chart_no: r.chart_no,
            patient_name: r.name,
            gender: patient.gender,
            status: 'ADMITTED',
          },
        });
        boardsCreated++;
      } catch (be: any) {
        insertErrors.push({ row: r, reason: `board 생성: ${be.message}` });
      }
    } catch (e: any) {
      insertErrors.push({ row: r, reason: e.message });
    }
  }

  console.log(`  patients: ${created} 건 insert`);
  console.log(`  ward_room_boards: ${boardsCreated} 건 동기화`);
  if (insertErrors.length > 0) {
    console.log('\n⚠️  insert 실패:');
    insertErrors.slice(0, 10).forEach(e => console.log(`  - ${e.row.chart_no} ${e.row.name}: ${e.reason}`));
  }

  // 최종 검증
  const total = await prisma.patient.count();
  console.log(`\n✅ 완료. 현재 환자 테이블: ${total} 건`);

  await prisma.$disconnect();
}

main().catch(e => {
  console.error('[import-patients] error:', e);
  process.exit(1);
});
