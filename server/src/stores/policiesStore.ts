import fs from 'node:fs';
import path from 'node:path';

const normalizeSku = (value: string): string => value.trim().toUpperCase();

export interface PolicyDraftRecord {
  sku: string;
  name: string | null;
  forecastDemand: number | null;
  demandStdDev: number | null;
  leadTimeDays: number | null;
  serviceLevelPercent: number | null;
  smoothingAlpha: number | null;
  corrRho: number | null;
}

const policyStore = new Map<string, PolicyDraftRecord>();
let dataDir = path.resolve(process.cwd(), 'server', '.data');
let storeFile = path.join(dataDir, 'policies.json');

const safeParseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const ensureDataDir = () => {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
};

const loadFromDisk = () => {
  try {
    if (!fs.existsSync(storeFile)) {
      return;
    }
    const raw = fs.readFileSync(storeFile, 'utf8');
    const parsed = safeParseJson(raw);
    if (!Array.isArray(parsed)) {
      return;
    }
    parsed.forEach((entry) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const record = entry as Partial<PolicyDraftRecord>;
      if (!record?.sku || typeof record.sku !== 'string') {
        return;
      }

      policyStore.set(normalizeSku(record.sku), {
        sku: normalizeSku(record.sku),
        name: typeof record.name === 'string' ? record.name.trim() || null : null,
        forecastDemand: typeof record.forecastDemand === 'number' ? record.forecastDemand : null,
        demandStdDev: typeof record.demandStdDev === 'number' ? record.demandStdDev : null,
        leadTimeDays: typeof record.leadTimeDays === 'number' ? record.leadTimeDays : null,
        serviceLevelPercent:
          typeof record.serviceLevelPercent === 'number' ? record.serviceLevelPercent : null,
        smoothingAlpha: typeof record.smoothingAlpha === 'number' ? record.smoothingAlpha : null,
        corrRho: typeof record.corrRho === 'number' ? record.corrRho : null,
      });
    });
  } catch {
    // Ignore load errors; store will start empty
  }
};

const persistToDisk = () => {
  try {
    ensureDataDir();
    const payload = JSON.stringify(Array.from(policyStore.values()), null, 2);
    fs.writeFileSync(storeFile, payload, 'utf8');
  } catch {
    // Ignore persistence errors to avoid crashing request handlers
  }
};

loadFromDisk();

const toNullableNumber = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return null;
  }
  return normalized >= 0 ? normalized : 0;
};

const clampServiceLevel = (value: number | null): number | null => {
  if (value === null) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(50, Math.min(99.9, value));
  return clamped;
};

const clampAlpha = (value: number | null): number | null => {
  if (value === null) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(1, value));
  return clamped;
};

const clampCorrelation = (value: number | null): number | null => {
  if (value === null) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(0, Math.min(0.5, value));
  return clamped;
};

const sanitizePolicyDraft = (draft: PolicyDraftRecord): PolicyDraftRecord | null => {
  if (!draft?.sku) {
    return null;
  }

  const normalizedSku = normalizeSku(draft.sku);
  if (!normalizedSku) {
    return null;
  }

  const normalizedName =
    typeof draft.name === 'string'
      ? draft.name.trim() || null
      : draft.name === null
        ? null
        : null;

  return {
    sku: normalizedSku,
    name: normalizedName,
    forecastDemand: toNullableNumber(draft.forecastDemand),
    demandStdDev: toNullableNumber(draft.demandStdDev),
    leadTimeDays: toNullableNumber(draft.leadTimeDays),
    serviceLevelPercent: clampServiceLevel(draft.serviceLevelPercent),
    smoothingAlpha: clampAlpha(draft.smoothingAlpha ?? null),
    corrRho: clampCorrelation(draft.corrRho ?? null),
  };
};

export const listPolicyDrafts = (): PolicyDraftRecord[] =>
  Array.from(policyStore.values()).map((record) => ({ ...record }));

