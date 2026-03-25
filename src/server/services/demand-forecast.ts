/**
 * 수요예측 서비스
 * 사용등록 이력 + 입원환자 현황 기반으로
 * 부서+품목별 일일 소모량, 재고 소진 예상일, 발주 필요 시점 계산
 */
import { prisma } from '../index';

export interface ForecastItem {
  item_id: string;
  item_name: string;
  item_code: string;
  uom: string;
  department_id: string;
  department_name: string;
  /** 1인 1일 평균 사용량 (최근 N개월 기준) */
  daily_rate_per_patient: number;
  /** 현재 입원환자 수 */
  current_patients: number;
  /** 일일 예상 소모량 */
  daily_demand: number;
  /** 현재 재고 */
  current_stock: number;
  /** 재고 소진 예상일 (일수) */
  days_remaining: number;
  /** 업체 리드타임 (일수) */
  lead_time_days: number;
  /** 안전일수 */
  safety_days: number;
  /** 발주 필요 여부 */
  needs_reorder: boolean;
  /** 발주 권장일 */
  reorder_by_date: string | null;
  /** 권장 발주 수량 (리드타임+안전일수 커버) */
  recommended_order_qty: number;
  /** 기본 업체명 */
  vendor_name: string | null;
  /** 위험도: critical(3일이내) / warning(7일이내) / safe */
  risk_level: 'critical' | 'warning' | 'safe' | 'no_data';
  /** 사용 데이터 기간 (일수) */
  data_days: number;
}

export interface ForecastSummary {
  critical_count: number;
  warning_count: number;
  safe_count: number;
  no_data_count: number;
  total_items: number;
  items: ForecastItem[];
}

/**
 * 부서별 입원환자일수 계산 (최근 N개월)
 * = Σ min(discharged_at || today, period_end) - max(admitted_at, period_start)
 */
async function calcPatientDays(
  deptId: string,
  startDate: Date,
  endDate: Date
): Promise<number> {
  const patients = await prisma.patient.findMany({
    where: {
      department_id: deptId,
      deleted_at: null,
      admitted_at: { lte: endDate },
      OR: [
        { discharged_at: null },
        { discharged_at: { gte: startDate } },
      ],
    },
    select: { admitted_at: true, discharged_at: true },
  });

  let totalDays = 0;
  const now = new Date();
  for (const p of patients) {
    const admitStart = p.admitted_at > startDate ? p.admitted_at : startDate;
    const discharge = p.discharged_at && p.discharged_at < endDate
      ? p.discharged_at
      : (now < endDate ? now : endDate);
    const days = Math.max(0, (discharge.getTime() - admitStart.getTime()) / (1000 * 60 * 60 * 24));
    totalDays += days;
  }
  return totalDays;
}

/**
 * 부서+품목별 사용량 합산 (최근 N개월, usage_records raw SQL)
 */
async function getUsageTotals(
  startDateStr: string,
  endDateStr: string,
  deptId?: string
): Promise<Array<{ department_id: string; item_id: string; total_qty: number }>> {
  let sql = `
    SELECT department_id, item_id, SUM(used_qty) as total_qty
    FROM usage_records
    WHERE deleted_at IS NULL
      AND used_at >= ? AND used_at <= ?
  `;
  const params: any[] = [startDateStr, endDateStr];

  if (deptId) {
    sql += ` AND department_id = ?`;
    params.push(deptId);
  }

  sql += ` GROUP BY department_id, item_id`;

  const rows = await (prisma as any).$queryRawUnsafe(sql, ...params);
  return rows.map((r: any) => ({
    department_id: r.department_id,
    item_id: r.item_id,
    total_qty: Number(r.total_qty),
  }));
}

/**
 * 수요 예측 메인 함수
 */
