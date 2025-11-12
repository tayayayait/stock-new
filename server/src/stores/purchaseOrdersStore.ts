import { randomUUID } from 'node:crypto';

const ORDER_NUMBER_PREFIX = 'PO';
const ORDER_NUMBER_SEQUENCE_WIDTH = 3;
const KST_OFFSET_HOURS = 9;
const KST_OFFSET_MS = KST_OFFSET_HOURS * 60 * 60 * 1000;
const ORDER_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface OrderDateContext {
  dateKey: string;
  orderDate: string;
}

const padOrderNumberSequence = (sequence: number) =>
  String(sequence).padStart(ORDER_NUMBER_SEQUENCE_WIDTH, '0');

const formatOrderDateParts = (year: number | string, month: number | string, day: number | string): OrderDateContext => {
  const yearStr = String(year).padStart(4, '0');
  const monthStr = String(month).padStart(2, '0');
  const dayStr = String(day).padStart(2, '0');
  return {
    dateKey: `${yearStr}${monthStr}${dayStr}`,
    orderDate: `${yearStr}-${monthStr}-${dayStr}`,
  };
};

const buildCurrentKstOrderDate = (): OrderDateContext => {
  const shifted = new Date(Date.now() + KST_OFFSET_MS);
  return formatOrderDateParts(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
};

const parseCandidateOrderDate = (value?: string): OrderDateContext | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const match = ORDER_DATE_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  const timestamp = Date.parse(`${year}-${month}-${day}T00:00:00+09:00`);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return formatOrderDateParts(year, month, day);
};

const orderSequenceByDate = new Map<string, number>();

const peekSequenceForDate = (dateKey: string) => orderSequenceByDate.get(dateKey) ?? 0;

const incrementSequenceForDate = (dateKey: string) => {
  const next = peekSequenceForDate(dateKey) + 1;
  orderSequenceByDate.set(dateKey, next);
  return next;
};

const buildOrderNumber = (dateKey: string, sequence: number) =>
  `${ORDER_NUMBER_PREFIX}-${dateKey}-${padOrderNumberSequence(sequence)}`;

export const parseOrderDateContext = (value?: string): OrderDateContext | null => parseCandidateOrderDate(value);

export const resolveOrderDateContext = (value?: string): OrderDateContext =>
  parseCandidateOrderDate(value) ?? buildCurrentKstOrderDate();

export const allocatePurchaseOrderNumberForContext = (context: OrderDateContext) => {
  const sequence = incrementSequenceForDate(context.dateKey);
  return {
    ...context,
    sequence,
    orderNumber: buildOrderNumber(context.dateKey, sequence),
  };
};

export const peekNextPurchaseOrderNumberForContext = (context: OrderDateContext) => {
  const sequence = peekSequenceForDate(context.dateKey) + 1;
  return {
    ...context,
    sequence,
    orderNumber: buildOrderNumber(context.dateKey, sequence),
  };
};

export type PurchaseOrderStatus = 'open' | 'partial' | 'closed' | 'canceled' | 'draft';
export type PurchaseOrderLineStatus = 'open' | 'partial' | 'closed';

export interface PurchaseOrderLineRecord {
  id: string;
  poId: string;
  sku: string;
  orderedQty: number;
  receivedQty: number;
  status: PurchaseOrderLineStatus;
  createdAt: string;
  updatedAt: string;
  unit?: string;
  productName?: string;
  unitPrice?: number;
  taxAmount?: number;
  taxLabel?: string;
  amount?: number;
  currency?: string;
  taxTypeId?: string;
}

export interface PurchaseOrderRecord {
  id: string;
  vendorId: string;
  vendorName: string;
  orderNumber: string;
  status: PurchaseOrderStatus;
  memo: string | null;
  createdAt: string;
  approvedAt: string | null;
  promisedDate: string | null;
  orderDate: string;
  orderSequence?: number;
  lines: PurchaseOrderLineRecord[];
}

const purchaseOrders = new Map<string, PurchaseOrderRecord>();

const normalizeSku = (value: string): string => value.trim().toUpperCase();
const ensurePositiveNumber = (value: number): number => Math.max(0, Math.round(value));

const sanitizeStringValue = (value?: string | null): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const sanitizeCurrencyValue = (value?: number | null): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.round(value);
};

