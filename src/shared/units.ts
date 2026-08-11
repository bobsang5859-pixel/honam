// 품목 단위 변환 유틸
// 품목은 발주 단위(purchase_uom)와 불출/재고 단위(issue_uom) 두 가지를 갖는다.
// 변환 비율은 pack_size: 1 purchase_uom = pack_size issue_uom (양의 정수, 기본 1)

export function normalizePackSize(packSize: unknown): number {
  const n = Number(packSize);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.max(1, Math.floor(n));
}

// 발주 수량 → 불출(=재고) 단위 수량
export function toIssueQty(purchaseQty: number, packSize: number): number {
  return Number(purchaseQty) * normalizePackSize(packSize);
}

// 발주 단가 → 불출 단위 단가 (재고 평균단가 계산용)
export function toIssueUnitCost(purchaseUnitPrice: number, packSize: number): number {
  const ps = normalizePackSize(packSize);
  return ps > 0 ? Number(purchaseUnitPrice) / ps : Number(purchaseUnitPrice);
}

// 불출 단위 수량 → 발주 단위 (정수 박스 + 잔여 개수)
export function splitToPurchaseUnits(issueQty: number, packSize: number): { purchase: number; remainder: number } {
  const ps = normalizePackSize(packSize);
  const qty = Number(issueQty);
  if (ps <= 1) return { purchase: qty, remainder: 0 };
  const purchase = Math.floor(qty / ps);
  const remainder = qty - purchase * ps;
  return { purchase, remainder };
}

// 불출 단위 수량을 올림하여 필요한 발주 단위 수량 (수요예측 추천 발주량)
export function ceilToPurchaseQty(issueQty: number, packSize: number): number {
  const ps = normalizePackSize(packSize);
  const qty = Number(issueQty);
  if (ps <= 1) return Math.max(0, Math.ceil(qty));
  return Math.max(0, Math.ceil(qty / ps));
}

// 표시용: 재고/사용량을 "100개 (=1박스)" 형태로 포맷
export function formatIssueWithPurchase(issueQty: number, packSize: number, purchaseUom: string, issueUom: string): string {
  const ps = normalizePackSize(packSize);
  const qty = Number(issueQty);
  if (ps <= 1 || !purchaseUom || purchaseUom === issueUom) {
    return `${qty} ${issueUom || ''}`.trim();
  }
  const { purchase, remainder } = splitToPurchaseUnits(qty, ps);
  if (remainder === 0) {
    return `${qty} ${issueUom} (=${purchase} ${purchaseUom})`;
  }
  return `${qty} ${issueUom} (=${purchase} ${purchaseUom} + ${remainder} ${issueUom})`;
}

// 표시용: 품목 단위 라벨 ("박스 (1박스=100개)")
export function formatItemUnitLabel(purchaseUom: string, issueUom: string, packSize: number): string {
  const ps = normalizePackSize(packSize);
  if (ps <= 1 || !purchaseUom || purchaseUom === issueUom) {
    return purchaseUom || issueUom || '';
  }
  return `${purchaseUom} (1${purchaseUom}=${ps}${issueUom})`;
}
