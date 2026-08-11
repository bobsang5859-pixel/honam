import { mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { detectHwpxPlaceholders, fillHwpxTemplate } from './hwpx-adapter';

const SECTION_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hp:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
  <hp:p id="1" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0"><hp:t>{{</hp:t></hp:run>
    <hp:run charPrIDRef="0"><hp:t>이름}}</hp:t></hp:run>
  </hp:p>
  <hp:p id="2" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0"><hp:t>[SECTION:계약조항]</hp:t></hp:run>
  </hp:p>
  <hp:p id="3" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0"><hp:t>계약 조항 본문입니다.</hp:t></hp:run>
  </hp:p>
  <hp:p id="4" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0"><hp:t>[/SECTION]</hp:t></hp:run>
  </hp:p>
  <hp:p id="5" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0"><hp:t>{{items.1.name}} / {{items.1.qty}}</hp:t></hp:run>
  </hp:p>
  <hp:p id="6" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0"><hp:t>{{본문}}</hp:t></hp:run>
    <hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1100" textheight="1100" baseline="550" spacing="0" horzpos="0" horzsize="14428" flags="393216"/></hp:linesegarray>
  </hp:p>
</hp:sec>`;

async function buildFixtureHwpx(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'hwpx-fixture-'));
  const filePath = path.join(dir, 'fixture.hwpx');
  const zip = new JSZip();
  zip.file('mimetype', 'application/hwp+zip');
  zip.file('Contents/section0.xml', SECTION_XML);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(filePath, buf);
  return filePath;
}

describe('hwpx-adapter', () => {
  it('문단 경계에 걸친 {{자리표시자}} 와 [SECTION] 마커, 표 자리표시자를 탐지한다', async () => {
    const fixture = await buildFixtureHwpx();
    const detected = await detectHwpxPlaceholders(fixture);
    expect(detected.placeholders.sort()).toEqual(['items.1.name', 'items.1.qty', '이름', '본문'].sort());
    expect(detected.sections).toEqual(['계약조항']);
  });

  it('run 경계에 걸친 자리표시자를 정확히 치환한다', async () => {
    const fixture = await buildFixtureHwpx();
    const outDir = mkdtempSync(path.join(tmpdir(), 'hwpx-out-'));
    const outPath = path.join(outDir, 'out.hwpx');

    await fillHwpxTemplate({
      masterFilePath: fixture,
      outputFilePath: outPath,
      fieldValues: { 이름: '홍길동' },
      tableRows: [{ table_key: 'items', rows: [{ name: '품목A', qty: '5' }] }],
      tableBindings: { items: { rows_reserved: 1, columns: ['name', 'qty'] } },
      visibleSections: ['계약조항'],
      hiddenSections: [],
    });

    const zip = await JSZip.loadAsync(await fs.readFile(outPath));
    const xml = await zip.file('Contents/section0.xml')!.async('string');
    expect(xml).toContain('홍길동');
    expect(xml).toContain('품목A');
    expect(xml).toContain('5');
    expect(xml).toContain('계약 조항 본문입니다.'); // 보이는 섹션 — 내용 유지
    expect(xml).not.toContain('[SECTION:계약조항]'); // 마커 자체는 제거
    expect(xml).not.toContain('[/SECTION]');
  });

  it('숨김 섹션은 마커와 내용이 통째로 제거된다', async () => {
    const fixture = await buildFixtureHwpx();
    const outDir = mkdtempSync(path.join(tmpdir(), 'hwpx-out-'));
    const outPath = path.join(outDir, 'out.hwpx');

    await fillHwpxTemplate({
      masterFilePath: fixture,
      outputFilePath: outPath,
      fieldValues: { 이름: '홍길동' },
      tableRows: [],
      tableBindings: {},
      visibleSections: [],
      hiddenSections: ['계약조항'],
    });

    const zip = await JSZip.loadAsync(await fs.readFile(outPath));
    const xml = await zip.file('Contents/section0.xml')!.async('string');
    expect(xml).not.toContain('계약 조항 본문입니다.');
    expect(xml).not.toContain('[SECTION:계약조항]');
  });

  it('rows_reserved 를 초과하는 표 데이터는 에러를 던진다', async () => {
    const fixture = await buildFixtureHwpx();
    const outDir = mkdtempSync(path.join(tmpdir(), 'hwpx-out-'));
    const outPath = path.join(outDir, 'out.hwpx');

    await expect(
      fillHwpxTemplate({
        masterFilePath: fixture,
        outputFilePath: outPath,
        fieldValues: {},
        tableRows: [{ table_key: 'items', rows: [{ name: 'a', qty: '1' }, { name: 'b', qty: '2' }] }],
        tableBindings: { items: { rows_reserved: 1, columns: ['name', 'qty'] } },
        visibleSections: [],
        hiddenSections: [],
      }),
    ).rejects.toThrow(/최대 행수/);
  });

  // 실제 기안서.hwpx로 검증하다 발견한 버그의 회귀 테스트: 문단 텍스트 길이가 원래보다
  // 많이 짧아지거나 길어지면, 그 문단에 남아있는 캐시된 <hp:linesegarray>(줄바꿈/폭 계산값)와
  // 실제 텍스트가 안 맞아서 한글이 파일을 아예 못 여는 문제가 있었다(Open() 이 조용히 false).
  // 텍스트를 바꾼 문단은 linesegarray 를 지워서 한글이 다시 계산하게 해야 한다.
  it('텍스트를 바꾼 문단의 캐시된 linesegarray 를 제거한다 (안 지우면 한글이 파일을 못 여는 버그 회귀 방지)', async () => {
    const fixture = await buildFixtureHwpx();
    const outDir = mkdtempSync(path.join(tmpdir(), 'hwpx-out-'));
    const outPath = path.join(outDir, 'out.hwpx');

    await fillHwpxTemplate({
      masterFilePath: fixture,
      outputFilePath: outPath,
      fieldValues: { 본문: '원래보다 훨씬 길거나 짧은 대체 텍스트로 교체된 본문입니다.' },
      tableRows: [],
      tableBindings: {},
      visibleSections: [],
      hiddenSections: [],
    });

    const zip = await JSZip.loadAsync(await fs.readFile(outPath));
    const xml = await zip.file('Contents/section0.xml')!.async('string');
    expect(xml).toContain('원래보다 훨씬 길거나 짧은 대체 텍스트로 교체된 본문입니다.');
    expect(xml).not.toContain('linesegarray'); // 텍스트가 바뀐 문단의 캐시값은 제거되어야 함
  });
});