const sanitizeLineInput = (line: CreatePurchaseOrderInput['lines'][number]) => ({
  sku: normalizeSku(line.sku ?? ''),
  orderedQty: ensurePositiveNumber(line.orderedQty ?? 0),
  productName: sanitizeStringValue(line.productName),
  unit: sanitizeStringValue(line.unit),
  unitPrice: sanitizeCurrencyValue(line.unitPrice),
  amount: sanitizeCurrencyValue(line.amount),
  taxAmount: sanitizeCurrencyValue(line.taxAmount),
  taxLabel: sanitizeStringValue(line.taxLabel),
  currency: sanitizeStringValue(line.currency),
  taxTypeId: sanitizeStringValue(line.taxTypeId),
});

const buildLineRecords = (
  poId: string,
  sanitizedLines: Array<ReturnType<typeof sanitizeLineInput>>,
  timestamp: string,
  options?: { allowEmptyLines?: boolean },
) => {
  const filtered = options?.allowEmptyLines
    ? sanitizedLines
    : sanitizedLines.filter((line) => line.sku && line.orderedQty > 0);

  return filtered.map((line) => ({
    id: randomUUID(),
    poId,
    sku: line.sku,
    orderedQty: line.orderedQty,
    receivedQty: 0,
    status: 'open' as PurchaseOrderLineStatus,
    unit: line.unit ?? 'EA',
    productName: line.productName,
    unitPrice: line.unitPrice,
    taxAmount: line.taxAmount,
    taxLabel: line.taxLabel,
    amount: line.amount,
    currency: line.currency,
    taxTypeId: line.taxTypeId,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
};

const deriveLineStatus = (orderedQty: number, receivedQty: number): PurchaseOrderLineStatus => {
  if (receivedQty >= orderedQty && orderedQty > 0) {
    return 'closed';
  }
  if (receivedQty > 0) {
    return 'partial';
  }
  return 'open';
};

const deriveOrderStatus = (lines: PurchaseOrderLineRecord[]): PurchaseOrderStatus => {
  if (lines.every((line) => line.status === 'closed')) {
    return 'closed';
  }
  if (lines.some((line) => line.status !== 'open')) {
    return 'partial';
  }
  return 'open';
};

export interface CreatePurchaseOrderInput {
  vendorId: string;
  vendorName?: string;
  orderNumber?: string;
  orderDate?: string;
  memo?: string;
  promisedDate?: string;
  status?: PurchaseOrderStatus;
  lines: Array<{
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
  }>;
}

export interface SavePurchaseOrderDraftInput extends CreatePurchaseOrderInput {
  id?: string;
}

export const createPurchaseOrder = (input: CreatePurchaseOrderInput): PurchaseOrderRecord => {
  const now = new Date().toISOString();
  const id = `PO-${randomUUID().slice(0, 8)}`;
  const sanitizedVendorId = input.vendorId.trim();
  const sanitizedVendorName = sanitizeStringValue(input.vendorName) ?? sanitizedVendorId;
  const sanitizedOrderNumber = sanitizeStringValue(input.orderNumber) ?? id;
  const sanitizedLines = input.lines.map(sanitizeLineInput);
  const lines = buildLineRecords(id, sanitizedLines, now);
  const orderDateContext = resolveOrderDateContext(input.orderDate);
  const isDraft = input.status === 'draft';
  const generatedOrderNumber = isDraft ? null : allocatePurchaseOrderNumberForContext(orderDateContext);
  const finalOrderNumber = generatedOrderNumber?.orderNumber ?? sanitizedOrderNumber;
  const finalOrderSequence = generatedOrderNumber?.sequence;

  const recordStatus =
    input.status === 'draft'
      ? 'draft'
      : lines.length
        ? deriveOrderStatus(lines)
        : 'closed';

  const record: PurchaseOrderRecord = {
    id,
    vendorId: sanitizedVendorId,
    vendorName: sanitizedVendorName,
    orderNumber: finalOrderNumber,
    memo: input.memo?.trim() || null,
    status: recordStatus,
    createdAt: now,
    approvedAt: null,
    promisedDate: input.promisedDate ?? null,
    orderDate: orderDateContext.orderDate,
    orderSequence: finalOrderSequence,
    lines,
  };

  purchaseOrders.set(id, record);
  return { ...record };
};

const applyDraftUpdate = (record: PurchaseOrderRecord, input: SavePurchaseOrderDraftInput): PurchaseOrderRecord => {
  const now = new Date().toISOString();
  const sanitizedVendorId = input.vendorId.trim();
  const sanitizedVendorName = sanitizeStringValue(input.vendorName) ?? sanitizedVendorId;
  const sanitizedOrderNumber = sanitizeStringValue(input.orderNumber) ?? record.orderNumber;
  const orderDateUpdate =
    input.orderDate !== undefined ? parseOrderDateContext(input.orderDate) : null;

  record.vendorId = sanitizedVendorId;
  record.vendorName = sanitizedVendorName;
  record.orderNumber = sanitizedOrderNumber;
  if (orderDateUpdate) {
    record.orderDate = orderDateUpdate.orderDate;
  }

  if (input.memo !== undefined) {
    record.memo = input.memo.trim() || null;
  }
  if (input.promisedDate !== undefined) {
    const trimmedDate = input.promisedDate.trim();
    record.promisedDate = trimmedDate === '' ? null : trimmedDate;
  }

  if (input.lines) {
    const sanitizedLines = input.lines.map(sanitizeLineInput);
    record.lines = buildLineRecords(record.id, sanitizedLines, now);
  }

  purchaseOrders.set(record.id, record);
  return { ...record, lines: [...record.lines] };
};

export const savePurchaseOrderDraft = (input: SavePurchaseOrderDraftInput): PurchaseOrderRecord => {
  if (input.id) {
    const existing = purchaseOrders.get(input.id);
    if (!existing) {
      throw new Error('Purchase order not found');
    }
    if (existing.status !== 'draft') {
      throw new Error('Drafts can only be updated while in draft status');
    }
    return applyDraftUpdate(existing, input);
  }

  const created = createPurchaseOrder({ ...input, status: 'draft' });
  return created;
};

export interface ListPurchaseOrdersOptions {
  from?: number;
  to?: number;
}

export const listPurchaseOrders = (options?: ListPurchaseOrdersOptions): PurchaseOrderRecord[] => {
  const { from, to } = options ?? {};
  const records = Array.from(purchaseOrders.values()).filter((record) => {
    const createdAtMs = Date.parse(record.createdAt);
    if (Number.isNaN(createdAtMs)) {
      return true;
    }
    if (from !== undefined && createdAtMs < from) {
      return false;
    }
    if (to !== undefined && createdAtMs > to) {
      return false;
    }
    return true;
  });

  return records.map((record) => ({ ...record, lines: [...record.lines] }));
};

export const getPurchaseOrder = (id: string): PurchaseOrderRecord | null => {
  const record = purchaseOrders.get(id);
  return record ? { ...record, lines: [...record.lines] } : null;
};

export const approvePurchaseOrder = (id: string, approvedAt?: string): PurchaseOrderRecord | null => {
  const record = purchaseOrders.get(id);
  if (!record) {
    return null;
  }
  record.approvedAt = approvedAt ?? new Date().toISOString();
  purchaseOrders.set(id, record);
  return { ...record, lines: [...record.lines] };
};

export const cancelPurchaseOrder = (id: string): PurchaseOrderRecord | null => {
  const record = purchaseOrders.get(id);
  if (!record) {
    return null;
  }
  record.status = 'canceled';
  purchaseOrders.set(id, record);
  return { ...record, lines: [...record.lines] };
};

export const deletePurchaseOrder = (id: string): PurchaseOrderRecord | null => {
  const record = purchaseOrders.get(id);
  if (!record) {
    return null;
  }
  purchaseOrders.delete(id);
  return { ...record, lines: [...record.lines] };
};

export interface PurchaseReceiptResult {
  order: PurchaseOrderRecord;
  previousReceivedQty: number;
  line: PurchaseOrderLineRecord;
}

export const recordPurchaseReceipt = (
  poId: string,
  lineId: string,
  quantity: number,
  receivedAt?: string,
): PurchaseReceiptResult | null => {
  const record = purchaseOrders.get(poId);
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
  const previousReceivedQty = line.receivedQty;
  line.receivedQty = Math.min(line.orderedQty, line.receivedQty + qty);
  line.status = deriveLineStatus(line.orderedQty, line.receivedQty);
  line.updatedAt = receivedAt ?? new Date().toISOString();
  record.status = deriveOrderStatus(record.lines);
  purchaseOrders.set(poId, record);
  return {
    order: { ...record, lines: [...record.lines] },
    previousReceivedQty,
    line: { ...line },
  };
};
