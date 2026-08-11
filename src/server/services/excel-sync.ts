import ExcelJS from 'exceljs';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';

// ─── 보험유형 변환 ────────────────────────────────────────────────────────────
function parseInsurance(raw: string): { insurance_type: string; copay_reduction: string } {
  const v = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (v.includes('의급') || v.includes('의료급여')) {
    const type = (v.includes('2종') || v.includes('2 종')) ? 'MEDICAL_2' : 'MEDICAL_1';
    return { insurance_type: type, copay_reduction: 'NONE' };
  }
  if (v.includes('자보') || v.includes('자동차')) return { insurance_type: 'AUTO_INS', copay_reduction: 'NONE' };
  if (v.includes('산재')) return { insurance_type: 'WORKERS_COMP', copay_reduction: 'NONE' };
  if (v.includes('희귀')) return { insurance_type: 'HEALTH', copay_reduction: 'RARE' };
  if (v.includes('차상위')) return { insurance_type: 'HEALTH', copay_reduction: 'NONE' };
  return { insurance_type: 'HEALTH', copay_reduction: 'NONE' };
}

// ─── 환자군 변환 ──────────────────────────────────────────────────────────────
function parseGroup(raw: string): string {
  const m: Record<string, string> = { 최고도: 'HIGHEST', 고도: 'HIGH', 중도: 'MEDIUM', 경도: 'LOW', 선택: 'SELECT' };
  return m[String(raw ?? '').trim()] ?? 'UNRATED';
}

// ─── 날짜 파싱 ────────────────────────────────────────────────────────────────
function parseDate(raw: any): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ─── 셀 텍스트 추출 ───────────────────────────────────────────────────────────
function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'richText' in v) return (v as any).richText.map((r: any) => r.text).join('');
  if (typeof v === 'object' && 'result' in v) return String((v as any).result ?? '');
  return String(v);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. 파일 종류 자동 감지
// ════════════════════════════════════════════════════════════════════════════
export type SyncFileType = 'wonmu' | 'dailyBoard' | 'rehab' | 'unknown';

export async function detectFileType(buffer: Buffer): Promise<SyncFileType> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const sheetNames = wb.worksheets.map(s => s.name);

  // 원무과약정금: "재원" 또는 "퇴원" 시트 존재
  if (sheetNames.includes('재원') || sheetNames.includes('퇴원')) return 'wonmu';

  // 일일병실현황: 시트명이 M.D 형식 (1.21, 6.9 등)
  const dateLike = sheetNames.filter(n => /^\d{1,2}\.\d{1,2}$/.test(n));
  if (dateLike.length >= 3) return 'dailyBoard';

  // 재활현황: 1행에 CNS/OS 키워드
  const ws = wb.worksheets[0];
  if (ws) {
    const row1 = ws.getRow(1);
    let hasCNS = false;
    row1.eachCell(cell => { if (cellText(cell).includes('CNS') || cellText(cell).includes('OS')) hasCNS = true; });
    if (hasCNS) return 'rehab';
    const row2 = ws.getRow(2);
    let hasCNS2 = false;
    row2.eachCell(cell => { if (cellText(cell).includes('CNS')) hasCNS2 = true; });
    if (hasCNS2) return 'rehab';
  }

  return 'unknown';
}

// ════════════════════════════════════════════════════════════════════════════
// 2. 원무과약정금 처리 → patients 업데이트
// ════════════════════════════════════════════════════════════════════════════
export interface WonmuResult {
  added: number;
  updated: number;
  discharged: number;
  errors: string[];
}

