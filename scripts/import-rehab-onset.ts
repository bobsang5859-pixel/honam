// 일회성 스크립트 — 엑셀(환자현황 4.30)을 읽어 차트번호로 환자를 매칭하여
// rehab_type(CNS / OS) + onset_date 만 일괄 업데이트.
//
// 실행 (마이그레이션 적용 후):
//   npx ts-node scripts/import-rehab-onset.ts "C:/Users/총무구매/Documents/카카오톡 받은 파일/환자현황4.30.xlsx"
//
// 엑셀 구조 가정:
//   Sheet1, A=섹션헤더("CNS" / "CNS 외" / "외래"), B=차트번호, C=이름, D=병실, F=발병일

import { PrismaClient } from '@prisma/client';
import * as XLSX from 'xlsx';

const prisma = new PrismaClient();

interface ExcelRow {
  chart_no: string;
  name: string;
  onset_date: Date | null;
  rehab_type: 'CNS' | 'OS';
}

function parseExcelDate(value: any): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    // XLSX serial date → JS Date (UTC)
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function extractRows(data: any[][]): ExcelRow[] {
  const out: ExcelRow[] = [];
  let section: 'CNS' | 'OS' | 'OUTPATIENT' | null = null;
  for (const row of data) {
    if (!row) continue;
    const a = String(row[0] ?? '').trim();
    const b = String(row[1] ?? '').trim();
    const c = String(row[2] ?? '').trim();

    if (a === 'CNS') { section = 'CNS'; continue; }
    if (a === 'CNS 외') { section = 'OS'; continue; }
    if (a === '외래') { section = 'OUTPATIENT'; continue; }
    if (b === '차트번호') continue; // 헤더 행

    // 외래 섹션은 일단 건너뜀 (외래는 별도 흐름)
    if (section !== 'CNS' && section !== 'OS') continue;

    // 차트번호는 숫자(7자리) 형태로 들어 있음
    if (!/^\d{4,}$/.test(b)) continue;

    out.push({
      chart_no: b,
      name: c,
      onset_date: parseExcelDate(row[5]),  // F 컬럼 = 발병일
      rehab_type: section,
    });
  }
  return out;
}

async function main() {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error('사용: npx ts-node scripts/import-rehab-onset.ts <엑셀 경로>');
    process.exit(1);
  }

  console.log(`엑셀 읽는 중: ${xlsxPath}`);
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: '' });
  const rows = extractRows(data as any[][]);
  const cnsCnt = rows.filter(r => r.rehab_type === 'CNS').length;
  const osCnt  = rows.filter(r => r.rehab_type === 'OS').length;
  const withOnset = rows.filter(r => r.onset_date).length;
  console.log(`추출: ${rows.length}명 (CNS=${cnsCnt}, OS=${osCnt}, 발병일 입력=${withOnset})\n`);

  let updPatient = 0, updBoard = 0, notFound = 0, skipped = 0;
  const missing: string[] = [];

  for (const row of rows) {
    // DB 차트번호는 0 패딩된 8자리(`02202133`)일 수 있어 여러 변형으로 매칭
    const candidates = Array.from(new Set([
      row.chart_no,
      row.chart_no.padStart(8, '0'),
      row.chart_no.padStart(7, '0'),
    ]));
    let patient: any = null;
    for (const cand of candidates) {
      patient = await (prisma as any).patient.findFirst({
        where: { OR: [{ chart_no: cand }, { patient_no: cand }], deleted_at: null },
      });
      if (patient) break;
    }
    if (!patient) {
      missing.push(`${row.chart_no} ${row.name} (${row.rehab_type})`);
      notFound++;
      continue;
    }

    // 이미 동일 값이면 스킵
    const sameRehab = (patient.rehab_type ?? '') === row.rehab_type;
    const samOnset =
      (patient.onset_date ? new Date(patient.onset_date).toISOString().slice(0, 10) : null) ===
      (row.onset_date ? row.onset_date.toISOString().slice(0, 10) : null);
    if (sameRehab && samOnset) { skipped++; continue; }

    await (prisma as any).patient.update({
      where: { id: patient.id },
      data: { rehab_type: row.rehab_type, onset_date: row.onset_date },
    });
    updPatient++;

    // 병실현황판 보드도 동기화 (현재 입원 중이면 모든 board_date row 갱신)
    const r = await (prisma as any).wardRoomBoard.updateMany({
      where: { patient_id: patient.id, deleted_at: null },
      data: { rehab_type: row.rehab_type, onset_date: row.onset_date },
    });
    updBoard += r.count;
  }

  console.log(`\n=== 결과 ===`);
  console.log(`환자 업데이트: ${updPatient}명`);
  console.log(`병실보드 동기화: ${updBoard}건`);
  console.log(`이미 동일하여 스킵: ${skipped}명`);
  console.log(`매칭 실패 (DB에 차트번호 없음): ${notFound}명`);
  if (missing.length > 0) {
    console.log(`\n매칭 실패 목록:`);
    for (const m of missing) console.log(`  - ${m}`);
  }

  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
