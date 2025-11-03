import type { FastifyInstance } from 'fastify';

import {
  createCategory,
  deleteCategory,
  ensureCategorySeedData,
  findCategoryById,
  listCategories,
  searchCategories,
  updateCategory,
  type CategoryPayload,
  type CategoryRecord,
} from '../stores/categoriesStore.js';

interface ValidationSuccess {
  success: true;
  value: { name: string; description: string | null; parentId: string | null };
}

interface ValidationFailure {
  success: false;
  errors: string[];
}

type ValidationResult = ValidationSuccess | ValidationFailure;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isString = (value: unknown): value is string => typeof value === 'string';

const normalize = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function validateCategoryPayload(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { success: false, errors: ['요청 본문이 객체가 아닙니다.'] };
  }

  const candidate = input as Record<string, unknown>;
  const errors: string[] = [];

  if (!isNonEmptyString(candidate.name)) {
    errors.push('name 필드는 비어있을 수 없습니다.');
  }

  let description: string | null = null;
  if (candidate.description === undefined || candidate.description === null) {
    description = null;
  } else if (isString(candidate.description)) {
    description = normalize(candidate.description);
  } else {
    errors.push('description 필드는 문자열이어야 합니다.');
  }

  let parentId: string | null = null;
  if (candidate.parentId === undefined || candidate.parentId === null || candidate.parentId === '') {
    parentId = null;
  } else if (isString(candidate.parentId)) {
    parentId = candidate.parentId.trim();
    if (parentId.length === 0) {
      parentId = null;
    }
  } else {
    errors.push('parentId 필드는 문자열이어야 합니다.');
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    value: {
      name: normalize(candidate.name),
      description,
      parentId,
    },
  };
}

function toResponse(record: CategoryRecord): CategoryRecord {
  return { ...record };
}

function toPayload(value: { name: string; description: string | null; parentId: string | null }): CategoryPayload {
  return {
    name: value.name,
    description: value.description ? value.description : null,
    parentId: value.parentId,
  };
}

export default async function categoriesRoutes(server: FastifyInstance) {
  ensureCategorySeedData();

  server.get('/', async (request, reply) => {
    const { q } = (request.query ?? {}) as { q?: string };
    const query = q?.trim();
    const items = (query ? searchCategories(query) : listCategories()).map((item) => toResponse(item));
    return reply.send({ items, count: items.length });
  });

  server.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = findCategoryById(id);
    if (!record) {
      return reply.code(404).send({ error: '요청한 카테고리를 찾을 수 없습니다.' });
    }

    return reply.send({ item: toResponse(record) });
  });

  server.post('/', async (request, reply) => {
    const validation = validateCategoryPayload(request.body);
    if (!validation.success) {
      return reply.code(400).send({ error: '유효하지 않은 입력입니다.', details: validation.errors });
    }

    const { value } = validation;
    try {
      const record = createCategory(toPayload(value));
      return reply.code(201).send({ item: toResponse(record) });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '카테고리를 생성하지 못했습니다.';
      return reply.code(400).send({ error: message });
    }
  });

  server.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = findCategoryById(id);
    if (!existing) {
      return reply.code(404).send({ error: '요청한 카테고리를 찾을 수 없습니다.' });
    }

    const validation = validateCategoryPayload(request.body);
    if (!validation.success) {
      return reply.code(400).send({ error: '유효하지 않은 입력입니다.', details: validation.errors });
    }

    const { value } = validation;
    try {
      const updated = updateCategory(id, toPayload(value));
      return reply.send({ item: toResponse(updated) });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '카테고리를 수정하지 못했습니다.';
      return reply.code(400).send({ error: message });
    }
  });

  server.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = findCategoryById(id);
    if (!existing) {
      return reply.code(404).send({ error: '요청한 카테고리를 찾을 수 없습니다.' });
    }

    try {
      deleteCategory(id);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '카테고리를 삭제하지 못했습니다.';
      return reply.code(400).send({ error: message });
    }
    return reply.code(204).send();
  });
}

export { validateCategoryPayload };
