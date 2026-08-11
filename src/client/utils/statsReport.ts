import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, HeadingLevel,
  PageBreak, ShadingType,
} from 'docx';
import { saveAs } from 'file-saver';

/* ── 공통 헬퍼 ── */

const fmt = (v: number) => v.toLocaleString();
const pct = (v: number | null | undefined) => v != null ? `${v}%` : '-';
const won = (v: number) => `₩${fmt(v)}`;
const diffText = (v: number | null | undefined) => {
  if (v == null) return '';
  return v > 0 ? `(+${v}%, 전기 대비 증가)` : v < 0 ? `(${v}%, 전기 대비 감소)` : '(전기 대비 변동 없음)';
};

const BORDER_NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const BORDER_THIN = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const BORDERS_ALL = { top: BORDER_THIN, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN };

function heading(text: string, level: typeof HeadingLevel[keyof typeof HeadingLevel] = HeadingLevel.HEADING_2) {
  return new Paragraph({ heading: level, spacing: { before: 240, after: 120 }, children: [new TextRun({ text, bold: true, font: 'Malgun Gothic' })] });
}

function body(text: string, opts?: { bold?: boolean; spacing?: number }) {
  return new Paragraph({
    spacing: { after: opts?.spacing ?? 80 },
    children: [new TextRun({ text, font: 'Malgun Gothic', size: 20, bold: opts?.bold })],
  });
}

function bullet(text: string) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 40 },
    children: [new TextRun({ text, font: 'Malgun Gothic', size: 20 })],
  });
}

function tableRow(cells: string[], header = false) {
  return new TableRow({
    children: cells.map(text => new TableCell({
      width: { size: Math.floor(9000 / cells.length), type: WidthType.DXA },
      borders: BORDERS_ALL,
      shading: header ? { type: ShadingType.SOLID, color: 'F1F5F9', fill: 'F1F5F9' } : undefined,
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 40, after: 40 },
        children: [new TextRun({ text, font: 'Malgun Gothic', size: 18, bold: header })],
      })],
    })),
  });
}

function simpleTable(headers: string[], rows: string[][]) {
  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: [tableRow(headers, true), ...rows.map(r => tableRow(r))],
  });
}

/* ── 라벨 맵 ── */

const patientGroupLabel: Record<string, string> = { HIGHEST: '최고도', HIGH: '고도', MEDIUM: '중도', LOW: '경도', SELECT: '선택', UNRATED: '미평가', INFECTION: '감염', PNEUMONIA: '폐렴', SEPSIS: '패혈증' };
const insuranceLabel: Record<string, string> = { HEALTH: '건강보험', MEDICAL_1: '의료급여1종', MEDICAL_2: '의료급여2종', WORKERS_COMP: '산재보험', AUTO_INS: '자동차보험' };
const caregiverLabel: Record<string, string> = { CLOSE: '밀착간병', OUTSOURCED: '외주간병', IN_HOUSE: '본원간병', NONE: '없음' };
const diaperLabel: Record<string, string> = { IN_HOUSE: '원내', PERSONAL: '본인', NONE: '미사용', CIRCLE: '원내', TRIANGLE: '본인' };
const specLabel: Record<string, string> = { INFECT: '감염', DIALYSIS: '투석', REHAB: '재활' };

function breakdownRows(data: Record<string, number>, labelMap: Record<string, string>) {
  const entries = Object.entries(data || {}).map(([k, v]) => [labelMap[k] ?? k, String(v)]).sort((a, b) => Number(b[1]) - Number(a[1]));
  const total = entries.reduce((s, e) => s + Number(e[1]), 0);
  return entries.map(([name, count]) => [name, count, total > 0 ? `${((Number(count) / total) * 100).toFixed(1)}%` : '-']);
}

/* ══════════════════════════════════════════════
   물품 통계 보고서
   ══════════════════════════════════════════════ */

