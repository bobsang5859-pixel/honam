import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';
import { authMiddleware, requireMenuAccess, requirePermission, isCustomMenuUser, AuthRequest } from '../middleware/auth';
import { audit, generateNo, nextSeq } from '../utils/audit';
import { performDirectStockOut } from '../services/stock-out-service';

const router = Router();
router.use(authMiddleware);
router.use(requireMenuAccess('approvals', 'PURCHASE_MANAGE'));

function isScopedToSelfDepartment(req: AuthRequest): boolean {
  const customMenuUser = isCustomMenuUser(req.user);
  const isAdmin = req.user?.permissions.includes('SYSTEM_ADMIN') ?? false;
  return customMenuUser && !isAdmin;
}

// 승인 목록 조회
router.get('/', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const { status, request_type } = req.query;
    const statusVal    = status ? String(status) : 'SUBMITTED';
    const statusFilter = statusVal === 'ALL' ? undefined : statusVal;
    const requests = await prisma.wardRequest.findMany({
      where: {
        deleted_at: null,
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(request_type ? { request_type: String(request_type) } : {}),
        ...(isScopedToSelfDepartment(req) && req.user?.department_id ? { department_id: req.user.department_id } : {}),
      },
      include: {
        department: true,
        requester: true,
        items: {
          include: {
            item: {
              include: {
                price_history: { orderBy: { effective_from: 'desc' }, take: 1 },
                inventory: true,
              },
            },
          },
        },
        approval_actions: {
          include: { approver: true },
          orderBy: { created_at: 'desc' },
          take: 1,
        },
      },
      orderBy: [{ is_emergency: 'desc' }, { submitted_at: 'asc' }],
    });

    res.json(requests.map(r => ({
      id: r.id,
      request_no: r.request_no,
      department_name: (r as any).department?.name,
      requester_name: (r as any).requester?.display_name,
      period_start: r.period_start,
      period_end: r.period_end,
      status: r.status,
      request_type: r.request_type,
      is_emergency: r.is_emergency,
      submitted_at: r.submitted_at,
      item_count: r.items.length,
      has_flags: r.items.some((it: any) => {
        const flags = JSON.parse(it.policy_flags ?? '[]');
        return flags.length > 0;
      }),
      last_action: (r as any).approval_actions?.[0] ? {
        action: (r as any).approval_actions[0].action,
        approver_name: (r as any).approval_actions[0].approver?.display_name,
      } : null,
    })));
  } catch (e) { res.status(500).json({ error: '서버 오류' }); }
});

