import { prisma } from '../index';

export interface HealthAlert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  entity_type: string;
  entity_id?: string;
  link?: string;
  detected_at: string;
}

// 캐시 — 크론잡에서 갱신, API에서 읽기
let cachedAlerts: HealthAlert[] = [];
let lastCheckedAt: string | null = null;

export function getCachedAlerts() {
  return { alerts: cachedAlerts, last_checked_at: lastCheckedAt };
}

export async function runHealthChecks(scope: 'critical' | 'all'): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  const now = new Date().toISOString();

  try {
    // ── 긴급 (critical) ──
    alerts.push(...await checkCapacityExceeded());
    alerts.push(...await checkInventoryDrift());
    alerts.push(...await checkNegativeLots());
    alerts.push(...await checkAllocationMismatch());

    if (scope === 'all') {
      // ── 경고 (warning) ──
      alerts.push(...await checkPatientStatusConflict());
      alerts.push(...await checkDuplicateBedAssignment());
      alerts.push(...await checkPOStatusInconsistency());
      alerts.push(...await checkReceiptStatusInconsistency());

      // ── 주의 (info) ──
      alerts.push(...await checkStaleRequests());
      alerts.push(...await checkSLAOverdue());
      alerts.push(...await checkOpenFollowUps());
      alerts.push(...await checkDuplicateRequests());
      alerts.push(...await checkUnassignedPatients());
      alerts.push(...await checkRecentLoans());
    }
  } catch (e) {
    console.error('[HealthCheck] Error during checks:', e);
  }

  cachedAlerts = alerts;
  lastCheckedAt = now;

  if (alerts.length > 0) {
    const critical = alerts.filter(a => a.severity === 'critical').length;
    const warning = alerts.filter(a => a.severity === 'warning').length;
    const info = alerts.filter(a => a.severity === 'info').length;
    console.log(`[HealthCheck] ${alerts.length}건 감지 (긴급 ${critical}, 경고 ${warning}, 주의 ${info})`);
  }

  return alerts;
}

/* ═══════════════════════════════════════════
   긴급 (critical)
   ═══════════════════════════════════════════ */

// 1. 병상 정원 초과
async function checkCapacityExceeded(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    const rooms = await (prisma as any).wardRoom.findMany({
      where: { deleted_at: null, is_active: true },
      select: { department_id: true, capacity: true, department: { select: { name: true } } },
    });
    const capacityByDept: Record<string, { name: string; capacity: number }> = {};
    for (const r of rooms) {
      if (!capacityByDept[r.department_id]) capacityByDept[r.department_id] = { name: r.department?.name ?? '', capacity: 0 };
      capacityByDept[r.department_id].capacity += Number(r.capacity);
    }

    const patients = await (prisma as any).patient.findMany({
      where: { status: 'ADMITTED', deleted_at: null },
      select: { department_id: true },
    });
    const countByDept: Record<string, number> = {};
    for (const p of patients) {
      countByDept[p.department_id] = (countByDept[p.department_id] || 0) + 1;
    }

    for (const [deptId, info] of Object.entries(capacityByDept)) {
      const occupied = countByDept[deptId] || 0;
      if (occupied > info.capacity) {
        alerts.push({
          id: `CAPACITY_EXCEEDED_${deptId}`,
          severity: 'critical',
          title: `${info.name} 정원 초과`,
          description: `정원 ${info.capacity}명, 현원 ${occupied}명 (${occupied - info.capacity}명 초과)`,
          entity_type: 'department',
          entity_id: deptId,
          link: '/patient-manage',
          detected_at: new Date().toISOString(),
        });
      }
    }
  } catch (e) { console.error('[HealthCheck] checkCapacityExceeded error:', e); }
  return alerts;
}

