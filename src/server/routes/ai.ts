/**
 * AI 어시스턴트 API 라우트
 */
import { Router, Request, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { checkModelReady, parseCommand } from '../services/llm-service';
import { routeIntent, executeConfirmedAction, cancelPendingAction } from '../services/ai-function-router';

const router = Router();

function getUser(req: Request): { id: string; department_id: string } | null {
  const u = (req as any).user;
  if (!u) return null;
  return { id: u.id, department_id: u.department_id || '' };
}

/**
 * GET /api/ai/status — AI 서비스 상태 확인
 */
router.get('/status', authMiddleware, async (_req: Request, res: Response) => {
  const modelReady = await checkModelReady();
  res.json({ ok: true, model_ready: modelReady });
});

/**
 * POST /api/ai/command — 텍스트 명령 처리
 * body: { message: string }
 */
router.post('/command', authMiddleware, async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { message } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    // 1. LLM으로 의도 파악
    const parsed = await parseCommand(message);

    // 2. 의도에 맞는 API 호출
    const result = await routeIntent(parsed, user.id);

    return res.json({
      ok: true,
      intent: parsed.intent,
      ...result,
    });
  } catch (err) {
    console.error('AI command error:', err);
    return res.status(500).json({ error: '처리 중 오류가 발생했습니다.' });
  }
});

/**
 * POST /api/ai/confirm/:id — 확인 대기 명령 실행
 */
router.post('/confirm/:id', authMiddleware, async (req: Request, res: Response) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { id } = req.params;

  try {
    const result = await executeConfirmedAction(id as string, user.id);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('AI confirm error:', err);
    return res.status(500).json({ error: '실행 중 오류가 발생했습니다.' });
  }
});

/**
 * DELETE /api/ai/confirm/:id — 확인 대기 명령 취소
 */
router.delete('/confirm/:id', authMiddleware, async (req: Request, res: Response) => {
  const { id } = req.params;
  const cancelled = cancelPendingAction(id as string);
  return res.json({ ok: true, cancelled });
});

export default router;
