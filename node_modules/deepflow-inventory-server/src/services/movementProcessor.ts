import { randomUUID } from 'node:crypto';

import type { MovementDraft, MovementRecord, MovementType } from '../../../shared/movements/types.js';
import { addMovementRecord } from '../stores/movementsStore.js';
import { recordMovementForAnalytics } from '../stores/movementAnalyticsStore.js';
import {
  listInventoryForSku,
  replaceInventoryForSku,
  summarizeInventory,
  type InventoryRecord,
} from '../stores/inventoryStore.js';
import { __adjustProductMovementTotals } from '../routes/products.js';
import {
  recordPurchaseReceipt,
  type PurchaseReceiptResult,
} from '../stores/purchaseOrdersStore.js';
import { recordSalesShipment } from '../stores/salesOrdersStore.js';
import { recordLeadTimeSample, recordFinalLeadTime } from '../stores/leadTimeStore.js';

type MovementTotals = { inbound: number; outbound: number };

export type InventoryBalanceRecord = {
  sku: string;
  warehouse: string;
  location?: string;
  qty: number;
  updatedAt: string;
};

const inventoryBalances = new Map<string, InventoryBalanceRecord>();

const buildBalanceKey = (sku: string, warehouse: string, location?: string) =>
  `${sku}::${warehouse}::${location ?? ''}`;

const buildInventoryStoreKey = (warehouse: string, location?: string) => `${warehouse}::${location ?? ''}`;

const cloneBalance = (balance: InventoryBalanceRecord): InventoryBalanceRecord => ({
  ...balance,
  location: balance.location,
});

class InventoryConflictError extends Error {}

const ensureBalanceSnapshot = (sku: string, warehouse: string, location?: string) => {
  const key = buildBalanceKey(sku, warehouse, location);
  const existing = inventoryBalances.get(key);
  if (existing) {
    return { key, balance: existing };
  }

  const snapshot = listInventoryForSku(sku).find((record) => {
    const recordLocation = record.locationCode?.trim() || undefined;
    const targetLocation = location?.trim() || undefined;
    return record.warehouseCode === warehouse && recordLocation === targetLocation;
  });

  const balance: InventoryBalanceRecord = {
    sku,
    warehouse,
    location,
    qty: snapshot?.onHand ?? 0,
    updatedAt: snapshot ? new Date().toISOString() : new Date(0).toISOString(),
  };
  inventoryBalances.set(key, balance);
  return { key, balance };
};

const applyMovementToBalances = (movement: MovementRecord, timestamp: string) => {
  const affected: InventoryBalanceRecord[] = [];

  switch (movement.type) {
    case 'RECEIPT':
    case 'RETURN': {
      const warehouse = movement.toWarehouse!;
      const { key, balance } = ensureBalanceSnapshot(movement.sku, warehouse, movement.toLocation);
      const updated = { ...balance, qty: balance.qty + movement.qty, updatedAt: timestamp };
      inventoryBalances.set(key, updated);
      affected.push(cloneBalance(updated));
      break;
    }
    case 'ISSUE': {
      const warehouse = movement.fromWarehouse!;
      const { key, balance } = ensureBalanceSnapshot(movement.sku, warehouse, movement.fromLocation);
      if (balance.qty < movement.qty) {
        throw new InventoryConflictError('재고가 부족합니다.');
      }
      const updated = { ...balance, qty: balance.qty - movement.qty, updatedAt: timestamp };
      inventoryBalances.set(key, updated);
      affected.push(cloneBalance(updated));
      break;
    }
    case 'TRANSFER': {
      const fromWarehouse = movement.fromWarehouse!;
      const toWarehouse = movement.toWarehouse!;
      const fromLookup = ensureBalanceSnapshot(movement.sku, fromWarehouse, movement.fromLocation);
      if (fromLookup.balance.qty < movement.qty) {
        throw new InventoryConflictError('출고 지점의 재고가 부족합니다.');
      }
      const updatedSource = {
        ...fromLookup.balance,
        qty: fromLookup.balance.qty - movement.qty,
        updatedAt: timestamp,
      } satisfies InventoryBalanceRecord;
      inventoryBalances.set(fromLookup.key, updatedSource);
      affected.push(cloneBalance(updatedSource));

      const toLookup = ensureBalanceSnapshot(movement.sku, toWarehouse, movement.toLocation);
      const updatedDest = {
        ...toLookup.balance,
        qty: toLookup.balance.qty + movement.qty,
        updatedAt: timestamp,
      } satisfies InventoryBalanceRecord;
      inventoryBalances.set(toLookup.key, updatedDest);
      affected.push(cloneBalance(updatedDest));
      break;
    }
    case 'ADJUST': {
      const warehouse = movement.toWarehouse!;
      const { key } = ensureBalanceSnapshot(movement.sku, warehouse, movement.toLocation);
      const updated: InventoryBalanceRecord = {
        sku: movement.sku,
        warehouse,
        location: movement.toLocation,
        qty: movement.qty,
        updatedAt: timestamp,
      };
      inventoryBalances.set(key, updated);
      affected.push(cloneBalance(updated));
      break;
    }
    default:
      break;
  }

  return affected;
};

