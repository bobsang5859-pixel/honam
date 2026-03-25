import { Router } from 'express';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit } from '../utils/audit';
import path from 'path';
import fs from 'fs';

const router = Router();

// Public endpoint — no auth required (used by LoginPage before login)
router.get('/public-info', async (_req, res) => {
  try {
    const keys = ['HOSPITAL_NAME', 'APP_NAME'];
    const rows = await prisma.appSetting.findMany({ where: { key: { in: keys } } });
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    res.json({
      hospital_name: map['HOSPITAL_NAME'] ?? '병원',
      app_name: map['APP_NAME'] ?? '물품 관리 시스템',
    });
  } catch {
    res.json({ hospital_name: '병원', app_name: '물품 관리 시스템' });
  }
});

router.use(authMiddleware);

router.get('/settings', requirePermission('SYSTEM_ADMIN'), async (req, res) => {
  try {
    const settings = await prisma.appSetting.findMany({ orderBy: { key: 'asc' } });
    res.json(settings.map(s => ({ key: s.key, value: s.value, description: s.description ?? '' })));
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// PUT /settings (body: { key, value })
router.put('/settings', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) return res.status(400).json({ error: 'key와 value는 필수입니다.' });
  try {
    const before = await prisma.appSetting.findUnique({ where: { key } });
    const after = await prisma.appSetting.upsert({
      where: { key },
      update: { value: String(value) },
      create: { id: require('uuid').v4(), key, value: String(value) },
    });
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'app_settings', entity_id: key, before, after });
    res.json(after);
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

router.put('/settings/:key', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: '값은 필수입니다.' });
  try {
    const before = await prisma.appSetting.findUnique({ where: { key: req.params.key } });
    const after = await prisma.appSetting.upsert({
      where: { key: req.params.key },
      update: { value: String(value) },
      create: { id: require('uuid').v4(), key: req.params.key, value: String(value) },
    });
    await audit({ actor_user_id: req.user!.id, action: 'UPDATE', entity_type: 'app_settings', entity_id: req.params.key, before, after });
    res.json(after);
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// Webhook 테스트 전송
router.post('/webhook-test', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const { emitEvent, validateWebhookUrl } = await import('../services/webhook-service');
    // 현재 저장된 URL 검증
    const setting = await prisma.appSetting.findUnique({ where: { key: 'N8N_WEBHOOK_URL' } });
    const url = setting?.value?.trim() || '';
    if (!url) return res.status(400).json({ error: 'Webhook URL이 설정되지 않았습니다.' });
    const validation = validateWebhookUrl(url);
    if (!validation.valid) return res.status(400).json({ error: validation.reason });
    await emitEvent('FORECAST_ALERT', { test: true, message: 'Webhook 테스트 전송', timestamp: new Date().toISOString() });
    res.json({ message: '테스트 이벤트 전송 완료' });
  } catch (e) {
    res.status(500).json({ error: '전송 실패' });
  }
});

router.post('/backup', requirePermission('SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const dbPath = process.env.DATABASE_URL?.replace('file:', '') ?? './prisma/hospital-supply.db';
    const backupDir = path.join(process.env.USER_DATA_PATH ?? '.', 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupDir, `backup-${timestamp}.db`);
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, backupPath);
      const record = await prisma.backupRecord.create({
        data: { id: require('uuid').v4(), file_path: backupPath, note: req.body.note ?? '수동 백업' },
      });
      await audit({ actor_user_id: req.user!.id, action: 'CREATE', entity_type: 'backup_records', entity_id: backupPath });
      res.json(record);
    } else {
      res.status(404).json({ error: 'DB 파일을 찾을 수 없습니다.' });
    }
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

router.get('/backups', requirePermission('SYSTEM_ADMIN'), async (req, res) => {
  try {
    const records = await prisma.backupRecord.findMany({ orderBy: { created_at: 'desc' }, take: 30 });
    res.json(records);
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

router.get('/backups/:id/download', requirePermission('SYSTEM_ADMIN'), async (req, res) => {
  try {
    const record = await prisma.backupRecord.findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ error: '백업 파일을 찾을 수 없습니다.' });
    if (!fs.existsSync(record.file_path)) return res.status(404).json({ error: '백업 파일이 디스크에 없습니다.' });
    const filename = path.basename(record.file_path);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(record.file_path);
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// GET /module-visibility — 인증된 모든 사용자가 접근 가능 (사이드바 필터링용)
router.get('/module-visibility', async (_req, res) => {
  try {
    const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: 'module:' } } });
    const result: Record<string, boolean> = {};
    for (const r of rows) {
      const id = r.key.replace('module:', '');
      result[id] = r.value !== 'false';
    }
    res.json(result);
  } catch { res.json({}); }
});

// GET /module-access — 모듈별 활성화 여부 + 허용 부서 (Layout 필터링용)
router.get('/module-access', async (_req, res) => {
  try {
    const rows = await prisma.appSetting.findMany({
      where: { key: { startsWith: 'module' } },
    });
    const result: Record<string, { enabled: boolean; depts: string[] }> = {};
    for (const r of rows) {
      if (r.key.startsWith('module:')) {
        const id = r.key.replace('module:', '');
        if (!result[id]) result[id] = { enabled: true, depts: ['ALL'] };
        result[id].enabled = r.value !== 'false';
      } else if (r.key.startsWith('module_depts:')) {
        const id = r.key.replace('module_depts:', '');
        if (!result[id]) result[id] = { enabled: true, depts: ['ALL'] };
        try { result[id].depts = JSON.parse(r.value); } catch { result[id].depts = ['ALL']; }
      }
    }
    res.json(result);
  } catch { res.json({}); }
});

export default router;
