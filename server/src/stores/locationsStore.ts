import { randomUUID } from 'node:crypto';

import { ensureWarehouseSeedData, findWarehouseByCode } from './warehousesStore.js';
import { deleteInventoryByLocation, renameInventoryLocation } from './inventoryStore.js';

export interface LocationPayload {
  code: string;
  warehouseCode: string;
  description: string;
  notes?: string | null;
}

export interface LocationRecord extends LocationPayload {
  id: string;
  createdAt: string;
  updatedAt: string;
}

const locationStore = new Map<string, LocationRecord>();

const readSeedPreference = () => process.env.SEED_SAMPLE_DATA === 'true';

let autoSeed = readSeedPreference();

const normalizeWarehouseCode = (value: string): string => value.trim().toLowerCase();
const normalizeDescription = (value: string): string => value.trim().toLowerCase();

const sanitizeForCode = (value: string): string =>
  value
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 12);

const sanitizeWarehousePrefix = (warehouseCode: string): string =>
  warehouseCode
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'WH';

const generateLocationCode = (warehouseCode: string, description: string): string => {
  const prefix = sanitizeWarehousePrefix(warehouseCode);
  const base = sanitizeForCode(description) || 'LOC';
  let attempt = 0;
  while (attempt < 1000) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const candidate = `${prefix}-${base}${suffix}`;
    if (!locationStore.has(candidate)) {
      return candidate;
    }
    attempt += 1;
  }
  return `${prefix}-${randomUUID().slice(0, 6).toUpperCase()}`;
};

const defaultLocations: LocationPayload[] = [
  {
    code: 'SEOUL-A1',
    warehouseCode: 'WH-SEOUL',
    description: '상온 A1 랙 존',
  },
  {
    code: 'SEOUL-C1',
    warehouseCode: 'WH-SEOUL',
    description: '냉장 C1 존',
  },
  {
    code: 'BUSAN-A1',
    warehouseCode: 'WH-BUSAN',
    description: '상온 A1 존',
  },
  {
    code: 'DAEJEON-B2',
    warehouseCode: 'WH-DAEJEON',
    description: '저온 B2 존',
  },
];

const normalizeNotes = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

