// 자동 사유 추론 — 운영자 라벨링 부담 없이 시스템이 데이터로 추정.
//
// 입력: 신청량 + inferDemand 결과 + 신청 유형
// 출력: 사유 코드 + 짧은 설명
//
// 운영자(총무부) 화면에만 표시. 병동 화면 노출 X.
// 학습 데이터 라벨로도 활용 가능 (Step 8 LLM 파인튜닝 단계).
//
// 사유 코드:
//   NORMAL              — 권장 ±편차 내 (정상)
//   UNDER_USAGE         — 권장 절반 이하 (과소 사용)
//   ANOMALY             — 권장 1.5배 이상 (이상 패턴)
//   COLD_START          — 모델·이력 없음, 룰 기반 prior
//   NO_INFERENCE        — 가이드라인 매핑 없는 품목
//
// (BLOCKAGE / INFECTION_OUTBREAK / NEW_ADMISSION 등 더 정교한 분류는
//  부서 단기 추세·항생제 처방·환자 변동 신호가 누적된 후 v2 에서 추가.)

import type { DemandInference } from './inferDemand';

export type AutoReason = {
  code: 'NORMAL' | 'UNDER_USAGE' | 'ANOMALY' | 'COLD_START' | 'NO_INFERENCE';
  label: string;
  detail: string;
};

export function inferRequestReason(input: {
  requested_qty: number;
  inference: DemandInference | null;
  request_type?: string;
}): AutoReason {
  const inf = input.inference;
  if (!inf || inf.recommended === 0) {
    return {
      code: 'NO_INFERENCE',
      label: '추정 불가',
      detail: '가이드라인 매핑 없음 — 운영자 판단 영역.',
    };
  }

  if (inf.basis.cold_start) {
    return {
      code: 'COLD_START',
      label: '데이터 누적 중',
      detail: `룰 기반 권장 ${inf.recommended}개 (모델 미사용). 사용 환자 ${inf.basis.patients}명.`,
    };
  }

  const ratio = input.requested_qty / inf.recommended;
  if (ratio < 0.5) {
    return {
      code: 'UNDER_USAGE',
      label: '과소 사용',
      detail: `신청 ${input.requested_qty}개 — 권장 ${inf.recommended}개의 ${Math.round(ratio * 100)}%. 안전·인증 리스크 검토.`,
    };
  }
  if (ratio >= 0.5 && ratio < 1.5) {
    return {
      code: 'NORMAL',
      label: '정상',
      detail: `신청 ${input.requested_qty}개 — 권장 ${inf.recommended}개 (${Math.round(ratio * 100)}%). 적정 범위.`,
    };
  }

  // ratio >= 1.5 — 이상 패턴
  return {
    code: 'ANOMALY',
    label: '이상 패턴',
    detail: `신청 ${input.requested_qty}개 — 권장 ${inf.recommended}개의 ${Math.round(ratio * 100)}%. 사유 검토 필요.`,
  };
}
