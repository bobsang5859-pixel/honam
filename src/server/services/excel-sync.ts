/**
 * excel-sync.ts
 * 프로그램에서 환자 상태 변경 시 Excel 파일에 자동 반영
 *
 * 사용: fire-and-forget 방식
 *   syncPatientToExcel({ action: 'discharge', patient, closedAt: new Date() }).catch(() => {});
 */

import ExcelJS from 'exceljs';
import fs from 'fs';
import { prisma } from '../index';
import { setExcelSyncLock } from './file-watcher';

// 환자목록 시트 헤더 순서 (rebuild-template.js와 동일하게 유지, 37컬럼)
const PATIENT_COL_KEYS = [
  'patient_no', 'chart_no', 'name', 'gender',
  'mobility_type', 'insurance_type', 'patient_group', 'specializations',
  'infection_strain', 'period_type', 'period_phase',
  'period_start_date', 'period_end_date',
  'diaper_state', 'diaper_price', 'diaper_start_date', 'diaper_end_date',
  'prev_hospital', 'admitted_at', 'room_no', 'bed_no',
  'main_disease_code', 'main_disease_name',
  'disease_code', 'disease_name',
  'disease_code_registered_at', 'disease_code_expires_at',
  'caregiver_type', 'guardian_name', 'billing_sms_phone',
  'acquaintance', 'acquaintance_color',
  'project_name', 'project_region', 'project_sigungu_office',
  'note',
  'status_action', // 마지막 = 상태 컬럼
] as const;

// DB 값 → Excel 표시값 변환
function toDisplayGender(v: string) { return v === 'M' ? '남' : v === 'F' ? '여' : ''; }
function toDisplayMobility(v: string) { return v === 'BEDRIDDEN' ? '와상' : v === 'AMBULATORY' ? '거동' : ''; }
function toDisplayInsurance(v: string) {
  const m: Record<string, string> = {
    HEALTH: '건강보험', MEDICAL_1: '의료급여1종', MEDICAL_2: '의료급여2종',
    WORKERS_COMP: '산재', AUTO_INS: '자동차',
    HEALTH_REDUCED_SEVERE: '본인부담중증', HEALTH_REDUCED_RARE: '본인부담희귀',
  };
  return m[v] ?? '';
}
function toDisplayGroup(v: string) {
  const m: Record<string, string> = {
    HIGHEST: '최고도', HIGH: '고도', MEDIUM: '중도', LOW: '경도', SELECT: '선택', UNRATED: '',
  };
  return m[v] ?? '';
}
function toDisplaySpec(v: string) {
  try {
    const arr: string[] = JSON.parse(v || '[]');
    const m: Record<string, string> = { INFECT: '감염', DIALYSIS: '투석', REHAB: '재활' };
    return arr.map(s => m[s] ?? s).join(',');
  } catch { return ''; }
}
function toDisplayPeriod(v: string) {
  return v === 'PNEUMONIA' ? '폐렴' : v === 'SEPSIS' ? '패혈증' : '';
}
function toDisplayDiaper(v: string) {
  return v === 'IN_HOUSE' ? '원내' : v === 'PERSONAL' ? '본인' : '없음';
}
function toDisplayPeriodPhase(v: string) {
  return v === 'START' ? '시작' : v === 'END' ? '종료' : '';
}
function toDisplayCaregiverType(v: string) {
  const m: Record<string, string> = { CLOSE: '밀착간병', OUTSOURCED: '외주간병', IN_HOUSE: '본원간병' };
  return m[v] ?? v;
}
const HEX_TO_COLOR: Record<string, string> = {
  '#ef4444': '빨강', '#3b82f6': '파랑', '#22c55e': '초록', '#eab308': '노랑',
  '#a855f7': '보라', '#f97316': '주황', '#ec4899': '분홍', '#0ea5e9': '하늘',
};
function hexToColorName(hex: string) { return HEX_TO_COLOR[hex] ?? hex; }
function fmtDate(d: Date | null | undefined): string {
  if (!d) return '';
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

// 환자 DB 레코드 → Excel 행 값 배열
// dcMap: DiseaseCode id → { code, name } (외부에서 주입)
function patientToRow(patient: any, dcMap?: Map<string, any>): any[] {
  const mainDc = dcMap?.get(patient.main_disease_code_id ?? '') ?? null;
  const dc = dcMap?.get(patient.disease_code_id ?? '') ?? null;
  return [
    patient.patient_no ?? '',
    patient.chart_no ?? '',
    patient.name ?? '',
    toDisplayGender(patient.gender ?? ''),
    toDisplayMobility(patient.mobility_type ?? ''),
    toDisplayInsurance(patient.insurance_type ?? ''),
    toDisplayGroup(patient.patient_group ?? ''),
    toDisplaySpec(patient.specializations ?? '[]'),
    patient.infection_strain ?? '',
    toDisplayPeriod(patient.period_type ?? ''),
    toDisplayPeriodPhase(patient.period_phase ?? ''),
    '', // period_start_date (placeholder)
    '', // period_end_date   (placeholder)
    toDisplayDiaper(patient.diaper_state ?? ''),
    patient.diaper_price ?? '',
    fmtDate(patient.diaper_start_date),
    fmtDate(patient.diaper_end_date),
    patient.prev_hospital ?? '',
    fmtDate(patient.admitted_at),
    patient.room_no ?? '',
    patient.bed_no ?? '',
    mainDc ? mainDc.code : '',         // 주상병코드
    mainDc ? mainDc.name : '',         // 주상병명
    dc ? dc.code : '',                 // 산정특례코드
    dc ? dc.name : '',                 // 산정특례명
    fmtDate(patient.disease_code_registered_at),
    fmtDate(patient.disease_code_expires_at),
    toDisplayCaregiverType(patient.caregiver_type ?? ''),
    patient.guardian_name ?? '',
    patient.billing_sms_phone ?? '',
    patient.acquaintance ?? '',
    hexToColorName(patient.acquaintance_color ?? ''),
    patient.project_name ?? '',
    patient.project_region ?? '',
    patient.project_sigungu_office ?? '',
    patient.note ?? '',
    '', // status_action — 항상 빈칸 (입원중)
  ];
}

// AppSetting 조회 헬퍼
async function getSetting(key: string): Promise<string | null> {
  try {
    const row = await (prisma as any).appSetting.findUnique({ where: { key } });
    return row?.value ?? null;
  } catch { return null; }
}

// chart_no로 환자목록 시트에서 행 번호 찾기
// 헤더 행 기준으로 chart_no 컬럼을 찾고, 데이터 행에서 매칭
function findPatientRow(
  ws: ExcelJS.Worksheet,
  chartNo: string,
): { rowNum: number; chartColIdx: number } | null {
  let chartColIdx = -1;

  // 헤더 행 스캔 (1번 행)
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell, colNum) => {
    const v = String(cell.value ?? '').trim();
    if (v === '차트번호' || v === 'chart_no') {
      chartColIdx = colNum;
    }
  });

  if (chartColIdx < 0) {
    // 헤더가 없으면 2번째 컬럼이 chart_no (위치 기반 fallback)
    chartColIdx = 2;
  }

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const val = String(row.getCell(chartColIdx).value ?? '').trim();
    if (val === chartNo) {
      return { rowNum: r, chartColIdx };
    }
  }
  return null;
}

