import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, resolveDeptScope, isCustomMenuUser, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('patient-stats', 'PURCHASE_MANAGE', 'STATS_VIEW', 'REQUEST_USE', 'SYSTEM_ADMIN'));

function resolveRequestedDept(req: AuthRequest, rawDepartmentId: unknown): string {
  const customMenuUser = isCustomMenuUser(req.user);
  const hasPatientStatsMenu = (req.user?.menu_permissions ?? []).includes('patient-stats');
  const scope = customMenuUser && hasPatientStatsMenu
    ? { is_all: true, department_id: req.user?.department_id ?? null }
    : resolveDeptScope(req);
  const requested = rawDepartmentId ? String(rawDepartmentId) : '';
  if (!scope.is_all) {
    if (requested && scope.department_id && requested !== scope.department_id) {
      throw new Error('FORBIDDEN_DEPARTMENT');
    }
    return scope.department_id ?? '';
  }
  return requested;
}

router.get('/', async (req: AuthRequest, res) => {
  try {
    const { department_id, period_type, year_month } = req.query;

    let scopedDeptId = '';
    try {
      scopedDeptId = resolveRequestedDept(req, department_id);
    } catch {
      return res.status(403).json({ error: '해당 부서 데이터에 접근할 수 없습니다.' });
    }

    const where: any = { deleted_at: null };
    if (scopedDeptId) where.department_id = scopedDeptId;
    if (period_type) where.period_type = String(period_type);
    if (year_month) {
      const [y, m] = String(year_month).split('-');
      where.period_start = { gte: new Date(`${y}-${m}-01`) };
    }

    const stats = await prisma.patientStat.findMany({
      where,
      include: { department: true },
      orderBy: [{ department: { name: 'asc' } }, { period_start: 'desc' }],
    });

    res.json(
      stats.map((s) => ({
        id: s.id,
        department_id: s.department_id,
        department_name: s.department.name,
        period_type: s.period_type,
        period_start: s.period_start,
        period_end: s.period_end,
        patient_count: s.patient_count,
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.post('/', requirePermission('STATS_VIEW'), async (req: AuthRequest, res) => {
  const { department_id, period_type, period_start, period_end, patient_count } = req.body;
  if (!department_id || !period_start || patient_count === undefined) {
    return res.status(400).json({ error: '부서, 기간 시작, 환자 수는 필수입니다.' });
  }

  try {
    let scopedDeptId = '';
    try {
      scopedDeptId = resolveRequestedDept(req, department_id);
    } catch {
      return res.status(403).json({ error: '해당 부서 데이터에 접근할 수 없습니다.' });
    }
    if (!scopedDeptId) return res.status(400).json({ error: 'department_id is required.' });

    const stat = await prisma.patientStat.upsert({
      where: {
        department_id_period_type_period_start: {
          department_id: scopedDeptId,
          period_type: period_type ?? 'MONTH',
          period_start: new Date(period_start),
        },
      },
      update: { patient_count, period_end: new Date(period_end ?? period_start) },
      create: {
        id: uuidv4(),
        department_id: scopedDeptId,
        period_type: period_type ?? 'MONTH',
        period_start: new Date(period_start),
        period_end: new Date(period_end ?? period_start),
        patient_count,
      },
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'CREATE',
      entity_type: 'patient_stats',
      entity_id: stat.id,
      after: stat,
    });
    res.status(201).json(stat);
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.delete('/:id', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const customMenuUser = isCustomMenuUser(req.user);
    if (isCustomMenuUser(req.user) && !req.user?.permissions.includes('SYSTEM_ADMIN')) {
      return res.status(403).json({ error: '관리자만 삭제할 수 있습니다.' });
    }

    const statId = String(req.params.id);
    const stat = await prisma.patientStat.findUnique({ where: { id: statId } });
    if (!stat) return res.status(404).json({ error: '통계를 찾을 수 없습니다.' });

    await prisma.patientStat.update({ where: { id: statId }, data: { deleted_at: new Date() } });
    await audit({
      actor_user_id: req.user!.id,
      action: 'SOFT_DELETE',
      entity_type: 'patient_stats',
      entity_id: statId,
      before: stat,
    });
    res.json({ message: '삭제되었습니다.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;


