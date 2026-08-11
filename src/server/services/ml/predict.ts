// 자체 추론 모델 — 예측 모듈.
//
// Cold start 정책:
//   - 학습된 모델 없음 → null 반환 → 호출자(inferDemand)는 룰 기반만 사용
//   - 학습 샘플 < 100 → null (cold_start)
//   - 학습 샘플 100~999 → 모델 가중치 0.3 (warmup)
//   - 학습 샘플 1000+ → 모델 가중치 0.7 (hot)
//
// 모델 파일: data/models/demand-{yyyymmdd}.json
// 형식 (Step 8 학습 단계에서 정의될 스키마):
//   {
//     version: 'v1-linear',
//     trained_at: '2026-...',
//     training_samples: number,
//     features: string[],         // 특성 이름 순서
//     coefficients: number[],     // 선형회귀 가중치
//     intercept: number,
//     metrics: { rmse, mae, r2 },
//   }

import * as fs from 'fs';
import * as path from 'path';

const MODEL_DIR = path.join(process.cwd(), 'data', 'models');

export type ModelArtifact = {
  version: string;
  trained_at: string;
  training_samples: number;
  features: string[];
  coefficients: number[];
  intercept: number;
  metrics: { rmse: number; mae: number; r2: number };
};

export type ModelPrediction = {
  qty: number;
  training_samples: number;
  model_version: string;
};

let cachedModel: ModelArtifact | null = null;
let cachedModelMtime = 0;

function loadLatestModel(): ModelArtifact | null {
  try {
    if (!fs.existsSync(MODEL_DIR)) return null;
    const files = fs.readdirSync(MODEL_DIR).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return null;
    files.sort();
    const latestFile = files[files.length - 1];
    const fullPath = path.join(MODEL_DIR, latestFile);
    const stat = fs.statSync(fullPath);
    if (cachedModel && stat.mtimeMs === cachedModelMtime) return cachedModel;
    const content = fs.readFileSync(fullPath, 'utf-8');
    const model = JSON.parse(content) as ModelArtifact;
    cachedModel = model;
    cachedModelMtime = stat.mtimeMs;
    return model;
  } catch {
    return null;
  }
}

// 추론 호출 — Step 8 학습 모듈 활성화 전까지는 항상 null 반환 (cold start 유지)
export async function predictModelDemand(_input: {
  department_id: string;
  item_id: string;
  period_days: number;
}): Promise<ModelPrediction | null> {
  const model = loadLatestModel();
  if (!model) return null;
  if (model.training_samples < 100) return null;

  // TODO: Step 8 — 특성 벡터 빌드 + 선형회귀 예측
  // 현재는 모델 파일 자체가 없어 항상 위에서 null 반환됨.
  return null;
}

// 디버그용: 현재 모델 상태 조회
export function getModelStatus(): { exists: boolean; samples: number; version: string | null } {
  const model = loadLatestModel();
  if (!model) return { exists: false, samples: 0, version: null };
  return { exists: true, samples: model.training_samples, version: model.version };
}