export async function processWonmuFile(buffer: Buffer, actorUserId: string): Promise<WonmuResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);

  const result: WonmuResult = { added: 0, updated: 0, discharged: 0, errors: [] };

  // 부서 목록 로드 (병실코드로 부서 찾기용)
  const departments = await (prisma as any).department.findMany({ where: { is_active: true } });
  const deptByName = new Map<string, any>(departments.map((d: any) => [d.name, d]));

  // 퇴원 시트 처리
  const dischargeSheet = wb.getWorksheet('퇴원');
  if (dischargeSheet) {
    for (let r = 2; r <= dischargeSheet.rowCount; r++) {
      const row = dischargeSheet.getRow(r);
      const chartNo = cellText(row.getCell(1)).trim();
      if (!chartNo) continue;
      try {
        const patient = await (prisma as any).patient.findFirst({
          where: { chart_no: chartNo, status: 'ADMITTED', deleted_at: null },
        });
        if (patient) {
          await (prisma as any).patient.update({
            where: { id: patient.id },
            data: { status: 'DISCHARGED', discharged_at: new Date() },
          });
          result.discharged++;
        }
      } catch (e: any) {
        result.errors.push(`퇴원처리 실패 (${chartNo}): ${e.message}`);
      }
    }
  }

  // 재원 시트 처리
  const admitSheet = wb.getWorksheet('재원');
  if (!admitSheet) return result;

  // 헤더 행 찾기 (차트번호가 있는 행)
  let headerRow = 1;
  for (let r = 1; r <= Math.min(5, admitSheet.rowCount); r++) {
    const row = admitSheet.getRow(r);
    const c1 = cellText(row.getCell(1));
    if (c1 === '차트번호' || c1 === '차트번호') { headerRow = r; break; }
  }
  const dataStart = headerRow + 1;

  for (let r = dataStart; r <= admitSheet.rowCount; r++) {
    const row = admitSheet.getRow(r);
    const chartNo = cellText(row.getCell(1)).trim();
    const typeRaw = cellText(row.getCell(2)).trim();
    const name = cellText(row.getCell(3)).trim();
    const roomRaw = cellText(row.getCell(4)).trim();   // 500/0507/02 형식
    const feeRaw = row.getCell(5).value;
    const diaperRaw = row.getCell(6).value;
    const acquaintance = cellText(row.getCell(9)).trim();
    const guardian = cellText(row.getCell(10)).trim();
    const smsPhone = cellText(row.getCell(11)).trim();
    // V코드 (col 12~14가 산정특례 코드/시작/종료)
    const vCode = cellText(row.getCell(12)).trim();
    const vStart = parseDate(row.getCell(13).value);
    const vEnd = parseDate(row.getCell(14).value);

    if (!chartNo || !name) continue;

    // 병실 파싱: "500/0507/02" → room_no=507, bed_no=2
    let roomNo = roomRaw;
    let bedNo: number | null = null;
    const roomParts = roomRaw.split('/');
    if (roomParts.length >= 2) {
      roomNo = roomParts[1]; // 0507
      bedNo = roomParts[2] ? parseInt(roomParts[2]) : null;
    }

    // 부서 찾기 (병실 앞자리로 매핑: 5xx → 5병동 등)
    let deptId: string | null = null;
    const wardNum = roomNo.replace(/^0+/, '').charAt(0);
    const wardName = `${wardNum}병동`;
    const dept = deptByName.get(wardName);
    if (dept) deptId = dept.id;

    const { insurance_type, copay_reduction } = parseInsurance(typeRaw);
    const diaperPrice = typeof diaperRaw === 'number' ? diaperRaw : null;

    // 기저귀 상태 추론
    const diaperState = diaperPrice && diaperPrice > 0 ? 'IN_HOUSE' : 'NONE';

    const monthlyFee = typeof feeRaw === 'number' ? feeRaw : null;

    try {
      const existing = await (prisma as any).patient.findFirst({
        where: { chart_no: chartNo, deleted_at: null },
      });

      const data: any = {
        name,
        insurance_type,
        copay_reduction,
        room_no: roomNo,
        ...(bedNo !== null ? { bed_no: bedNo } : {}),
        ...(deptId ? { department_id: deptId } : {}),
        ...(diaperPrice !== null ? { diaper_price: diaperPrice, diaper_state: diaperState } : {}),
        ...(monthlyFee !== null ? { monthly_medical_fee: monthlyFee } : {}),
        ...(acquaintance ? { acquaintance } : {}),
        ...(guardian ? { guardian_name: guardian } : {}),
        ...(smsPhone ? { billing_sms_phone: smsPhone } : {}),
        status: 'ADMITTED',
      };

      if (existing) {
        await (prisma as any).patient.update({ where: { id: existing.id }, data });
        result.updated++;
      } else {
        if (!deptId) {
          result.errors.push(`부서 미확인으로 추가 불가 (${chartNo} ${name})`);
          continue;
        }
        await (prisma as any).patient.create({
          data: {
            id: uuidv4(),
            chart_no: chartNo,
            patient_no: chartNo,
            created_by: actorUserId,
            ...data,
          },
        });
        result.added++;
      }

      // V코드 산정특례 처리
      if (vCode && vStart) {
        const dc = await (prisma as any).diseaseCode.findFirst({ where: { code: vCode, is_active: true } });
        if (dc) {
          const pat = await (prisma as any).patient.findFirst({ where: { chart_no: chartNo, deleted_at: null } });
          if (pat) {
            await (prisma as any).patient.update({
              where: { id: pat.id },
              data: {
                disease_code_id: dc.id,
                disease_code_registered_at: vStart,
                disease_code_expires_at: vEnd,
                copay_reduction: dc.code_type === 'SEVERE' ? 'SEVERE' : dc.code_type === 'RARE' ? 'RARE' : copay_reduction,
              },
            });
          }
        }
      }
    } catch (e: any) {
      result.errors.push(`처리 실패 (${chartNo} ${name}): ${e.message}`);
    }
  }

  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. 일일병실현황 처리 → ward_room_boards 덮어쓰기
