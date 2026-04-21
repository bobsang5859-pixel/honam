import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { audit } from '../utils/audit';

// ── 보류 큐: 엑셀 파일 잠금으로 쓰기 실패한 행 이동 작업 ──────────────────
interface PendingMove {
  chartNo: string;
  sheetName: string; // '퇴원기록'
  rowValues: any[];
  closedAt: string;  // ISO date string
}
let pendingMoves: PendingMove[] = [];
export function getPendingMoves() { return pendingMoves; }
export function clearPendingMoves() { pendingMoves = []; }

// ── 헤더 매핑 ───────────────────────────────────────────────────────────────
const IMPORT_HEADER_MAP: Record<string, string> = {
  '환자번호': 'patient_no', 'patient_no': 'patient_no', '번호': 'patient_no',
  '차트번호': 'chart_no',   'chart_no': 'chart_no',     '차트': 'chart_no',
  '이름': 'name',           'name': 'name',             '환자명': 'name', '성명': 'name',
  '성별': 'gender',
  '거동상태': 'mobility_type', '거동유형': 'mobility_type', '거동': 'mobility_type', '기동상태': 'mobility_type',
  '보험종류': 'insurance_type', '보험유형': 'insurance_type', '보험': 'insurance_type',
  '본인부담경감': 'copay_reduction', '경감유형': 'copay_reduction', '산정특례유형': 'copay_reduction',
  '환자군': 'patient_group', '환자등급': 'patient_group', '등급': 'patient_group',
  '주상병': 'main_disease_code', '주상병코드': 'main_disease_code',
  '산정특례': 'disease_code', '산정특례코드': 'disease_code', 'V코드': 'disease_code',
  '산정특례시작일': 'disease_code_registered_at', '산정특례시작': 'disease_code_registered_at',
  '산정특례종료일': 'disease_code_expires_at', '산정특례종료': 'disease_code_expires_at', '산정특례기간': 'disease_code_expires_at',
  '특성화': 'specializations',
  '감염균주': 'infection_strain', '균주': 'infection_strain',
  '특정기간': 'period_type', '특정기간질환': 'period_type',
  '기저귀': 'diaper_state', '기저귀상태': 'diaper_state',
  '기저귀수량': 'diaper_price', '기저귀금액': 'diaper_price',
  '기저귀시작일': 'diaper_start_date', '기저귀시작': 'diaper_start_date',
  '기저귀종료일': 'diaper_end_date',   '기저귀종료': 'diaper_end_date',
  '입원전병원': 'prev_hospital', '이전병원': 'prev_hospital',
  '입원일': 'admitted_at',
  '병실': 'room_no',
  '병상': 'bed_no', '병상번호': 'bed_no', '자리번호': 'bed_no', '자리': 'bed_no',
  '특정기간단계': 'period_phase', '기간단계': 'period_phase',
  '간병유형': 'caregiver_type',
  '보호자': 'guardian_name',
  '연락처': 'billing_sms_phone',
  '주상병명': 'main_disease_name',   // import 시 무시 (참조용)
  '산정특례명': 'disease_name',       // import 시 무시 (참조용)
  '지인': 'acquaintance', '소개자': 'acquaintance',
  '지인색상': 'acquaintance_color',
  '사업명': 'project_name', '사업명칭': 'project_name',
  '사업지역': 'project_region',
  '시군구관할관청': 'project_sigungu_office', '시군구': 'project_sigungu_office',
  '비고': 'note', '메모': 'note',
  '병동': 'department_code', '병동코드': 'department_code', '병동명': 'department_code',
  '상태': 'status_action',   // 퇴원 | (빈칸=입원중)
};

const cleanHdr = (cell: any) => String(cell ?? '').trim().replace(/[★*✓✗]/g, '').trim();
const isImportHeaderRow = (row: any[]) =>
  row.filter(cell => IMPORT_HEADER_MAP[cleanHdr(cell)]).length >= 2;

