import { randomUUID } from 'node:crypto';

export type TaxMode = 'exclusive' | 'inclusive';

export interface TaxTypePayload {
  name: string;
  rate: number;
  mode: TaxMode;
  isDefault?: boolean;
}

export interface TaxTypeRecord extends TaxTypePayload {
  id: string;
  createdAt: string;
  updatedAt: string;
  isDefault: boolean;
}

type TaxTypeSeed = TaxTypePayload;

const taxTypeStore = new Map<string, TaxTypeRecord>();
let autoSeed = true;

const TAX_TYPE_SEEDS: TaxTypeSeed[] = [
  { name: '부가세', rate: 0.1, mode: 'inclusive', isDefault: true },
  { name: '영세율', rate: 0, mode: 'exclusive' },
];

function toRecord(payload: TaxTypePayload, overrides?: { id?: string; createdAt?: string; updatedAt?: string }): TaxTypeRecord {
  const now = new Date().toISOString();
  const createdAt = overrides?.createdAt ?? now;
  const updatedAt = overrides?.updatedAt ?? now;

  return {
    id: overrides?.id ?? randomUUID(),
    name: payload.name.trim(),
    rate: payload.rate,
    mode: payload.mode,
    isDefault: payload.isDefault ?? false,
    createdAt,
    updatedAt,
  };
}

export function ensureTaxTypeSeedData(): void {
  if (!autoSeed || taxTypeStore.size > 0) {
    return;
  }

  TAX_TYPE_SEEDS.forEach((seed) => {
    const record = toRecord(seed);
    taxTypeStore.set(record.id, record);
  });

  autoSeed = false;
}

export function listTaxTypes(): TaxTypeRecord[] {
  ensureTaxTypeSeedData();
  return Array.from(taxTypeStore.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function createTaxType(payload: TaxTypePayload): TaxTypeRecord {
  ensureTaxTypeSeedData();
  const record = toRecord(payload);
  taxTypeStore.set(record.id, record);
  return record;
}

export function findTaxTypeById(id: string): TaxTypeRecord | undefined {
  ensureTaxTypeSeedData();
  return taxTypeStore.get(id);
}
