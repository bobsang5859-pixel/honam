import { existsSync, mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { detectHwpxPlaceholders, fillHwpxTemplate } from './hwpx-adapter';

// 실제 기안서.hwpx(연간 누적철) 구조를 그대로 사용해, 그 안의 실제 텍스트 하나를
// {{자리표시자}}로 바꿔치기한 "합성 템플릿"을 만들어 검증한다 — 실제 파일의
// 네임스페이스/스타일 참조 구조를 그대로 쓰면서도 치환 대상은 우리가 통제할 수 있다.
const REAL_FILE = path.resolve(__dirname, '..', '..', '..', '..', '구매결의서양식', '2026년 기안서.hwpx');

describe.skipIf(!existsSync(REAL_FILE))('hwpx-adapter — 실제 2026년 기안서.hwpx 구조 검증', () => {
  it('실제 문서의 텍스트 자리표시자를 정확히 탐지·치환한다', async () => {
    const buf = await fs.readFile(REAL_FILE);
    const zip = await JSZip.loadAsync(buf);
    let xml = await zip.file('Contents/section0.xml')!.async('string');
    expect(xml).toContain('<hp:t>총무부</hp:t>');

    xml = xml.replace('<hp:t>총무부</hp:t>', '<hp:t>{{기안부서}}</hp:t>');
    const dir = mkdtempSync(path.join(tmpdir(), 'hwpx-real-'));
    const tplPath = path.join(dir, 'gian-with-placeholder.hwpx');
    zip.file('Contents/section0.xml', xml);
    await fs.writeFile(tplPath, await zip.generateAsync({ type: 'nodebuffer' }));

    const detected = await detectHwpxPlaceholders(tplPath);
    expect(detected.placeholders).toContain('기안부서');

    const outPath = path.join(dir, 'gian-filled.hwpx');
    await fillHwpxTemplate({
      masterFilePath: tplPath,
      outputFilePath: outPath,
      fieldValues: { 기안부서: '테스트부서' },
      tableRows: [],
      tableBindings: {},
      visibleSections: [],
      hiddenSections: [],
    });

    const outZip = await JSZip.loadAsync(await fs.readFile(outPath));
    const outXml = await outZip.file('Contents/section0.xml')!.async('string');
    expect(outXml).toContain('테스트부서');
    expect(outXml).not.toContain('{{기안부서}}');
  });

  it('원본 파일을 무변경 라운드트립(파싱→재직렬화)해도 zip 구조가 유효하다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hwpx-real-rt-'));
    const outPath = path.join(dir, 'roundtrip.hwpx');
    await fillHwpxTemplate({
      masterFilePath: REAL_FILE,
      outputFilePath: outPath,
      fieldValues: {},
      tableRows: [],
      tableBindings: {},
      visibleSections: [],
      hiddenSections: [],
    });
    const outZip = await JSZip.loadAsync(await fs.readFile(outPath));
    expect(outZip.file('mimetype')).not.toBeNull();
    expect(outZip.file('Contents/section0.xml')).not.toBeNull();
    const xml = await outZip.file('Contents/section0.xml')!.async('string');
    expect(xml).toContain('총무부'); // 내용 보존 확인
  });
});