const syncInventory = (movement: MovementRecord, balances: InventoryBalanceRecord[]) => {
  const existing = listInventoryForSku(movement.sku);
  const recordsByKey = new Map<string, InventoryRecord>();

  existing.forEach((record) => {
    recordsByKey.set(buildInventoryStoreKey(record.warehouseCode, record.locationCode), { ...record });
  });

  balances.forEach((balance) => {
    const locationCode = balance.location ?? '';
    const key = buildInventoryStoreKey(balance.warehouse, locationCode);
    const current = recordsByKey.get(key);
    recordsByKey.set(key, {
      sku: movement.sku,
      warehouseCode: balance.warehouse,
      locationCode,
      onHand: Math.max(0, balance.qty),
      reserved: current?.reserved ?? 0,
    });
  });

  const nextRecords = Array.from(recordsByKey.values());
  replaceInventoryForSku(
    movement.sku,
    nextRecords.map((record) => ({ ...record })),
  );

  return summarizeInventory(movement.sku);
};

const calculateMovementTotalsDelta = (movement: MovementRecord): MovementTotals => {
  switch (movement.type) {
    case 'RECEIPT':
    case 'RETURN':
      return { inbound: movement.qty, outbound: 0 };
    case 'ISSUE':
      return { inbound: 0, outbound: movement.qty };
    case 'TRANSFER':
      return { inbound: movement.qty, outbound: movement.qty };
    default:
      return { inbound: 0, outbound: 0 };
  }
};

export interface MovementProcessingResult {
  movement: MovementRecord;
  balances: InventoryBalanceRecord[];
  inventory: ReturnType<typeof summarizeInventory>;
}

export const finalizeMovementDraft = (draft: MovementDraft): MovementProcessingResult => {
  const createdAt = new Date().toISOString();
  const movement: MovementRecord = {
    ...draft,
    id: randomUUID(),
    createdAt,
  };

  const balances = applyMovementToBalances(movement, createdAt);
  const inventory = syncInventory(movement, balances);

  addMovementRecord(movement);
  recordMovementForAnalytics(movement);

  if (movement.type === 'RECEIPT' && movement.poId && movement.poLineId) {
    const receipt = recordPurchaseReceipt(movement.poId, movement.poLineId, movement.qty, createdAt);
    if (receipt) {
      const { order, previousReceivedQty, line } = receipt;
      if (previousReceivedQty === 0 && line.receivedQty > 0 && order.approvedAt) {
        recordLeadTimeSample(movement.sku, order.vendorId, movement.poId, movement.poLineId, order.approvedAt, createdAt);
      }
      if (line.status === 'closed') {
        recordFinalLeadTime(movement.poId, movement.poLineId, createdAt);
      }
    }
  }
  if (movement.type === 'ISSUE' && movement.soId && movement.soLineId) {
    recordSalesShipment(movement.soId, movement.soLineId, movement.qty, createdAt);
  }

  const { inbound, outbound } = calculateMovementTotalsDelta(movement);
  if (inbound > 0 || outbound > 0) {
    __adjustProductMovementTotals(movement.sku, { inbound, outbound });
  }

  return { movement, balances, inventory };
};

export const resetMovementProcessorState = (): void => {
  inventoryBalances.clear();
};

export { InventoryConflictError };

export const getInventoryBalancesSnapshot = (): InventoryBalanceRecord[] =>
  Array.from(inventoryBalances.values()).map((balance) => cloneBalance(balance));