export async function forecastDemand(options: {
  dept_id?: string;
  item_id?: string;
  months?: number;
  safety_days?: number;
}): Promise<ForecastSummary> {
  const { dept_id, item_id, months = 3, safety_days = 2 } = options;

  // 기간 계산
  const now = new Date();
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - months);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(now);

  const startDateStr = startDate.toISOString().slice(0, 10);
  const endDateStr = endDate.toISOString().slice(0, 10);

  // 1. 사용량 집계
  const usageTotals = await getUsageTotals(startDateStr, endDateStr, dept_id);

  if (item_id) {
    // 특정 품목만 필터
    const filtered = usageTotals.filter(u => u.item_id === item_id);
    usageTotals.length = 0;
    usageTotals.push(...filtered);
  }

  // 2. 관련 부서 목록
  const deptIds = [...new Set(usageTotals.map(u => u.department_id))];
  const departments = await prisma.department.findMany({
    where: { id: { in: deptIds }, deleted_at: null },
    select: { id: true, name: true },
  });
  const deptMap = new Map(departments.map(d => [d.id, d.name]));

  // 3. 부서별 입원환자일수 + 현재 환자 수
  const patientDaysMap = new Map<string, number>();
  const currentPatientsMap = new Map<string, number>();

  for (const dId of deptIds) {
    const pDays = await calcPatientDays(dId, startDate, endDate);
    patientDaysMap.set(dId, pDays);

    const count = await prisma.patient.count({
      where: { department_id: dId, status: 'ADMITTED', deleted_at: null },
    });
    currentPatientsMap.set(dId, count);
  }

  // 4. 관련 품목 정보
  const itemIds = [...new Set(usageTotals.map(u => u.item_id))];
  const items = await prisma.item.findMany({
    where: { id: { in: itemIds }, deleted_at: null },
    select: {
      id: true, name: true, item_code: true, uom: true,
      default_vendor_id: true,
    },
  });
  const itemMap = new Map(items.map(i => [i.id, i]));

  // 5. 업체 리드타임
  const vendorIds = items.map(i => i.default_vendor_id).filter(Boolean) as string[];
  const vendors = vendorIds.length ? await prisma.vendor.findMany({
    where: { id: { in: vendorIds } },
    select: { id: true, name: true, lead_time_days: true },
  }) : [];
  const vendorMap = new Map(vendors.map(v => [v.id, v]));

  // 6. 현재 재고 (부서별 창고 기준)
  const inventoryWhere: any = { on_hand_qty: { gt: 0 } };
  if (item_id) inventoryWhere.item_id = item_id;

  const inventories = await prisma.inventory.findMany({
    where: inventoryWhere,
    include: {
      location: { select: { id: true, department_id: true } },
    },
  });

  // 부서+품목별 재고 합산
  const stockMap = new Map<string, number>();
  for (const inv of inventories) {
    const dId = inv.location.department_id;
    if (dId) {
      const key = `${dId}:${inv.item_id}`;
      stockMap.set(key, (stockMap.get(key) || 0) + Number(inv.on_hand_qty));
    }
  }

  // 중앙창고 재고도 별도로 (부서 없는 창고)
  const centralStock = new Map<string, number>();
  for (const inv of inventories) {
    if (!inv.location.department_id) {
      centralStock.set(inv.item_id, (centralStock.get(inv.item_id) || 0) + Number(inv.on_hand_qty));
    }
  }

  // 7. 예측 계산
  const forecastItems: ForecastItem[] = [];

  for (const usage of usageTotals) {
    const item = itemMap.get(usage.item_id);
    if (!item) continue;

    const deptName = deptMap.get(usage.department_id) || '알수없음';
    const patientDays = patientDaysMap.get(usage.department_id) || 0;
    const currentPatients = currentPatientsMap.get(usage.department_id) || 0;

    // 1인 1일 평균 사용량
    const dailyRatePerPatient = patientDays > 0
      ? usage.total_qty / patientDays
      : 0;

    // 일일 예상 소모량
    const dailyDemand = dailyRatePerPatient * currentPatients;

    // 재고 (부서 창고 + 중앙 창고)
    const deptStock = stockMap.get(`${usage.department_id}:${usage.item_id}`) || 0;
    const central = centralStock.get(usage.item_id) || 0;
    const currentStock = deptStock + central;

    // 소진 예상일
    const daysRemaining = dailyDemand > 0
      ? Math.floor(currentStock / dailyDemand)
      : currentStock > 0 ? 999 : 0;

    // 업체 리드타임
    const vendor = item.default_vendor_id ? vendorMap.get(item.default_vendor_id) : null;
    const leadTimeDays = vendor?.lead_time_days || 3;

    // 발주 필요 여부
    const needsReorder = daysRemaining <= (leadTimeDays + safety_days);

    // 발주 권장일
    let reorderByDate: string | null = null;
    if (needsReorder && dailyDemand > 0) {
      const reorderDate = new Date(now);
      reorderDate.setDate(reorderDate.getDate() + Math.max(0, daysRemaining - leadTimeDays - safety_days));
      reorderByDate = reorderDate.toISOString().slice(0, 10);
    }

    // 권장 발주 수량 (리드타임+안전일수 동안의 소모량)
    const recommendedOrderQty = dailyDemand > 0
      ? Math.ceil(dailyDemand * (leadTimeDays + safety_days + 7))
      : 0;

    // 위험도
    let riskLevel: ForecastItem['risk_level'] = 'safe';
    if (patientDays === 0 || dailyDemand === 0) {
      riskLevel = 'no_data';
    } else if (daysRemaining <= 3) {
      riskLevel = 'critical';
    } else if (daysRemaining <= 7) {
      riskLevel = 'warning';
    }

    // 데이터 기간 (일수)
    const dataDays = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

    forecastItems.push({
      item_id: usage.item_id,
      item_name: item.name,
      item_code: item.item_code,
      uom: item.uom,
      department_id: usage.department_id,
      department_name: deptName,
      daily_rate_per_patient: Math.round(dailyRatePerPatient * 100) / 100,
      current_patients: currentPatients,
      daily_demand: Math.round(dailyDemand * 10) / 10,
      current_stock: currentStock,
      days_remaining: daysRemaining,
      lead_time_days: leadTimeDays,
      safety_days,
      needs_reorder: needsReorder,
      reorder_by_date: reorderByDate,
      recommended_order_qty: recommendedOrderQty,
      vendor_name: vendor?.name || null,
      risk_level: riskLevel,
      data_days: dataDays,
    });
  }

  // 위험도순 정렬: critical > warning > safe > no_data, 같은 등급 내에서는 days_remaining 오름차순
  const riskOrder = { critical: 0, warning: 1, safe: 2, no_data: 3 };
  forecastItems.sort((a, b) => {
    const diff = riskOrder[a.risk_level] - riskOrder[b.risk_level];
    if (diff !== 0) return diff;
    return a.days_remaining - b.days_remaining;
  });

  return {
    critical_count: forecastItems.filter(i => i.risk_level === 'critical').length,
    warning_count: forecastItems.filter(i => i.risk_level === 'warning').length,
    safe_count: forecastItems.filter(i => i.risk_level === 'safe').length,
    no_data_count: forecastItems.filter(i => i.risk_level === 'no_data').length,
    total_items: forecastItems.length,
    items: forecastItems,
  };
}