export async function generateSupplyReport(cost: any, period: { year: number; month: number }) {
  const totalIssued = cost?.total_issued ?? 0;
  const totalPurchased = cost?.total_purchased ?? 0;
  const patientCount = cost?.patient_count ?? 0;
  const perPatient = patientCount > 0 ? Math.round(totalIssued / patientCount) : 0;
  const byDept = cost?.by_department ?? [];
  const byItem = cost?.by_item ?? [];
  const byVendor = cost?.by_vendor ?? [];
  const deptTotal = byDept.reduce((s: number, d: any) => s + (d.amount || 0), 0);
  const vendorTotal = byVendor.reduce((s: number, v: any) => s + (v.amount || 0), 0);

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1200, right: 1200 } } },
      children: [
        // 제목
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 80 },
          children: [new TextRun({ text: `${period.year}년 ${period.month}월 물품 통계 보고서`, font: 'Malgun Gothic', size: 32, bold: true })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 300 },
          children: [new TextRun({ text: `출력일: ${new Date().toLocaleDateString('ko-KR')}`, font: 'Malgun Gothic', size: 18, color: '888888' })],
        }),

        // 1. 핵심 지표 요약
        heading('1. 핵심 지표 요약'),
        body(`${period.year}년 ${period.month}월 기준, 총 불출금액은 ${won(totalIssued)}이며, 구매금액은 ${won(totalPurchased)}입니다. 해당 기간 입원 환자 수는 ${fmt(patientCount)}명으로, 환자 1인당 재료비는 ${perPatient > 0 ? won(perPatient) : '산출 불가'}입니다.`),
        simpleTable(
          ['지표', '금액/수치'],
          [
            ['월 불출금액', won(totalIssued)],
            ['월 구매금액', won(totalPurchased)],
            ['환자 수', `${fmt(patientCount)}명`],
            ['1인당 재료비', perPatient > 0 ? won(perPatient) : '-'],
          ],
        ),

        // 2. 부서별 불출 현황
        heading('2. 부서별 불출 현황'),
        body(`총 ${byDept.length}개 부서에서 물품이 불출되었으며, 전체 불출금액 대비 각 부서의 비중은 아래와 같습니다.`),
        ...(byDept.length > 0 ? [
          simpleTable(
            ['부서', '불출금액', '비중'],
            byDept.slice(0, 10).map((d: any) => [
              d.dept_name || d.department_name || '-',
              won(d.amount || 0),
              deptTotal > 0 ? `${(((d.amount || 0) / deptTotal) * 100).toFixed(1)}%` : '-',
            ]),
          ),
        ] : [body('해당 기간 불출 데이터가 없습니다.')]),

        // 3. 상위 품목 현황
        heading('3. 상위 품목 현황 (불출금액 기준)'),
        body(`불출금액 기준 상위 ${Math.min(byItem.length, 10)}개 품목입니다. 상위 품목의 비용 변동을 주기적으로 모니터링하여 원가 관리에 활용할 수 있습니다.`),
        ...(byItem.length > 0 ? [
          simpleTable(
            ['순위', '품목명', '불출금액'],
            byItem.slice(0, 10).map((d: any, i: number) => [
              String(i + 1),
              d.item_name || '-',
              won(d.amount || 0),
            ]),
          ),
        ] : [body('해당 기간 품목 데이터가 없습니다.')]),

        // 4. 거래처별 구매 현황
        heading('4. 거래처별 구매 현황'),
        body(`총 ${byVendor.length}개 거래처와 거래가 발생하였습니다. 거래 집중도를 파악하여 가격 협상력 확보 및 공급 리스크 분산에 참고할 수 있습니다.`),
        ...(byVendor.length > 0 ? [
          simpleTable(
            ['거래처', '구매금액', '비중'],
            byVendor.slice(0, 10).map((v: any) => [
              v.vendor_name || '-',
              won(v.amount || 0),
              vendorTotal > 0 ? `${(((v.amount || 0) / vendorTotal) * 100).toFixed(1)}%` : '-',
            ]),
          ),
        ] : [body('해당 기간 거래처 데이터가 없습니다.')]),

        // 5. 종합 의견
        heading('5. 종합 의견'),
        body(`${period.month}월 물품 운영 현황을 종합하면, 총 불출금액 ${won(totalIssued)} 중 상위 3개 부서가 전체의 상당 부분을 차지하고 있어 해당 부서 중심의 비용 관리가 필요합니다. 환자 1인당 재료비(${perPatient > 0 ? won(perPatient) : '-'})는 전월 대비 모니터링이 필요하며, 거래처 다변화를 통한 단가 절감 방안을 검토할 것을 권고합니다.`),
      ],
    }],
  });

  const blob = await Packer.toBlob(doc);
  saveAs(blob, `물품통계보고서_${period.year}년${period.month}월.docx`);
}

/* ══════════════════════════════════════════════
   환자 통계 보고서
   ══════════════════════════════════════════════ */

