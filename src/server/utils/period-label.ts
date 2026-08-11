// 주기/주차 라벨 단일 진실원 (single source of truth).
//
// 규칙(사용자 확정): 요청은 "신청한 날짜(period_start)가 어느 신청주기의 신청기간
// [open_from, open_to] 안에 드느냐"로 그 신청주기에 묶이고, 표시 라벨은 그 신청주기의
// 관리자 수동 입력 period_label 을 그대로 쓴다. 신청주기가 없거나 라벨이 비면 월 라벨로 폴백.
//
// 승인(approvals.ts) 과 동일한 매칭을 발주·즉시불출·구매결의서가 공유하도록 여기로 통일.

export interface ScheduleLite {
  request_type: string;
  open_from: Date;
  open_to: Date;
  period_label: string;
}

// 폴백 월 라벨 — 전 단계 동일 형식 ("2026년 5월"). 기존 PO 의 "2026-05",
// stock-out 의 "2026년 5월" 처럼 제각각이던 것을 하나로 통일.
export function monthLabel(dateLike: Date | string | null | undefined): string {
  const d = dateLike ? new Date(dateLike) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
}

// (request_type, period_start) → 그 신청주기의 수동 라벨. 없으면 월 라벨.
export function resolveScheduleLabel(
  requestType: string,
  periodStart: Date | null,
  schedulesByType: Map<string, ScheduleLite[]>,
): { period_label: string; matched: boolean } {
  if (!periodStart) return { period_label: '', matched: false };
  const schedules = schedulesByType.get(String(requestType)) ?? [];
  const m = schedules.find((s) => s.open_from <= periodStart && periodStart <= s.open_to);
  if (m) return { period_label: m.period_label || monthLabel(periodStart), matched: true };
  return { period_label: monthLabel(periodStart), matched: false };
}

export async function loadSchedulesByType(prisma: any): Promise<Map<string, ScheduleLite[]>> {
  const rows: any[] = await prisma.requestSchedule.findMany({
    select: { request_type: true, open_from: true, open_to: true, period_label: true },
  });
  const byType = new Map<string, ScheduleLite[]>();
  for (const r of rows) {
    const t = String(r.request_type);
    const arr = byType.get(t) ?? [];
    arr.push({
      request_type: t,
      open_from: new Date(r.open_from),
      open_to: new Date(r.open_to),
      period_label: String(r.period_label ?? ''),
    });
    byType.set(t, arr);
  }
  return byType;
}