// ── 한국어 → enum 변환 ───────────────────────────────────────────────────────
const toGender = (v: string) => v === '남' ? 'M' : v === '여' ? 'F' : 'UNKNOWN';
const toMobility = (v: string) => v === '와상' ? 'BEDRIDDEN' : 'AMBULATORY';
const toInsurance = (v: string) => {
  const m: Record<string, string> = {
    '의료급여1종': 'MEDICAL_1', '의료급여 1종': 'MEDICAL_1',
    '의료급여2종': 'MEDICAL_2', '의료급여 2종': 'MEDICAL_2',
    '산재': 'WORKERS_COMP', '산재보험': 'WORKERS_COMP',
    '자동차': 'AUTO_INS', '자동차보험': 'AUTO_INS',
  };
  return m[v.trim()] || 'HEALTH';
};
const toCopayReduction = (v: string) => {
  const m: Record<string, string> = {
    '중증질환': 'SEVERE', '본인부담중증': 'SEVERE', '본인부담경감(중증질환)': 'SEVERE', '중증': 'SEVERE',
    '희귀난치성': 'RARE', '본인부담희귀': 'RARE', '본인부담경감(희귀난치성)': 'RARE', '희귀': 'RARE',
    '해당없음': 'NONE', '없음': 'NONE',
  };
  return m[v.trim()] || 'NONE';
};
const toGroup = (v: string) => (({ '최고도': 'HIGHEST', '고도': 'HIGH', '중도': 'MEDIUM', '경도': 'LOW', '선택': 'SELECT' } as Record<string,string>)[v.trim()] || 'UNRATED');
const toSpecializations = (v: string): string[] => {
  const m: Record<string, string> = { '감염': 'INFECT', '투석': 'DIALYSIS', '재활': 'REHAB' };
  return v.split(',').map(s => m[s.trim()]).filter(Boolean);
};
const toPeriodType = (v: string) => (({ '폐렴': 'PNEUMONIA', '패혈증': 'SEPSIS' } as Record<string,string>)[v.trim()] || '');
const toPeriodPhase = (v: string) => (({ '시작': 'START', '종료': 'END' } as Record<string,string>)[v.trim()] || '');
const toDiaperState = (v: string) => v === '원내' ? 'IN_HOUSE' : v === '본인' ? 'PERSONAL' : 'NONE';
const toCaregiverTypeEnum = (v: string) => {
  const m: Record<string, string> = { '밀착간병': 'CLOSE', '외주간병': 'OUTSOURCED', '본원간병': 'IN_HOUSE',
    '공동간병': 'CLOSE', '개인간병': 'OUTSOURCED', '보호자': 'IN_HOUSE', '입주간병': 'IN_HOUSE' };
  return m[v.trim()] || v.trim();
};
const COLOR_NAME_TO_HEX: Record<string, string> = {
  '빨강': '#ef4444', '파랑': '#3b82f6', '초록': '#22c55e', '노랑': '#eab308',
  '보라': '#a855f7', '주황': '#f97316', '분홍': '#ec4899', '하늘': '#0ea5e9',
};
const colorNameToHex = (v: string) => COLOR_NAME_TO_HEX[v.trim()] || v.trim() || '#0ea5e9';

// 날짜 파싱 (YYYY-MM-DD 문자열 또는 Excel serial 또는 JS Date 객체)
function parseDateField(raw: any): Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === 'number') {
    // Excel serial date: ExcelJS often returns Date objects directly, but fallback
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + raw * 86400000);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ── DB 퇴원 처리 (Express req 없이) ──────────────────────────────────────────
async function closePatientInDB(
  patient: any,
  actorUserId: string,
  reason?: string,
): Promise<void> {
  const now = new Date();
  await (prisma as any).patient.update({
    where: { id: patient.id },
    data: {
      status: 'DISCHARGED',
      discharged_at: now,
      ...(reason ? { note: [patient.note, `[퇴원사유] ${reason}`].filter(Boolean).join('\n') } : {}),
    },
  });
  await (prisma as any).patientEvent.create({
    data: {
      id: uuidv4(),
      patient_id: patient.id,
      department_id: patient.department_id,
      event_type: 'DISCHARGE',
      event_date: now,
      room_no: patient.room_no ?? '',
      bed_no: patient.bed_no ?? null,
      prev_hospital: patient.prev_hospital ?? '',
      memo: reason || 'Excel 자동 처리',
      created_by: actorUserId,
    } as any,
  });
  // WardRoomBoard 업데이트 (모든 날짜)
  await (prisma as any).wardRoomBoard.updateMany({
    where: {
      patient_id: patient.id,
      deleted_at: null,
    },
    data: {
      status: 'DISCHARGED',
      patient_id: null,
      patient_no: '',
      chart_no: '',
      patient_name: '',
    },
  });
}

// ── 시트에서 실제 데이터가 있는 마지막 행 번호 찾기 ─────────────────────────
function findLastDataRow(sheet: ExcelJS.Worksheet): number {
  let lastRow = 1; // 헤더 행
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    let hasData = false;
    row.eachCell((cell) => {
      if (cell.value !== null && cell.value !== undefined && String(cell.value).trim() !== '') {
        hasData = true;
      }
    });
    if (hasData) lastRow = r;
  }
  return lastRow;
}

// ── Excel 시트에 행 추가 헬퍼 (빈 행 건너뛰고 데이터 바로 다음에 추가) ──────
function appendRowToSheet(
  sheet: ExcelJS.Worksheet,
  values: any[],
  gray = true,
) {
  const lastDataRow = findLastDataRow(sheet);
  const targetRowNum = lastDataRow + 1;
  const row = sheet.getRow(targetRowNum);
  values.forEach((val, i) => { row.getCell(i + 1).value = val; });
  if (gray) {
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
      cell.font = { size: 9 };
    });
  }
  row.commit();
}