export const getPolicyDraft = (sku: string): PolicyDraftRecord | null => {
  if (!sku) {
    return null;
  }
  const normalizedSku = normalizeSku(sku);
  const record = policyStore.get(normalizedSku);
  return record ? { ...record } : null;
};

export const savePolicyDrafts = (drafts: PolicyDraftRecord[]): void => {
  const entries = new Map<string, PolicyDraftRecord>();

  drafts.forEach((draft) => {
    if (!draft?.sku) {
      return;
    }
    const normalizedSku = normalizeSku(draft.sku);
    if (!normalizedSku) {
      return;
    }

    entries.set(normalizedSku, {
      ...(sanitizePolicyDraft({ ...draft, sku: normalizedSku }) ?? {
        sku: normalizedSku,
        name: null,
        forecastDemand: null,
        demandStdDev: null,
        leadTimeDays: null,
        serviceLevelPercent: null,
        smoothingAlpha: null,
        corrRho: null,
      }),
    });
  });

  policyStore.clear();
  entries.forEach((record) => {
    policyStore.set(record.sku, record);
  });

  persistToDisk();
};

export const upsertPolicyDraft = (draft: PolicyDraftRecord): void => {
  const sanitized = sanitizePolicyDraft(draft);
  if (!sanitized) {
    return;
  }

  policyStore.set(sanitized.sku, sanitized);
  persistToDisk();
};

export const hasPolicyDraft = (sku: string): boolean => {
  if (!sku) {
    return false;
  }
  const normalized = normalizeSku(sku);
  if (!normalized) {
    return false;
  }
  return policyStore.has(normalized);
};

export const renamePolicyDraft = (
  currentSku: string,
  nextSku: string,
  options?: { overwrite?: boolean },
): void => {
  if (!currentSku || !nextSku) {
    return;
  }

  const currentNormalized = normalizeSku(currentSku);
  const nextNormalized = normalizeSku(nextSku);
  if (!currentNormalized || !nextNormalized || currentNormalized === nextNormalized) {
    return;
  }

  const existing = policyStore.get(currentNormalized);
  if (!existing) {
    return;
  }

  const targetExists = policyStore.has(nextNormalized);
  if (targetExists && !options?.overwrite) {
    policyStore.delete(currentNormalized);
    persistToDisk();
    return;
  }

  const sanitized = sanitizePolicyDraft({ ...existing, sku: nextNormalized });
  policyStore.delete(currentNormalized);
  if (sanitized) {
    policyStore.set(nextNormalized, sanitized);
  }
  persistToDisk();
};

export const deletePolicyDrafts = (skus: Iterable<string>): string[] => {
  const removed: string[] = [];
  let mutated = false;
  const targets = new Set<string>();
  for (const sku of skus) {
    const normalized = normalizeSku(sku);
    if (normalized) {
      targets.add(normalized);
    }
  }

  targets.forEach((sku) => {
    if (policyStore.delete(sku)) {
      removed.push(sku);
      mutated = true;
    }
  });

  if (mutated) {
    persistToDisk();
  }

  return removed;
};

const setStoragePath = (filePath: string) => {
  const resolved = path.resolve(filePath);
  dataDir = path.dirname(resolved);
  storeFile = resolved;
  ensureDataDir();
};

export const __test__ = {
  normalizeSku,
  loadFromDisk,
  persistToDisk,
  get storeFile() {
    return storeFile;
  },
  get dataDir() {
    return dataDir;
  },
  setStoragePathForTests: (filePath: string) => {
    policyStore.clear();
    setStoragePath(filePath);
    loadFromDisk();
  },
  clearStore: () => {
    policyStore.clear();
  },
  deleteStoreFile: () => {
    try {
      if (fs.existsSync(storeFile)) {
        fs.unlinkSync(storeFile);
      }
    } catch {
      // ignore
    }
  },
  policyStore,
};
