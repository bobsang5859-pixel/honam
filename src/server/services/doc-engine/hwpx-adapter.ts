// HWPX(한글 개방형 XML) 템플릿 어댑터 — 한컴오피스 COM 자동화 없이, zip 컨테이너 안의
// section0.xml 을 직접 파싱/치환/재압축한다.
//
// 자리표시자 규칙(템플릿 제작자가 한글에서 미리 심어둠):
//   - 값 치환: {{필드키}}
//   - 섹션(조건부 문단): 시작 마커 `[SECTION:키]` 와 종료 마커 `[/SECTION]` 을 각각
//     "그 문단에 그 텍스트만" 있는 상태로 넣는다. 보이는 섹션은 마커 문단만 제거되고
//     안의 내용은 남고, 숨김 섹션은 마커 포함 그 사이 문단이 통째로 제거된다.
//   - 반복 표: 템플릿에 rows_reserved 개만큼 행을 미리 만들어두고, 각 행의 셀에
//     `{{표키.행번호.컬럼키}}` (예: {{items.1.name}}, {{items.1.qty}}) 형태로 자리표시자를 심는다.
//     실제 데이터 행이 rows_reserved 보다 적으면 남는 행은 빈 문자열로 채워진다.
//     (표 구조 자체를 XML 로 복제/삽입하지 않음 — 필드 치환과 동일한 안전한 경로만 사용)
//
// 실제 파일 검증 결과: 사람 눈엔 붙어 보이는 텍스트가 항상 한 <hp:t> 안에 있는 건 아닐 수
// 있어(오피스 XML 공통 이슈), 문단(<hp:p>) 단위로 텍스트를 재구성해서 패턴을 찾고,
// 매치된 자리표시자는 첫 run 에 몰아 쓰고 나머지 run 은 비우는 방식으로 안전하게 치환한다.

import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Document as XDocument, Element as XElement } from '@xmldom/xmldom';
import fs from 'fs/promises';
import type { TableRowsSpec } from './types';

const SECTION_XML_PATH = 'Contents/section0.xml';
const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;
const SECTION_START_RE = /^\[SECTION:([^\]]+)\]$/;
const SECTION_END_RE = /^\[\/SECTION\]$/;

export interface HwpxTableBinding {
  rows_reserved: number;
  columns: string[]; // 컬럼 키 목록 (예: ['name','qty','unit_price','amount'])
}

interface RunInfo {
  runEl: XElement;
  textEl: XElement | null;
  text: string;
}

interface ParagraphInfo {
  pEl: XElement;
  runs: RunInfo[];
  fullText: string;
}

function localName(el: XElement): string {
  return el.localName ?? el.nodeName.split(':').pop() ?? '';
}

function collectParagraphs(doc: XDocument): ParagraphInfo[] {
  const result: ParagraphInfo[] = [];
  const allP = doc.getElementsByTagName('hp:p');
  for (let i = 0; i < allP.length; i++) {
    const pEl = allP.item(i) as unknown as XElement;
    const runs: RunInfo[] = [];
    for (let j = 0; j < pEl.childNodes.length; j++) {
      const child = pEl.childNodes.item(j) as unknown as XElement;
      if (!child || child.nodeType !== 1) continue;
      if (localName(child) !== 'run') continue;
      let textEl: XElement | null = null;
      for (let k = 0; k < child.childNodes.length; k++) {
        const grandchild = child.childNodes.item(k) as unknown as XElement;
        if (grandchild && grandchild.nodeType === 1 && localName(grandchild) === 't') {
          textEl = grandchild;
          break;
        }
      }
      const text = textEl?.textContent ?? '';
      runs.push({ runEl: child, textEl, text });
    }
    result.push({ pEl, runs, fullText: runs.map((r) => r.text).join('') });
  }
  return result;
}

// 문단의 전체 텍스트를 newText 로 바꿔치기 — 첫 run 에 몰아 쓰고 나머지는 비움
// (여러 run 에 걸쳐 있던 서식이 첫 run 서식으로 통일되는 트레이드오프가 있음)
//
// 실제 기안서.hwpx로 검증하다 발견한 버그: 문단의 <hp:linesegarray>(캐시된 줄바꿈/폭 계산값)를
// 안 지우면, 텍스트 길이가 원래보다 많이 짧아지거나 길어질 때 한글이 그 캐시값과 실제 텍스트가
// 안 맞는다고 보고 파일을 아예 못 엽니다(Open() 이 조용히 false 반환). 그래서 텍스트를 바꾼
// 문단은 linesegarray 를 지워서 한글이 열 때 다시 계산하게 해야 합니다.
function setParagraphText(para: ParagraphInfo, newText: string, doc: XDocument): void {
  if (para.runs.length === 0) return;
  const [first, ...rest] = para.runs;
  if (first.textEl) {
    first.textEl.textContent = newText;
  } else if (newText) {
    const tEl = doc.createElement('hp:t');
    tEl.textContent = newText;
    first.runEl.appendChild(tEl);
  }
  for (const r of rest) {
    if (r.textEl) r.textEl.textContent = '';
  }

  for (let i = 0; i < para.pEl.childNodes.length; i++) {
    const child = para.pEl.childNodes.item(i) as unknown as XElement;
    if (child && child.nodeType === 1 && localName(child) === 'linesegarray') {
      para.pEl.removeChild(child);
      break;
    }
  }
}

