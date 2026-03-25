import { Router } from 'express';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import {
  WorkGroupPolicy,
  DeptDefaultPolicy,
  getWorkGroupPolicies,
  setWorkGroupPolicies,
  getDeptDefaultPolicies,
  setDeptDefaultPolicies,
  getUserPolicyOverride,
  setUserPolicyOverride,
  previewUserMenuPolicy,
} from '../services/menu-policy-service';
import { audit } from '../utils/audit';

const router = Router();
router.use(authMiddleware);
router.use(requirePermission('BASIC_MANAGE', 'SYSTEM_ADMIN'));

router.get('/groups', async (_req, res) => {
  try {
    const groups = await getWorkGroupPolicies();
    res.json(groups);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/groups', async (req: AuthRequest, res) => {
  try {
    const payload = Array.isArray(req.body?.groups) ? req.body.groups : [];
    const before = await getWorkGroupPolicies();
    const after = await setWorkGroupPolicies(payload as WorkGroupPolicy[]);

    await audit({
      actor_user_id: req.user?.id ?? null,
      action: 'UPDATE',
      entity_type: 'menu_policy_groups',
      entity_id: 'menu_policy:groups',
      before,
      after,
    });

    res.json(after);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/dept-defaults', async (_req, res) => {
  try {
    const defaults = await getDeptDefaultPolicies();
    res.json(defaults);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/dept-defaults', async (req: AuthRequest, res) => {
  try {
    const payload = Array.isArray(req.body?.defaults) ? req.body.defaults : [];
    const before = await getDeptDefaultPolicies();
    const after = await setDeptDefaultPolicies(payload as DeptDefaultPolicy[]);

    await audit({
      actor_user_id: req.user?.id ?? null,
      action: 'UPDATE',
      entity_type: 'menu_policy_dept_defaults',
      entity_id: 'menu_policy:dept_defaults',
      before,
      after,
    });

    res.json(after);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/users/:userId', async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const override = await getUserPolicyOverride(userId);
    res.json(override);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.put('/users/:userId', async (req: AuthRequest, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const before = await getUserPolicyOverride(userId);
    const after = await setUserPolicyOverride(userId, {
      add_group_keys: req.body?.add_group_keys,
      remove_group_keys: req.body?.remove_group_keys,
      include_menu_keys: req.body?.include_menu_keys,
      exclude_menu_keys: req.body?.exclude_menu_keys,
    });

    await audit({
      actor_user_id: req.user?.id ?? null,
      action: 'UPDATE',
      entity_type: 'menu_policy_user_override',
      entity_id: userId,
      before,
      after,
    });

    res.json(after);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

router.get('/preview/:userId', async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const preview = await previewUserMenuPolicy(userId);
    res.json(preview);
  } catch (e: any) {
    if (String(e?.message || '') === 'USER_NOT_FOUND') {
      return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    }
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

export default router;

