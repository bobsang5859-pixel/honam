import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillExcelTemplate, readExcelGrid } from './excel-adapter';

const TEMPLATE_PATH = path.resolve(__dirname, '..', '..', '..', '..', '구매결의서양식', '구매결의서 양식.xlsx');

describe.skipIf(!existsSync(TEMPLATE_PATH))('excel-adapter — 실제 구매결의서 양식.xlsx', () => {
  it('시트를 그리드로 읽을 수 있다', async () => {
    const grid = await readExcelGrid(TEMPLATE_PATH);
    expect(grid.sheets.length).toBeGreaterThan(0);
    expect(grid.sheets[0].rows.length).toBeGreaterThan(0);
  });

  it('필드/표 바인딩으로 값을 채워 저장할 수 있다', async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'doc-engine-test-'));
    const outPath = path.join(outDir, 'out.xlsx');

    await fillExcelTemplate({
      masterFilePath: TEMPLATE_PATH,
      outputFilePath: outPath,
      fieldValues: { vendor_name: '테스트업체 구매 결의서' },
      fieldBindings: { vendor_name: { sheet_index: 1, cell: 'A1' } },
      tableRows: [
        { table_key: 'items', rows: [{ name: '테스트품목', qty: '10' }] },
      ],
      tableBindings: {
        items: { sheet_index: 1, start_row: 10, rows_reserved: 3, columns: { name: 'B', qty: 'D' } },
      },
    });

    expect(existsSync(outPath)).toBe(true);
    const check = await readExcelGrid(outPath);
    const sheet2 = check.sheets[1];
    expect(sheet2.rows[0][0].value).toBe('테스트업체 구매 결의서');
    expect(sheet2.rows[9][1].value).toBe('테스트품목'); // row10 = index9, col B = index1
  });
});