// ── 안전한 엑셀 쓰기 (파일 잠금 시 임시파일 → rename 재시도) ─────────────────
async function writeExcelSafe(wb: ExcelJS.Workbook, filePath: string): Promise<boolean> {
  // 1차: 직접 쓰기
  try {
    await wb.xlsx.writeFile(filePath);
    return true;
  } catch {
    // 파일 잠금 → 임시 파일 전략
  }

  // 2차: 임시 파일에 쓰고 rename
  const tmpPath = filePath + '.tmp';
  try {
    await wb.xlsx.writeFile(tmpPath);
    // 원본 파일이 잠겨 있어도 rename이 될 수 있음
    try {
      fs.renameSync(tmpPath, filePath);
      return true;
    } catch {
      // rename도 실패 → copyFile 시도
      try {
        fs.copyFileSync(tmpPath, filePath);
        fs.unlinkSync(tmpPath);
        return true;
      } catch {
        // 완전 실패 — 임시 파일 정리
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  console.warn('[patient-import] Excel 파일 저장 실패 (파일이 열려 있을 수 있음)');
  return false;
}

// ── 차트번호로 환자목록 행 찾기 (보류 큐 재적용용) ────────────────────────────
function findRowByChartNo(ws: ExcelJS.Worksheet, chartNo: string): { rowNum: number; values: any[] } | null {
  // 헤더에서 차트번호 컬럼 찾기
  const headerRow = ws.getRow(1);
  let chartColNum = -1;
  headerRow.eachCell((cell, colNum) => {
    const hdr = String(cell.value ?? '').trim();
    if (hdr === '차트번호' || hdr === '차트') chartColNum = colNum;
  });
  if (chartColNum < 1) return null;

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const val = String(row.getCell(chartColNum).value ?? '').trim();
    if (val === chartNo) {
      const values: any[] = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        values.push(row.getCell(c).value ?? '');
      }
      return { rowNum: r, values };
    }
  }
  return null;
}

// ── 병실현황판 기존 셀 비우기 (병실 변경 시) ──────────────────────────────────
async function clearBoardCell(deptId: string, roomNo: string, bedNo: number) {
  const date = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const room = await (prisma as any).wardRoom.findFirst({
    where: { department_id: deptId, room_no: { in: [roomNo, roomNo.replace(/호$/, ''), roomNo + '호'] }, is_active: true, deleted_at: null },
  });
  if (!room) return;
  await (prisma as any).wardRoomBoard.updateMany({
    where: {
      board_date: date,
      department_id: deptId,
      ward_room_id: room.id,
      bed_no: bedNo,
      deleted_at: null,
    },
    data: {
      patient_id: null,
      patient_no: '',
      chart_no: '',
      patient_name: '',
      status: 'ADMITTED',
    },
  });
  console.log(`[patient-import] 기존 보드 셀 비움: room=${roomNo}, bed=${bedNo}`);
}

// ── 병실현황판 자동 배치 헬퍼 ─────────────────────────────────────────────────
async function upsertBoardCell(patient: any, deptId: string, roomNo: string, bedNo: number | null) {
  if (!roomNo || bedNo == null) {
    console.log(`[patient-import] 보드 배치 건너뜀: roomNo=${roomNo}, bedNo=${bedNo}, chart=${patient.chart_no}`);
    return;
  }
  const date = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
  // room_no가 '507'이면 '507호'도 시도 (DB에 '호' 포함 저장 가능)
  const room = await (prisma as any).wardRoom.findFirst({
    where: { department_id: deptId, room_no: { in: [roomNo, roomNo + '호'] }, is_active: true, deleted_at: null },
  });
  if (!room) {
    console.log(`[patient-import] WardRoom 찾을 수 없음: deptId=${deptId}, roomNo=${roomNo}, chart=${patient.chart_no}`);
    return;
  }
  const actualRoomNo = room.room_no; // DB에 저장된 실제 room_no 사용
  console.log(`[patient-import] 보드 배치 시도: chart=${patient.chart_no}, room=${actualRoomNo}, bed=${bedNo}, date=${date}`);
  await (prisma as any).wardRoomBoard.upsert({
    where: {
      board_date_department_id_ward_room_id_bed_no: {
        board_date: date,
        department_id: deptId,
        ward_room_id: room.id,
        bed_no: bedNo,
      },
    },
    create: {
      id: uuidv4(),
      board_date: date,
      department_id: deptId,
      ward_room_id: room.id,
      room_no: actualRoomNo,
      bed_no: bedNo,
      patient_id: patient.id,
      patient_no: patient.patient_no,
      chart_no: patient.chart_no,
      patient_name: patient.name,
      gender: patient.gender ?? 'UNKNOWN',
      mobility_type: patient.mobility_type ?? 'AMBULATORY',
      insurance_type: patient.insurance_type ?? 'HEALTH',
      patient_group: patient.patient_group ?? 'UNRATED',
      specializations: patient.specializations ?? '[]',
      infection_strain: patient.infection_strain ?? '',
      period_type: patient.period_type ?? '',
      period_phase: patient.period_phase ?? '',
      diaper_state: patient.diaper_state ?? 'NONE',
      diaper_price: patient.diaper_price ?? 0,
      diaper_start_date: patient.diaper_start_date ?? undefined,
      diaper_end_date: patient.diaper_end_date ?? undefined,
      prev_hospital: patient.prev_hospital ?? '',
      acquaintance: patient.acquaintance ?? '',
      acquaintance_color: patient.acquaintance_color ?? '',
      main_disease_code_id: patient.main_disease_code_id ?? undefined,
      caregiver_type: patient.caregiver_type ?? '',
      guardian_name: patient.guardian_name ?? '',
      billing_sms_phone: patient.billing_sms_phone ?? '',
      project_name: patient.project_name ?? '',
      project_region: patient.project_region ?? '',
      project_sigungu_office: patient.project_sigungu_office ?? '',
      note: patient.note ?? '',
      status: 'ADMITTED',
    },
    update: {
      patient_id: patient.id,
      patient_no: patient.patient_no,
      chart_no: patient.chart_no,
      patient_name: patient.name,
      gender: patient.gender ?? 'UNKNOWN',
      mobility_type: patient.mobility_type ?? 'AMBULATORY',
      insurance_type: patient.insurance_type ?? 'HEALTH',
      patient_group: patient.patient_group ?? 'UNRATED',
      specializations: patient.specializations ?? '[]',
      infection_strain: patient.infection_strain ?? '',
      period_type: patient.period_type ?? '',
      period_phase: patient.period_phase ?? '',
      diaper_state: patient.diaper_state ?? 'NONE',
      diaper_price: patient.diaper_price ?? 0,
      diaper_start_date: patient.diaper_start_date ?? undefined,
      diaper_end_date: patient.diaper_end_date ?? undefined,
      prev_hospital: patient.prev_hospital ?? '',
      acquaintance: patient.acquaintance ?? '',
      acquaintance_color: patient.acquaintance_color ?? '',
      main_disease_code_id: patient.main_disease_code_id ?? undefined,
      caregiver_type: patient.caregiver_type ?? '',
      guardian_name: patient.guardian_name ?? '',
      billing_sms_phone: patient.billing_sms_phone ?? '',
      project_name: patient.project_name ?? '',
      project_region: patient.project_region ?? '',
      project_sigungu_office: patient.project_sigungu_office ?? '',
      note: patient.note ?? '',
      status: 'ADMITTED',
    },
  });
}

// ── 결과 인터페이스 ──────────────────────────────────────────────────────────
export interface ImportResult {
  created: number;
  skipped: number;
  discharged: number;
  deceased: number; // 하위호환용 (항상 0)
  updated: number;
  errors: { row: number; message: string }[];
  synced_at: string;
}

// ── 메인 임포트 함수 ─────────────────────────────────────────────────────────
export async function importPatientsFromBuffer(
  buffer: Buffer,
  deptId: string,
  actorUserId: string,
  filePath?: string,
): Promise<ImportResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  // ── 병동별 시트 지원: 시트 이름이 병동명과 일치하면 자동 매핑 ──────────
  const allDepts: any[] = await (prisma as any).department.findMany({ where: { deleted_at: null } });
  const deptByName = new Map<string, string>(allDepts.map((d: any) => [d.name, d.id]));

  // 병동별 시트가 있는지 확인
  const wardSheets: { ws: ExcelJS.Worksheet; deptId: string }[] = [];
  for (const sheet of wb.worksheets) {
    const sheetName = sheet.name.trim();
    if (sheetName === '퇴원기록' || sheetName === '사망기록') continue;
    const matchedDeptId = deptByName.get(sheetName);
    if (matchedDeptId && sheet.rowCount >= 2) {
      wardSheets.push({ ws: sheet, deptId: matchedDeptId });
    }
  }

  // 병동별 시트가 있으면 각 시트를 개별 import 후 결과 합산
  if (wardSheets.length > 0) {
    const totals: ImportResult = { created: 0, skipped: 0, discharged: 0, deceased: 0, updated: 0, errors: [], synced_at: new Date().toISOString() };
    for (const { ws: wardWs, deptId: wardDeptId } of wardSheets) {
      const r = await importSingleSheet(wb, wardWs, wardDeptId, actorUserId, filePath);
      totals.created += r.created;
      totals.skipped += r.skipped;
      totals.discharged += r.discharged;
      totals.updated += r.updated;
      totals.errors.push(...r.errors.map(e => ({ ...e, message: `[${wardWs.name}] ${e.message}` })));
    }
    totals.synced_at = new Date().toISOString();

    // Excel 파일 저장 (행 이동이 있었을 수 있으므로)
    if (filePath) {
      await writeExcelSafe(wb, filePath);
    }

    await audit({
      actor_user_id: actorUserId,
      action: 'IMPORT',
      entity_type: 'patients',
      entity_id: 'bulk',
      after: { created: totals.created, updated: totals.updated, discharged: totals.discharged, deceased: 0, skipped: totals.skipped, source: 'file-watcher' },
    });
    return totals;
  }

  // ── 기존 방식: 환자목록 단일 시트 ──────────────────────────────────────
  const ws = wb.getWorksheet('환자목록') ?? wb.worksheets[0];
  if (!ws || ws.rowCount < 2) {
    return { created: 0, skipped: 0, discharged: 0, deceased: 0, updated: 0, errors: [], synced_at: new Date().toISOString() };
  }

  return importSingleSheet(wb, ws, deptId, actorUserId, filePath);
}

