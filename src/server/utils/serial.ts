import { PrismaClient } from '@prisma/client';

/**
 * 비품 일련번호 생성: EQ-YYYY-NNNNN 형식 (연도별 순번)
 * 예: EQ-2026-00001
 */
export async function generateEquipmentSerial(prisma: PrismaClient | any): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `EQ-${year}-`;
  const count = await (prisma as any).equipmentUnit.count({
    where: { serial_no: { startsWith: prefix } },
  });
  return `${prefix}${String(count + 1).padStart(5, '0')}`;
}
