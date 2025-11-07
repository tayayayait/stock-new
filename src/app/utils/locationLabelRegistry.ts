const STORAGE_KEY = 'stockwise.locationLabels';

type LocationLabelEntry = {
  warehouseName?: string;
  locationName?: string;
  updatedAt: string;
};

type RegistryRecord = Record<string, LocationLabelEntry>;

const memoryCache: RegistryRecord = {};

const loadRegistry = (): RegistryRecord => {
  if (Object.keys(memoryCache).length > 0) {
    return memoryCache;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return memoryCache;
    }
    const parsed = JSON.parse(raw) as RegistryRecord;
    if (parsed && typeof parsed === 'object') {
      Object.assign(memoryCache, parsed);
    }
  } catch {
    // ignore malformed data
  }
  return memoryCache;
};

const persistRegistry = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryCache));
  } catch {
    // ignore quota errors
  }
};

const makeKey = (warehouseCode?: string | null, locationCode?: string | null) => {
  const warehouse = warehouseCode?.trim();
  const location = locationCode?.trim();
  if (!warehouse || !location) {
    return null;
  }
  return `${warehouse}::${location}`;
};

export const rememberLocationLabel = (input: {
  warehouseCode?: string | null;
  warehouseName?: string | null;
  locationCode?: string | null;
  locationName?: string | null;
}) => {
  const key = makeKey(input.warehouseCode, input.locationCode);
  if (!key) {
    return;
  }
  const registry = loadRegistry();
  const warehouseName = input.warehouseName?.trim();
  const locationName = input.locationName?.trim();
  const existing = registry[key];
  if (
    existing &&
    existing.warehouseName === warehouseName &&
    existing.locationName === locationName
  ) {
    return;
  }
  registry[key] = {
    warehouseName,
    locationName,
    updatedAt: new Date().toISOString(),
  };
  persistRegistry();
};

export const getLocationLabel = (
  warehouseCode?: string | null,
  locationCode?: string | null,
): { warehouseName?: string; locationName?: string } | null => {
  const key = makeKey(warehouseCode, locationCode);
  if (!key) {
    return null;
  }
  const registry = loadRegistry();
  const entry = registry[key];
  if (!entry) {
    return null;
  }
  return {
    warehouseName: entry.warehouseName,
    locationName: entry.locationName,
  };
};