/**
 * 품목별 월간 사용 추이 (6개월)
 */
export async function getUsageHistory(
  itemId: string,
  deptId?: string,
  months: number = 6
): Promise<Array<{ month: string; total_qty: number; patient_days: number; rate: number }>> {
  const results: Array<{ month: string; total_qty: number; patient_days: number; rate: number }> = [];
  const now = new Date();

  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
    const monthLabel = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;

    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);

    let sql = `
      SELECT COALESCE(SUM(used_qty), 0) as total_qty
      FROM usage_records
      WHERE deleted_at IS NULL AND item_id = ? AND used_at >= ? AND used_at <= ?
    `;
    const params: any[] = [itemId, startStr, endStr];

    if (deptId) {
      sql += ` AND department_id = ?`;
      params.push(deptId);
    }

    const rows: any[] = await (prisma as any).$queryRawUnsafe(sql, ...params);
    const totalQty = Number(rows[0]?.total_qty || 0);

    // 환자일수 (해당 부서 또는 전체)
    let patientDays = 0;
    if (deptId) {
      patientDays = await calcPatientDays(deptId, start, end);
    } else {
      // 전체 부서 합산
      const depts = await prisma.department.findMany({
        where: { is_active: true, deleted_at: null },
        select: { id: true },
      });
      for (const d of depts) {
        patientDays += await calcPatientDays(d.id, start, end);
      }
    }

    const rate = patientDays > 0 ? Math.round((totalQty / patientDays) * 100) / 100 : 0;

    results.push({ month: monthLabel, total_qty: totalQty, patient_days: Math.round(patientDays), rate });
  }

  return results;
}