export async function generatePatientReport(stats: any, finance: any, dateRange: { from: string; to: string }) {
  if (!stats) return;

  const overall = stats.overall || {};
  const comp = stats.comparison || {};
  const occ = stats.occupancy || {};
  const bd = stats.breakdown || {};
  const diaper = stats.diaper_analysis || {};
  const charges = stats.charges || {};
  const depts = stats.departments || [];

  const coveredTotal = Object.values(charges.covered || {}).reduce((s: number, v: any) => s + (v.total || 0), 0);
  const ncTotal = Object.values(charges.non_covered || {}).reduce((s: number, v: any) => s + (v.total || 0), 0);
  const chargeTotal = coveredTotal + ncTotal;

  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1200, right: 1200 } } },
      children: [
        // 제목
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 80 },
          children: [new TextRun({ text: '환자 통계 보고서', font: 'Malgun Gothic', size: 32, bold: true })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 300 },
          children: [new TextRun({ text: `기간: ${dateRange.from} ~ ${dateRange.to} | 출력일: ${new Date().toLocaleDateString('ko-KR')}`, font: 'Malgun Gothic', size: 18, color: '888888' })],
        }),

        // 1. 병상 운영 현황
        heading('1. 병상 운영 현황'),
        body(`보고 기간 기준, 총 병상 정원은 ${fmt(overall.total_capacity)}병상이며, 현재 입원 환자 수는 ${fmt(overall.total_occupied)}명입니다. 잔여 병상은 ${fmt(overall.total_available)}병상이고, 평균 병상 가동률은 ${pct(overall.occupancy_rate)}입니다 ${diffText(comp.occupancy_rate?.diff_pct)}.`),
        body(`기간 내 입원건수는 ${fmt(overall.admitted_count)}건 ${diffText(comp.admitted_count?.diff_pct)}, 퇴원건수는 ${fmt(overall.discharged_count)}건 ${diffText(comp.discharged_count?.diff_pct)}이며, 평균 재원일수는 ${comp.avg_los?.current ?? '-'}일입니다.`),
        simpleTable(
          ['지표', '현재', '직전', '증감'],
          [
            ['입원건수', `${comp.admitted_count?.current ?? 0}`, `${comp.admitted_count?.previous ?? 0}`, `${comp.admitted_count?.diff_pct ?? 0}%`],
            ['퇴원건수', `${comp.discharged_count?.current ?? 0}`, `${comp.discharged_count?.previous ?? 0}`, `${comp.discharged_count?.diff_pct ?? 0}%`],
            ['평균재원일수', `${comp.avg_los?.current ?? 0}일`, `${comp.avg_los?.previous ?? 0}일`, `${comp.avg_los?.diff_pct ?? 0}%`],
            ['평균가동률', `${comp.occupancy_rate?.current ?? 0}%`, `${comp.occupancy_rate?.previous ?? 0}%`, `${comp.occupancy_rate?.diff_pct ?? 0}%`],
          ],
        ),

        // 병동별 가동률
        ...(depts.length > 0 ? [
          body(`병동별 현황은 아래와 같으며, 가동률이 높은 병동 중심으로 인력 배치 및 병상 관리 계획을 수립할 필요가 있습니다.`, { spacing: 120 }),
          simpleTable(
            ['병동', '정원', '현원', '가동률'],
            depts.map((d: any) => [
              d.department_name,
              String(d.capacity),
              String(d.occupied),
              d.capacity > 0 ? `${((d.occupied / d.capacity) * 100).toFixed(1)}%` : '-',
            ]),
          ),
        ] : []),

        // 2. 환자 구성 분석
        heading('2. 환자 구성 분석'),

        // 환자군
        body('(1) 환자군 분포', { bold: true, spacing: 120 }),
        ...(Object.keys(bd.patient_group || {}).length > 0 ? [
          body(`현재 입원 환자의 환자군 분포입니다. 환자군별 비중을 통해 간호 인력 배치 및 간호등급 산정의 근거 자료로 활용할 수 있습니다.`),
          simpleTable(['환자군', '인원', '비중'], breakdownRows(bd.patient_group, patientGroupLabel)),
        ] : [body('데이터가 없습니다.')]),

        // 보험유형
        body('(2) 보험유형 분포', { bold: true, spacing: 120 }),
        ...(Object.keys(bd.insurance_type || {}).length > 0 ? [
          body(`보험유형별 환자 분포입니다. 의료급여 및 산재/자동차보험 비율은 수가 체계와 미수금 관리에 직접적 영향을 미칩니다.`),
          simpleTable(['보험유형', '인원', '비중'], breakdownRows(bd.insurance_type, insuranceLabel)),
        ] : [body('데이터가 없습니다.')]),

        // 간병유형
        body('(3) 간병유형 분포', { bold: true, spacing: 120 }),
        ...(Object.keys(bd.caregiver_type || {}).length > 0 ? [
          body(`간병유형 분포입니다. 밀착간병과 외주간병 비율에 따라 간병비 지출 구조가 달라지므로, 본원간병 확대 가능성을 검토할 수 있습니다.`),
          simpleTable(['간병유형', '인원', '비중'], breakdownRows(bd.caregiver_type, caregiverLabel)),
        ] : [body('데이터가 없습니다.')]),

        // 특성화
        ...(Object.keys(bd.specialization || {}).length > 0 ? [
          body('(4) 특성화 현황', { bold: true, spacing: 120 }),
          body(`특성화 환자(감염/투석/재활) 현황입니다. 특성화 환자 비율은 수가 가산 항목과 직결됩니다.`),
          simpleTable(['구분', '인원', '비중'], breakdownRows(bd.specialization, specLabel)),
        ] : []),

        // 기저귀
        ...(diaper.usage_counts ? [
          body('(5) 기저귀 사용 현황', { bold: true, spacing: 120 }),
          body(`원내 기저귀 사용 ${diaper.usage_counts.in_house ?? 0}명, 본인 지참 ${diaper.usage_counts.personal ?? 0}명, 미사용 ${diaper.usage_counts.none ?? 0}명입니다. 원내 기저귀 총 비용은 ${won(Number(diaper.billing?.in_house_total_amount ?? 0))}입니다.`),
        ] : []),

        // 페이지 나눔
        new Paragraph({ children: [new PageBreak()] }),

        // 3. 진료비 현황
        heading('3. 진료비 현황'),
        body(`보고 기간 총 진료비는 ${won(chargeTotal)}이며, 급여 ${won(coveredTotal)} (${chargeTotal > 0 ? ((coveredTotal / chargeTotal) * 100).toFixed(1) : 0}%), 비급여 ${won(ncTotal)} (${chargeTotal > 0 ? ((ncTotal / chargeTotal) * 100).toFixed(1) : 0}%)입니다.`),

        ...(Object.keys(charges.covered || {}).length > 0 ? [
          body('급여 항목별 내역:', { bold: true, spacing: 100 }),
          simpleTable(
            ['항목', '총액', '건수'],
            Object.entries(charges.covered || {}).sort((a: any, b: any) => (b[1].total || 0) - (a[1].total || 0)).map(([name, v]: [string, any]) => [
              name, won(v.total || 0), String(v.count || 0),
            ]),
          ),
        ] : []),

        ...(Object.keys(charges.non_covered || {}).length > 0 ? [
          body('비급여 항목별 내역:', { bold: true, spacing: 100 }),
          simpleTable(
            ['항목', '총액', '건수'],
            Object.entries(charges.non_covered || {}).sort((a: any, b: any) => (b[1].total || 0) - (a[1].total || 0)).map(([name, v]: [string, any]) => [
              name, won(v.total || 0), String(v.count || 0),
            ]),
          ),
        ] : []),

        // 4. 종합 의견
        heading('4. 종합 의견'),
        body(`보고 기간 병상 가동률 ${pct(overall.occupancy_rate)}로 ${(overall.occupancy_rate ?? 0) >= 90 ? '높은 수준을 유지하고 있으며, 병상 확충 또는 회전율 개선이 필요할 수 있습니다' : (overall.occupancy_rate ?? 0) >= 70 ? '안정적인 수준을 유지하고 있습니다' : '다소 낮은 수준이므로 입원 경로 다변화 및 홍보 강화를 검토할 필요가 있습니다'}.`),
        body(`환자 구성 측면에서는 환자군별·보험유형별 분포를 감안하여 간호 인력 배치를 최적화하고, 비급여 비중(${chargeTotal > 0 ? ((ncTotal / chargeTotal) * 100).toFixed(1) : 0}%)에 대한 적정성을 검토할 것을 제안합니다.`),
        body(`이상 보고합니다.`, { spacing: 200 }),

        // 서명란
        new Paragraph({ spacing: { before: 400 }, children: [] }),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: `${new Date().toLocaleDateString('ko-KR')}`, font: 'Malgun Gothic', size: 20 })],
        }),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { before: 80 },
          children: [new TextRun({ text: '작성자: _______________', font: 'Malgun Gothic', size: 20 })],
        }),
      ],
    }],
  });

  const blob = await Packer.toBlob(doc);
  saveAs(blob, `환자통계보고서_${dateRange.from}_${dateRange.to}.docx`);
}