// 기록 시트(퇴원기록/사망기록)에 행 추가
function appendToRecordSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  dateLabel: string,
  rowValues: any[],
  dateValue: string,
) {
  let sheet = wb.getWorksheet(sheetName);
  if (!sheet) {
    sheet = wb.addWorksheet(sheetName);
    // 헤더 행 생성
    const headers = PATIENT_COL_KEYS.slice(0, -1).map(k => {
      const labels: Record<string, string> = {
        patient_no: '환자번호', chart_no: '차트번호', name: '이름', gender: '성별',
        mobility_type: '거동상태', insurance_type: '보험유형', patient_group: '환자군',
        specializations: '특성화', infection_strain: '감염균주', period_type: '특정기간',
        period_phase: '특정기간단계',
        period_start_date: '특정기간시작일', period_end_date: '특정기간종료일',
        diaper_state: '기저귀', diaper_price: '기저귀금액',
        diaper_start_date: '기저귀시작일', diaper_end_date: '기저귀종료일',
        prev_hospital: '입원전병원', admitted_at: '입원일', room_no: '병실',
        bed_no: '병상',
        main_disease_code: '주상병코드', main_disease_name: '주상병명',
        disease_code: '산정특례코드', disease_name: '산정특례명',
        disease_code_registered_at: '산정특례시작일', disease_code_expires_at: '산정특례종료일',
        caregiver_type: '간병유형', guardian_name: '보호자',
        billing_sms_phone: '연락처',
        acquaintance: '지인', acquaintance_color: '지인색상',
        project_name: '사업명', project_region: '사업지역',
        project_sigungu_office: '시군구관할관청',
        note: '비고',
      };
      return labels[k] ?? k;
    });
    const hRow = sheet.addRow([...headers, dateLabel]);
    hRow.font = { bold: true };
    hRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD0D0D0' } };
    });
    hRow.commit();
  }

  // status_action 컬럼(마지막) 제거하고 날짜 추가
  const vals = rowValues.slice(0, PATIENT_COL_KEYS.length - 1);
  const allVals = [...vals, dateValue];

  // 빈 행 건너뛰고 실제 데이터 마지막 행 다음에 추가
  let lastDataRow = 1;
  for (let r = 2; r <= sheet.rowCount; r++) {
    let hasData = false;
    sheet.getRow(r).eachCell(cell => {
      if (cell.value !== null && cell.value !== undefined && String(cell.value).trim() !== '') hasData = true;
    });
    if (hasData) lastDataRow = r;
  }
  const targetRow = sheet.getRow(lastDataRow + 1);
  allVals.forEach((v, i) => { targetRow.getCell(i + 1).value = v; });
  targetRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
    cell.font = { size: 9 };
  });
  targetRow.commit();
}

