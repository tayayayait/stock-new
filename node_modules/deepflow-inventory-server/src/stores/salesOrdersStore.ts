import { randomUUID } from 'node:crypto';

export type SalesOrderStatus = 'open' | 'alloc' | 'picking' | 'packed' | 'closed' | 'canceled';
export type SalesOrderLineStatus = 'open' | 'partial' | 'closed';

export interface SalesOrderLineRecord {
  id: string;
  soId: string;
  sku: string;
  orderedQty: number;
  shippedQty: number;
  status: SalesOrderLineStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SalesOrderRecord {
  id: string;
  customerId: string;
  status: SalesOrderStatus;
  memo: string | null;
  createdAt: string;
  promisedDate: string | null;
  lines: SalesOrderLineRecord[];
}

const salesOrders = new Map<string, SalesOrderRecord>();

const normalizeSku = (value: string): string => value.trim().toUpperCase();
const ensurePositiveNumber = (value: number): number => Math.max(0, Math.round(value));

const deriveLineStatus = (orderedQty: number, shippedQty: number): SalesOrderLineStatus => {
  if (shippedQty >= orderedQty && orderedQty > 0) {
    return 'closed';
  }
  if (shippedQty > 0) {
    return 'partial';
  }
  return 'open';
};

const deriveOrderStatus = (lines: SalesOrderLineRecord[]): SalesOrderStatus => {
  if (lines.every((line) => line.status === 'closed')) {
    return 'closed';
  }
  if (lines.some((line) => line.status === 'partial')) {
    return 'packed';
  }
  return 'open';
};

export interface CreateSalesOrderInput {
  customerId: string;
  memo?: string;
  promisedDate?: string;
  lines: Array<{ sku: string; orderedQty: number }>;
}

export const createSalesOrder = (input: CreateSalesOrderInput): SalesOrderRecord => {
  const now = new Date().toISOString();
  const id = `SO-${randomUUID().slice(0, 8)}`;
  const lines = input.lines
    .map((line) => ({
      sku: normalizeSku(line.sku),
      orderedQty: ensurePositiveNumber(line.orderedQty),
    }))
    .filter((line) => line.sku && line.orderedQty > 0)
    .map((line) => ({
      id: randomUUID(),
      soId: id,
      sku: line.sku,
      orderedQty: line.orderedQty,
      shippedQty: 0,
      status: 'open' as SalesOrderLineStatus,
      createdAt: now,
      updatedAt: now,
    }));
  const record: SalesOrderRecord = {
    id,
    customerId: input.customerId.trim(),
    memo: input.memo?.trim() || null,
    status: lines.length ? 'open' : 'closed',
    createdAt: now,
    promisedDate: input.promisedDate ?? null,
    lines,
  };
  salesOrders.set(id, record);
  return { ...record, lines: [...record.lines] };
};

export const listSalesOrders = (): SalesOrderRecord[] =>
  Array.from(salesOrders.values()).map((record) => ({ ...record, lines: [...record.lines] }));

export const getSalesOrder = (id: string): SalesOrderRecord | null => {
  const record = salesOrders.get(id);
  return record ? { ...record, lines: [...record.lines] } : null;
};

export const cancelSalesOrder = (id: string): SalesOrderRecord | null => {
  const record = salesOrders.get(id);
  if (!record) {
    return null;
  }
  record.status = 'canceled';
  salesOrders.set(id, record);
  return { ...record, lines: [...record.lines] };
};

export interface SalesShipmentResult {
  order: SalesOrderRecord;
  previousShippedQty: number;
  line: SalesOrderLineRecord;
}

export const recordSalesShipment = (
  soId: string,
  lineId: string,
  quantity: number,
  shippedAt?: string,
): SalesShipmentResult | null => {
  const record = salesOrders.get(soId);
  if (!record) {
    return null;
  }
  const line = record.lines.find((entry) => entry.id === lineId);
  if (!line) {
    return null;
  }
  const qty = Math.min(line.orderedQty, ensurePositiveNumber(quantity));
  if (qty <= 0) {
    return null;
  }
  const previousShippedQty = line.shippedQty;
  line.shippedQty = Math.min(line.orderedQty, line.shippedQty + qty);
  line.status = deriveLineStatus(line.orderedQty, line.shippedQty);
  line.updatedAt = shippedAt ?? new Date().toISOString();
  record.status = deriveOrderStatus(record.lines);
  salesOrders.set(soId, record);
  return {
    order: { ...record, lines: [...record.lines] },
    previousShippedQty,
    line: { ...line },
  };
};
