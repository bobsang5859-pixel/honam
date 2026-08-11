/**
 * 테스트 데이터 시드 / 현황 / 삭제 API
 *
 * - 신청 단계 시드만 박아두고, 사용자가 직접 승인→발주→입고→불출을 클릭하며 흐름 체험
 * - is_test 플래그가 자동 전파되어 통계에서 제외
 * - 삭제 시 cascade + inventory 원복 (입고로 늘었던 만큼 차감, 불출로 줄었던 만큼 복원)
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requirePermission, AuthRequest } from '../middleware/auth';
import { audit, generateNo, nextSeq } from '../utils/audit';

const router = Router();
router.use(authMiddleware);
router.use(requirePermission('SYSTEM_ADMIN', 'PURCHASE_MANAGE'));

// ─── GET /api/test-data/status ──────────────────────────────────────────────
// 현재 존재하는 테스트 row 개수를 단계별로 반환
router.get('/status', async (_req: AuthRequest, res) => {
  try {
    const [wr, po, gr, so] = await Promise.all([
      prisma.wardRequest.count({ where: { is_test: true, deleted_at: null } }),
      prisma.purchaseOrder.count({ where: { is_test: true, deleted_at: null } }),
      prisma.goodsReceipt.count({ where: { is_test: true, deleted_at: null } }),
      prisma.stockOut.count({ where: { is_test: true, deleted_at: null } }),
    ]);
    res.json({ ward_requests: wr, purchase_orders: po, goods_receipts: gr, stock_outs: so });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '서버 오류' });
  }
});

// ─── POST /api/test-data/seed ───────────────────────────────────────────────
// 시드 시나리오 — 사용자 부서가 있는 부서 중 첫 두 개 부서에 정기 소모품 신청 1건씩 생성
router.post('/seed', async (req: AuthRequest, res) => {
  try {
    // 활성 부서 중 "총무"/"창고"가 들어간 중앙 창고 제외, 활성 신청자 부서 2개 선정
    const allDepts = await prisma.department.findMany({
      where: { is_active: true, deleted_at: null },
      orderBy: { name: 'asc' },
    });
    const requesterDepts = allDepts.filter(d => !d.name.includes('총무') && !d.name.includes('창고')).slice(0, 2);
    if (requesterDepts.length === 0) return res.status(400).json({ error: '시드용 신청자 부서가 없습니다.' });

    // 활성 품목 중 임의 5개
    const items = await prisma.item.findMany({
      where: { is_active: true, deleted_at: null },
      take: 5,
      orderBy: { name: 'asc' },
    });
    if (items.length === 0) return res.status(400).json({ error: '시드용 품목이 없습니다.' });

    // 한 달치 기간으로 신청
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const created: { id: string; request_no: string; department_name: string }[] = [];
    for (const dept of requesterDepts) {
      const seq = await nextSeq('ward_requests');
      const request_no = generateNo('WR', seq);
      const wr = await prisma.wardRequest.create({
        data: {
          id: uuidv4(),
          request_no,
          department_id: dept.id,
          requester_id: req.user!.id,
          period_type: 'MONTH',
          period_start: periodStart,
          period_end: periodEnd,
          request_type: 'CONSUMABLE_REGULAR',
          is_emergency: false,
          is_test: true,
          status: 'SUBMITTED',
          submitted_at: now,
          items: {
            create: items.map((it, idx) => ({
              id: uuidv4(),
              item_id: it.id,
              requested_qty: 10 + idx * 5, // 10, 15, 20, 25, 30
              current_stock_qty: idx + 1, // 임의 초기값
              note: '[TEST 시드]',
            })),
          },
        },
        include: { department: { select: { name: true } } },
      });
      created.push({ id: wr.id, request_no: wr.request_no, department_name: wr.department?.name ?? '' });
    }

    await audit({
      actor_user_id: req.user?.id ?? null,
      action: 'CREATE',
      entity_type: 'test_data_seed',
      entity_id: 'seed',
      after: { created_count: created.length, request_nos: created.map(c => c.request_no) },
    });
    res.json({ message: `${created.length}건의 테스트 신청이 생성되었습니다.`, items: created });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message || '서버 오류' });
  }
});

// ─── DELETE /api/test-data ──────────────────────────────────────────────────
// 모든 테스트 데이터 삭제 + 영향받은 inventory 원복
router.delete('/', async (req: AuthRequest, res) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1) 테스트 StockOut → inventory.on_hand_qty 복원 + lot remaining_qty 복원 + cascade 삭제
      const testStockOuts = await tx.stockOut.findMany({
        where: { is_test: true, deleted_at: null },
        include: {
          items: true,
          lot_allocations: true,
        },
      });
      for (const so of testStockOuts) {
        for (const it of so.items) {
          // inventory에 issued_qty 복원
          const inv = await tx.inventory.findUnique({
            where: { item_id_location_id: { item_id: it.item_id, location_id: it.location_id } },
          });
          if (inv) {
            await tx.inventory.update({
              where: { id: inv.id },
              data: { on_hand_qty: { increment: Number(it.issued_qty) } },
            });
          }
        }
        for (const alloc of so.lot_allocations) {
          if (alloc.inventory_lot_id) {
            await tx.inventoryLot.update({
              where: { id: alloc.inventory_lot_id },
              data: { remaining_qty: { increment: Number(alloc.issued_qty) } },
            });
          }
        }
        await tx.stockOutLotAllocation.deleteMany({ where: { stock_out_id: so.id } });
        await tx.stockOutItem.deleteMany({ where: { stock_out_id: so.id } });
      }
      const stockOutDeleted = await tx.stockOut.deleteMany({ where: { is_test: true } });

      // 2) 테스트 GoodsReceipt → inventory 차감 + lot 삭제 + cascade 삭제
      const testGRs = await tx.goodsReceipt.findMany({
        where: { is_test: true, deleted_at: null },
        include: { stock_in_items: true, inventory_lots: true },
      });
      for (const gr of testGRs) {
        for (const sii of gr.stock_in_items) {
          const inv = await tx.inventory.findUnique({
            where: { item_id_location_id: { item_id: sii.item_id, location_id: sii.location_id } },
          });
          if (inv) {
            await tx.inventory.update({
              where: { id: inv.id },
              data: { on_hand_qty: { decrement: Number(sii.received_qty) } },
            });
          }
        }
        await tx.inventoryLot.deleteMany({ where: { goods_receipt_id: gr.id } });
        await tx.stockInItem.deleteMany({ where: { goods_receipt_id: gr.id } });
      }
      const grDeleted = await tx.goodsReceipt.deleteMany({ where: { is_test: true } });

      // 3) 테스트 PurchaseOrder cascade
      const testPOs = await tx.purchaseOrder.findMany({ where: { is_test: true, deleted_at: null } });
      for (const po of testPOs) {
        await tx.purchaseOrderItem.deleteMany({ where: { purchase_order_id: po.id } });
        await tx.purchaseOrderSource.deleteMany({ where: { po_id: po.id } });
      }
      const poDeleted = await tx.purchaseOrder.deleteMany({ where: { is_test: true } });

      // 4) 테스트 WardRequest cascade (approval_actions, ward_request_items)
      const testWRs = await tx.wardRequest.findMany({ where: { is_test: true, deleted_at: null } });
      for (const wr of testWRs) {
        const approvals = await tx.approvalAction.findMany({ where: { ward_request_id: wr.id } });
        for (const aa of approvals) {
          await tx.approvalActionItem.deleteMany({ where: { approval_action_id: aa.id } });
        }
        await tx.approvalAction.deleteMany({ where: { ward_request_id: wr.id } });
        await tx.wardRequestItem.deleteMany({ where: { ward_request_id: wr.id } });
        await tx.purchaseOrderSource.deleteMany({ where: { ward_request_id: wr.id } });
      }
      const wrDeleted = await tx.wardRequest.deleteMany({ where: { is_test: true } });

      return {
        stock_outs: stockOutDeleted.count,
        goods_receipts: grDeleted.count,
        purchase_orders: poDeleted.count,
        ward_requests: wrDeleted.count,
      };
    }, { timeout: 30000 });

    await audit({
      actor_user_id: req.user?.id ?? null,
      action: 'DELETE',
      entity_type: 'test_data',
      entity_id: 'all',
      after: result,
    });
    res.json({ message: '테스트 데이터 삭제 + 재고 원복 완료', deleted: result });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message || '삭제 실패' });
  }
});

export default router;