function toRecord(payload: LocationPayload): LocationRecord {
  const now = new Date().toISOString();
  return {
    ...payload,
    notes: normalizeNotes(payload.notes),
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
}

export function ensureLocationSeedData(): void {
  ensureWarehouseSeedData();

  if (!autoSeed) {
    return;
  }

  autoSeed = false;

  if (locationStore.size > 0) {
    return;
  }

  defaultLocations.forEach((payload) => {
    if (findWarehouseByCode(payload.warehouseCode) && !locationStore.has(payload.code)) {
      locationStore.set(payload.code, toRecord(payload));
    }
  });
}


export function listLocations(): LocationRecord[] {
  ensureLocationSeedData();
  return Array.from(locationStore.values()).sort((a, b) => a.code.localeCompare(b.code));
}

export function findLocationByCode(code: string): LocationRecord | undefined {
  ensureLocationSeedData();
  return locationStore.get(code);
}

export function findLocationByDescription(warehouseCode: string, description: string): LocationRecord | undefined {
  ensureLocationSeedData();
  const normalizedWarehouse = normalizeWarehouseCode(warehouseCode);
  const normalizedDescriptionValue = normalizeDescription(description);
  if (!normalizedWarehouse || !normalizedDescriptionValue) {
    return undefined;
  }
  return Array.from(locationStore.values()).find(
    (record) =>
      normalizeWarehouseCode(record.warehouseCode) === normalizedWarehouse &&
      normalizeDescription(record.description) === normalizedDescriptionValue,
  );
}

export function createLocation(payload: LocationPayload): LocationRecord {
  ensureLocationSeedData();
  if (!findWarehouseByCode(payload.warehouseCode)) {
    throw new Error('연결된 물류센터를 찾을 수 없습니다.');
  }

  if (locationStore.has(payload.code)) {
    throw new Error('이미 존재하는 로케이션 코드입니다.');
  }

  const record = toRecord(payload);
  locationStore.set(record.code, record);
  return record;
}

export function findOrCreateLocation(warehouseCode: string, description: string): LocationRecord {
  ensureLocationSeedData();
  const trimmedWarehouseCode = warehouseCode.trim();
  const trimmedDescription = description.trim();
  if (!trimmedWarehouseCode) {
    throw new Error('창고 코드는 비어 있을 수 없습니다.');
  }
  if (!trimmedDescription) {
    throw new Error('로케이션 설명은 비어 있을 수 없습니다.');
  }

  const existingByCode = findLocationByCode(trimmedDescription);
  if (existingByCode && normalizeWarehouseCode(existingByCode.warehouseCode) === normalizeWarehouseCode(trimmedWarehouseCode)) {
    return existingByCode;
  }

  const existing = findLocationByDescription(trimmedWarehouseCode, trimmedDescription);
  if (existing) {
    return existing;
  }

  const code = generateLocationCode(trimmedWarehouseCode, trimmedDescription);
  return createLocation({ code, warehouseCode: trimmedWarehouseCode, description: trimmedDescription });
}

export function updateLocation(
  code: string,
  changes: Pick<LocationPayload, 'warehouseCode' | 'description'> & { notes?: string | null },
): LocationRecord {
  ensureLocationSeedData();
  const existing = locationStore.get(code);
  if (!existing) {
    throw new Error('요청한 로케이션을 찾을 수 없습니다.');
  }

  if (changes.warehouseCode !== existing.warehouseCode) {
    if (!findWarehouseByCode(changes.warehouseCode)) {
      throw new Error('연결된 물류센터를 찾을 수 없습니다.');
    }
  }

  const updated: LocationRecord = {
    ...existing,
    ...changes,
    notes: changes.notes === undefined ? existing.notes ?? null : normalizeNotes(changes.notes),
    updatedAt: new Date().toISOString(),
  };
  locationStore.set(code, updated);
  return updated;
}

export function renameLocation(oldCode: string, payload: LocationPayload): LocationRecord {
  ensureLocationSeedData();
  const existing = locationStore.get(oldCode);
  if (!existing) {
    throw new Error('요청한 로케이션을 찾을 수 없습니다.');
  }

  if (!findWarehouseByCode(payload.warehouseCode)) {
    throw new Error('연결된 물류센터를 찾을 수 없습니다.');
  }

  if (payload.code !== oldCode && locationStore.has(payload.code)) {
    throw new Error('이미 존재하는 로케이션 코드입니다.');
  }

  const updated: LocationRecord = {
    ...existing,
    ...payload,
    notes: payload.notes === undefined ? existing.notes ?? null : normalizeNotes(payload.notes),
    updatedAt: new Date().toISOString(),
  };

  if (payload.code !== oldCode) {
    locationStore.delete(oldCode);
  }
  locationStore.set(payload.code, updated);

  if (payload.code !== oldCode || existing.warehouseCode !== payload.warehouseCode) {
    renameInventoryLocation(oldCode, payload.code, payload.warehouseCode);
  }

  return updated;
}

export function deleteLocation(code: string): LocationRecord | undefined {
  ensureLocationSeedData();
  const existing = locationStore.get(code);
  if (!existing) {
    return undefined;
  }

  locationStore.delete(code);
  deleteInventoryByLocation(code);
  return existing;
}

export function deleteLocationsByWarehouse(warehouseCode: string): LocationRecord[] {
  ensureLocationSeedData();
  const removed: LocationRecord[] = [];
  Array.from(locationStore.values())
    .filter((location) => location.warehouseCode === warehouseCode)
    .forEach((location) => {
      locationStore.delete(location.code);
      deleteInventoryByLocation(location.code);
      removed.push(location);
    });
  return removed;
}

export function __resetLocationStore(seed = readSeedPreference()): void {
  locationStore.clear();
  autoSeed = seed;
}

export function __getLocationRecords(): LocationRecord[] {
  return listLocations();
}