// ── 단일 시트 임포트 (병동별 or 환자목록) ──────────────────────────────────
async function importSingleSheet(
  wb: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  deptId: string,
  actorUserId: string,
  filePath?: string,
): Promise<ImportResult> {

  // ── 행 데이터를 메모리로 읽기 ─────────────────────────────────────────────
  // rowData[i] = { values: any[], rowNum: number }
  const rowData: { values: any[]; rowNum: number }[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    const vals = (row.values as any[]).slice(1); // ExcelJS는 1-indexed → 0-indexed로 변환
    rowData.push({ values: vals, rowNum });
  });

  if (rowData.length === 0) {
    return { created: 0, skipped: 0, discharged: 0, deceased: 0, updated: 0, errors: [], synced_at: new Date().toISOString() };
  }

  // ── 헤더 파싱 ─────────────────────────────────────────────────────────────
  const firstRow = rowData[0].values;
  const isHeaderMode = isImportHeaderRow(firstRow);
  let colIndex: Record<string, number>;
  let dataRows: { values: any[]; rowNum: number }[];

  if (isHeaderMode) {
    colIndex = {};
    firstRow.forEach((cell: any, i: number) => {
      const field = IMPORT_HEADER_MAP[cleanHdr(cell)];
      if (field && !(field in colIndex)) colIndex[field] = i;
    });
    console.log(`[patient-import] 인식된 헤더: ${JSON.stringify(colIndex)}`);
    console.log(`[patient-import] 원본 헤더: ${firstRow.map((c: any) => cleanHdr(c)).join(', ')}`);
    dataRows = rowData.slice(1).filter(r => r.values.some((c: any) => c !== '' && c != null));
  } else {
    // 헤더 없는 파일: 위치 기반
    colIndex = {
      chart_no: 0, name: 1, gender: 2, mobility_type: 3, insurance_type: 4,
      patient_group: 5, specializations: 6, infection_strain: 7, period_type: 8,
      diaper_state: 9, diaper_price: 10, prev_hospital: 11, admitted_at: 12,
      room_no: 13, bed_no: 14,
      main_disease_code: 15, disease_code: 16,
      disease_code_registered_at: 17, disease_code_expires_at: 18,
    };
    dataRows = rowData.slice(1).filter(r => r.values.some((c: any) => c !== '' && c != null));
  }

  const gc = (row: any[], field: string): any => {
    const idx = colIndex[field];
    return idx !== undefined ? row[idx] : '';
  };

  // ── DiseaseCode 마스터 조회 (주상병 + 산정특례 V코드 → ID 변환용) ─────────
  const allDiseaseCodes: any[] = await (prisma as any).diseaseCode.findMany({
    where: { is_active: true, deleted_at: null },
  });
  const diseaseCodeByCode = new Map<string, any>(
    allDiseaseCodes.map((dc: any) => [dc.code.trim().toUpperCase(), dc]),
  );

  // ── 결과 카운터 ────────────────────────────────────────────────────────────
  const createdCharts: string[] = [];
  const skippedCharts: string[] = [];
  const dischargedCharts: string[] = [];
  const updatedCharts: string[] = [];
  const errors: { row: number; message: string }[] = [];

  // ── DB에서 현재 입원 환자 목록 (scope) ───────────────────────────────────
  const dbAdmittedWhere: any = { status: 'ADMITTED', deleted_at: null };
  if (deptId) dbAdmittedWhere.department_id = deptId;
  const dbAdmitted: any[] = await (prisma as any).patient.findMany({ where: dbAdmittedWhere });
  const dbByChart = new Map<string, any>(dbAdmitted.map((p: any) => [p.chart_no, p]));

  // ── 엑셀에 남아있는 환자 chart_no 추적 ───────────────────────────────────
  const excelChartNos = new Set<string>();

  // ── 퇴원으로 이동될 행 수집 ──────────────────────────────────────────────
  const rowsToMove: { rowNum: number; sheetName: string; rowValues: any[]; closedAt: Date }[] = [];

  // ── 각 데이터 행 처리 ─────────────────────────────────────────────────────
  for (let i = 0; i < dataRows.length; i++) {
    const { values: row, rowNum } = dataRows[i];
    const dispRow = rowNum; // Excel row number (1-indexed)

    let chart_no = String(gc(row, 'chart_no') ?? '').trim();
    const name     = String(gc(row, 'name') ?? '').trim();
    const statusAction = String(gc(row, 'status_action') ?? '').trim();
    if (statusAction) {
      console.log(`[patient-import] Row ${dispRow}: chart=${chart_no}, name=${name}, statusAction="${statusAction}", colIdx=${colIndex['status_action']}`);
    }

    if (!name)     { errors.push({ row: dispRow, message: '이름은 필수입니다.' }); continue; }
    // 차트번호 없으면 이름+행번호로 자동 생성
    if (!chart_no) { chart_no = `AUTO-${name}-${dispRow}`; }

    const existingPatient = dbByChart.get(chart_no);
    const closedAt = new Date();

    // ── 퇴원 처리 (사망 포함 — 사유에 기록) ──────────────────────────────
    if (statusAction === '퇴원' || statusAction === '사망') {
      const reason = statusAction === '사망' ? '사망' : undefined;
      if (existingPatient) {
        try {
          await closePatientInDB(existingPatient, actorUserId, reason);
          dischargedCharts.push(chart_no);
        } catch (e: any) {
          errors.push({ row: dispRow, message: `퇴원 처리 오류: ${e.message}` });
        }
      }
      // DB 상태와 무관하게 항상 행 이동
      rowsToMove.push({ rowNum, sheetName: '퇴원기록', rowValues: [...row], closedAt });
      continue;
    }

    // ── 일반 입원중 행 ──────────────────────────────────────────────────────
    excelChartNos.add(chart_no);

    const patient_no     = String(gc(row, 'patient_no') ?? '').trim();
    const gender         = toGender(String(gc(row, 'gender') ?? '').trim());
    const mobility_type  = toMobility(String(gc(row, 'mobility_type') ?? '').trim());
    const insurance_type = toInsurance(String(gc(row, 'insurance_type') ?? '').trim());
    const copay_reduction = toCopayReduction(String(gc(row, 'copay_reduction') ?? '').trim());
    const patient_group  = toGroup(String(gc(row, 'patient_group') ?? '').trim());
    const specializations = toSpecializations(String(gc(row, 'specializations') ?? '').trim());
    const infection_strain = String(gc(row, 'infection_strain') ?? '').trim();
    const period_type    = toPeriodType(String(gc(row, 'period_type') ?? '').trim());
    const diaper_state   = toDiaperState(String(gc(row, 'diaper_state') ?? '').trim());
    const diaperRaw      = gc(row, 'diaper_price');
    const diaper_price   = diaperRaw !== '' && diaperRaw != null ? Number(diaperRaw) : 0;
    const diaper_start_date = parseDateField(gc(row, 'diaper_start_date'));
    const diaper_end_date   = parseDateField(gc(row, 'diaper_end_date'));
    const prev_hospital  = String(gc(row, 'prev_hospital') ?? '').trim();
    const room_no_raw    = String(gc(row, 'room_no') ?? '').trim().replace(/호$/, '');
    const room_no        = room_no_raw ? room_no_raw + '호' : '';
    const bedRaw         = gc(row, 'bed_no');
    const bed_no         = bedRaw !== '' && bedRaw != null ? Number(bedRaw) : (room_no ? 1 : null);
    const period_phase   = toPeriodPhase(String(gc(row, 'period_phase') ?? '').trim());
    const caregiver_type = toCaregiverTypeEnum(String(gc(row, 'caregiver_type') ?? '').trim());
    const guardian_name  = String(gc(row, 'guardian_name') ?? '').trim();
    const billing_sms_phone = String(gc(row, 'billing_sms_phone') ?? '').trim();
    const acquaintance   = String(gc(row, 'acquaintance') ?? '').trim();
    const acquaintance_color = colorNameToHex(String(gc(row, 'acquaintance_color') ?? '').trim());
    const project_name   = String(gc(row, 'project_name') ?? '').trim();
    const project_region = String(gc(row, 'project_region') ?? '').trim();
    const project_sigungu_office = String(gc(row, 'project_sigungu_office') ?? '').trim();
    const note           = String(gc(row, 'note') ?? '').trim();

    // 주상병 코드 → ID 변환
    const mainDiseaseRaw = String(gc(row, 'main_disease_code') ?? '').trim().toUpperCase();
    const mainDiseaseEntry = mainDiseaseRaw ? diseaseCodeByCode.get(mainDiseaseRaw) : null;
    const main_disease_code_id = mainDiseaseEntry?.id ?? null;

    // 산정특례(V코드) → ID 변환
    const diseaseCodeRaw = String(gc(row, 'disease_code') ?? '').trim().toUpperCase();
    const diseaseCodeEntry = diseaseCodeRaw ? diseaseCodeByCode.get(diseaseCodeRaw) : null;
    const disease_code_id = diseaseCodeEntry?.id ?? null;

    // 산정특례 기간
    const disease_code_registered_at = parseDateField(gc(row, 'disease_code_registered_at'));
    const disease_code_expires_at = parseDateField(gc(row, 'disease_code_expires_at'));

    // 병동 변경 감지 (엑셀 '병동' 컬럼)
    const deptCodeRaw = String(gc(row, 'department_code') ?? '').trim();
    let newDeptId: string | null = null;
    if (deptCodeRaw) {
      const dept = await prisma.department.findFirst({
        where: { OR: [{ code: deptCodeRaw }, { name: deptCodeRaw }], deleted_at: null },
      });
      if (dept) newDeptId = dept.id;
    }

    if (existingPatient) {
      // ── 기존 환자 업데이트 ──────────────────────────────────
      try {
        const spec = JSON.stringify(specializations);
        const dp = diaper_state === 'IN_HOUSE' ? diaper_price : 0;
        const deptChanged = newDeptId && newDeptId !== existingPatient.department_id;

        await (prisma as any).patient.update({
          where: { id: existingPatient.id },
          data: {
            mobility_type,
            insurance_type,
            copay_reduction,
            patient_group,
            // 병동 변경 시: 새 병동 + 병실/병상 초기화 (배치는 별도)
            ...(deptChanged
              ? { department_id: newDeptId, room_no: room_no || '', bed_no: bed_no ?? null }
              : { room_no: room_no || existingPatient.room_no, bed_no: bed_no ?? existingPatient.bed_no }),
            specializations: spec,
            infection_strain,
            period_type,
            period_phase,
            diaper_state,
            diaper_price: dp,
            diaper_start_date: diaper_start_date ?? undefined,
            diaper_end_date: diaper_end_date ?? undefined,
            ...(main_disease_code_id !== null && { main_disease_code_id }),
            ...(disease_code_id !== null && { disease_code_id }),
            ...(disease_code_registered_at !== null && { disease_code_registered_at }),
            ...(disease_code_expires_at !== null && { disease_code_expires_at }),
            caregiver_type,
            guardian_name,
            billing_sms_phone,
            acquaintance,
            acquaintance_color,
            project_name,
            project_region,
            project_sigungu_office,
            note,
          } as any,
        });
        updatedCharts.push(chart_no);

        // 병실현황판 동기화
        const updatedPatient = await (prisma as any).patient.findUnique({ where: { id: existingPatient.id } });
        if (updatedPatient) {
          const oldRoom = existingPatient.room_no ?? '';
          const oldBed = existingPatient.bed_no;
          const newRoom = updatedPatient.room_no ?? '';
          const newBed = updatedPatient.bed_no;

          if (deptChanged) {
            // 전실: 기존 부서 보드 셀 클리어
            if (oldRoom && oldBed != null) {
              await clearBoardCell(existingPatient.department_id, oldRoom, Number(oldBed));
            }
            // PatientEvent TRANSFER 기록
            await (prisma as any).patientEvent.create({
              data: {
                id: uuidv4(),
                patient_id: existingPatient.id,
                department_id: existingPatient.department_id,
                event_type: 'TRANSFER',
                event_date: new Date(),
                room_no: oldRoom,
                bed_no: oldBed ?? null,
                memo: `엑셀 전실 → ${deptCodeRaw}`,
                created_by: actorUserId,
              },
            });
            // 새 부서 보드에 배치
            if (newRoom && newBed != null) {
              await upsertBoardCell(updatedPatient, newDeptId!, newRoom, Number(newBed));
            }
          } else {
            // 같은 부서 내 병실/병상 변경
            if (oldRoom && oldBed != null && (oldRoom !== newRoom || Number(oldBed) !== Number(newBed))) {
              await clearBoardCell(existingPatient.department_id, oldRoom, Number(oldBed));
            }
            await upsertBoardCell(updatedPatient, updatedPatient.department_id, newRoom, newBed != null ? Number(newBed) : null);
          }
        }
      } catch (e: any) {
        errors.push({ row: dispRow, message: `업데이트 오류: ${e.message}` });
      }
    } else {
      // ── 신규 환자 등록 ───────────────────────────────────────────────────
      const admDate = String(gc(row, 'admitted_at') ?? '').trim();
      const admitted_at_str = admDate || new Date().toISOString().slice(0, 10);
      try {
        const d = new Date(admitted_at_str);
        if (isNaN(d.getTime())) throw new Error();
      } catch {
        errors.push({ row: dispRow, message: '입원일 형식 오류: ' + admDate }); continue;
      }

      // 부서 자동 결정
      let resolvedDeptId = deptId;
      if (!resolvedDeptId && room_no) {
        // room_no가 '507'이면 '507호'도 시도 (DB에 '호' 포함 저장 가능)
        const wardRoom = await (prisma as any).wardRoom.findFirst({
          where: { room_no: { in: [room_no, room_no + '호'] }, is_active: true, deleted_at: null },
        });
        resolvedDeptId = wardRoom?.department_id ?? '';
      }
      if (!resolvedDeptId) {
        errors.push({ row: dispRow, message: `부서를 찾을 수 없습니다. (병실: ${room_no || '없음'})` });
        continue;
      }

      try {
        const spec = JSON.stringify(specializations);
        const dp = diaper_state === 'IN_HOUSE' ? diaper_price : 0;
        await (prisma as any).patient.create({
          data: {
            id: uuidv4(),
            patient_no: patient_no || chart_no,
            chart_no,
            name,
            department_id: resolvedDeptId,
            admitted_at: new Date(admitted_at_str),
            room_no: room_no || '',
            status: 'ADMITTED',
            created_by: actorUserId,
            gender,
            mobility_type,
            insurance_type,
            copay_reduction,
            patient_group,
            specializations: spec,
            infection_strain,
            period_type,
            period_phase,
            diaper_state,
            diaper_price: dp,
            diaper_start_date: diaper_start_date ?? undefined,
            diaper_end_date: diaper_end_date ?? undefined,
            prev_hospital,
            main_disease_code_id,
            disease_code_id,
            disease_code_registered_at: disease_code_registered_at ?? undefined,
            disease_code_expires_at: disease_code_expires_at ?? undefined,
            caregiver_type,
            guardian_name,
            billing_sms_phone,
            acquaintance,
            acquaintance_color,
            project_name,
            project_region,
            project_sigungu_office,
            note,
          } as any,
        });
        createdCharts.push(chart_no);
        // 병실현황판 자동 배치
        const createdPatient = await (prisma as any).patient.findFirst({ where: { chart_no, status: 'ADMITTED', deleted_at: null } });
        if (createdPatient) {
          await upsertBoardCell(createdPatient, resolvedDeptId, room_no, bed_no);
        }
      } catch (e: any) {
        if (e.code === 'P2002') skippedCharts.push(chart_no);
        else errors.push({ row: dispRow, message: e.message });
      }
    }
  }

  // ── Step 3: 삭제된 환자 자동 퇴원 (deptId 있을 때만) ─────────────────────
  if (deptId) {
    for (const [chartNo, p] of dbByChart.entries()) {
      if (!excelChartNos.has(chartNo)) {
        try {
          await closePatientInDB(p, actorUserId);
          dischargedCharts.push(chartNo);
        } catch (e: any) {
          errors.push({ row: -1, message: `자동 퇴원 오류 (${chartNo}): ${e.message}` });
        }
      }
    }
  }

  // ── Step 4: Excel 파일 수정 (행 이동) ────────────────────────────────────
  // 이전에 실패한 보류 작업이 있으면 합치기
  if (pendingMoves.length > 0 && filePath) {
    console.log(`[patient-import] 보류된 행 이동 ${pendingMoves.length}건 재적용`);
    for (const pm of pendingMoves) {
      // 아직 환자목록에 있는 행만 이동 (이미 이동된 건 스킵)
      const found = findRowByChartNo(ws, pm.chartNo);
      if (found) {
        rowsToMove.push({
          rowNum: found.rowNum,
          sheetName: pm.sheetName,
          rowValues: found.values,
          closedAt: new Date(pm.closedAt),
        });
      }
    }
    pendingMoves = [];
  }

  console.log(`[patient-import] rowsToMove: ${rowsToMove.length}건, filePath: ${filePath ?? 'N/A'}`);
  if (filePath && rowsToMove.length > 0) {
    await moveRowsInExcel(wb, ws, rowsToMove, colIndex, firstRow);
    const saved = await writeExcelSafe(wb, filePath);
    if (saved) {
      console.log(`[patient-import] Excel 행 이동 저장 완료 (${rowsToMove.length}건)`);
    } else {
      // 실패한 이동 작업을 보류 큐에 저장 → 다음 import 시 재시도
      const chartIdx = colIndex['chart_no'];
      for (const rm of rowsToMove) {
        const chartNo = chartIdx !== undefined ? String(rm.rowValues[chartIdx] ?? '').trim() : `row-${rm.rowNum}`;
        pendingMoves.push({
          chartNo,
          sheetName: rm.sheetName,
          rowValues: rm.rowValues,
          closedAt: rm.closedAt.toISOString(),
        });
      }
      console.log(`[patient-import] ${pendingMoves.length}건 보류 큐에 저장 — 다음 저장 시 재시도`);
    }
  }

  await audit({
    actor_user_id: actorUserId,
    action: 'IMPORT',
    entity_type: 'patients',
    entity_id: 'bulk',
    after: {
      created: createdCharts.length,
      updated: updatedCharts.length,
      discharged: dischargedCharts.length,
      deceased: 0,
      skipped: skippedCharts.length,
      source: 'file-watcher',
    },
  });

  return {
    created: createdCharts.length,
    skipped: skippedCharts.length,
    discharged: dischargedCharts.length,
    deceased: 0,
    updated: updatedCharts.length,
    errors,
    synced_at: new Date().toISOString(),
  };
}

