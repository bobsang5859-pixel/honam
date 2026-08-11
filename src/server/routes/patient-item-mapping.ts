/**
 * 환자×품목 매핑 자동 등록.
 *
 * 신청 화면 폴백에서 "이 환자도 이 품목 사용함" 이라고 체크하면 호출되는 엔드포인트.
 * 카테고리에 따라 다음 두 가지로 분기:
 *   A. 기저귀 카테고리(DIAPER_*)  → Patient.diaper_state 변경
 *   B. 그 외(처치 매핑 있는 품목) → PatientTreatment 등록 (자동 추론으로 처치 종류 결정)
 *
 * 자동 추론 단서 (B 분기):
 *   1) 품목에 매핑된 처치가 1개면 그것 자동 사용
 *   2) 환자의 활성 처치 ∩ 품목 매핑 처치 = 1개면 그것 자동 사용
 *   3) Item.default_treatment_type_id 가 단서 1 결과에 포함되면 그것 자동 사용
 *   셋 다 실패하면 candidates 반환 — UI 가 popup 으로 사용자 선택
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';
import { inferUsageKind, getGroupKey, USAGE_KIND_LABEL } from '../../shared/usage-kind';

const router = Router();
router.use(authMiddleware);

router.post('/auto', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const patientId = String(req.body.patient_id ?? '').trim();
    const itemId = String(req.body.item_id ?? '').trim();
    const treatmentTypeIdInput = req.body.treatment_type_id ? String(req.body.treatment_type_id).trim() : null;
    const force = req.body.force === true;

    if (!patientId || !itemId) {
      return res.status(400).json({ error: 'patient_id, item_id 가 필요합니다.' });
    }

    const patient = await prisma.patient.findUnique({
      where: { id: patientId },
      select: { id: true, name: true, diaper_state: true, deleted_at: true, status: true, department_id: true },
    });
    if (!patient || patient.deleted_at) return res.status(404).json({ error: '환자를 찾을 수 없습니다.' });

    const item = await prisma.item.findUnique({
      where: { id: itemId },
      select: { id: true, name: true, category: true, sub_category: true, default_treatment_type_id: true, deleted_at: true },
    });
    if (!item || item.deleted_at) return res.status(404).json({ error: '품목을 찾을 수 없습니다.' });

    // ── A. 기저귀 카테고리 분기 ─────────────────────────────
    // diaper_state 값: IN_HOUSE(원내) / PERSONAL(본인) / NONE(미사용)
    // 신청 시점 폴백은 "원내 공급" 의미이므로 IN_HOUSE 로 설정.
    if (item.category && item.category.startsWith('DIAPER')) {
      if (patient.diaper_state === 'IN_HOUSE') {
        return res.json({ auto: true, action: 'NOOP', diaper_state: patient.diaper_state, message: '이미 원내 기저귀 사용 중인 환자입니다.' });
      }
      const before = patient.diaper_state ?? '';
      await prisma.patient.update({
        where: { id: patient.id },
        data: { diaper_state: 'IN_HOUSE' } as any,
      });
      await audit({
        actor_user_id: req.user!.id,
        action: 'UPDATE',
        entity_type: 'patients',
        entity_id: patient.id,
        before: { diaper_state: before },
        after: { diaper_state: 'IN_HOUSE' },
        reason: `신청 시점 폴백: ${item.name}`,
      });
      return res.json({ auto: true, action: 'DIAPER_ENABLED', diaper_state: 'IN_HOUSE' });
    }

    // ── B. 호흡·삽관 / 카테터·튜브 — usage_kind 매핑 분기 ───
    const usageKind = inferUsageKind({ name: item.name, category: item.category });
    if (usageKind) {
      const size = String(item.sub_category ?? '').trim();
      const groupKey = getGroupKey(usageKind);

      // 같은 환자가 같은 usage_kind 의 다른 size 에 이미 등록되어 있나? → confirm 트리거
      const sameKindRows = await prisma.patientItemUsage.findMany({
        where: {
          patient_id: patient.id,
          usage_kind: usageKind,
          ended_at: null,
        },
        select: { id: true, size: true },
      });
      const dupOtherSize = sameKindRows.find((r) => r.size !== size);
      if (dupOtherSize && !force) {
        return res.json({
          auto: false,
          action: 'CONFIRM_DUPLICATE_SIZE',
          patient: { id: patient.id, name: patient.name },
          existing: { usage_kind: usageKind, label: USAGE_KIND_LABEL[usageKind], size: dupOtherSize.size },
          requested: { usage_kind: usageKind, label: USAGE_KIND_LABEL[usageKind], size },
          message: `${patient.name} 환자는 이미 ${USAGE_KIND_LABEL[usageKind]} ${dupOtherSize.size} 사용 중입니다. ${USAGE_KIND_LABEL[usageKind]} ${size} 도 함께 사용하시는 게 맞나요?`,
        });
      }

      // 정확히 같은 size 면 noop
      const exactDup = sameKindRows.find((r) => r.size === size);
      if (exactDup) {
        return res.json({
          auto: true,
          action: 'NOOP',
          usage_kind: usageKind,
          size,
          message: '이미 등록된 환자입니다.',
        });
      }

      const created = await prisma.patientItemUsage.create({
        data: {
          id: uuidv4(),
          patient_id: patient.id,
          usage_kind: usageKind,
          size,
          group_key: groupKey,
          created_by: req.user!.id,
          note: `신청 시점 등록: ${item.name}`,
        } as any,
      });
      await audit({
        actor_user_id: req.user!.id,
        action: 'CREATE',
        entity_type: 'patient_item_usage',
        entity_id: created.id,
        after: { patient_id: patient.id, usage_kind: usageKind, size, group_key: groupKey },
      });

      return res.json({
        auto: true,
        action: 'USAGE_REGISTERED',
        usage_kind: usageKind,
        size,
        group_key: groupKey,
        patient_item_usage_id: created.id,
      });
    }

    // ── C. 처치 등록 분기 ────────────────────────────────────
    const supplyMaps = await prisma.treatmentSupplyMap.findMany({
      where: { item_id: item.id },
      include: { treatment_type: { select: { id: true, name: true, is_active: true } } },
    });
    const candidates = supplyMaps
      .filter(m => m.treatment_type?.is_active !== false)
      .map(m => ({ treatment_type_id: m.treatment_type_id, name: m.treatment_type?.name ?? '' }));

    if (candidates.length === 0) {
      return res.status(400).json({
        error: '이 품목은 처치 매핑이 없어 환자별 사용 추적이 불가합니다.',
        item_name: item.name,
      });
    }

    let chosen: string | null = treatmentTypeIdInput;

    // 사용자가 명시한 경우 candidates 안에 있는지 검증
    if (chosen && !candidates.some(c => c.treatment_type_id === chosen)) {
      return res.status(400).json({ error: '지정한 처치는 이 품목의 매핑에 속하지 않습니다.' });
    }

    if (!chosen) {
      // 단서 1: 매핑이 1개?
      if (candidates.length === 1) {
        chosen = candidates[0].treatment_type_id;
      }
    }

    if (!chosen) {
      // 단서 2: 환자 활성 처치 ∩ 품목 매핑 = 1개?
      const activeTreatments = await prisma.patientTreatment.findMany({
        where: {
          patient_id: patient.id,
          deleted_at: null,
          OR: [{ ended_at: null }, { ended_at: { gt: new Date() } }],
        },
        select: { treatment_type_id: true },
      });
      const activeIds = new Set(activeTreatments.map(t => t.treatment_type_id));
      const intersect = candidates.filter(c => activeIds.has(c.treatment_type_id));
      if (intersect.length === 1) {
        chosen = intersect[0].treatment_type_id;
      }
    }

    if (!chosen) {
      // 단서 3: Item.default_treatment_type_id 가 candidates 에 포함?
      if (item.default_treatment_type_id && candidates.some(c => c.treatment_type_id === item.default_treatment_type_id)) {
        chosen = item.default_treatment_type_id;
      }
    }

    if (!chosen) {
      // 자동 추론 실패 — candidates 반환, UI 가 popup 으로 사용자 선택
      return res.json({ auto: false, candidates });
    }

    // 이미 활성 PatientTreatment 가 있으면 noop
    const existing = await prisma.patientTreatment.findFirst({
      where: {
        patient_id: patient.id,
        treatment_type_id: chosen,
        deleted_at: null,
        OR: [{ ended_at: null }, { ended_at: { gt: new Date() } }],
      },
      select: { id: true },
    });
    if (existing) {
      return res.json({
        auto: true,
        action: 'NOOP',
        treatment_type_id: chosen,
        patient_treatment_id: existing.id,
        message: '이미 등록된 처치입니다.',
      });
    }

    const created = await prisma.patientTreatment.create({
      data: {
        id: uuidv4(),
        patient_id: patient.id,
        treatment_type_id: chosen,
        started_at: new Date(),
        note: `신청 시점 폴백: ${item.name}`,
        created_by: req.user!.id,
      } as any,
    });
    await audit({
      actor_user_id: req.user!.id,
      action: 'CREATE',
      entity_type: 'patient_treatments',
      entity_id: created.id,
      after: { patient_id: patient.id, treatment_type_id: chosen },
    });

    res.json({
      auto: true,
      action: 'TREATMENT_ADDED',
      treatment_type_id: chosen,
      patient_treatment_id: created.id,
    });
  } catch (e) {
    console.error('[POST /patient-item-mapping/auto] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

/**
 * 환자×품목 매핑 해제 — /auto 의 역연산.
 *
 *   A. 기저귀 카테고리 → Patient.diaper_state = 'NONE'
 *   B. 호흡·삽관/카테터 (usage_kind) → PatientItemUsage.ended_at = now()
 *   C. 처치 등록 → PatientTreatment.ended_at = now()
 */