// 승인 상세 (품목별 diff 포함)
router.get('/:requestId', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  try {
    const r: any = await prisma.wardRequest.findUnique({
      where: { id: String(req.params.requestId) },
      include: {
        department: true,
        requester: true,
        items: {
          include: {
            item: {
              include: {
                price_history: { orderBy: { effective_from: 'desc' }, take: 1 },
                inventory: true,
                vendor_maps: { include: { vendor: true }, where: { priority: 1 }, take: 1 },
              },
            },
          },
        },
        approval_actions: {
          include: { approver: true, items: { include: { item: true } } },
          orderBy: { created_at: 'desc' },
        },
      },
    });
    if (!r) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });

    // 최근 3개월 평균 단가 비교 (가격 변동 감지)
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    if (isScopedToSelfDepartment(req) && req.user?.department_id !== r.department_id) {
      return res.status(403).json({ error: '타 부서 신청은 조회할 수 없습니다.' });
    }

    const enrichedItems = await Promise.all(
      r.items.map(async (it: any) => {
        const recentPrices = await prisma.priceHistory.findMany({
          where: { item_id: it.item_id, effective_from: { gte: threeMonthsAgo } },
          orderBy: { effective_from: 'desc' },
        });
        const avgPrice = recentPrices.length > 0
          ? recentPrices.reduce((s, p) => s + Number(p.price), 0) / recentPrices.length
          : 0;
        const latestPrice = it.item.price_history?.[0] ? Number(it.item.price_history[0].price) : 0;
        const flags = JSON.parse(it.policy_flags ?? '[]');
        if (avgPrice > 0 && latestPrice > avgPrice * 1.1) flags.push('PRICE_UP_10PCT');

        return {
          id: it.id,
          item_id: it.item_id,
          item_code: it.item?.item_code,
          item_name: it.item?.name,
          uom: it.item?.uom,
          category: it.item?.category,
          requested_qty: Number(it.requested_qty),
          baseline_qty: Number(it.baseline_qty),
          diff_pct: Number(it.diff_pct),
          policy_flags: flags,
          note: it.note,
          latest_price: latestPrice,
          avg_3m_price: avgPrice,
          on_hand_qty: it.item?.inventory?.reduce((s: number, inv: any) => s + Number(inv.on_hand_qty), 0) ?? 0,
          vendor_name: it.item?.vendor_maps?.[0]?.vendor?.name ?? '',
        };
      })
    );

    res.json({
      id: r.id,
      request_no: r.request_no,
      department_id: r.department_id,
      department_name: (r as any).department?.name,
      requester_name: (r as any).requester?.display_name,
      period_start: r.period_start,
      period_end: r.period_end,
      status: r.status,
      request_type: r.request_type,
      equipment_request_type: (r as any).equipment_request_type ?? null,
      is_emergency: r.is_emergency,
      submitted_at: r.submitted_at,
      items: enrichedItems,
      approval_history: (r as any).approval_actions.map((a: any) => ({
        id: a.id,
        action: a.action,
        reason: a.reason,
        approver_name: a.approver?.display_name,
        created_at: a.created_at,
        items: a.items.map((ai: any) => ({
          item_name: ai.item?.name,
          requested_qty: Number(ai.requested_qty),
          approved_qty: Number(ai.approved_qty),
          diff_pct: Number(ai.diff_pct),
          policy_flags: JSON.parse(ai.policy_flags ?? '[]'),
        })),
      })),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

// 승인/조정/반려 처리
router.post('/:requestId/decide', requirePermission('PURCHASE_MANAGE'), async (req: AuthRequest, res) => {
  const { action, reason, items, approval_method } = req.body;
  const approvalMethod = String(approval_method ?? 'PO').toUpperCase() === 'STOCK_OUT' ? 'STOCK_OUT' : 'PO';
  const reasonText = String(reason ?? '').trim();

  if (!['APPROVE', 'ADJUST', 'REJECT'].includes(action))
    return res.status(400).json({ error: '유효하지 않은 액션입니다.' });
  if ((action === 'ADJUST' || action === 'REJECT') && !reasonText)
    return res.status(400).json({ error: '사유는 필수입니다.' });

  try {
    const wr: any = await prisma.wardRequest.findUnique({
      where: { id: String(req.params.requestId) },
      include: { items: true },
    });
    if (!wr) return res.status(404).json({ error: '신청을 찾을 수 없습니다.' });
    if (isScopedToSelfDepartment(req) && req.user?.department_id !== wr.department_id) {
      return res.status(403).json({ error: '타 부서 신청은 처리할 수 없습니다.' });
    }
    if (wr.status !== 'SUBMITTED')
      return res.status(400).json({ error: 'SUBMITTED 상태에서만 승인/반려 가능합니다.' });

    // OVER_15PCT 플래그가 있는데 reason이 짧은 경우 추가 체크
    const hasFlag = wr.items.some((it: any) => {
      const flags = JSON.parse(it.policy_flags ?? '[]');
      return flags.length > 0;
    });
    if ((action === 'ADJUST' || action === 'REJECT') && hasFlag && reasonText.length < 5)
      return res.status(400).json({ error: '정책 위반 항목이 있습니다. 5자 이상의 사유를 입력하세요.' });

    const itemsMap = new Map((items ?? []).map((i: any) => [i.item_id, i.approved_qty]));

    const newStatus = action === 'REJECT' ? 'REJECTED'
      : action === 'ADJUST' ? 'PARTIAL_APPROVED'
      : 'APPROVED';

    const AUTO_PO_TYPES = ['CONSUMABLE_REGULAR', 'DIAPER', 'NIGHT_SNACK', 'CONSUMABLE'];
    const isAutoPoType = AUTO_PO_TYPES.includes(wr.request_type);
    const isAdhoc = wr.request_type === 'ADHOC';
    const isEquipAddition = wr.request_type === 'EQUIPMENT' && (wr as any).equipment_request_type === 'ADDITION';
    const needStockOut = (isAdhoc || isEquipAddition) && approvalMethod === 'STOCK_OUT' && (action === 'APPROVE' || action === 'ADJUST');

    // 즉시불출 준비 (트랜잭션 내에서 함께 실행)
    let stockOutItems: { item_id: string; approved_qty: number }[] = [];
    if (needStockOut) {
      stockOutItems = wr.items
        .filter((it: any) => it.item_id)
        .map((it: any) => ({
          item_id: it.item_id,
          approved_qty: Number(itemsMap.get(it.item_id) ?? it.requested_qty),
        }))
        .filter((it: any) => it.approved_qty > 0);
    }

    // 승인 기록 + 상태 변경 + PO 생성 + 즉시불출을 하나의 트랜잭션으로 처리
    await prisma.$transaction(async (tx) => {
      // 즉시불출이 필요하면 동일 트랜잭션 내에서 실행
      if (needStockOut && stockOutItems.length > 0) {
        await performDirectStockOut({
          items: stockOutItems,
          department_id: wr.department_id,
          ward_request_id: String(req.params.requestId),
          issued_by: req.user!.id,
          tx,
        });
      }
      await tx.approvalAction.create({
        data: {
          id: uuidv4(),
          ward_request_id: String(req.params.requestId),
          approver_id: req.user!.id,
          action,
          reason: reasonText,
          items: {
            create: wr.items.map((it: any) => {
              const approvedQty = action === 'REJECT' ? 0
                : (it.item_id && itemsMap.get(it.item_id) !== undefined ? Number(itemsMap.get(it.item_id)) : Number(it.requested_qty));
              const baselineQty = Number(it.baseline_qty);
              const diffQty = approvedQty - Number(it.requested_qty);
              const diffPct = Number(it.requested_qty) > 0 ? (diffQty / Number(it.requested_qty)) * 100 : 0;
              return {
                id: uuidv4(),
                item_id: it.item_id || null,
                custom_name: it.custom_name ?? '',
                requested_qty: it.requested_qty,
                approved_qty: approvedQty,
                baseline_qty: baselineQty,
                diff_qty: diffQty,
                diff_pct: diffPct,
                policy_flags: it.policy_flags,
              };
            }),
          },
        },
      });

      await tx.wardRequest.update({
        where: { id: String(req.params.requestId) },
        data: { status: newStatus },
      });

      // 정기 3종류 + ADHOC(PO 선택) 시 자동 발주서 생성
      if ((isAutoPoType || ((isAdhoc || isEquipAddition) && approvalMethod !== 'STOCK_OUT')) && (action === 'APPROVE' || action === 'ADJUST')) {
        const typeNoteMap: Record<string, string> = {
          CONSUMABLE_REGULAR: '[AUTO] 정기소모품 승인 자동발주',
          DIAPER: '[AUTO] 기저귀 승인 자동발주',
          NIGHT_SNACK: '[AUTO] 야간당직간식 승인 자동발주',
          ADHOC: '[AUTO] 비정기 승인 자동발주',
          CONSUMABLE: '[AUTO] 소모품 승인 자동발주',
          EQUIPMENT: '[AUTO] 비품추가 승인 자동발주',
        };
        const autoNote = typeNoteMap[wr.request_type] ?? '[AUTO] 소모품 승인 자동발주';

        const itemIds = wr.items.filter((it: any) => it.item_id).map((it: any) => it.item_id);
        const itemRows = await tx.item.findMany({
          where: { id: { in: itemIds }, deleted_at: null, is_active: true },
          include: {
            default_vendor: true,
            vendor_maps: { orderBy: { priority: 'asc' }, include: { vendor: true } },
            price_history: { where: { effective_to: null }, orderBy: { effective_from: 'desc' }, take: 1 },
            inventory: true,
          },
        });
        const itemMap = new Map(itemRows.map((it: any) => [it.id, it]));
        const vendorBuckets = new Map<string, { item_id: string; ordered_qty: number; unit_price: number }[]>();

        for (const reqItem of wr.items as any[]) {
          const approvedQty = Number(itemsMap.get(reqItem.item_id) ?? reqItem.requested_qty);
          if (approvedQty <= 0) continue;
          const item = itemMap.get(reqItem.item_id);
          if (!item) continue;

          const onHand = (item.inventory || []).reduce((s: number, inv: any) => s + Number(inv.on_hand_qty), 0);
          let needed = Math.max(0, approvedQty - onHand);
          const minOrderQty = Math.max(1, Number(item.min_order_qty ?? 1));
          if (needed > 0 && needed < minOrderQty) needed = minOrderQty;
          if (needed <= 0) continue;

          const preferredVendorId = item.default_vendor_id
            || item.vendor_maps?.find((vm: any) => vm.vendor_id)?.vendor_id
            || item.price_history?.[0]?.vendor_id
            || null;
          if (!preferredVendorId) continue;
          const price = Number(item.price_history?.[0]?.price ?? 0);
          if (price <= 0) {
            console.warn(`[approvals] item ${item.id} (${item.name}) has no price, PO line will be 0원`);
          }

          const bucket = vendorBuckets.get(preferredVendorId) ?? [];
          const existing = bucket.find(b => b.item_id === item.id);
          if (existing) existing.ordered_qty += needed;
          else bucket.push({ item_id: item.id, ordered_qty: needed, unit_price: price });
          vendorBuckets.set(preferredVendorId, bucket);
        }

        for (const [vendorId, rows] of vendorBuckets.entries()) {
          let po = await tx.purchaseOrder.findFirst({
            where: {
              vendor_id: vendorId,
              status: 'DRAFT',
              deleted_at: null,
              note: { startsWith: autoNote },
            },
            orderBy: { ordered_at: 'desc' },
          });

          if (!po) {
            const seq = await nextSeq('purchase_orders');
            po = await tx.purchaseOrder.create({
              data: {
                id: uuidv4(),
                po_no: generateNo('PO', seq),
                vendor_id: vendorId,
                created_by: req.user!.id,
                status: 'DRAFT',
                note: autoNote,
                total_amount: 0,
              } as any,
            });
          }

          for (const row of rows) {
            const current = await tx.purchaseOrderItem.findUnique({
              where: { purchase_order_id_item_id: { purchase_order_id: po.id, item_id: row.item_id } },
            });
            if (current) {
              const nextQty = Number(current.ordered_qty) + row.ordered_qty;
              const unitPrice = row.unit_price > 0 ? row.unit_price : Number(current.unit_price);
              await tx.purchaseOrderItem.update({
                where: { id: current.id },
                data: {
                  ordered_qty: nextQty,
                  unit_price: unitPrice,
                  line_amount: nextQty * unitPrice,
                } as any,
              });
            } else {
              await tx.purchaseOrderItem.create({
                data: {
                  id: uuidv4(),
                  purchase_order_id: po.id,
                  item_id: row.item_id,
                  ordered_qty: row.ordered_qty,
                  unit_price: row.unit_price,
                  line_amount: row.ordered_qty * row.unit_price,
                } as any,
              });
            }
          }

          const poItems = await tx.purchaseOrderItem.findMany({ where: { purchase_order_id: po.id } });
          const totalAmount = poItems.reduce((s, it) => s + Number(it.line_amount), 0);
          await tx.purchaseOrder.update({
            where: { id: po.id },
            data: {
              total_amount: totalAmount,
              note: `${po.note || autoNote}\n- ${wr.request_no}`,
            } as any,
          });

          // 발주서와 신청 연결 (PurchaseOrderSource)
          const sourceExists = await (tx as any).purchaseOrderSource.findUnique({
            where: { po_id_ward_request_id: { po_id: po.id, ward_request_id: String(req.params.requestId) } },
          });
          if (!sourceExists) {
            await (tx as any).purchaseOrderSource.create({
              data: { id: uuidv4(), po_id: po.id, ward_request_id: String(req.params.requestId) },
            });
          }
        }
      }

      // 비품 폐기 승인 → EquipmentUnit DISPOSED
      if (wr.request_type === 'EQUIPMENT' && (wr as any).equipment_request_type === 'DISPOSAL'
          && (action === 'APPROVE' || action === 'ADJUST') && newStatus !== 'REJECTED') {
        const unitIds: string[] = (() => {
          try { return JSON.parse((wr as any).equipment_unit_ids ?? '[]'); } catch { return []; }
        })();
        if (unitIds.length > 0) {
          await (tx as any).equipmentUnit.updateMany({
            where: { id: { in: unitIds } },
            data: { status: 'DISPOSED' },
          });
        }
      }
    });

    await audit({
      actor_user_id: req.user!.id,
      action,
      entity_type: 'ward_requests',
      entity_id: String(req.params.requestId),
      before: { status: 'SUBMITTED' },
      after: { status: newStatus },
      reason: reasonText,
    });

    res.json({ message: '처리되었습니다.', action, new_status: newStatus });
  } catch (e) { console.error(e); res.status(500).json({ error: '서버 오류' }); }
});

export default router;