// ── 행 이동 헬퍼 (퇴원 행을 기록 시트로 이동) ───────────────────────────────
async function moveRowsInExcel(
  wb: ExcelJS.Workbook,
  mainSheet: ExcelJS.Worksheet,
  rowsToMove: { rowNum: number; sheetName: string; rowValues: any[]; closedAt: Date }[],
  colIndex: Record<string, number>,
  headerValues: any[],
): Promise<void> {
  // 기록 시트 가져오기 (없으면 생성)
  const getOrCreateSheet = (name: string, dateLabel: string): ExcelJS.Worksheet => {
    let sheet = wb.getWorksheet(name);
    if (!sheet) {
      sheet = wb.addWorksheet(name);
      // 헤더: 환자목록 헤더 + 날짜 컬럼
      const headers = [...headerValues.filter(Boolean), dateLabel];
      const hRow = sheet.addRow(headers);
      hRow.font = { bold: true };
      hRow.commit();
    }
    return sheet;
  };

  const dischargeSheet = getOrCreateSheet('퇴원기록', '퇴원일자');

  const statusColIdx = colIndex['status_action'] ?? -1;

  for (const { rowValues, closedAt } of rowsToMove) {
    // 상태 컬럼을 빈칸으로 바꿔서 기록 시트에 추가 (상태 없음 = 처리 완료)
    const vals = [...rowValues];
    if (statusColIdx >= 0) vals[statusColIdx] = '';

    const dateStr = closedAt.toISOString().slice(0, 10);
    appendRowToSheet(dischargeSheet, [...vals, dateStr]);
  }

  // 이동될 행 번호 수집 (높은 번호부터 삭제해야 인덱스가 안 밀림)
  const rowNumsToDelete = rowsToMove.map(r => r.rowNum).sort((a, b) => b - a);
  for (const rn of rowNumsToDelete) {
    mainSheet.spliceRows(rn, 1);
  }
}
