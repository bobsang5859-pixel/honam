// 부서 신청 추천 추론 엔진.
//
// 병동이 신청서에 적을 권장량을 계산하는 메인 진입점.
// 룰 기반(가이드라인) + 자체 추론 모델(Step 8) 의 가중 평균.
//
// Cold start 정책 (predict.ts):
//   - 모델 없음/샘플 부족 → 룰 기반 100%
//   - 샘플 100~999 → 룰 70% + 모델 30%
//   - 샘플 1000+ → 룰 30% + 모델 70%
//
// 가이드라인은 평생 prior 로 동작 — 모델 학습 후에도 사라지지 않음.
//
// (참고: src/server/services/demand-forecast.ts 는 업체 발주 시점 예측이고,
//   본 모듈은 부서 신청 권장량 — 별도 책임.)

import { prisma } from '../index';
import {
  getItemGuideline,
  isGuidedCategory,
  applyOverride,
  type ItemGuideline,
  type GuidelineOverrideMap,
} from '../../shared/item-guidelines';
import { inferUsageKind, getGroupKey } from '../../shared/usage-kind';
import { predictModelDemand, type ModelPrediction } from './ml/predict';

// B4 — 병원·부서별 override 로딩.
// AppSetting('guideline_overrides') JSON 에서 읽음. 없으면 빈 Map.
// 호출당 1회 — 캐싱 미적용(데이터 소량 + 일관성 우선).
async function loadGuidelineOverrides(): Promise<GuidelineOverrideMap> {
  try {
    const row = await (prisma as any).appSetting.findUnique({
      where: { key: 'guideline_overrides' },
    });
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export type DemandInference = {
  recommended: number;     // 권장 신청량
  min: number;             // 적정 하한
  max: number;             // 적정 상한
  basis: {
    patients: number;            // 사용 환자수
    rule_based: number;          // 룰만 사용한 권장량
    model_based: number | null;  // 모델 예측값 (null = 모델 없음)
    blend_weight: number;        // 0=룰만, 1=모델만
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    cold_start: boolean;         // true = 모델 미사용
    reason: string;              // 디버그/총무부 화면용 설명
  };
};

export async function inferRecommendedQty(
  department_id: string,
  item_id: string,
  period_days: number = 30,
): Promise<DemandInference | null> {
  // 1. 품목 + 가이드라인
  const item = await prisma.item.findUnique({
    where: { id: item_id },
    select: { id: true, name: true, category: true, sub_category: true },
  });
  if (!item) return null;
  if (!isGuidedCategory(item.category)) return null;

  const baseGuideline = getItemGuideline(item);
  if (!baseGuideline) return null;

  // B4 — override 적용
  const overrides = await loadGuidelineOverrides();
  const guideline = applyOverride(baseGuideline, overrides[item.id]);

  // 가이드라인이 신청 주기를 명시하면 그 값 사용 (기저귀: 7일).
  // 호출자의 period_days 가 default(30) 이고 가이드라인에 명시되어 있으면 가이드라인 우선.
  const effectivePeriod = guideline.request_period_days ?? period_days;

  // 2. 사용 환자수
  const usage = await countUsingPatients(department_id, item);

  // 사용 환자 식별 불가능한 품목 (소독제·일반 주사기 등) — 가이드라인 적용 X
  // 부서 전체 환자수 × 빈도 로 추정하면 과대 추천(예: D/Syringe 1710개) 발생.
  // 대신 BASELINE/HISTORY 가 있으면 그쪽이 사용됨. 둘 다 없으면 0 추천.
  if (!usage.specific) return null;

  const patients = usage.count;
  if (patients === 0) {
    return {
      recommended: 0,
      min: 0,
      max: 0,
      basis: {
        patients: 0,
        rule_based: 0,
        model_based: null,
        blend_weight: 0,
        confidence: guideline.confidence,
        cold_start: true,
        reason: '사용 환자 0명 — 권장 0',
      },
    };
  }

  // 3. 룰 기반 권장량 (effectivePeriod 사용 — 기저귀 7일 등)
  const ruleBased = computeRuleBasedQty(patients, guideline, effectivePeriod);

  // 4. 모델 예측 (있으면)
  const modelPred = await predictModelDemand({ department_id, item_id, period_days: effectivePeriod });

  // 5. Cold start 가중치
  const blend = computeBlendWeight(modelPred);
  const recommended =
    blend.weight === 0 || !modelPred
      ? ruleBased
      : (1 - blend.weight) * ruleBased + blend.weight * modelPred.qty;

  // 6. variance 적용 — min/max 구간
  const tol = guideline.variance_tolerance;
  const min = Math.max(0, Math.round(recommended * (1 - tol)));
  const max = Math.ceil(recommended * (1 + tol));

  return {
    recommended: Math.round(recommended),
    min,
    max,
    basis: {
      patients,
      rule_based: Math.round(ruleBased),
      model_based: modelPred ? Math.round(modelPred.qty) : null,
      blend_weight: blend.weight,
      confidence: guideline.confidence,
      cold_start: blend.weight === 0,
      reason: blend.reason,
    },
  };
}

// B3 — 환자별 전용 다회용품 분실·파손 보정율.
// 토니켓·Enema Syringe·투약병 같은 다회용은 정상 운영 시 추가 신청 거의 없으나,
// 분실·파손으로 월 ~5% 보충 신청 발생.
const PER_PATIENT_REPLACEMENT_LOSS_RATE = 0.05;

// 룰 기반 권장량 계산. (B1 — 우선순위 명시)
//
// 분기 우선순위 (위에서부터 매칭되는 첫 분기 적용):
//   1. on_demand        → 0 (routine 교체 안 함, 필요 시 별도 신청)
//   2. usage_per_patient_per_day 명시  → patients × usage × period_days  (가장 정확)
//   3. replacement.days  → patients × (period_days / days)
//   4. replacement.hours → patients × ((period_days × 24) / hours)
//   5. per_patient       → 환자수 × 분실·파손 보정율 × 기간계수  (B3 — 다회용 별도 분기)
//   6. per_event 단가    → patients (보수적 추정)
//   7. fallback          → patients
function computeRuleBasedQty(
  patients: number,
  g: ItemGuideline,
  period_days: number,
): number {
  const r = g.replacement;

  // 1. routine 교체 X
  if (r.on_demand) return 0;

  // 2. 환자별 1일 사용 빈도 (가장 정확)
  if (g.usage_per_patient_per_day != null) {
    return patients * g.usage_per_patient_per_day * period_days;
  }

  // 3. 일 단위 교체주기
  if (r.days != null) {
    return patients * (period_days / r.days);
  }

  // 4. 시간 단위 교체주기
  if (r.hours != null) {
    return patients * ((period_days * 24) / r.hours);
  }

  // 5. 환자별 전용 다회용품 — 분실·파손 보정 (B3)
  //    정상 운영 시 추가 신청 거의 0 이지만, 월 5% 보정으로 분실·파손 흡수.
  //    period_days 기간동안 비례 적용.
  if (r.per_patient) {
    const monthlyLoss = patients * PER_PATIENT_REPLACEMENT_LOSS_RATE;
    return monthlyLoss * (period_days / 30);
  }

  // 6. 시술 단가 (사용량 미정)
  if (r.per_event) {
    return patients;
  }

  // 7. fallback
  return patients;
}

function computeBlendWeight(modelPred: ModelPrediction | null): {
  weight: number;
  reason: string;
} {
  if (!modelPred) {
    return { weight: 0, reason: 'cold_start (모델 없음 — 룰 기반 100%)' };
  }
  if (modelPred.training_samples < 100) {
    return {
      weight: 0,
      reason: `cold_start (샘플 ${modelPred.training_samples} < 100 — 룰 기반 100%)`,
    };
  }
  if (modelPred.training_samples < 1000) {
    return {
      weight: 0.3,
      reason: `warmup (샘플 ${modelPred.training_samples} — 룰 70% + 모델 30%)`,
    };
  }
  return {
    weight: 0.7,
    reason: `hot (샘플 ${modelPred.training_samples} — 룰 30% + 모델 70%)`,
  };
}

// 부서 내에서 이 품목을 실제로 사용하는 환자수 산출.
// 반환값:
//   { count, specific: true }  — 정확히 식별 가능 (DIAPER 또는 usage_kind 매핑)
//   { count, specific: false } — 부서 전체 fallback (정확도 낮음 — 가이드라인 적용 X 권장)
// - 기저귀: Patient.diaper_state == 'IN_HOUSE'
// - usage_kind 매핑 품목: PatientItemUsage 활성 매핑 (group_key 기반)
// - 그 외: 부서 전체 환자수 (specific=false — 호출자가 결정)
async function countUsingPatients(
  department_id: string,
  item: { name: string; category: string | null; sub_category: string | null },
): Promise<{ count: number; specific: boolean }> {
  // 1. 기저귀 분기 — diaper_state 기반
  if (item.category?.startsWith('DIAPER') || item.category === 'PAT_DIAPER') {
    const count = await prisma.patient.count({
      where: { department_id, diaper_state: 'IN_HOUSE' },
    });
    return { count, specific: true };
  }

  // 2. usage_kind 매핑 품목 — 활성 PatientItemUsage 기반
  const usageKind = inferUsageKind({ name: item.name, category: item.category });
  if (usageKind) {
    const groupKey = getGroupKey(usageKind);
    const usages = await prisma.patientItemUsage.findMany({
      where: { group_key: groupKey, ended_at: null },
      select: { patient_id: true },
      distinct: ['patient_id'],
    });
    if (usages.length === 0) return { count: 0, specific: true };
    const patientIds = usages.map((u) => u.patient_id);
    const count = await prisma.patient.count({
      where: { id: { in: patientIds }, department_id },
    });
    return { count, specific: true };
  }

  // 3. 매핑 없는 품목 — 부서 전체 환자수 (정확도 낮음)
  const count = await prisma.patient.count({ where: { department_id } });
  return { count, specific: false };
}
