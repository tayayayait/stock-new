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

const defaultCategories: CategorySeed[] = [
  {
    name: '유제품',
    description: '냉장 및 상온 유제품 전반',
    productCount: 42,
    parentId: null,
  },
  {
    name: '가공식품',
    description: '간편식, 통조림 등 장기 보관 식품',
    productCount: 31,
    parentId: null,
  },
  {
    name: '신선식품',
    description: '야채, 과일, 육류 등 신선 상품',
    productCount: 27,
    parentId: null,
  },
];

const normalizeName = (value: string): string => value.trim();

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
  return Array.from(categoryStore.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function searchCategories(query: string): CategoryRecord[] {
  ensureCategorySeedData();
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
  return categoryStore.get(id);
}

export function createCategory(payload: CategoryPayload): CategoryRecord {
  ensureCategorySeedData();
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
}

export function __getCategoryRecords(): CategoryRecord[] {
  return listCategories();
}
