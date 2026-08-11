// 자체 추론 모델 — 특성 벡터 빌더.
//
// Step 8 학습 단계에서 사용. 현재는 자리만.
//
// 특성 (v1):
//   - patient_count: 부서 입원 환자수
//   - active_treatments: usage_kind 별 활성 매핑 수
//   - day_of_week: 0~6
//   - month: 1~12
//   - department_idx: 부서 인덱스 (one-hot 또는 정수)
//   - recent_4w_avg: 최근 4주 평균 사용량
//   - guideline_baseline: item-guidelines.ts 기반 권장값

export type FeatureVector = {
  patient_count: number;
  active_treatments: Record<string, number>;
  day_of_week: number;
  month: number;
  department_idx: number;
  recent_4w_avg: number;
  guideline_baseline: number;
};

export async function buildFeatureVector(_input: {
  department_id: string;
  item_id: string;
  date: Date;
}): Promise<FeatureVector | null> {
  // TODO: Step 8 구현
  return null;
}