// ════════════════════════════════════════════════════════════════════════════
export interface BoardResult {
  date: string;
  updated: number;
  errors: string[];
}

export async function processDailyBoardFile(buffer: Buffer): Promise<BoardResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);

  const result: BoardResult = { date: '', updated: 0, errors: [] };

  // 가장 최신 날짜 시트 찾기 (M.D 형식)
  const dateSheets = wb.worksheets
    .filter(s => /^\d{1,2}\.\d{1,2}$/.test(s.name))
    .map(s => {
      const [m, d] = s.name.split('.').map(Number);
      return { sheet: s, month: m, day: d };
    })
    .sort((a, b) => a.month !== b.month ? b.month - a.month : b.day - a.day);

  if (dateSheets.length === 0) {
    result.errors.push('날짜 시트를 찾을 수 없습니다.');
    return result;
  }

  const { sheet, month, day } = dateSheets[0];
  const year = new Date().getFullYear();
  const boardDate = new Date(year, month - 1, day, 12, 0, 0);
  result.date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  // 부서/병동 목록 로드
  const departments = await (prisma as any).department.findMany({ where: { is_active: true } });
  const deptByName = new Map<string, any>(departments.map((d: any) => [d.name, d]));

  // WardRoom 목록 로드
  const wardRooms = await (prisma as any).wardRoom.findMany({ where: { deleted_at: null } });
  const roomByDeptRoom = new Map<string, any>(
    wardRooms.map((wr: any) => [`${wr.department_id}:${wr.room_no}`, wr])
  );

  // 환자 이름 → patient 조회용
  const patients = await (prisma as any).patient.findMany({
    where: { status: 'ADMITTED', deleted_at: null },
    select: { id: true, name: true, chart_no: true },
  });
  const patientByName = new Map<string, any>();
  for (const p of patients) {
    if (!patientByName.has(p.name)) patientByName.set(p.name, p);
  }

  // 2행: 병동명 → 컬럼 범위 매핑
  const row2 = sheet.getRow(2);
  const colToDept = new Map<number, any>();
  let currentDeptName = '';
  for (let c = 1; c <= 100; c++) {
    const v = cellText(row2.getCell(c));
    if (v) currentDeptName = v.replace(/\(.*\)/, '').trim(); // "2병동(재활,밀착)" → "2병동"
    if (currentDeptName) {
      const dept = deptByName.get(currentDeptName);
      if (dept) colToDept.set(c, dept);
    }
  }

  // 3행: 컬럼 헤더 (병실/No/성명/비고/비고/환자군 반복)
  const row3 = sheet.getRow(3);
  interface ColGroup { dept: any; roomCol: number; noCol: number; nameCol: number; groupCol: number }
  const groups: ColGroup[] = [];

  for (let c = 1; c <= 100; c++) {
    const h = cellText(row3.getCell(c)).trim();
    if (h === '병실') {
      const dept = colToDept.get(c);
      if (dept) {
        groups.push({ dept, roomCol: c, noCol: c + 1, nameCol: c + 2, groupCol: c + 5 });
      }
    }
  }

  if (groups.length === 0) {
    result.errors.push('병실 컬럼을 찾을 수 없습니다.');
    return result;
  }

  // 기존 board_date 데이터 삭제
  await (prisma as any).wardRoomBoard.deleteMany({ where: { board_date: boardDate } });

  // 데이터 행 처리
  let currentRoom: Record<number, string> = {}; // groupIdx → roomNo (병실 셀이 병합되므로 마지막 값 유지)

  for (let r = 4; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    let hasAnyData = false;

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const roomVal = cellText(row.getCell(g.roomCol)).replace(/\n.*/, '').trim(); // "201\nF" → "201"
      const noVal = cellText(row.getCell(g.noCol)).trim();
      const nameVal = cellText(row.getCell(g.nameCol)).trim();
      const groupVal = cellText(row.getCell(g.groupCol)).trim();

      // 병실 업데이트 (merged cell이면 빈 값이 옴 → 마지막 값 유지)
      if (roomVal) currentRoom[gi] = roomVal;
      const roomNo = currentRoom[gi];
      if (!roomNo) continue;

      const bedNo = parseInt(noVal) || 0;
      if (bedNo === 0) continue;

      hasAnyData = true;

      // 빈 자리는 저장 안 함 (이름 없으면 skip)
      if (!nameVal) continue;

      const wardRoom = roomByDeptRoom.get(`${g.dept.id}:${roomNo}`);
      if (!wardRoom) continue;

      const patient = patientByName.get(nameVal);
      const patientGroup = parseGroup(groupVal);

      try {
        await (prisma as any).wardRoomBoard.create({
          data: {
            id: uuidv4(),
            board_date: boardDate,
            department_id: g.dept.id,
            ward_room_id: wardRoom.id,
            room_no: roomNo,
            bed_no: bedNo,
            patient_id: patient?.id ?? null,
            patient_name: nameVal,
            chart_no: patient?.chart_no ?? '',
            patient_no: patient?.chart_no ?? '',
            patient_group: patientGroup,
            status: 'ADMITTED',
          },
        });
        result.updated++;
      } catch (e: any) {
        result.errors.push(`병실현황 저장 실패 (${roomNo}-${bedNo} ${nameVal}): ${e.message}`);
      }
    }

    if (!hasAnyData) break;
  }

  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// 4. 환자현황(재활) 처리 → patients 재활정보 업데이트
