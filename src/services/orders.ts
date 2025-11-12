import { emitInventoryRefreshEvent, type InventoryMovementLike } from '../app/utils/inventoryEvents';
import type { ProductRecordMock } from '../mocks/products';
import { productCatalog } from '../mocks/products';
import { isUtcWithinKstToday } from '@/shared/datetime/kst';

export type PartnerType = 'SUPPLIER' | 'CUSTOMER';

export interface Partner {
  id: string;
  type: PartnerType;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  isSample?: boolean;
  isActive: boolean;
}

export interface ListPartnersOptions {
  type?: PartnerType;
  includeSample?: boolean;
}

export interface CreatePartnerInput {
  type: PartnerType;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}

export interface UpdatePartnerInput {
  id: string;
  type?: PartnerType;
  name?: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export type OrderStatus = 'DRAFT' | 'OPEN' | 'PARTIAL' | 'RECEIVED' | 'CANCELLED';

export interface OrderStatusChangeEvent {
  id: string;
  orderId: string;
  kind: 'STATUS';
  from: OrderStatus;
  to: OrderStatus;
  occurredAt: string;
  note?: string;
}

export interface OrderFulfillmentLineEvent {
  sku: string;
  quantity: number;
  warehouseCode: string;
  locationCode: string;
  category?: string;
  productName?: string;
}

export interface OrderFulfillmentEvent {
  id: string;
  orderId: string;
  kind: 'RECEIVE' | 'SHIP';
  occurredAt: string;
  note?: string;
  lines: OrderFulfillmentLineEvent[];
}

export type OrderEvent = OrderStatusChangeEvent | OrderFulfillmentEvent;

interface BaseOrder {
  id: string;
  partnerId: string;
  status: OrderStatus;
  createdAt: string;
  scheduledAt: string;
  memo?: string;
  events: OrderEvent[];
  warehouseId?: string;
  warehouseCode?: string;
  detailedLocationId?: string;
  detailedLocationCode?: string;
  isSample?: boolean;
}

export interface PurchaseOrderItem {
  orderId: string;
  sku: string;
  qty: number;
  unit: string;
  receivedQty: number;
  warehouseCode?: string;
  locationCode?: string;
}

export interface PurchaseOrder extends BaseOrder {
  type: 'PURCHASE';
  items: PurchaseOrderItem[];
}

export interface SalesOrderItem {
  orderId: string;
  sku: string;
  qty: number;
  unit: string;
  shippedQty: number;
  warehouseCode?: string;
  locationCode?: string;
  category?: string;
  productName?: string;
}

export interface SalesOrder extends BaseOrder {
  type: 'SALES';
  items: SalesOrderItem[];
  isCsvImport?: boolean;
  csvImportRef?: string;
}

export interface PurchaseOrderSummary {
  id: string;
  partnerId: string;
  partnerName: string;
  status: OrderStatus;
  createdAt: string;
  scheduledAt: string;
  totalQty: number;
  receivedQty: number;
  warehouseId?: string;
  warehouseCode?: string;
  detailedLocationId?: string;
  detailedLocationCode?: string;
}

export interface SalesOrderSummary {
  id: string;
  partnerId: string;
  partnerName: string;
  status: OrderStatus;
  createdAt: string;
  scheduledAt: string;
  totalQty: number;
  shippedQty: number;
  warehouseId?: string;
  warehouseCode?: string;
  detailedLocationId?: string;
  detailedLocationCode?: string;
}

export interface CreatePurchaseOrderInput {
  partnerId: string;
  items: Array<{ sku: string; qty: number; unit: string }>;
  memo?: string;
  status?: OrderStatus;
  warehouseId: string;
  warehouseCode: string;
  detailedLocationId: string;
  detailedLocationCode: string;
  scheduledAt: string;
}

export interface CreateSalesOrderInput {
  partnerId: string;
  items: Array<{ sku: string; qty: number; unit: string }>;
  memo?: string;
  status?: OrderStatus;
  warehouseId: string;
  warehouseCode: string;
  detailedLocationId: string;
  detailedLocationCode: string;
  scheduledAt: string;
}

export interface FulfillmentInput {
  note?: string;
  lines: Array<{
    sku: string;
    quantity: number;
    warehouseCode: string;
    locationCode: string;
    category?: string;
    productName?: string;
  }>;
  /** Optional event time; if omitted uses now */
  occurredAt?: string;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const buildKstMonthKey = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  const shifted = new Date(timestamp + KST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}`;
};

const buildShipmentRowKey = (row: ShipmentCsvRow): string => {
  const normalize = (value?: string) => (value ? value.trim().toUpperCase() : '');
  const partnerId = normalize(row.partnerId);
  const partnerName = normalize(row.partnerName);
  const orderRef = normalize(row.orderRef);
  const sku = normalize(row.sku);
  const warehouse = normalize(row.warehouseCode);
  const location = normalize(row.locationCode);
  return [partnerId, partnerName, orderRef, row.occurredAt, sku, String(row.quantity), warehouse, location].join('|');
};

const importedShipmentRowKeys = new Set<string>();
const importedRowKeysByOrderId = new Map<string, string[]>();

const normalizeShipmentDate = (value: string): number => {
  const trimmed = value.trim();
  if (!trimmed) {
    return Number.NaN;
  }
  const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
  if (dateOnlyPattern.test(trimmed)) {
    const [year, month, day] = trimmed.split('-').map(Number);
    if ([year, month, day].some((part) => Number.isNaN(part))) {
      return Number.NaN;
    }
    return Date.UTC(year, month - 1, day) - KST_OFFSET_MS;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
};

const clone = <T>(value: T): T => {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
};

const generateId = (prefix: string): string => {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
};

const findProductRecord = (sku: string): ProductRecordMock | undefined =>
  productCatalog.items.find((item) => item.sku === sku);

const ensureValidUtcTimestamp = (value: string): number => {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error('유효한 날짜와 시간을 입력해주세요.');
  }
  return timestamp;
};

const applyReceiptToProductInventory = (
  lines: OrderFulfillmentLineEvent[],
): InventoryMovementLike[] => {
  const movements: InventoryMovementLike[] = [];

  lines.forEach(({ sku, quantity, warehouseCode, locationCode }) => {
    if (quantity <= 0) {
      return;
    }

    const product = findProductRecord(sku);
    if (!product) {
      return;
    }

    const normalizedWarehouse = warehouseCode?.trim() ?? '';
    const normalizedLocation = locationCode?.trim() ?? '';
    const productInventory = product.inventory ? [...product.inventory] : [];

    if (normalizedWarehouse || normalizedLocation) {
      let entry = productInventory.find(
        (item) =>
          item.warehouseCode === normalizedWarehouse && item.locationCode === normalizedLocation,
      );
      if (!entry) {
        entry = {
          warehouseCode: normalizedWarehouse,
          locationCode: normalizedLocation,
          onHand: 0,
          reserved: 0,
        };
        productInventory.push(entry);
      }
      entry.onHand += quantity;
    }

    product.inventory = productInventory;
    const totalOnHand = productInventory.reduce((sum, item) => sum + item.onHand, 0);
    if (productInventory.length > 0) {
      product.onHand = totalOnHand;
    } else {
      product.onHand = (product.onHand ?? 0) + quantity;
    }
    product.totalInbound = (product.totalInbound ?? 0) + quantity;

    movements.push({
      change: quantity,
      occurredAt: new Date().toISOString(),
      reason: 'purchase-receipt',
      productId: Number.isFinite(product.legacyProductId) ? product.legacyProductId : undefined,
      product: {
        id: Number.isFinite(product.legacyProductId) ? product.legacyProductId : undefined,
        sku: product.sku,
        name: product.name,
      },
      toLocation: {
        code: normalizedLocation || undefined,
        warehouse: normalizedWarehouse
          ? {
              code: normalizedWarehouse,
            }
          : undefined,
      },
    });
  });

  return movements;
};

const applyShipmentToProductInventory = (
  lines: OrderFulfillmentLineEvent[],
): InventoryMovementLike[] => {
  const movements: InventoryMovementLike[] = [];

  lines.forEach(({ sku, quantity, warehouseCode, locationCode }) => {
    if (quantity <= 0) {
      return;
    }

    const product = findProductRecord(sku);
    if (!product) {
      return;
    }

    const normalizedWarehouse = warehouseCode?.trim() ?? '';
    const normalizedLocation = locationCode?.trim() ?? '';
    const productInventory = product.inventory ? [...product.inventory] : [];

    if (normalizedWarehouse || normalizedLocation) {
      let entry = productInventory.find(
        (item) =>
          item.warehouseCode === normalizedWarehouse && item.locationCode === normalizedLocation,
      );
      if (!entry) {
        entry = {
          warehouseCode: normalizedWarehouse,
          locationCode: normalizedLocation,
          onHand: 0,
          reserved: 0,
        };
        productInventory.push(entry);
      }
      entry.onHand = Math.max(0, entry.onHand - quantity);
    }

    product.inventory = productInventory;
    if (productInventory.length > 0) {
      const totalOnHand = productInventory.reduce((sum, item) => sum + item.onHand, 0);
      product.onHand = Math.max(0, totalOnHand);
    } else {
      const currentOnHand =
        typeof product.onHand === 'number' && Number.isFinite(product.onHand) ? product.onHand : 0;
      product.onHand = Math.max(0, currentOnHand - quantity);
    }

    product.totalOutbound = (product.totalOutbound ?? 0) + quantity;

    const productId = Number.isFinite(product.legacyProductId) ? product.legacyProductId : undefined;
    movements.push({
      change: -quantity,
      occurredAt: new Date().toISOString(),
      reason: 'sales-shipment',
      productId,
      product: {
        id: productId,
        sku: product.sku,
        name: product.name,
      },
      fromLocation:
        normalizedWarehouse || normalizedLocation
          ? {
              code: normalizedLocation || undefined,
              warehouse: normalizedWarehouse
                ? {
                    code: normalizedWarehouse,
                  }
                : undefined,
            }
          : undefined,
    });
  });

  return movements;
};

const partners: Partner[] = [
  {
    id: 'partner-s-1',
    type: 'SUPPLIER',
    name: '한빛식품',
    phone: '02-1234-5678',
    email: 'sales@hanbitfood.co.kr',
    address: '서울특별시 성동구 성수이로 77',
    isSample: true,
    isActive: true,
  },
  {
    id: 'partner-s-2',
    type: 'SUPPLIER',
    name: '코리아패키징',
    phone: '031-987-6543',
    email: 'order@korpack.kr',
    address: '경기도 안산시 단원구 고잔로 22',
    isSample: true,
    isActive: true,
  },
  {
    id: 'partner-s-cheongho',
    type: 'SUPPLIER',
    name: '청호유통',
    phone: '02-345-1122',
    email: 'info@cheongho.co.kr',
    address: '서울특별시 구로구 디지털로 201',
    isSample: true,
    isActive: true,
  },
  {
    id: 'partner-c-1',
    type: 'CUSTOMER',
    name: '스타마켓 강남점',
    phone: '02-333-0001',
    email: 'stock@starmarket.kr',
    address: '서울특별시 강남구 테헤란로 320',
    isSample: true,
    isActive: true,
  },
  {
    id: 'partner-c-2',
    type: 'CUSTOMER',
    name: '프레시몰 온라인',
    phone: '02-444-0020',
    email: 'ops@freshmall.co.kr',
    address: '서울특별시 송파구 위례성대로 55',
    isSample: true,
    isActive: true,
  },
];

const purchaseOrders: PurchaseOrder[] = [
  {
    id: 'po-20250101-001',
    type: 'PURCHASE',
    partnerId: 'partner-s-1',
    status: 'OPEN',
    createdAt: '2025-01-04T02:00:00.000Z',
    scheduledAt: '2025-01-06T00:00:00.000Z',
    memo: '냉장창고 보충용',
    warehouseId: "wh-1",
    warehouseCode: 'WHS-SEOUL',
    detailedLocationId: "loc-101",
    detailedLocationCode: 'LOC-COLD-01',
    isSample: true,
    items: [
      {
        orderId: 'po-20250101-001',
        sku: 'ING-APPLE-10KG',
        qty: 120,
        unit: 'BOX',
        receivedQty: 60,
        warehouseCode: 'WHS-SEOUL',
        locationCode: 'LOC-COLD-01',
      },
      {
        orderId: 'po-20250101-001',
        sku: 'ING-BANANA-05KG',
        qty: 80,
        unit: 'BOX',
        receivedQty: 20,
        warehouseCode: 'WHS-SEOUL',
        locationCode: 'LOC-COLD-02',
      },
    ],
    events: [
      {
        id: 'po-20250101-001-status-open',
        orderId: 'po-20250101-001',
        kind: 'STATUS',
        from: 'DRAFT',
        to: 'OPEN',
        occurredAt: '2025-01-04T02:00:00.000Z',
      },
      {
        id: 'po-20250101-001-receive-1',
        orderId: 'po-20250101-001',
        kind: 'RECEIVE',
        occurredAt: '2025-01-06T01:30:00.000Z',
        lines: [
          {
            sku: 'ING-APPLE-10KG',
            quantity: 60,
            warehouseCode: 'WHS-SEOUL',
            locationCode: 'LOC-COLD-01',
          },
          {
            sku: 'ING-BANANA-05KG',
            quantity: 20,
            warehouseCode: 'WHS-SEOUL',
            locationCode: 'LOC-COLD-02',
          },
        ],
        note: '부분 입고 완료',
      },
    ],
  },
  {
    id: 'po-20250105-002',
    type: 'PURCHASE',
    partnerId: 'partner-s-2',
    status: 'DRAFT',
    createdAt: '2025-01-05T05:20:00.000Z',
    scheduledAt: '2025-01-08T00:00:00.000Z',
    memo: '패키지 자재 신규 발주',
    warehouseId: "wh-2",
    warehouseCode: 'WHS-ICN',
    detailedLocationId: "loc-202",
    detailedLocationCode: 'LOC-PACK-01',
    isSample: true,
    items: [
      {
        orderId: 'po-20250105-002',
        sku: 'PACK-BOX-20',
        qty: 200,
        unit: 'EA',
        receivedQty: 0,
        warehouseCode: 'WHS-ICN',
        locationCode: 'LOC-PACK-01',
      },
      {
        orderId: 'po-20250105-002',
        sku: 'PACK-TAPE-48',
        qty: 300,
        unit: 'EA',
        receivedQty: 0,
        warehouseCode: 'WHS-ICN',
        locationCode: 'LOC-PACK-01',
      },
    ],
    events: [
      {
        id: 'po-20250105-002-status-draft',
        orderId: 'po-20250105-002',
        kind: 'STATUS',
        from: 'DRAFT',
        to: 'DRAFT',
        occurredAt: '2025-01-05T05:20:00.000Z',
      },
    ],
  },
];

const salesOrders: SalesOrder[] = [];

const purgeSampleOrders = <T extends BaseOrder>(orders: T[]): void => {
  for (let index = orders.length - 1; index >= 0; index -= 1) {
    if (orders[index]?.isSample) {
      orders.splice(index, 1);
    }
  }
};

const purgeSampleSalesOrders = () => {
  purgeSampleOrders(salesOrders);
};

export interface ClearImportedShipmentsOptions {
  months?: string[];
}

export function clearImportedSalesOrders(options?: ClearImportedShipmentsOptions) {
  const targets = options?.months?.filter(Boolean) ?? [];
  const monthFilter = targets.length > 0 ? new Set(targets) : null;

  for (let index = salesOrders.length - 1; index >= 0; index -= 1) {
    const order = salesOrders[index];
    if (!order.isCsvImport) {
      continue;
    }
    if (monthFilter) {
      const monthKey = buildKstMonthKey(order.scheduledAt) ?? buildKstMonthKey(order.createdAt);
      if (!monthKey || !monthFilter.has(monthKey)) {
        continue;
      }
    }
    const storedKeys = importedRowKeysByOrderId.get(order.id);
    if (storedKeys) {
      storedKeys.forEach((key) => importedShipmentRowKeys.delete(key));
      importedRowKeysByOrderId.delete(order.id);
    }
    salesOrders.splice(index, 1);
  }
}

const findPartner = (partnerId: string) => partners.find((partner) => partner.id === partnerId);

export async function listPartners(options: ListPartnersOptions = {}) {
  const { type, includeSample = false } = options;

  const filtered = partners.filter((partner) => {
    if (!includeSample && partner.isSample) {
      return false;
    }
    if (type && partner.type !== type) {
      return false;
    }
    return true;
  });

  return clone(filtered);
}

export async function createPartner(input: CreatePartnerInput) {
  const type = input.type;
  if (type !== 'SUPPLIER' && type !== 'CUSTOMER') {
    throw new Error('거래처 유형을 선택하세요.');
  }

  const name = input.name?.trim();
  if (!name) {
    throw new Error('거래처명을 입력하세요.');
  }

  const idPrefix = type === 'SUPPLIER' ? 'partner-s' : 'partner-c';
  const partner: Partner = {
    id: generateId(idPrefix),
    type,
    name,
    phone: input.phone?.trim() || undefined,
    email: input.email?.trim() || undefined,
    address: input.address?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    isSample: false,
    isActive: true,
  };

  partners.push(partner);
  return clone(partner);
}

export async function updatePartner(input: UpdatePartnerInput) {
  const target = findPartner(input.id);
  if (!target) {
    throw new Error('해당 거래처를 찾을 수 없습니다.');
  }

  const nextType = input.type ?? target.type;
  if (nextType !== 'SUPPLIER' && nextType !== 'CUSTOMER') {
    throw new Error('거래처 유형을 선택하세요.');
  }

  const nextName = input.name?.trim() ?? target.name;
  if (!nextName) {
    throw new Error('거래처명을 입력하세요.');
  }

  const normalizeOptional = (value: string | null | undefined, current: string | undefined) => {
    if (value === undefined) {
      return current;
    }
    const trimmed = (value ?? '').trim();
    return trimmed ? trimmed : undefined;
  };

  target.type = nextType;
  target.name = nextName;
  target.phone = normalizeOptional(input.phone, target.phone);
  target.email = normalizeOptional(input.email, target.email);
  target.address = normalizeOptional(input.address, target.address);
  target.notes = normalizeOptional(input.notes, target.notes);
  if (typeof input.isActive === 'boolean') {
    target.isActive = input.isActive;
  }

  return clone(target);
}

export async function deletePartner(partnerId: string) {
  const index = partners.findIndex((partner) => partner.id === partnerId);
  if (index === -1) {
    throw new Error('해당 거래처를 찾을 수 없습니다.');
  }

  const [removed] = partners.splice(index, 1);
  return clone(removed);
}

const computePurchaseSummary = (order: PurchaseOrder): PurchaseOrderSummary => {
  const partner = findPartner(order.partnerId);
  const totalQty = order.items.reduce((sum, item) => sum + item.qty, 0);
  const receivedQty = order.items.reduce((sum, item) => sum + item.receivedQty, 0);
  return {
    id: order.id,
    partnerId: order.partnerId,
    partnerName: partner?.name ?? '—',
    status: order.status,
    createdAt: order.createdAt,
    scheduledAt: order.scheduledAt,
    totalQty,
    receivedQty,
    warehouseId: order.warehouseId,
    warehouseCode: order.warehouseCode,
    detailedLocationId: order.detailedLocationId,
    detailedLocationCode: order.detailedLocationCode,
  };
};

const computeSalesSummary = (order: SalesOrder): SalesOrderSummary => {
  const partner = findPartner(order.partnerId);
  const totalQty = order.items.reduce((sum, item) => sum + item.qty, 0);
  const shippedQty = order.items.reduce((sum, item) => sum + item.shippedQty, 0);
  return {
    id: order.id,
    partnerId: order.partnerId,
    partnerName: partner?.name ?? '—',
    status: order.status,
    createdAt: order.createdAt,
    scheduledAt: order.scheduledAt,
    totalQty,
    shippedQty,
    warehouseId: order.warehouseId,
    warehouseCode: order.warehouseCode,
    detailedLocationId: order.detailedLocationId,
    detailedLocationCode: order.detailedLocationCode,
  };
};

const resolvePurchaseStatus = (order: PurchaseOrder) => {
  const total = order.items.reduce((sum, item) => sum + item.qty, 0);
  const received = order.items.reduce((sum, item) => sum + item.receivedQty, 0);
  if (received === 0) {
    return order.status === 'CANCELLED' ? 'CANCELLED' : 'OPEN';
  }
  if (received >= total) {
    return 'RECEIVED';
  }
  return 'PARTIAL';
};

const resolveSalesStatus = (order: SalesOrder) => {
  const total = order.items.reduce((sum, item) => sum + item.qty, 0);
  const shipped = order.items.reduce((sum, item) => sum + item.shippedQty, 0);
  if (shipped === 0) {
    return order.status === 'CANCELLED' ? 'CANCELLED' : 'OPEN';
  }
  if (shipped >= total) {
    return 'RECEIVED';
  }
  return 'PARTIAL';
};

export async function listPurchaseOrders(): Promise<PurchaseOrderSummary[]> {
  return purchaseOrders.map((order) => computePurchaseSummary(order));
}

export async function listSalesOrders(): Promise<SalesOrderSummary[]> {
  return salesOrders.map((order) => computeSalesSummary(order));
}

export async function getPurchaseOrder(orderId: string): Promise<PurchaseOrder | undefined> {
  const order = purchaseOrders.find((entry) => entry.id === orderId);
  return order ? clone(order) : undefined;
}

export async function getSalesOrder(orderId: string): Promise<SalesOrder | undefined> {
  const order = salesOrders.find((entry) => entry.id === orderId);
  return order ? clone(order) : undefined;
}

const stripBom = (value: string) => (value && value.charCodeAt(0) === 0xfeff ? value.slice(1) : value);

/**
 * Very small CSV parser for simple, comma-separated data without embedded commas.
 * - Trims whitespace
 * - Skips empty lines and comment lines starting with '#'
 */
function parseSimpleCsv(text: string): { headers: string[]; rows: string[][] } {
  const normalizedLines = text
    .split(/\r?\n/)
    .map((line) => stripBom(line).trim())
    .filter((line) => line && !line.startsWith('#'));
  if (normalizedLines.length === 0) {
    return { headers: [], rows: [] };
  }
  const splitLine = (line: string) => stripBom(line).split(',').map((segment) => stripBom(segment).trim());
  const headers = splitLine(normalizedLines[0]);
  const rows = normalizedLines.slice(1).map(splitLine);
  return { headers, rows };
}

const normalizeHeaderName = (value: string) =>
  stripBom(value)
    .replace(/\s+/g, '')
    .replace(/[()（）]/g, '')
    .toLowerCase();

const HEADER_SYNONYMS = {
  orderRef: ['orderref', '주문참조', '주문번호'],
  occurredAt: ['occurredat', '발생일시', '발생시간', '발생시각'],
  partnerId: ['partnerid', '거래처id', '거래id', '거래처아이디'],
  partnerName: ['partnername', '거래처명', '고객명', '고객사'],
  sku: ['sku', 'sku품번', '품번'],
  productName: ['productname', '품명', '상품명', '제품명'],
  category: ['category', '카테고리', '대분류'],
  quantity: ['quantity', '출고량', '출고수량', '수량'],
  warehouseCode: ['warehousecode', '창고코드', '창고'],
  locationCode: ['locationcode', '로케이션코드', '로케이션', '위치코드'],
} as const;

const findHeaderIndex = (headers: string[], key: keyof typeof HEADER_SYNONYMS) => {
  const candidates = new Set(HEADER_SYNONYMS[key].map(normalizeHeaderName));
  return headers.findIndex((header) => candidates.has(normalizeHeaderName(header)));
};

export interface ShipmentCsvRow {
  /** Optional order reference to group multiple lines */
  orderRef?: string;
  /** occurredAt: ISO string or YYYY-MM-DD; bare dates assume KST midnight */
  occurredAt: string;
  /** partnerId or partnerName: at least one should exist */
  partnerId?: string;
  partnerName?: string;
  sku: string;
  productName?: string;
  category?: string;
  quantity: number;
  warehouseCode?: string;
  locationCode?: string;
}

export interface ImportShipmentsOptions {
  mode?: 'append' | 'replace';
}

interface ParsedShipmentRow extends ShipmentCsvRow {
  dedupKey: string;
  rowNum: number;
  monthKey: string | null;
}

export interface ImportShipmentsResult {
  addedOrders: number;
  addedLines: number;
  errors: string[];
}

/**
 * Imports simple shipment rows as Sales orders with SHIP events.
 * This mutates the in-memory salesOrders list used by the dashboard.
 *
 * Supported headers (case-insensitive):
 *  - orderRef (optional)
 *  - occurredAt (ISO or YYYY-MM-DD)
 *  - partnerId (optional)
 *  - partnerName (optional; used if partnerId missing)
 *  - sku, quantity
 *  - warehouseCode (optional), locationCode (optional)
 */
export async function importShipmentsFromCsv(
  csvText: string,
  options?: ImportShipmentsOptions,
): Promise<ImportShipmentsResult> {
  const { headers, rows } = parseSimpleCsv(csvText);
  const errors: string[] = [];
  if (headers.length === 0) {
    return { addedOrders: 0, addedLines: 0, errors: ['CSV 헤더가 없습니다.'] };
  }

  const idx = {
    orderRef: findHeaderIndex(headers, 'orderRef'),
    occurredAt: findHeaderIndex(headers, 'occurredAt'),
    partnerId: findHeaderIndex(headers, 'partnerId'),
    partnerName: findHeaderIndex(headers, 'partnerName'),
    sku: findHeaderIndex(headers, 'sku'),
    productName: findHeaderIndex(headers, 'productName'),
    category: findHeaderIndex(headers, 'category'),
    quantity: findHeaderIndex(headers, 'quantity'),
    warehouseCode: findHeaderIndex(headers, 'warehouseCode'),
    locationCode: findHeaderIndex(headers, 'locationCode'),
  } as const;

  if (idx.occurredAt === -1 || idx.sku === -1 || idx.quantity === -1) {
    return {
      addedOrders: 0,
      addedLines: 0,
      errors: ['필수 헤더(occurredAt, sku, quantity)가 누락되었습니다.'],
    };
  }

  type GroupKey = string;

  const toRow = (line: string[], rowNum: number): ShipmentCsvRow | undefined => {
    const occurredAtRaw = line[idx.occurredAt] ?? '';
    const ms = normalizeShipmentDate(occurredAtRaw);
    if (Number.isNaN(ms)) {
      errors.push(`행 ${rowNum}: occurredAt 값을 날짜로 해석할 수 없습니다.`);
      return undefined;
    }
    const occurredAt = new Date(ms).toISOString();
    const sku = (line[idx.sku] ?? '').trim();
    if (!sku) {
      errors.push(`행 ${rowNum}: sku가 비어 있습니다.`);
      return undefined;
    }
    const productNameRaw = idx.productName >= 0 ? (line[idx.productName] ?? '').trim() : '';
    const productName = productNameRaw || undefined;
    const categoryRaw = idx.category >= 0 ? (line[idx.category] ?? '').trim() : '';
    const category = categoryRaw || '기타';
    const qtyRaw = (line[idx.quantity] ?? '').replace(/,/g, '');
    const quantity = Number(qtyRaw);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push(`행 ${rowNum}: quantity는 양수여야 합니다.`);
      return undefined;
    }
    const partnerId = idx.partnerId >= 0 ? (line[idx.partnerId] ?? '').trim() : undefined;
    const partnerName = idx.partnerName >= 0 ? (line[idx.partnerName] ?? '').trim() : undefined;
    const orderRef = idx.orderRef >= 0 ? (line[idx.orderRef] ?? '').trim() : undefined;
    const warehouseCode = idx.warehouseCode >= 0 ? (line[idx.warehouseCode] ?? '').trim() : undefined;
    const locationCode = idx.locationCode >= 0 ? (line[idx.locationCode] ?? '').trim() : undefined;
    return {
      orderRef,
      occurredAt,
      partnerId,
      partnerName,
      sku,
      productName,
      category,
      quantity,
      warehouseCode,
      locationCode,
    };
  };

  const parsedRows: ParsedShipmentRow[] = [];
  const seenCsvRowKeys = new Set<string>();
  rows.forEach((line, index) => {
    const rowNum = index + 2;
    const row = toRow(line, rowNum);
    if (!row) {
      return;
    }
    const dedupKey = buildShipmentRowKey(row);
    if (seenCsvRowKeys.has(dedupKey)) {
      errors.push(`행 ${rowNum}: 같은 출고 데이터가 반복되어 있어 건너뜁니다.`);
      return;
    }
    seenCsvRowKeys.add(dedupKey);
    parsedRows.push({
      ...row,
      rowNum,
      dedupKey,
      monthKey: buildKstMonthKey(row.occurredAt),
    });
  });

  if (parsedRows.length === 0) {
    return { addedOrders: 0, addedLines: 0, errors };
  }

  const touchedMonths = new Set<string>();
  parsedRows.forEach((entry) => {
    if (entry.monthKey) {
      touchedMonths.add(entry.monthKey);
    }
  });

  const mode = options?.mode ?? 'append';
  if (mode === 'replace' && touchedMonths.size > 0) {
    clearImportedSalesOrders({ months: Array.from(touchedMonths) });
  }

  const uniqueRows: ParsedShipmentRow[] = [];
  const seenImportKeys = new Set<string>();
  parsedRows.forEach((entry) => {
    if (seenImportKeys.has(entry.dedupKey)) {
      errors.push(`행 ${entry.rowNum}: 같은 출고 데이터가 반복되어 있어 건너뜁니다.`);
      return;
    }
    if (importedShipmentRowKeys.has(entry.dedupKey)) {
      errors.push(`행 ${entry.rowNum}: 이전에 업로드한 데이터와 중복되어 건너뜁니다.`);
      return;
    }
    seenImportKeys.add(entry.dedupKey);
    uniqueRows.push(entry);
  });

  if (uniqueRows.length === 0) {
    return { addedOrders: 0, addedLines: 0, errors };
  }

  const groups = new Map<GroupKey, ParsedShipmentRow[]>();
  uniqueRows.forEach((row) => {
    const groupKeyBase =
      row.orderRef?.trim() || `${row.partnerId || row.partnerName || 'unknown'}|${row.occurredAt.slice(0, 10)}`;
    const key: GroupKey = groupKeyBase;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  });

  if (groups.size === 0) {
    return { addedOrders: 0, addedLines: 0, errors };
  }

  purgeSampleSalesOrders();

  const findPartnerByName = (name?: string) => (name ? partners.find((p) => p.name === name) : undefined);
  const defaultPartner = partners.find((p) => p.type === 'CUSTOMER') ?? partners[0];

  let addedOrders = 0;
  let addedLines = 0;

  for (const rowsInGroup of groups.values()) {
    if (rowsInGroup.length === 0) {
      continue;
    }
    const first = rowsInGroup[0];
    const occurredAt = first.occurredAt;
    const partner =
      (first.partnerId && partners.find((p) => p.id === first.partnerId)) ||
      findPartnerByName(first.partnerName) ||
      defaultPartner;

    const orderId = generateId('so-imp');
    const itemTotals = new Map<string, { qty: number; category?: string; productName?: string }>();
    rowsInGroup.forEach((r) => {
      const key = r.sku;
      const entry = itemTotals.get(key) ?? { qty: 0, category: r.category, productName: r.productName };
      entry.qty += r.quantity;
      if (!entry.category && r.category) {
        entry.category = r.category;
      }
      if (!entry.productName && r.productName) {
        entry.productName = r.productName;
      }
      itemTotals.set(key, entry);
    });

    const items = Array.from(itemTotals.entries()).map(([sku, info]) => ({
      orderId,
      sku,
      qty: info.qty,
      unit: 'EA',
      shippedQty: 0,
      warehouseCode: first.warehouseCode,
      locationCode: first.locationCode,
      category: info.category,
      productName: info.productName,
    }));

    const order: SalesOrder = {
      id: orderId,
      type: 'SALES',
      partnerId: partner?.id ?? 'partner-c-unknown',
      status: 'OPEN',
      createdAt: occurredAt,
      scheduledAt: occurredAt,
      memo: first.orderRef ? `CSV import ${first.orderRef}` : 'CSV import',
      warehouseId: undefined,
      warehouseCode: first.warehouseCode,
      detailedLocationId: undefined,
      detailedLocationCode: first.locationCode,
      items,
      events: [],
      isCsvImport: true,
      csvImportRef: first.orderRef?.trim() || undefined,
    };

    salesOrders.unshift(order);

    const fulfillmentLines = rowsInGroup.map((row) => ({
      sku: row.sku,
      quantity: row.quantity,
      warehouseCode: row.warehouseCode?.trim() ?? '',
      locationCode: row.locationCode?.trim() ?? '',
      category: row.category,
      productName: row.productName,
    }));

    let shipmentCreated = false;
    try {
      await recordSalesShipment(orderId, { lines: fulfillmentLines, occurredAt });
      shipmentCreated = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.';
      errors.push(`주문 ${orderId}: ${message}`);
    }

    if (shipmentCreated) {
      const orderRowKeys = rowsInGroup.map((row) => row.dedupKey);
      importedRowKeysByOrderId.set(orderId, orderRowKeys);
      orderRowKeys.forEach((key) => importedShipmentRowKeys.add(key));
    }

    addedOrders += 1;
    addedLines += rowsInGroup.length;
  }

  return { addedOrders, addedLines, errors };
}

const pushStatusEvent = (
  order: PurchaseOrder | SalesOrder,
  to: OrderStatus,
  note?: string,
) => {
  const lastStatus = order.status;
  if (lastStatus === to) {
    return;
  }
  const event: OrderStatusChangeEvent = {
    id: `${order.id}-status-${Date.now()}`,
    orderId: order.id,
    kind: 'STATUS',
    from: lastStatus,
    to,
    occurredAt: new Date().toISOString(),
    note,
  };
  order.events.push(event);
  order.status = to;
};

export async function updatePurchaseOrderStatus(orderId: string, status: OrderStatus, note?: string) {
  const order = purchaseOrders.find((entry) => entry.id === orderId);
  if (!order) {
    throw new Error(`Purchase order ${orderId} not found`);
  }
  pushStatusEvent(order, status, note);
  return clone(order);
}

export async function updateSalesOrderStatus(orderId: string, status: OrderStatus, note?: string) {
  const order = salesOrders.find((entry) => entry.id === orderId);
  if (!order) {
    throw new Error(`Sales order ${orderId} not found`);
  }
  pushStatusEvent(order, status, note);
  return clone(order);
}

const sanitizeLines = (lines: FulfillmentInput['lines']) =>
  lines.filter((line) => line.quantity > 0);

export async function recordPurchaseReceipt(orderId: string, input: FulfillmentInput) {
  const order = purchaseOrders.find((entry) => entry.id === orderId);
  if (!order) {
    throw new Error(`Purchase order ${orderId} not found`);
  }

  const updates = sanitizeLines(input.lines);
  if (!updates.length) {
    return clone(order);
  }

  const appliedLines: OrderFulfillmentLineEvent[] = [];

  updates.forEach(({ sku, quantity, warehouseCode, locationCode, category, productName }) => {
    const item = order.items.find((entry) => entry.sku === sku);
    if (!item) {
      return;
    }
    const previous = item.receivedQty;
    const next = Math.min(item.qty, previous + quantity);
    const appliedQuantity = Math.max(0, next - previous);
    if (appliedQuantity <= 0) {
      return;
    }

    item.receivedQty = next;

    appliedLines.push({
      sku: item.sku,
      quantity: appliedQuantity,
      warehouseCode: warehouseCode?.trim() || item.warehouseCode || order.warehouseCode || '',
      locationCode:
        locationCode?.trim() || item.locationCode || order.detailedLocationCode || '',
      category,
      productName,
    });
  });

  if (appliedLines.length === 0) {
    return clone(order);
  }

  const event: OrderFulfillmentEvent = {
    id: `${orderId}-receive-${Date.now()}`,
    orderId,
    kind: 'RECEIVE',
    occurredAt: new Date().toISOString(),
    note: input.note,
    lines: appliedLines,
  };

  order.events.push(event);
  const nextStatus = resolvePurchaseStatus(order);
  pushStatusEvent(order, nextStatus);

  const movements = applyReceiptToProductInventory(appliedLines);
  if (movements.length > 0) {
    emitInventoryRefreshEvent({ source: 'purchases', movements });
  }

  return clone(order);
}

export async function recordSalesShipment(orderId: string, input: FulfillmentInput) {
  const order = salesOrders.find((entry) => entry.id === orderId);
  if (!order) {
    throw new Error(`Sales order ${orderId} not found`);
  }

  const updates = sanitizeLines(input.lines);
  if (!updates.length) {
    return clone(order);
  }

  const appliedLines: OrderFulfillmentLineEvent[] = [];

  updates.forEach(({ sku, quantity, warehouseCode, locationCode, category, productName }) => {
    const item = order.items.find((entry) => entry.sku === sku);
    if (!item) {
      return;
    }
    const previous = item.shippedQty;
    const next = Math.min(item.qty, previous + quantity);
    const appliedQuantity = Math.max(0, next - previous);
    if (appliedQuantity <= 0) {
      return;
    }

    item.shippedQty = next;

    appliedLines.push({
      sku: item.sku,
      quantity: appliedQuantity,
      warehouseCode: warehouseCode?.trim() || item.warehouseCode || order.warehouseCode || '',
      locationCode:
        locationCode?.trim() || item.locationCode || order.detailedLocationCode || '',
      category: category ?? item.category,
      productName: productName ?? item.productName,
    });
  });

  if (appliedLines.length === 0) {
    return clone(order);
  }

  // Use provided occurredAt when valid, otherwise fall back to now
  const occurredAtIso =
    input.occurredAt && !Number.isNaN(Date.parse(input.occurredAt))
      ? new Date(input.occurredAt).toISOString()
      : new Date().toISOString();

  const event: OrderFulfillmentEvent = {
    id: `${orderId}-ship-${Date.now()}`,
    orderId,
    kind: 'SHIP',
    occurredAt: occurredAtIso,
    note: input.note,
    lines: appliedLines,
  };

  order.events.push(event);
  const nextStatus = resolveSalesStatus(order);
  pushStatusEvent(order, nextStatus);

  const movements = applyShipmentToProductInventory(appliedLines);
  if (movements.length > 0) {
    emitInventoryRefreshEvent({ source: 'sales', movements });
  }

  return clone(order);
}

export async function createPurchaseOrder(input: CreatePurchaseOrderInput) {
  const partner = findPartner(input.partnerId);
  if (!partner || partner.type !== 'SUPPLIER' || partner.isActive === false) {
    throw new Error('유효한 공급업체를 선택하세요.');
  }
  ensureValidUtcTimestamp(input.scheduledAt);
  const orderId = generateId('po');
  const now = new Date().toISOString();
  const status = input.status ?? 'DRAFT';
  const order: PurchaseOrder = {
    id: orderId,
    type: 'PURCHASE',
    partnerId: input.partnerId,
    status,
    createdAt: now,
    scheduledAt: input.scheduledAt,
    memo: input.memo,
    warehouseId: input.warehouseId,
    warehouseCode: input.warehouseCode,
    detailedLocationId: input.detailedLocationId,
    detailedLocationCode: input.detailedLocationCode,
    items: input.items.map((item) => ({
      orderId,
      sku: item.sku,
      qty: item.qty,
      unit: item.unit,
      receivedQty: status === 'RECEIVED' ? item.qty : 0,
      warehouseCode: input.warehouseCode,
      locationCode: input.detailedLocationCode,
    })),
    events: [
      {
        id: `${orderId}-status-${status.toLowerCase()}`,
        orderId,
        kind: 'STATUS',
        from: 'DRAFT',
        to: status,
        occurredAt: now,
      },
    ],
  };

  purchaseOrders.unshift(order);

  if (status === 'RECEIVED') {
    const initialReceiptLines = order.items
      .filter((item) => item.receivedQty > 0)
      .map<OrderFulfillmentLineEvent>((item) => ({
        sku: item.sku,
        quantity: item.receivedQty,
        warehouseCode: item.warehouseCode || input.warehouseCode || '',
        locationCode: item.locationCode || input.detailedLocationCode || '',
      }));

    if (initialReceiptLines.length > 0) {
      order.events.push({
        id: `${orderId}-receive-initial`,
        orderId,
        kind: 'RECEIVE',
        occurredAt: now,
        lines: initialReceiptLines,
      });

      const movements = applyReceiptToProductInventory(initialReceiptLines);
      if (movements.length > 0) {
        emitInventoryRefreshEvent({ source: 'purchases', movements });
      }
    }
  }

  return clone(order);
}

export async function createSalesOrder(input: CreateSalesOrderInput) {
  const partner = findPartner(input.partnerId);
  if (!partner || partner.isActive === false) {
    throw new Error('유효한 거래처를 선택해주세요.');
  }
  const scheduledAtUtc = ensureValidUtcTimestamp(input.scheduledAt);
  if (!isUtcWithinKstToday(scheduledAtUtc)) {
    throw new Error('출고 주문은 KST 기준 오늘(00:00~23:59)만 선택 가능합니다.');
  }
  const orderId = generateId('so');
  const now = new Date().toISOString();
  const status = input.status ?? 'DRAFT';
  const order: SalesOrder = {
    id: orderId,
    type: 'SALES',
    partnerId: input.partnerId,
    status,
    createdAt: now,
    scheduledAt: input.scheduledAt,
    memo: input.memo,
    warehouseId: input.warehouseId,
    warehouseCode: input.warehouseCode,
    detailedLocationId: input.detailedLocationId,
    detailedLocationCode: input.detailedLocationCode,
    items: input.items.map((item) => ({
      orderId,
      sku: item.sku,
      qty: item.qty,
      unit: item.unit,
      shippedQty: 0,
      warehouseCode: input.warehouseCode,
      locationCode: input.detailedLocationCode,
    })),
    events: [
      {
        id: `${orderId}-status-${status.toLowerCase()}`,
        orderId,
        kind: 'STATUS',
        from: 'DRAFT',
        to: status,
        occurredAt: now,
      },
    ],
  };

  purgeSampleSalesOrders();
  salesOrders.unshift(order);
  return clone(order);
}