async function loadSection0(filePath: string): Promise<{ zip: JSZip; doc: XDocument; rawXml: string }> {
  const buf = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file(SECTION_XML_PATH);
  if (!entry) throw new Error(`HWPX 안에서 ${SECTION_XML_PATH} 를 찾을 수 없습니다.`);
  const rawXml = await entry.async('string');
  const doc = new DOMParser().parseFromString(rawXml, 'text/xml');
  return { zip, doc, rawXml };
}

export interface DetectedHwpx {
  placeholders: string[];
  sections: string[];
}

export async function detectHwpxPlaceholders(filePath: string): Promise<DetectedHwpx> {
  const { doc } = await loadSection0(filePath);
  const paragraphs = collectParagraphs(doc);
  const placeholders = new Set<string>();
  const sections = new Set<string>();

  for (const para of paragraphs) {
    const trimmed = para.fullText.trim();
    const startMatch = trimmed.match(SECTION_START_RE);
    if (startMatch) sections.add(startMatch[1]);

    let m: RegExpExecArray | null;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(para.fullText))) {
      placeholders.add(m[1].trim());
    }
  }

  return { placeholders: [...placeholders], sections: [...sections] };
}

export interface FillHwpxParams {
  masterFilePath: string;
  outputFilePath: string;
  fieldValues: Record<string, string>;
  tableRows: TableRowsSpec[];
  tableBindings: Record<string, HwpxTableBinding>;
  visibleSections: string[];
  hiddenSections: string[];
}

export async function fillHwpxTemplate(params: FillHwpxParams): Promise<void> {
  const { masterFilePath, outputFilePath, fieldValues, tableRows, tableBindings, hiddenSections } = params;
  const { zip, doc } = await loadSection0(masterFilePath);

  // 표 반복 행 → {{표키.행번호.컬럼키}} 형태의 합성 필드값으로 확장 (필드 치환과 동일 경로로 처리)
  const expandedValues: Record<string, string> = { ...fieldValues };
  for (const spec of tableRows) {
    const binding = tableBindings[spec.table_key];
    if (!binding) throw new Error(`표 바인딩을 찾을 수 없습니다: ${spec.table_key}`);
    if (spec.rows.length > binding.rows_reserved) {
      throw new Error(
        `"${spec.table_key}" 표에 담을 수 있는 최대 행수(${binding.rows_reserved})를 초과했습니다(${spec.rows.length}행).`,
      );
    }
    for (let i = 0; i < binding.rows_reserved; i++) {
      const rowData = spec.rows[i];
      for (const col of binding.columns) {
        expandedValues[`${spec.table_key}.${i + 1}.${col}`] = rowData ? (rowData[col] ?? '') : '';
      }
    }
  }

  // ── 1. 자리표시자 치환 (문단 단위로 재구성한 텍스트에서 찾아 대응 run 에 되돌려 씀) ──
  const paragraphs = collectParagraphs(doc);
  for (const para of paragraphs) {
    if (!para.fullText.includes('{{')) continue;
    const newText = para.fullText.replace(PLACEHOLDER_RE, (whole, rawKey) => {
      const key = String(rawKey).trim();
      return Object.prototype.hasOwnProperty.call(expandedValues, key) ? expandedValues[key] : whole;
    });
    if (newText !== para.fullText) setParagraphText(para, newText, doc);
  }

  // ── 2. 섹션 마커 처리 — 매 호출 시 paragraphs 를 다시 모아서 최신 트리 기준으로 탐색 ──
  const hiddenSet = new Set(hiddenSections);
  let scan = collectParagraphs(doc);
  while (true) {
    const startIdx = scan.findIndex((p) => SECTION_START_RE.test(p.fullText.trim()));
    if (startIdx === -1) break;
    const key = (scan[startIdx].fullText.trim().match(SECTION_START_RE) as RegExpMatchArray)[1];
    const endIdx = scan.findIndex((p, i) => i > startIdx && SECTION_END_RE.test(p.fullText.trim()));
    if (endIdx === -1) {
      // 종료 마커가 없으면 시작 마커만 제거하고 중단(형식 오류 — 조용히 무시)
      scan[startIdx].pEl.parentNode?.removeChild(scan[startIdx].pEl);
      scan = collectParagraphs(doc);
      continue;
    }
    const hide = hiddenSet.has(key);
    if (hide) {
      // 숨김 — 마커 포함 그 사이 문단을 통째로 제거
      for (let i = endIdx; i >= startIdx; i--) {
        scan[i].pEl.parentNode?.removeChild(scan[i].pEl);
      }
    } else {
      // 표시 — 마커 문단(시작/끝)만 제거하고 내용은 유지
      scan[endIdx].pEl.parentNode?.removeChild(scan[endIdx].pEl);
      scan[startIdx].pEl.parentNode?.removeChild(scan[startIdx].pEl);
    }
    scan = collectParagraphs(doc);
  }

  const newXml = new XMLSerializer().serializeToString(doc);
  zip.file(SECTION_XML_PATH, newXml);
  const outBuf = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(outputFilePath, outBuf);
}