// 2. 재고 수량 불일치
async function checkInventoryDrift(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    // Inventory 모델에는 deleted_at 컬럼이 없음 (단일 (item, location) 집계 행) — 필터 제거
    const inventories = await (prisma as any).inventory.findMany({
      select: { id: true, item_id: true, location_id: true, on_hand_qty: true, item: { select: { name: true } } },
    });
    for (const inv of inventories) {
      const lots = await (prisma as any).inventoryLot.findMany({
        where: { item_id: inv.item_id, location_id: inv.location_id, deleted_at: null },
        select: { remaining_qty: true },
      });
      const lotSum = lots.reduce((s: number, l: any) => s + Number(l.remaining_qty), 0);
      const diff = Math.abs(Number(inv.on_hand_qty) - lotSum);
      if (diff > 0.01) {
        alerts.push({
          id: `INVENTORY_DRIFT_${inv.id}`,
          severity: 'critical',
          title: `재고 수량 불일치 — ${inv.item?.name ?? ''}`,
          description: `재고장부 ${Number(inv.on_hand_qty)}, 로트합계 ${lotSum} (차이 ${diff.toFixed(1)})`,
          entity_type: 'inventory',
          entity_id: inv.id,
          link: '/inventory',
          detected_at: new Date().toISOString(),
        });
      }
    }
  } catch (e) { console.error('[HealthCheck] checkInventoryDrift error:', e); }
  return alerts;
}

// 3. 음수 재고 로트
async function checkNegativeLots(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    const lots = await (prisma as any).inventoryLot.findMany({
      where: { deleted_at: null, remaining_qty: { lt: 0 } },
      select: { id: true, item_id: true, remaining_qty: true, item: { select: { name: true } } },
      take: 20,
    });
    for (const lot of lots) {
      alerts.push({
        id: `NEGATIVE_LOT_${lot.id}`,
        severity: 'critical',
        title: `음수 재고 — ${lot.item?.name ?? ''}`,
        description: `로트 잔량 ${Number(lot.remaining_qty)} (비정상)`,
        entity_type: 'inventory_lot',
        entity_id: lot.id,
        link: '/inventory',
        detected_at: new Date().toISOString(),
      });
    }
  } catch (e) { console.error('[HealthCheck] checkNegativeLots error:', e); }
  return alerts;
}

// 4. 불출 배분 불일치
async function checkAllocationMismatch(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    const items = await (prisma as any).stockOutItem.findMany({
      where: { stock_out: { status: { not: 'REVERSED' } } },
      select: {
        id: true, issued_qty: true, item: { select: { name: true } },
        stock_out: { select: { so_no: true } },
        allocations: { select: { issued_qty: true } },
      },
      take: 500,
    });
    for (const item of items) {
      const allocSum = (item.allocations || []).reduce((s: number, a: any) => s + Number(a.issued_qty), 0);
      const diff = Math.abs(Number(item.issued_qty) - allocSum);
      if (diff > 0.01) {
        alerts.push({
          id: `ALLOC_MISMATCH_${item.id}`,
          severity: 'critical',
          title: `불출 배분 불일치 — ${item.stock_out?.so_no ?? ''}`,
          description: `${item.item?.name ?? ''}: 불출 ${Number(item.issued_qty)}, 배분합계 ${allocSum}`,
          entity_type: 'stock_out_item',
          entity_id: item.id,
          link: '/stock-out',
          detected_at: new Date().toISOString(),
        });
      }
    }
  } catch (e) { console.error('[HealthCheck] checkAllocationMismatch error:', e); }
  return alerts;
}

/* ═══════════════════════════════════════════
   경고 (warning)
   ═══════════════════════════════════════════ */

