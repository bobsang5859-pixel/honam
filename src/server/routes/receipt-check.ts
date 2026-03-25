import { Router } from 'express';
import { AuthRequest, authMiddleware, requireMenuAccess, requirePermission, resolveDeptScope } from '../middleware/auth';
import { audit } from '../utils/audit';
import {
  ReceiptServiceError,
  confirmReceipt,
  getReceiptDetail,
  listReceiptFollowUps,
  listReceiptQueue,
  saveReceiptLine,
} from '../services/stock-out-receipt-service';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('receipt-check', 'REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'));

function isAdminLike(req: AuthRequest): boolean {
  return resolveDeptScope(req).is_all;
}

function buildViewer(req: AuthRequest) {
  return {
    user_id: String(req.user?.id ?? ''),
    department_id: req.user?.department_id ?? null,
    is_admin_like: isAdminLike(req),
  };
}

router.get('/', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const queue = await listReceiptQueue({
      status_query: req.query.status == null ? undefined : String(req.query.status),
      department_id_query: req.query.department_id == null ? undefined : String(req.query.department_id),
      overdue_only: req.query.overdue_only,
      viewer: buildViewer(req),
    });
    res.json(queue);
  } catch (e: any) {
    if (e instanceof ReceiptServiceError) {
      return res.status(e.status).json({ error: e.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const detail = await getReceiptDetail(String(req.params.id), buildViewer(req));
    res.json(detail);
  } catch (e: any) {
    if (e instanceof ReceiptServiceError) {
      return res.status(e.status).json({ error: e.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/lines/:itemId', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const updated = await saveReceiptLine({
      stock_out_id: String(req.params.id),
      item_id: String(req.params.itemId),
      received_qty: Number(req.body?.received_qty),
      receipt_note: String(req.body?.receipt_note ?? '').trim(),
      viewer: buildViewer(req),
    });
    res.json(updated);
  } catch (e: any) {
    if (e instanceof ReceiptServiceError) {
      return res.status(e.status).json({ error: e.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/confirm', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const stockOutId = String(req.params.id);
    const result = await confirmReceipt({
      stock_out_id: stockOutId,
      viewer: buildViewer(req),
    });

    await audit({
      actor_user_id: req.user!.id,
      action: 'CONFIRM_RECEIPT',
      entity_type: 'stock_out',
      entity_id: stockOutId,
      after: {
        status: result.status,
        receipt_diff_count: result.receipt_diff_count,
        follow_up_count: result.follow_up_count,
      },
    });

    res.json({
      message: 'Receipt confirmation completed.',
      status: result.status,
      receipt_diff_count: result.receipt_diff_count,
      follow_up_count: result.follow_up_count,
      follow_up_ids: result.follow_up_ids,
    });
  } catch (e: any) {
    if (e instanceof ReceiptServiceError) {
      return res.status(e.status).json({ error: e.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id/follow-ups', requirePermission('REQUEST_USE', 'PURCHASE_MANAGE', 'SYSTEM_ADMIN'), async (req: AuthRequest, res) => {
  try {
    const rows = await listReceiptFollowUps(String(req.params.id), buildViewer(req));
    res.json(rows);
  } catch (e: any) {
    if (e instanceof ReceiptServiceError) {
      return res.status(e.status).json({ error: e.message });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