// ════════════════════════════════════════════════════════════════════════════
export interface RehabResult {
  updated: number;
  errors: string[];
}

export async function processRehabFile(buffer: Buffer): Promise<RehabResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const sheet = wb.worksheets[0];
  const result: RehabResult = { updated: 0, errors: [] };

  // 헤더 행 찾기 (차트번호가 있는 행)
  let dataStart = 4;
  for (let r = 1; r <= 6; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= 20; c++) {
      if (cellText(row.getCell(c)).includes('차트번호')) { dataStart = r + 1; break; }
    }
  }

  // 헤더 위치 파악
  const hdrRow = sheet.getRow(dataStart - 1);
  let chartCol = 3, nameCol = 4, onsetCol = 7, rehabTypeCol = 12, groupCol = 15;
  for (let c = 1; c <= 20; c++) {
    const h = cellText(hdrRow.getCell(c)).trim();
    if (h === '차트번호') chartCol = c;
    else if (h === '이름') nameCol = c;
    else if (h === '발병일') onsetCol = c;
    else if (h === '유형') rehabTypeCol = c;
    else if (h === '수가') groupCol = c;
  }

  // CNS/OS 구분 찾기 (row 2)
  const row2 = sheet.getRow(2);
  const colToRehabType = new Map<number, string>();
  for (let c = 1; c <= 50; c++) {
    const v = cellText(row2.getCell(c)).trim();
    if (v === 'CNS') colToRehabType.set(c, 'CNS');
    else if (v === 'OS') colToRehabType.set(c, 'OS');
  }

  for (let r = dataStart; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const chartNoRaw = cellText(row.getCell(chartCol)).trim();
    if (!chartNoRaw) continue;
    const chartNo = String(chartNoRaw).replace(/\.0$/, ''); // 숫자로 읽힌 경우 소수점 제거

    const onsetDate = parseDate(row.getCell(onsetCol).value);
    const groupRaw = cellText(row.getCell(groupCol)).trim();
    const patient_group = parseGroup(groupRaw);

    // 재활 유형: 행이 속한 섹션의 CNS/OS 결정
    // 컬럼 위치로 찾거나 rehabTypeCol에서 직접 읽기
    const rehabRaw = cellText(row.getCell(rehabTypeCol)).trim();
    let rehabType = 'CNS';
    if (rehabRaw.includes('의급') || rehabRaw.includes('보험')) rehabType = rehabType; // 유형 컬럼은 보험유형
    // CNS/OS는 col2에서 찾은 섹션 구분 사용: chartCol 기준
    for (const [col, rt] of colToRehabType.entries()) {
      if (Math.abs(col - chartCol) <= 2) { rehabType = rt; break; }
    }

    try {
      const patient = await (prisma as any).patient.findFirst({
        where: { chart_no: chartNo, deleted_at: null },
      });
      if (!patient) continue;

      await (prisma as any).patient.update({
        where: { id: patient.id },
        data: {
          rehab_type: rehabType,
          ...(onsetDate ? { onset_date: onsetDate } : {}),
          ...(patient_group !== 'UNRATED' ? { patient_group } : {}),
          specializations: Array.from(new Set([...(patient.specializations ?? []), 'REHAB'])),
        },
      });
      result.updated++;
    } catch (e: any) {
      result.errors.push(`재활정보 업데이트 실패 (${chartNo}): ${e.message}`);
    }
  }

  return result;
}