// 5. 환자 상태 불일치
async function checkPatientStatusConflict(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    // ADMITTED인데 discharged_at 있음
    const admittedWithDischarge = await (prisma as any).patient.findMany({
      where: { status: 'ADMITTED', discharged_at: { not: null }, deleted_at: null },
      select: { id: true, name: true, patient_no: true },
      take: 20,
    });
    for (const p of admittedWithDischarge) {
      alerts.push({
        id: `STATUS_CONFLICT_ADMIT_${p.id}`,
        severity: 'warning',
        title: `환자 상태 불일치 — ${p.name}`,
        description: `입원 상태이나 퇴원일자가 설정되어 있음 (${p.patient_no})`,
        entity_type: 'patient', entity_id: p.id, link: '/patient-manage',
        detected_at: new Date().toISOString(),
      });
    }
    // DISCHARGED인데 discharged_at 없음
    const dischargedNoDate = await (prisma as any).patient.findMany({
      where: { status: 'DISCHARGED', discharged_at: null, deleted_at: null },
      select: { id: true, name: true, patient_no: true },
      take: 20,
    });
    for (const p of dischargedNoDate) {
      alerts.push({
        id: `STATUS_CONFLICT_DISC_${p.id}`,
        severity: 'warning',
        title: `환자 상태 불일치 — ${p.name}`,
        description: `퇴원 상태이나 퇴원일자가 없음 (${p.patient_no})`,
        entity_type: 'patient', entity_id: p.id, link: '/patient-manage',
        detected_at: new Date().toISOString(),
      });
    }
  } catch (e) { console.error('[HealthCheck] checkPatientStatusConflict error:', e); }
  return alerts;
}

// 6. 같은 침대 중복 배정
async function checkDuplicateBedAssignment(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const boards = await (prisma as any).wardRoomBoard.findMany({
      where: { board_date: new Date(today), deleted_at: null, patient_id: { not: null } },
      select: { department_id: true, ward_room_id: true, bed_no: true, patient_id: true,
        department: { select: { name: true } }, ward_room: { select: { room_no: true } } },
    });
    const bedMap: Record<string, any[]> = {};
    for (const b of boards) {
      const key = `${b.ward_room_id}_${b.bed_no}`;
      if (!bedMap[key]) bedMap[key] = [];
      bedMap[key].push(b);
    }
    for (const [, entries] of Object.entries(bedMap)) {
      if (entries.length > 1) {
        const b = entries[0];
        alerts.push({
          id: `DUP_BED_${b.ward_room_id}_${b.bed_no}`,
          severity: 'warning',
          title: `침대 중복 배정`,
          description: `${b.department?.name ?? ''} ${b.ward_room?.room_no ?? ''}호 ${b.bed_no}번에 ${entries.length}명 배정`,
          entity_type: 'ward_room_board', link: '/patient-manage',
          detected_at: new Date().toISOString(),
        });
      }
    }
  } catch (e) { console.error('[HealthCheck] checkDuplicateBedAssignment error:', e); }
  return alerts;
}

// 7. PO 상태 불일치
async function checkPOStatusInconsistency(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    const pos = await (prisma as any).purchaseOrder.findMany({
      where: { status: { in: ['SENT', 'PARTIAL_RECEIVED'] }, deleted_at: null },
      select: {
        id: true, po_no: true, status: true,
        po_items: { select: { ordered_qty: true, item_id: true } },
        receipts: {
          where: { status: { in: ['CONFIRMED', 'DIFF_CONFIRMED'] } },
          select: { stock_in_items: { select: { item_id: true, confirmed_qty: true } } },
        },
      },
      take: 100,
    });
    for (const po of pos) {
      const receivedByItem: Record<string, number> = {};
      for (const gr of po.receipts) {
        for (const si of gr.stock_in_items) {
          receivedByItem[si.item_id] = (receivedByItem[si.item_id] || 0) + Number(si.confirmed_qty ?? 0);
        }
      }
      const allReceived = po.po_items.every((pi: any) => (receivedByItem[pi.item_id] || 0) >= Number(pi.ordered_qty));
      if (allReceived && po.status === 'SENT') {
        alerts.push({
          id: `PO_STATUS_${po.id}`,
          severity: 'warning',
          title: `발주 상태 불일치 — ${po.po_no}`,
          description: `전량 입고 완료되었으나 상태가 '${po.status}'`,
          entity_type: 'purchase_order', entity_id: po.id, link: '/purchase-orders',
          detected_at: new Date().toISOString(),
        });
      }
    }
  } catch (e) { console.error('[HealthCheck] checkPOStatusInconsistency error:', e); }
  return alerts;
}