router.post('/remove', requirePermission('REQUEST_USE'), async (req: AuthRequest, res) => {
  try {
    const patientId = String(req.body.patient_id ?? '').trim();
    const itemId = String(req.body.item_id ?? '').trim();
    if (!patientId || !itemId) return res.status(400).json({ error: 'patient_id, item_id 가 필요합니다.' });

    const patient = await prisma.patient.findUnique({
      where: { id: patientId },
      select: { id: true, name: true, diaper_state: true, deleted_at: true },
    });
    if (!patient || patient.deleted_at) return res.status(404).json({ error: '환자를 찾을 수 없습니다.' });

    const item = await prisma.item.findUnique({
      where: { id: itemId },
      select: { id: true, name: true, category: true, deleted_at: true },
    });
    if (!item || item.deleted_at) return res.status(404).json({ error: '품목을 찾을 수 없습니다.' });

    // ── A. 기저귀 카테고리 ─────────────────────────────────
    if (item.category && item.category.startsWith('DIAPER')) {
      if (patient.diaper_state !== 'IN_HOUSE') {
        return res.json({ removed: false, action: 'NOOP', message: '원내 기저귀 사용자가 아닙니다.' });
      }
      const before = patient.diaper_state;
      await prisma.patient.update({
        where: { id: patient.id },
        data: { diaper_state: 'NONE' } as any,
      });
      await audit({
        actor_user_id: req.user!.id,
        action: 'UPDATE',
        entity_type: 'patients',
        entity_id: patient.id,
        before: { diaper_state: before },
        after: { diaper_state: 'NONE' },
        reason: `사용 환자 해제: ${item.name}`,
      });
      return res.json({ removed: true, action: 'DIAPER_DISABLED' });
    }

    // ── B. usage_kind 매핑 (호흡·삽관 / 카테터·튜브 등) ─────
    const usageKind = inferUsageKind({ name: item.name, category: item.category });
    if (usageKind) {
      const rows = await prisma.patientItemUsage.findMany({
        where: {
          patient_id: patient.id,
          usage_kind: usageKind,
          ended_at: null,
        },
        select: { id: true, size: true },
      });
      if (rows.length === 0) {
        return res.json({ removed: false, action: 'NOOP', message: '등록된 사용 기록이 없습니다.' });
      }
      const now = new Date();
      for (const r of rows) {
        await prisma.patientItemUsage.update({
          where: { id: r.id },
          data: { ended_at: now },
        });
        await audit({
          actor_user_id: req.user!.id,
          action: 'UPDATE',
          entity_type: 'patient_item_usage',
          entity_id: r.id,
          after: { ended_at: now.toISOString() },
          reason: `사용 환자 해제: ${item.name}`,
        });
      }
      return res.json({ removed: true, action: 'USAGE_ENDED', count: rows.length });
    }

    // ── C. 처치 매핑 ─────────────────────────────────────
    const supplyMaps = await prisma.treatmentSupplyMap.findMany({
      where: { item_id: item.id },
      select: { treatment_type_id: true },
    });
    const candidateTreatmentIds = supplyMaps.map(m => m.treatment_type_id);
    if (candidateTreatmentIds.length === 0) {
      return res.status(400).json({ error: '이 품목은 환자 매핑이 없는 품목입니다.' });
    }
    const activeTreatments = await prisma.patientTreatment.findMany({
      where: {
        patient_id: patient.id,
        treatment_type_id: { in: candidateTreatmentIds },
        deleted_at: null,
        OR: [{ ended_at: null }, { ended_at: { gt: new Date() } }],
      },
      select: { id: true, treatment_type_id: true },
    });
    if (activeTreatments.length === 0) {
      return res.json({ removed: false, action: 'NOOP', message: '등록된 처치가 없습니다.' });
    }
    const now = new Date();
    for (const t of activeTreatments) {
      await prisma.patientTreatment.update({
        where: { id: t.id },
        data: { ended_at: now },
      });
      await audit({
        actor_user_id: req.user!.id,
        action: 'UPDATE',
        entity_type: 'patient_treatments',
        entity_id: t.id,
        after: { ended_at: now.toISOString() },
        reason: `사용 환자 해제: ${item.name}`,
      });
    }
    return res.json({ removed: true, action: 'TREATMENT_ENDED', count: activeTreatments.length });
  } catch (e) {
    console.error('[POST /patient-item-mapping/remove] error', e);
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;