// ── 안전한 엑셀 쓰기 (파일 잠금 시 임시파일 → rename 재시도) ─────────────────
async function writeExcelSafe(wb: ExcelJS.Workbook, filePath: string): Promise<boolean> {
  try {
    await wb.xlsx.writeFile(filePath);
    return true;
  } catch { /* 파일 잠금 → 임시 파일 전략 */ }

  const tmpPath = filePath + '.tmp';
  try {
    await wb.xlsx.writeFile(tmpPath);
    try {
      fs.renameSync(tmpPath, filePath);
      return true;
    } catch {
      try {
        fs.copyFileSync(tmpPath, filePath);
        fs.unlinkSync(tmpPath);
        return true;
      } catch {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    }
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }

  console.warn('[excel-sync] Excel 파일 저장 실패 (파일이 열려 있을 수 있음)');
  return false;
}

// ── 메인 sync 함수 ────────────────────────────────────────────────────────────
export async function syncPatientToExcel(opts: {
  action: 'admit' | 'update' | 'discharge' | 'death';
  patient: any;
  closedAt?: Date;
}): Promise<void> {
  const { action, patient, closedAt } = opts;

  // 1. 파일 경로 조회
  const filePath = await getSetting('patient_watch_file_path');
  const enabled  = await getSetting('patient_watch_enabled');
  if (!filePath || enabled !== 'true') return;
  if (!fs.existsSync(filePath)) return;

  // 2. 루프 방지 락 설정
  setExcelSyncLock(true);
  try {
    // 3. 파일 열기 (실패 시 조용히 스킵)
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.readFile(filePath);
    } catch {
      return; // EPERM: 파일 열려 있음 → 스킵
    }

    const ws = wb.getWorksheet('환자목록') ?? wb.worksheets[0];
    if (!ws) return;

    // DiseaseCode 맵 빌드 (주상병/산정특례 코드 표시용)
    let dcMap: Map<string, any> | undefined;
    try {
      const codes: any[] = await (prisma as any).diseaseCode.findMany({ where: { is_active: true, deleted_at: null } });
      dcMap = new Map(codes.map((c: any) => [c.id, c]));
    } catch { /* ignore */ }

    const rowValues = patientToRow(patient, dcMap);
    const dateStr = (closedAt ?? new Date()).toISOString().slice(0, 10);

    if (action === 'admit') {
      // 환자목록 맨 아래에 새 행 추가
      const newRow = ws.addRow(rowValues);
      newRow.commit();

    } else if (action === 'update') {
      // chart_no로 찾아 업데이트 가능한 필드만 덮어쓰기
      const found = findPatientRow(ws, patient.chart_no);
      if (found) {
        const row = ws.getRow(found.rowNum);
        // 헤더에서 컬럼 인덱스 맵 빌드
        const headerRow = ws.getRow(1);
        const colMap: Record<string, number> = {};
        headerRow.eachCell((cell, colNum) => {
          const hdr = String(cell.value ?? '').trim();
          const fieldMap: Record<string, string> = {
            '거동상태': 'mobility_type', '보험유형': 'insurance_type', '환자군': 'patient_group',
            '특성화': 'specializations', '감염균주': 'infection_strain', '특정기간': 'period_type',
            '특정기간단계': 'period_phase',
            '기저귀': 'diaper_state', '기저귀금액': 'diaper_price',
            '기저귀시작일': 'diaper_start_date', '기저귀종료일': 'diaper_end_date',
            '병실': 'room_no', '병상': 'bed_no',
            '주상병': 'main_disease_code', '주상병코드': 'main_disease_code',
            '주상병명': 'main_disease_name',
            '산정특례': 'disease_code', '산정특례코드': 'disease_code', 'V코드': 'disease_code',
            '산정특례명': 'disease_name',
            '산정특례시작일': 'disease_code_registered_at', '산정특례시작': 'disease_code_registered_at',
            '산정특례종료일': 'disease_code_expires_at', '산정특례종료': 'disease_code_expires_at',
            '간병유형': 'caregiver_type', '보호자': 'guardian_name', '연락처': 'billing_sms_phone',
            '지인': 'acquaintance', '지인색상': 'acquaintance_color',
            '사업명': 'project_name', '사업지역': 'project_region',
            '시군구관할관청': 'project_sigungu_office',
            '비고': 'note',
          };
          const field = fieldMap[hdr];
          if (field) colMap[field] = colNum;
        });

        const mainDc = dcMap?.get(patient.main_disease_code_id ?? '') ?? null;
        const dc = dcMap?.get(patient.disease_code_id ?? '') ?? null;

        const updateMap: Record<string, any> = {
          mobility_type: toDisplayMobility(patient.mobility_type ?? ''),
          insurance_type: toDisplayInsurance(patient.insurance_type ?? ''),
          patient_group: toDisplayGroup(patient.patient_group ?? ''),
          specializations: toDisplaySpec(patient.specializations ?? '[]'),
          infection_strain: patient.infection_strain ?? '',
          period_type: toDisplayPeriod(patient.period_type ?? ''),
          period_phase: toDisplayPeriodPhase(patient.period_phase ?? ''),
          diaper_state: toDisplayDiaper(patient.diaper_state ?? ''),
          diaper_price: patient.diaper_price ?? '',
          diaper_start_date: fmtDate(patient.diaper_start_date),
          diaper_end_date: fmtDate(patient.diaper_end_date),
          room_no: patient.room_no ?? '',
          bed_no: patient.bed_no ?? '',
          main_disease_code: mainDc ? mainDc.code : '',
          main_disease_name: mainDc ? mainDc.name : '',
          disease_code: dc ? dc.code : '',
          disease_name: dc ? dc.name : '',
          disease_code_registered_at: fmtDate(patient.disease_code_registered_at),
          disease_code_expires_at: fmtDate(patient.disease_code_expires_at),
          caregiver_type: toDisplayCaregiverType(patient.caregiver_type ?? ''),
          guardian_name: patient.guardian_name ?? '',
          billing_sms_phone: patient.billing_sms_phone ?? '',
          acquaintance: patient.acquaintance ?? '',
          acquaintance_color: hexToColorName(patient.acquaintance_color ?? ''),
          project_name: patient.project_name ?? '',
          project_region: patient.project_region ?? '',
          project_sigungu_office: patient.project_sigungu_office ?? '',
          note: patient.note ?? '',
        };

        for (const [field, colNum] of Object.entries(colMap)) {
          if (updateMap[field] !== undefined) {
            row.getCell(colNum).value = updateMap[field];
          }
        }
        row.commit();
      }

    } else if (action === 'discharge' || action === 'death') {
      // 환자목록에서 행 찾아 기록 시트로 이동
      const found = findPatientRow(ws, patient.chart_no);
      if (found) {
        const row = ws.getRow(found.rowNum);
        // 행 값 수집
        const vals: any[] = [];
        for (let c = 1; c <= PATIENT_COL_KEYS.length; c++) {
          vals.push(row.getCell(c).value ?? '');
        }
        // 기록 시트에 추가
        const sheetName = action === 'discharge' ? '퇴원기록' : '사망기록';
        const dateLabel = action === 'discharge' ? '퇴원일자' : '사망일자';
        appendToRecordSheet(wb, sheetName, dateLabel, vals, dateStr);
        // 환자목록에서 행 삭제
        ws.spliceRows(found.rowNum, 1);
      }
    }

    // 4. 파일 저장 (파일 잠금 시 임시파일→rename 재시도)
    await writeExcelSafe(wb, filePath);
  } finally {
    // 5. 락 해제 (약간 지연하여 watcher 이벤트 발생 후 해제)
    setTimeout(() => setExcelSyncLock(false), 3000);
  }
}