// 8. 입고 상태 불일치
async function checkReceiptStatusInconsistency(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    const receipts = await (prisma as any).goodsReceipt.findMany({
      where: { status: 'PENDING', deleted_at: null },
      select: {
        id: true, gr_no: true,
        stock_in_items: { select: { confirmed_at: true } },
      },
      take: 50,
    });
    for (const gr of receipts) {
      if (gr.stock_in_items.length > 0 && gr.stock_in_items.every((si: any) => si.confirmed_at)) {
        alerts.push({
          id: `GR_STATUS_${gr.id}`,
          severity: 'warning',
          title: `입고 상태 불일치 — ${gr.gr_no}`,
          description: `전 항목 검수 완료되었으나 상태가 PENDING`,
          entity_type: 'goods_receipt', entity_id: gr.id, link: '/receipts',
          detected_at: new Date().toISOString(),
        });
      }
    }
  } catch (e) { console.error('[HealthCheck] checkReceiptStatusInconsistency error:', e); }
  return alerts;
}

/* ═══════════════════════════════════════════
   주의 (info)
   ═══════════════════════════════════════════ */

// 9. 장기 미승인 신청
async function checkStaleRequests(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const stale = await (prisma as any).wardRequest.findMany({
      where: { status: 'SUBMITTED', deleted_at: null, submitted_at: { lt: cutoff } },
      select: { id: true, request_no: true, submitted_at: true, department: { select: { name: true } } },
      take: 20,
    });
    for (const r of stale) {
      const days = Math.floor((Date.now() - new Date(r.submitted_at).getTime()) / 86400000);
      alerts.push({
        id: `STALE_REQ_${r.id}`,
        severity: 'info',
        title: `장기 미승인 — ${r.request_no}`,
        description: `${r.department?.name ?? ''}, ${days}일 경과`,
        entity_type: 'ward_request', entity_id: r.id, link: '/approvals',
        detected_at: new Date().toISOString(),
      });
    }
  } catch (e) { console.error('[HealthCheck] checkStaleRequests error:', e); }
  return alerts;
}

// 10. 수령검수 지연
async function checkSLAOverdue(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const overdue = await (prisma as any).stockOut.findMany({
      where: { status: 'RECEIPT_PENDING', issued_at: { lt: cutoff } },
      select: { id: true, so_no: true, issued_at: true, department: { select: { name: true } } },
      take: 20,
    });
    for (const so of overdue) {
      const hours = Math.floor((Date.now() - new Date(so.issued_at).getTime()) / 3600000);
      alerts.push({
        id: `SLA_OVERDUE_${so.id}`,
        severity: 'info',
        title: `수령검수 지연 — ${so.so_no}`,
        description: `${so.department?.name ?? ''}, ${hours}시간 경과`,
        entity_type: 'stock_out', entity_id: so.id, link: '/receipt-check',
        detected_at: new Date().toISOString(),
      });
    }
  } catch (e) { console.error('[HealthCheck] checkSLAOverdue error:', e); }
  return alerts;
}

// 11. 미처리 후속조치
async function checkOpenFollowUps(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const soFollowUps = await (prisma as any).stockOutFollowUp.findMany({
      where: { status: 'OPEN', created_at: { lt: cutoff } },
      select: { id: true, action_type: true, created_at: true, stock_out: { select: { so_no: true } } },
      take: 20,
    });
    for (const f of soFollowUps) {
      const days = Math.floor((Date.now() - new Date(f.created_at).getTime()) / 86400000);
      alerts.push({
        id: `FOLLOWUP_SO_${f.id}`,
        severity: 'info',
        title: `미처리 후속조치 — ${f.stock_out?.so_no ?? ''}`,
        description: `${f.action_type === 'ISSUE_ADD' ? '추가불출' : '회수'} 필요, ${days}일 경과`,
        entity_type: 'stock_out_followup', entity_id: f.id, link: '/stock-out',
        detected_at: new Date().toISOString(),
      });
    }

    const rcptFollowUps = await (prisma as any).pendingReceiptFollowUp.findMany({
      where: { status: 'OPEN', created_at: { lt: cutoff } },
      select: { id: true, created_at: true, goods_receipt: { select: { gr_no: true } } },
      take: 20,
    });
    for (const f of rcptFollowUps) {
      const days = Math.floor((Date.now() - new Date(f.created_at).getTime()) / 86400000);
      alerts.push({
        id: `FOLLOWUP_GR_${f.id}`,
        severity: 'info',
        title: `미입고 후속조치 — ${f.goods_receipt?.gr_no ?? ''}`,
        description: `미입고 품목 미처리, ${days}일 경과`,
        entity_type: 'receipt_followup', entity_id: f.id, link: '/receipts',
        detected_at: new Date().toISOString(),
      });
    }
  } catch (e) { console.error('[HealthCheck] checkOpenFollowUps error:', e); }
  return alerts;
}

