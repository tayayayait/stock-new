import { get, post, put } from './api';

export interface SalesOrderLine {
  id: string;
  soId: string;
  sku: string;
  orderedQty: number;
  shippedQty: number;
  status: 'open' | 'partial' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export interface SalesOrder {
  id: string;
  customerId: string;
  status: 'open' | 'alloc' | 'picking' | 'packed' | 'closed' | 'canceled';
  memo: string | null;
  createdAt: string;
  promisedDate: string | null;
  lines: SalesOrderLine[];
}

interface SalesOrderListResponse {
  success: true;
  items: SalesOrder[];
}

interface SalesOrderResponse {
  success: true;
  item: SalesOrder;
}

export const listSalesOrders = async (): Promise<SalesOrder[]> => {
  const response = await get<SalesOrderListResponse>('/sales-orders');
  return response.items;
};

export const createSalesOrder = async (payload: {
  customerId: string;
  memo?: string;
  promisedDate?: string;
  lines: Array<{ sku: string; orderedQty: number }>;
}): Promise<SalesOrder> => {
  const response = await post<SalesOrderResponse>('/sales-orders', payload);
  return response.item;
};

export const cancelSalesOrder = async (id: string): Promise<SalesOrder> => {
  const response = await put<SalesOrderResponse>(`/sales-orders/${encodeURIComponent(id)}/cancel`);
  return response.item;
};
