import { prisma } from '../index';

/**
 * 날짜를 자정(00:00:00) 기준으로 정규화
 */
function toMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * 병동의 오늘 DRAFT 신청서를 조회하거나 생성
 * @@unique([ward_id, period_date]) 제약으로 중복 방지
 * db 파라미터로 트랜잭션 클라이언트 전달 가능
 */
export async function getOrCreateDraftRequest(
  ward_id: number,
  created_by: number,
  date?: Date,
  db?: any
): Promise<number> {
  const client = db ?? prisma;
  const periodDate = toMidnight(date || new Date());

  try {
    const existing = await client.request.findUnique({
      where: { ward_id_period_date: { ward_id, period_date: periodDate } },
    });
    if (existing) return existing.id;

    const created = await client.request.create({
      data: { ward_id, created_by, period_date: periodDate, status: 'DRAFT' },
    });
    return created.id;
  } catch (err: any) {
    // P2002: unique constraint violation — 동시 요청 race condition 처리
    if (err.code === 'P2002') {
      const existing = await client.request.findUnique({
        where: { ward_id_period_date: { ward_id, period_date: periodDate } },
      });
      if (existing) return existing.id;
    }
    throw err;
  }
}

/**
 * 수가품목 사용등록 후 자동 신청라인 생성
 * qty_auto = qty_used × replacement_cycle_days
 */
export async function generateLineFromSugaUse(
  sugaUseId: number,
  actorUserId: number
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const sugaUse = await tx.sugaUse.findUniqueOrThrow({
      where: { id: sugaUseId },
      include: {
        item: {
          include: { price_history: { orderBy: { changed_at: 'desc' }, take: 1 } },
        },
      },
    });

    const requestId = await getOrCreateDraftRequest(
      sugaUse.ward_id,
      actorUserId,
      sugaUse.recorded_at,
      tx
    );

    const qty = sugaUse.qty_used * sugaUse.replacement_cycle_days;
    const unitPrice = sugaUse.item.price_history.length > 0
      ? Number(sugaUse.item.price_history[0].price)
      : 0;
    if (unitPrice <= 0) {
      console.warn(`[auto-request] item ${sugaUse.item_id} has no price history, using 0`);
    }

    await tx.requestLine.create({
      data: {
        request_id: requestId,
        item_id: sugaUse.item_id,
        suga_use_id: sugaUse.id,
        line_source: 'SUGA',
        qty_auto: qty,
        qty_final: qty,
        unit_price_snapshot: unitPrice,
        line_amount_auto: unitPrice * qty,
        line_amount_final: unitPrice * qty,
      },
    });
  });
}

/**
 * 수가품목 사용등록 취소 시 연결된 신청라인 취소
 */
export async function cancelLineFromSugaUse(sugaUseId: number): Promise<void> {
  await prisma.requestLine.updateMany({
    where: { suga_use_id: sugaUseId },
    data: { status: 'CANCELLED' },
  });
}

/**
 * 처치의존도 일일 입력 후 PATIENT_BASED 품목 자동 신청라인 생성/갱신
 * qty_auto = ceil((L1×w1 + L2×w2 + L3×w3 + L4×w4) × per_patient_qty)
 */
export async function generateLinesFromTreatmentDependency(
  treatmentDependencyId: number,
  actorUserId: number
): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    const td = await tx.treatmentDependencyDaily.findUniqueOrThrow({
      where: { id: treatmentDependencyId },
    });

    const quotas = await tx.wardQuota.findMany({
      where: { ward_id: td.ward_id, quota_type: 'PATIENT_BASED', is_active: true, deleted_at: null },
      include: {
        item: {
          include: { price_history: { orderBy: { changed_at: 'desc' }, take: 1 } },
        },
      },
    });

    const requestId = await getOrCreateDraftRequest(td.ward_id, actorUserId, td.date, tx);
    let updatedCount = 0;

    for (const quota of quotas) {
      const weightedCount =
        td.l1_count * Number(quota.l1_weight) +
        td.l2_count * Number(quota.l2_weight) +
        td.l3_count * Number(quota.l3_weight) +
        td.l4_count * Number(quota.l4_weight);

      const qty = Math.ceil(weightedCount * Number(quota.per_patient_qty));
      const unitPrice = quota.item.price_history.length > 0
        ? Number(quota.item.price_history[0].price)
        : 0;
      if (unitPrice <= 0) {
        console.warn(`[auto-request] item ${quota.item_id} has no price history, using 0`);
      }

      const existing = await tx.requestLine.findFirst({
        where: {
          request_id: requestId,
          item_id: quota.item_id,
          line_source: 'TREATMENT',
          status: 'ACTIVE',
        },
      });

      if (existing) {
        if (existing.qty_final === existing.qty_auto) {
          // 아직 수동 수정 없음 → qty_auto + qty_final 모두 갱신
          await tx.requestLine.update({
            where: { id: existing.id },
            data: {
              qty_auto: qty,
              qty_final: qty,
              unit_price_snapshot: unitPrice,
              line_amount_auto: unitPrice * qty,
              line_amount_final: unitPrice * qty,
            },
          });
        } else {
          // 이미 수동 수정됨 → qty_auto만 갱신
          await tx.requestLine.update({
            where: { id: existing.id },
            data: {
              qty_auto: qty,
              line_amount_auto: unitPrice * qty,
              unit_price_snapshot: unitPrice,
            },
          });
        }
      } else {
        await tx.requestLine.create({
          data: {
            request_id: requestId,
            item_id: quota.item_id,
            line_source: 'TREATMENT',
            qty_auto: qty,
            qty_final: qty,
            unit_price_snapshot: unitPrice,
            line_amount_auto: unitPrice * qty,
            line_amount_final: unitPrice * qty,
          },
        });
      }
      updatedCount++;
    }

    return updatedCount;
  });
}

/**
 * 병동의 특정 월 예외율 계산
 * 예외율 = 예외수량(|qty_final - qty_auto|의 합) / auto_qty 합계
 * 5% 초과 시 is_alert = true
 */
export async function computeExceptionRate(
  ward_id: number,
  year: number,
  month: number
): Promise<{ exception_qty: number; auto_qty: number; rate: number; is_alert: boolean }> {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 1);

  const lines = await prisma.requestLine.findMany({
    where: {
      request: {
        ward_id,
        period_date: { gte: startDate, lt: endDate },
        status: { in: ['APPROVED', 'ORDERED'] },
      },
      status: 'ACTIVE',
    },
  });

  const auto_qty = lines.reduce((s, l) => s + l.qty_auto, 0);
  const exception_qty = lines
    .filter((l) => l.qty_final !== l.qty_auto)
    .reduce((s, l) => s + Math.abs(l.qty_final - l.qty_auto), 0);

  const rate = auto_qty > 0 ? exception_qty / auto_qty : 0;
  return { exception_qty, auto_qty, rate, is_alert: rate > 0.05 };
}