// 12. 중복 신청
async function checkDuplicateRequests(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    const requests = await (prisma as any).wardRequest.findMany({
      where: { status: { in: ['SUBMITTED', 'APPROVED', 'PARTIAL_APPROVED'] }, deleted_at: null },
      select: { id: true, request_no: true, department_id: true, period_start: true, period_end: true, request_type: true, department: { select: { name: true } } },
    });
    const groups: Record<string, any[]> = {};
    for (const r of requests) {
      const key = `${r.department_id}_${r.period_start}_${r.request_type}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }
    for (const [, entries] of Object.entries(groups)) {
      if (entries.length > 1) {
        alerts.push({
          id: `DUP_REQ_${entries[0].department_id}_${entries[0].period_start}_${entries[0].request_type}`,
          severity: 'info',
          title: `중복 신청 감지`,
          description: `${entries[0].department?.name ?? ''} ${entries[0].request_type} — ${entries.map((e: any) => e.request_no).join(', ')}`,
          entity_type: 'ward_request', link: '/approvals',
          detected_at: new Date().toISOString(),
        });
      }
    }
  } catch (e) { console.error('[HealthCheck] checkDuplicateRequests error:', e); }
  return alerts;
}

// 13. 미배정 입원환자
async function checkUnassignedPatients(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    const unassigned = await (prisma as any).patient.findMany({
      where: { status: 'ADMITTED', deleted_at: null, OR: [{ department_id: null }, { department_id: '' }] },
      select: { id: true, name: true, patient_no: true },
      take: 20,
    });
    for (const p of unassigned) {
      alerts.push({
        id: `UNASSIGNED_${p.id}`,
        severity: 'info',
        title: `미배정 환자 — ${p.name}`,
        description: `입원 상태이나 부서 미배정 (${p.patient_no})`,
        entity_type: 'patient', entity_id: p.id, link: '/patient-manage',
        detected_at: new Date().toISOString(),
      });
    }
  } catch (e) { console.error('[HealthCheck] checkUnassignedPatients error:', e); }
  return alerts;
}

// 최근 부서간 대여 (24시간 내) — 총무구매가 인지해야 하므로 info 알림
async function checkRecentLoans(): Promise<HealthAlert[]> {
  const alerts: HealthAlert[] = [];
  try {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rows: any[] = await (prisma as any).$queryRawUnsafe(
      `SELECT l.id, l.from_department_id, l.to_department_id, l.item_id, l.qty, l.loaned_at,
              f.name AS from_name, t.name AS to_name, i.name AS item_name
       FROM department_loans l
       LEFT JOIN departments f ON f.id = l.from_department_id
       LEFT JOIN departments t ON t.id = l.to_department_id
       LEFT JOIN items i ON i.id = l.item_id
       WHERE l.deleted_at IS NULL AND l.status = 'ACTIVE' AND l.loaned_at >= ?
       ORDER BY l.loaned_at DESC`,
      cutoff,
    );
    for (const r of rows) {
      alerts.push({
        id: `LOAN_RECENT_${r.id}`,
        severity: 'info',
        title: `부서 대여 — ${r.from_name ?? ''} → ${r.to_name ?? ''}`,
        description: `${r.item_name ?? ''} ${Number(r.qty)}개 (${new Date(r.loaned_at).toLocaleString('ko-KR')})`,
        entity_type: 'loan',
        entity_id: String(r.id),
        link: '/loans',
        detected_at: new Date().toISOString(),
      });
    }
  } catch (e) { console.error('[HealthCheck] checkRecentLoans error:', e); }
  return alerts;
}
