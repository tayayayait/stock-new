import type { PurchaseOrder } from '../../services/purchaseOrders';

export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrder['status'], string> = {
  open: '입고대기',
  partial: '부분 입고',
  closed: '입고 완료',
  canceled: '취소됨',
  draft: '임시저장',
};

export const getPurchaseStatusLabel = (status: PurchaseOrder['status']): string =>
  PURCHASE_ORDER_STATUS_LABELS[status] ?? status;
