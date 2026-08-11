import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

let _prisma: PrismaClient | null = null;
function getPrisma(): PrismaClient {
  if (!_prisma) _prisma = require('../index').prisma;
  return _prisma!;
}

export interface AuditParams {
  actor_user_id: string | null;
  actor_role_snapshot?: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before?: any;
  after?: any;
  reason?: string;
  ip?: string;
}

export async function audit(params: AuditParams): Promise<void> {
  try {
    const prisma = getPrisma();
    await prisma.auditLog.create({
      data: {
        id: uuidv4(),
        actor_user_id: params.actor_user_id,
        actor_role_snapshot: params.actor_role_snapshot ?? '',
        action: params.action,
        entity_type: params.entity_type,
        entity_id: params.entity_id,
        before_json: params.before ? JSON.stringify(params.before) : '',
        after_json: params.after ? JSON.stringify(params.after) : '',
        reason: params.reason ?? '',
        ip: params.ip ?? '',
      },
    });
  } catch (e) {
    // 감사 로그 실패가 원 트랜잭션에 영향 주지 않도록 silent
    console.error('[audit] Failed to write audit log:', e);
  }
}

/** 숫자 시퀀스 생성: PO-202602-00001 형태 */
export function generateNo(prefix: string, seq: number): string {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  return `${prefix}-${ym}-${String(seq).padStart(5, '0')}`;
}

/** 테이블별 번호 컬럼 매핑 (허용 목록 — SQL injection 방지)
 *  키는 실제 DB 테이블명(snake_case). PascalCase Prisma 모델명도 fallback으로 매핑. */
const SEQ_COLUMNS: Record<string, { col: string; table: string }> = {
  // snake_case (실제 호출 형태)
  ward_requests:      { col: 'request_no',  table: 'ward_requests' },
  purchase_orders:    { col: 'po_no',       table: 'purchase_orders' },
  goods_receipts:     { col: 'gr_no',       table: 'goods_receipts' },
  stock_out:          { col: 'so_no',       table: 'stock_out' },
  equipment_units:    { col: 'serial_no',   table: 'equipment_units' },
  purchase_decisions: { col: 'decision_no', table: 'purchase_decisions' },
  proposal_documents: { col: 'document_no', table: 'proposal_documents' },
  // PascalCase (구버전 호출 호환)
  WardRequest:      { col: 'request_no', table: 'ward_requests' },
  PurchaseOrder:    { col: 'po_no',      table: 'purchase_orders' },
  GoodsReceipt:     { col: 'gr_no',      table: 'goods_receipts' },
  StockOut:         { col: 'so_no',      table: 'stock_out' },
  EquipmentUnit:    { col: 'serial_no',  table: 'equipment_units' },
};

/**
 * DB에서 다음 시퀀스 번호 조회 (MAX 기반, 삭제된 행이 있어도 안전)
 * 번호 형식: PREFIX-YYYYMM-NNNNN (예: PO-202603-00001)
 * 마지막 '-' 이후 숫자 부분의 MAX + 1을 반환
 */
export async function nextSeq(table: string): Promise<number> {
  const entry = SEQ_COLUMNS[table];
  if (!entry) throw new Error(`nextSeq: 지원하지 않는 테이블 "${table}"`);
  const prisma = getPrisma();
  // SUBSTR: 마지막 5자리 (NNNNN 부분)를 숫자로 변환하여 MAX 조회
  const result = await (prisma as any).$queryRawUnsafe(
    `SELECT MAX(CAST(SUBSTR("${entry.col}", LENGTH("${entry.col}") - 4) AS INTEGER)) as max_seq FROM "${entry.table}" WHERE "${entry.col}" IS NOT NULL`
  ) as any[];
  return Number(result[0]?.max_seq ?? 0) + 1;
}
