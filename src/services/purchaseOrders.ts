import { get, post, put, del } from './api';

export interface PurchaseOrderLine {
  id: string;
  poId: string;
  sku: string;
  orderedQty: number;
  receivedQty: number;
  status: 'open' | 'partial' | 'closed';
  unit?: string;
  productName?: string;
  unitPrice?: number;
  taxAmount?: number;
  taxLabel?: string;
  amount?: number;
  currency?: string;
  taxTypeId?: string;
  promisedDate?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrder {
  id: string;
  vendorId: string;
  status: 'open' | 'partial' | 'closed' | 'canceled' | 'draft';
  vendorName: string;
  orderNumber: string;
  orderDate: string;
  orderSequence?: number;
  memo: string | null;
  createdAt: string;
  approvedAt: string | null;
  promisedDate: string | null;
  lines: PurchaseOrderLine[];
}

interface PurchaseOrderListResponse {
  success: true;
  items: PurchaseOrder[];
}

interface PurchaseOrderResponse {
  success: true;
  item: PurchaseOrder;
}

interface DeletePurchaseOrderResponse {
  success: true;
  item: PurchaseOrder;
}

export interface CreatePurchaseOrderLine {
  sku: string;
  orderedQty: number;
  productName?: string;
  unit?: string;
  unitPrice?: number;
  amount?: number;
  taxAmount?: number;
  taxLabel?: string;
  currency?: string;
  taxTypeId?: string;
}

export interface CreatePurchaseOrderPayload {
  vendorId: string;
  vendorName?: string;
  orderNumber?: string;
  orderDate?: string;
  memo?: string;
  promisedDate?: string;
  lines: CreatePurchaseOrderLine[];
}

export interface NextPurchaseOrderNumber {
  orderNumber: string;
  orderDate: string;
  sequence: number;
}

interface NextPurchaseOrderNumberResponse {
  success: true;
  item: NextPurchaseOrderNumber;
}

interface GetPurchaseOrderOptions {
  timeoutMs?: number;
}

export interface PurchaseOrderListFilters {
  from?: string;
  to?: string;
}

export const listPurchaseOrders = async (filters?: PurchaseOrderListFilters): Promise<PurchaseOrder[]> => {
  const params = new URLSearchParams();
  if (filters?.from) {
    params.set('from', filters.from);
  }
  if (filters?.to) {
    params.set('to', filters.to);
  }
  const query = params.toString();
  const path = query ? `/purchase-orders?${query}` : '/purchase-orders';
  const response = await get<PurchaseOrderListResponse>(path);
  return response.items;
};

export const getNextPurchaseOrderNumber = async (
  orderDate: string,
): Promise<NextPurchaseOrderNumber> => {
  const params = new URLSearchParams({ orderDate });
  const query = params.toString();
  const path = query ? `/purchase-orders/next-number?${query}` : '/purchase-orders/next-number';
  const response = await get<NextPurchaseOrderNumberResponse>(path);
  return response.item;
};

export const createPurchaseOrder = async (payload: CreatePurchaseOrderPayload): Promise<PurchaseOrder> => {
  const response = await post<PurchaseOrderResponse>('/purchase-orders', payload);
  return response.item;
};

export const createPurchaseOrderDraft = async (
  payload: CreatePurchaseOrderPayload,
): Promise<PurchaseOrder> => {
  const response = await post<PurchaseOrderResponse>('/purchase-orders/drafts', payload);
  return response.item;
};

export const updatePurchaseOrderDraft = async (
  id: string,
  payload: CreatePurchaseOrderPayload,
): Promise<PurchaseOrder> => {
  const response = await put<PurchaseOrderResponse>(
    `/purchase-orders/drafts/${encodeURIComponent(id)}`,
    payload,
  );
  return response.item;
};

export const approvePurchaseOrder = async (id: string): Promise<PurchaseOrder> => {
  const response = await put<PurchaseOrderResponse>(`/purchase-orders/${encodeURIComponent(id)}/approve`);
  return response.item;
};

export const deletePurchaseOrder = async (id: string): Promise<PurchaseOrder> => {
  const response = await del<DeletePurchaseOrderResponse>(`/purchase-orders/${encodeURIComponent(id)}`);
  return response.item;
};

export const getPurchaseOrder = async (
  id: string,
  options?: GetPurchaseOrderOptions,
): Promise<PurchaseOrder> => {
  const response = await get<PurchaseOrderResponse>(`/purchase-orders/${encodeURIComponent(id)}`, {
    timeoutMs: options?.timeoutMs,
  });
  return response.item;
};
