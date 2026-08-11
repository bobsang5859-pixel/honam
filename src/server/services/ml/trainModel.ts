// 자체 추론 모델 — 학습 파이프라인.
//
// Step 8 에서 본격 구현. 현재는 자리만.
//
// 학습 흐름 (Step 8):
//   1. WardRequest + WardRequestItem + Patient + PatientItemUsage 에서 학습 데이터 추출
//   2. featureBuilder.buildFeatureVector() 로 특성 매트릭스 빌드
//   3. ml-regression-multivariate-linear (또는 정규방정식 직접 구현) 으로 선형회귀 학습
//   4. metrics 계산 (RMSE, MAE, R²)
//   5. data/models/demand-{yyyymmdd}.json 저장
//
// 트리거:
//   - nightly cron (자정)
//   - 또는 관리자 수동 호출

import type { ModelArtifact } from './predict';

export async function trainDemandModel(_options?: {
  min_samples?: number;
  test_ratio?: number;
}): Promise<ModelArtifact> {
  throw new Error(
    'Step 8 미구현 — 자체 추론 모델 학습 모듈은 데이터 누적 후 활성화 예정 (계획상 운영 2개월 시점)',
  );
}
