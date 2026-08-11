// 엑셀 템플릿 어댑터 — 회사양식 .xlsx 파일을 열어서 "셀 주소 ↔ 필드" 매핑에 따라
// 값만 채워 넣고 원본 파일 그대로 저장한다. 구조(행 삽입/삭제) 는 건드리지 않는다 —
// 표 반복 영역은 템플릿에 미리 마련된 빈 슬롯(rows_reserved)을 순서대로 채우는 방식으로,
// 기존 `/api/purchase-decisions/:id/excel` 처럼 매 문서 종류마다 좌표를 하드코딩하지 않고
// 관리자가 등록한 매핑(field_schema_json/table_binding_json)만으로 동작한다.

import ExcelJS from 'exceljs';
import type { TableRowsSpec } from './types';

export interface ExcelFieldBinding {
  sheet_index: number;
  cell: string;              // 예: "B5"
}

export interface ExcelTableBinding {
  sheet_index: number;
  start_row: number;         // 첫 반복 행(템플릿 스타일 원본이자 첫 슬롯)
  rows_reserved: number;     // 템플릿에 미리 마련된 슬롯 수 — 이 이상은 채우지 않고 에러
  columns: Record<string, string>; // 데이터 행의 키 -> 열 문자 (예: { name: 'B', qty: 'D' })
}

export interface ExcelGridCell {
  address: string;
  value: string;
  bold: boolean;
  align: string | null;
  rowSpan: number;
  colSpan: number;
  isMergedAway: boolean;
}

export interface ExcelGridSheet {
  name: string;
  rowCount: number;
  colCount: number;
  rows: ExcelGridCell[][];
}

export interface ExcelGrid {
  sheets: ExcelGridSheet[];
}

function parseMerges(worksheet: ExcelJS.Worksheet): Map<string, { rowSpan: number; colSpan: number; isAnchor: boolean }> {
  const map = new Map<string, { rowSpan: number; colSpan: number; isAnchor: boolean }>();
  const merges: string[] = ((worksheet as unknown as { model?: { merges?: string[] } }).model?.merges) ?? [];
  for (const range of merges) {
    const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!m) continue;
    const [, c1, r1s, c2, r2s] = m;
    const r1 = parseInt(r1s, 10);
    const r2 = parseInt(r2s, 10);
    const colToNum = (col: string) => col.split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
    const cn1 = colToNum(c1);
    const cn2 = colToNum(c2);
    for (let r = r1; r <= r2; r++) {
      for (let c = cn1; c <= cn2; c++) {
        const isAnchor = r === r1 && c === cn1;
        map.set(`${r}:${c}`, { rowSpan: r2 - r1 + 1, colSpan: cn2 - cn1 + 1, isAnchor });
      }
    }
  }
  return map;
}

export async function readExcelGrid(filePath: string, maxRows = 120, maxCols = 26): Promise<ExcelGrid> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheets: ExcelGridSheet[] = [];

  for (const worksheet of wb.worksheets) {
    const merges = parseMerges(worksheet);
    const rowCount = Math.min(worksheet.rowCount || 0, maxRows);
    const colCount = Math.min(worksheet.columnCount || 0, maxCols);
    const rows: ExcelGridCell[][] = [];

    for (let r = 1; r <= rowCount; r++) {
      const rowCells: ExcelGridCell[] = [];
      for (let c = 1; c <= colCount; c++) {
        const cell = worksheet.getCell(r, c);
        const mergeInfo = merges.get(`${r}:${c}`);
        const isMergedAway = Boolean(mergeInfo && !mergeInfo.isAnchor);
        rowCells.push({
          address: cell.address,
          value: cell.value === null || cell.value === undefined ? '' : String(cell.text ?? cell.value),
          bold: Boolean(cell.font?.bold),
          align: (cell.alignment?.horizontal as string) ?? null,
          rowSpan: mergeInfo?.isAnchor ? mergeInfo.rowSpan : 1,
          colSpan: mergeInfo?.isAnchor ? mergeInfo.colSpan : 1,
          isMergedAway,
        });
      }
      rows.push(rowCells);
    }

    sheets.push({ name: worksheet.name, rowCount, colCount, rows });
  }

  return { sheets };
}

export interface FillExcelParams {
  masterFilePath: string;
  outputFilePath: string;
  fieldValues: Record<string, string>;
  fieldBindings: Record<string, ExcelFieldBinding>;
  tableRows: TableRowsSpec[];
  tableBindings: Record<string, ExcelTableBinding>;
}

export async function fillExcelTemplate(params: FillExcelParams): Promise<void> {
  const { masterFilePath, outputFilePath, fieldValues, fieldBindings, tableRows, tableBindings } = params;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(masterFilePath);

  for (const [fieldKey, binding] of Object.entries(fieldBindings)) {
    const value = fieldValues[fieldKey];
    if (value === undefined) continue;
    const sheet = wb.worksheets[binding.sheet_index];
    if (!sheet) throw new Error(`엑셀 시트 인덱스가 템플릿 범위를 벗어났습니다: ${binding.sheet_index}`);
    sheet.getCell(binding.cell).value = value;
  }

  for (const spec of tableRows) {
    const binding = tableBindings[spec.table_key];
    if (!binding) throw new Error(`표 바인딩을 찾을 수 없습니다: ${spec.table_key}`);
    if (spec.rows.length > binding.rows_reserved) {
      throw new Error(
        `"${spec.table_key}" 표에 담을 수 있는 최대 행수(${binding.rows_reserved})를 초과했습니다(${spec.rows.length}행).`,
      );
    }
    const sheet = wb.worksheets[binding.sheet_index];
    if (!sheet) throw new Error(`엑셀 시트 인덱스가 템플릿 범위를 벗어났습니다: ${binding.sheet_index}`);

    for (let i = 0; i < binding.rows_reserved; i++) {
      const rowNum = binding.start_row + i;
      const rowData = spec.rows[i];
      for (const [colKey, colLetter] of Object.entries(binding.columns)) {
        sheet.getCell(`${colLetter}${rowNum}`).value = rowData ? (rowData[colKey] ?? '') : '';
      }
    }
  }

  await wb.xlsx.writeFile(outputFilePath);
}
