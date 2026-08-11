// 환자 쓰기 가드 — Prisma client extension.
//
// 모든 patient.create / patient.update / wardRoomBoard.create 호출에 자동 적용.
// normalizePatient 우회 경로(예: referral.ts:160 사고 사례)에서도 빈 문자열 등
// 알려진 잘못된 값이 DB 에 들어가지 못하게 방어.
//
// 검증 범위:
//   - diaper_state: 'IN_HOUSE' | 'PERSONAL' | 'NONE' 외 입력 → 'NONE' 강제
//   - specializations: 빈 문자열 → '[]' 강제
//   - patient_group: 빈 문자열 → 'UNRATED' 강제
//   - mobility_type: 빈 문자열 → 'AMBULATORY' 강제
//   - insurance_type: 빈 문자열 → 'HEALTH' 강제
//   - copay_reduction: 빈 문자열 → 'NONE' 강제
//   - gender: 빈 문자열 → 'UNKNOWN' 강제
//
// 적용: src/server/index.ts 에서 const prisma = new PrismaClient().$extends(patientWriteGuard);

import { Prisma } from '@prisma/client';

const VALID_DIAPER = new Set(['IN_HOUSE', 'PERSONAL', 'NONE']);

function sanitizePatientLike(data: any): void {
  if (!data || typeof data !== 'object') return;

  // diaper_state — 가장 중요한 필드. enum-like 라 빈값이면 inferDemand 추론 빗나감.
  if ('diaper_state' in data) {
    const v = data.diaper_state;
    if (typeof v !== 'string' || !VALID_DIAPER.has(v)) {
      data.diaper_state = 'NONE';
    }
  }

  // specializations — JSON 배열 문자열. 빈값 들어가면 JSON.parse 실패 가능.
  if ('specializations' in data) {
    const v = data.specializations;
    if (typeof v !== 'string' || v.trim() === '') {
      data.specializations = '[]';
    }
  }

  // patient_group — 환자 등급. UI 필터·통계에 사용. 빈값이면 분류 누락.
  if ('patient_group' in data) {
    const v = data.patient_group;
    if (typeof v !== 'string' || v.trim() === '') {
      data.patient_group = 'UNRATED';
    }
  }

  if ('mobility_type' in data) {
    const v = data.mobility_type;
    if (typeof v !== 'string' || v.trim() === '') {
      data.mobility_type = 'AMBULATORY';
    }
  }

  if ('insurance_type' in data) {
    const v = data.insurance_type;
    if (typeof v !== 'string' || v.trim() === '') {
      data.insurance_type = 'HEALTH';
    }
  }

  if ('copay_reduction' in data) {
    const v = data.copay_reduction;
    if (typeof v !== 'string' || v.trim() === '') {
      data.copay_reduction = 'NONE';
    }
  }

  if ('gender' in data) {
    const v = data.gender;
    if (typeof v !== 'string' || v.trim() === '') {
      data.gender = 'UNKNOWN';
    }
  }
}

export const patientWriteGuard = Prisma.defineExtension({
  name: 'patient-write-guard',
  query: {
    patient: {
      create({ args, query }) {
        sanitizePatientLike((args as any).data);
        return query(args);
      },
      update({ args, query }) {
        sanitizePatientLike((args as any).data);
        return query(args);
      },
      upsert({ args, query }) {
        sanitizePatientLike((args as any).create);
        sanitizePatientLike((args as any).update);
        return query(args);
      },
      createMany({ args, query }) {
        const data = (args as any).data;
        if (Array.isArray(data)) {
          for (const row of data) sanitizePatientLike(row);
        } else {
          sanitizePatientLike(data);
        }
        return query(args);
      },
      updateMany({ args, query }) {
        sanitizePatientLike((args as any).data);
        return query(args);
      },
    },
    wardRoomBoard: {
      create({ args, query }) {
        sanitizePatientLike((args as any).data);
        return query(args);
      },
      update({ args, query }) {
        sanitizePatientLike((args as any).data);
        return query(args);
      },
      upsert({ args, query }) {
        sanitizePatientLike((args as any).create);
        sanitizePatientLike((args as any).update);
        return query(args);
      },
    },
  },
});
