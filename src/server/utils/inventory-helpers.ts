import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../index';

/**
 * 부서의 활성 InventoryLocation 을 선택. preferredLocationId 가 지정되면
 * 그 ID 가 부서에 속하는지 검증 후 사용하고, 없으면 첫 번째 활성 위치를 반환.
 * 부서 보관함이 없는 경우 자동 생성 (code: DEPT-{deptId8}, name: {부서명} 보관함).
 * tx 를 넘기면 그 트랜잭션 안에서 생성됨.
 */
export async function pickDeptLocationId(
  departmentId: string,
  preferredLocationId?: string | null,
  tx?: any,
): Promise<string | null> {
  const client = tx ?? prisma;
  if (preferredLocationId) {
    const preferred = await client.inventoryLocation.findFirst({
      where: { id: preferredLocationId, department_id: departmentId, deleted_at: null, is_active: true },
      select: { id: true },
    });
    if (preferred) return preferred.id;
  }
  const row = await client.inventoryLocation.findFirst({
    where: { department_id: departmentId, deleted_at: null, is_active: true },
    orderBy: [{ code: 'asc' }],
    select: { id: true },
  });
  if (row) return row.id;

  // 보관함이 없으면 자동 생성
  const dept = await client.department.findUnique({
    where: { id: departmentId },
    select: { name: true },
  });
  const loc = await client.inventoryLocation.create({
    data: {
      id: uuidv4(),
      code: `DEPT-${departmentId.slice(0, 8).toUpperCase()}`,
      name: `${dept?.name ?? '부서'} 보관함`,
      department_id: departmentId,
      is_active: true,
    } as any,
  });
  return loc.id;
}

// 특정 location 의 현재 on_hand_qty 조회 (없으면 0)
export async function getInventoryQty(tx: any, itemId: string, locationId: string): Promise<number> {
  const row = await tx.inventory.findUnique({
    where: { item_id_location_id: { item_id: itemId, location_id: locationId } },
  });
  return row ? Number(row.on_hand_qty) : 0;
}

// 절대값으로 Inventory.on_hand_qty 덮어쓰기 (없으면 생성)
export async function setInventoryQty(tx: any, itemId: string, locationId: string, qty: number) {
  const existing = await tx.inventory.findUnique({
    where: { item_id_location_id: { item_id: itemId, location_id: locationId } },
  });
  if (existing) {
    await tx.inventory.update({
      where: { item_id_location_id: { item_id: itemId, location_id: locationId } },
      data: { on_hand_qty: qty } as any,
    });
  } else {
    await tx.inventory.create({
      data: {
        id: uuidv4(),
        item_id: itemId,
        location_id: locationId,
        on_hand_qty: qty,
        avg_unit_cost: 0,
      } as any,
    });
  }
}
