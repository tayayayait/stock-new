import { randomUUID } from 'node:crypto';

export interface CategoryPayload {
  name: string;
  description: string | null;
  parentId?: string | null;
}

export interface CategoryRecord {
  id: string;
  name: string;
  description: string | null;
  productCount: number;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

type CategorySeed = CategoryPayload & { productCount?: number };

const categoryStore = new Map<string, CategoryRecord>();
let autoSeed = true;

const defaultCategories: CategorySeed[] = [];
const LEGACY_DEFAULT_CATEGORY_NAMES = new Set(['유제품', '가공식품', '신선식품']);

const normalizeName = (value: string): string => value.trim();
const normalizeKey = (value: string): string => normalizeName(value).toLowerCase();

let legacyDefaultsPurged = false;

function purgeLegacyDefaultCategories(): void {
  if (legacyDefaultsPurged) {
    return;
  }

  legacyDefaultsPurged = true;
  autoSeed = false;

  const roots = Array.from(categoryStore.values()).filter(
    (record) => record.parentId === null && LEGACY_DEFAULT_CATEGORY_NAMES.has(record.name),
  );

  roots.forEach((record) => {
    deleteCategory(record.id);
  });
}

function findCategoryByName(name: string, parentId: string | null): CategoryRecord | undefined {
  const key = normalizeKey(name);
  for (const record of categoryStore.values()) {
    if (record.parentId === parentId && normalizeKey(record.name) === key) {
      return record;
    }
  }
  return undefined;
}

function toRecord(
  payload: CategorySeed,
  overrides?: { id?: string; createdAt?: string; updatedAt?: string },
) {
  const now = new Date().toISOString();
  const createdAt = overrides?.createdAt ?? now;
  const updatedAt = overrides?.updatedAt ?? now;

  return {
    id: overrides?.id ?? randomUUID(),
    name: payload.name.trim(),
    description: payload.description?.trim() ?? null,
    productCount: payload.productCount ?? 0,
    parentId: payload.parentId ?? null,
    createdAt,
    updatedAt,
  } satisfies CategoryRecord;
}

export function ensureCategorySeedData(): void {
  if (!autoSeed || categoryStore.size > 0) {
    return;
  }

  defaultCategories.forEach((payload) => {
    const record = toRecord(payload);
    categoryStore.set(record.id, record);
  });
}

export function listCategories(): CategoryRecord[] {
  ensureCategorySeedData();
  purgeLegacyDefaultCategories();
  return Array.from(categoryStore.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function searchCategories(query: string): CategoryRecord[] {
  ensureCategorySeedData();
  purgeLegacyDefaultCategories();
  const key = query.trim().toLowerCase();
  if (!key) {
    return listCategories();
  }

  return listCategories().filter((category) =>
    category.name.toLowerCase().includes(key) || (category.description ?? '').toLowerCase().includes(key),
  );
}

export function findCategoryById(id: string): CategoryRecord | undefined {
  ensureCategorySeedData();
  purgeLegacyDefaultCategories();
  return categoryStore.get(id);
}

export function createCategory(payload: CategoryPayload): CategoryRecord {
  ensureCategorySeedData();
  purgeLegacyDefaultCategories();
  const normalizedName = normalizeName(payload.name);
  if (!normalizedName) {
    throw new Error('카테고리 이름은 비어 있을 수 없습니다.');
  }

  const parentIdCandidate = typeof payload.parentId === 'string' ? payload.parentId.trim() : null;
  const parentId = parentIdCandidate && parentIdCandidate.length > 0 ? parentIdCandidate : null;
  if (parentId && !categoryStore.has(parentId)) {
    throw new Error('선택한 상위 카테고리를 찾을 수 없습니다.');
  }

  const record = toRecord({ ...payload, parentId });
  categoryStore.set(record.id, record);
  return record;
}

export function updateCategory(id: string, payload: CategoryPayload): CategoryRecord {
  ensureCategorySeedData();
  purgeLegacyDefaultCategories();
  const existing = categoryStore.get(id);
  if (!existing) {
    throw new Error('요청한 카테고리를 찾을 수 없습니다.');
  }

  const normalizedName = normalizeName(payload.name);
  if (!normalizedName) {
    throw new Error('카테고리 이름은 비어 있을 수 없습니다.');
  }

  const parentIdRaw = payload.parentId === undefined ? existing.parentId : payload.parentId;
  const parentIdCandidate = typeof parentIdRaw === 'string' ? parentIdRaw.trim() : null;
  const parentId = parentIdCandidate && parentIdCandidate.length > 0 ? parentIdCandidate : null;
  if (parentId && !categoryStore.has(parentId)) {
    throw new Error('선택한 상위 카테고리를 찾을 수 없습니다.');
  }

  if (parentId === id) {
    throw new Error('카테고리를 자기 자신 아래로 이동할 수 없습니다.');
  }

  const hasCircularReference = parentId
    ? (() => {
        let current = parentId;
        while (current) {
          if (current === id) {
            return true;
          }
          const parent = categoryStore.get(current)?.parentId ?? null;
          current = parent ?? null;
        }
        return false;
      })()
    : false;

  if (hasCircularReference) {
    throw new Error('카테고리를 하위 분류로 이동할 수 없습니다.');
  }


  const updated: CategoryRecord = {
    ...existing,
    name: normalizedName,
    description: payload.description?.trim() ?? null,
    parentId,
    updatedAt: new Date().toISOString(),
  };

  categoryStore.set(id, updated);
  return updated;
}

export function deleteCategory(id: string): CategoryRecord | undefined {
  ensureCategorySeedData();
  purgeLegacyDefaultCategories();
  const existing = categoryStore.get(id);
  if (!existing) {
    return undefined;
  }

  const stack = [id];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const record of categoryStore.values()) {
      if (record.parentId === current) {
        stack.push(record.id);
      }
    }
  }

  visited.forEach((targetId) => {
    categoryStore.delete(targetId);
  });

  return existing;
}

export function __resetCategoryStore(seed = true): void {
  categoryStore.clear();
  autoSeed = seed;
  legacyDefaultsPurged = false;
}

export function __getCategoryRecords(): CategoryRecord[] {
  return listCategories();
}

export function ensureProductCategory(
  categoryName: string,
  subCategoryName?: string | null,
): { category?: CategoryRecord; subCategory?: CategoryRecord } {
  const normalizedCategory = normalizeName(categoryName);
  if (!normalizedCategory) {
    return {};
  }

  ensureCategorySeedData();
  purgeLegacyDefaultCategories();

  let categoryRecord = findCategoryByName(normalizedCategory, null);
  if (!categoryRecord) {
    categoryRecord = createCategory({ name: normalizedCategory, description: null });
  }

  const normalizedSubCategory = typeof subCategoryName === 'string' ? normalizeName(subCategoryName) : '';

  if (!normalizedSubCategory) {
    return { category: categoryRecord };
  }

  let subCategoryRecord = findCategoryByName(normalizedSubCategory, categoryRecord.id);
  if (!subCategoryRecord) {
    subCategoryRecord = createCategory({
      name: normalizedSubCategory,
      description: null,
      parentId: categoryRecord.id,
    });
  }

  return { category: categoryRecord, subCategory: subCategoryRecord };
}
