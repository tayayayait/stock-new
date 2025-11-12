import type { FastifyInstance } from 'fastify';

import {
  createTaxType,
  ensureTaxTypeSeedData,
  listTaxTypes,
  type TaxMode,
  type TaxTypeRecord,
  type TaxTypePayload,
} from '../stores/taxTypesStore.js';

type ApiTaxType = Pick<TaxTypeRecord, 'id' | 'name' | 'rate' | 'mode' | 'isDefault'>;

interface ValidationSuccess {
  success: true;
  value: { name: string; rate: number; mode: TaxMode; isDefault?: boolean };
}

interface ValidationFailure {
  success: false;
  errors: string[];
}

type ValidationResult = ValidationSuccess | ValidationFailure;

const isTaxMode = (value: unknown): value is TaxMode => value === 'exclusive' || value === 'inclusive';

const parseNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
};

const parseBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  return undefined;
};

const normalizeName = (value: string): string => value.trim();

function validateTaxTypePayload(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) {
    return { success: false, errors: ['요청 본문이 객체여야 합니다.'] };
  }

  const candidate = body as Record<string, unknown>;
  const errors: string[] = [];

  const name = typeof candidate.name === 'string' ? normalizeName(candidate.name) : '';
  if (!name) {
    errors.push('name 필드는 비어 있을 수 없습니다.');
  }

  const rateValue = parseNumber(candidate.rate);
  if (rateValue === undefined) {
    errors.push('rate 필드는 숫자여야 합니다.');
  } else if (rateValue < 0 || rateValue > 1) {
    errors.push('rate 필드는 0 이상 1 이하의 값이어야 합니다.');
  }

  let mode: TaxMode | null = null;
  if (typeof candidate.mode === 'string') {
    const normalizedMode = candidate.mode.trim();
    if (isTaxMode(normalizedMode)) {
      mode = normalizedMode;
    } else {
      errors.push("mode 필드는 'exclusive' 또는 'inclusive' 중 하나여야 합니다.");
    }
  } else {
    errors.push("mode 필드는 문자열이어야 합니다.");
  }

  let isDefault: boolean | undefined;
  if ('isDefault' in candidate && candidate.isDefault !== undefined && candidate.isDefault !== null) {
    const parsedBoolean = parseBoolean(candidate.isDefault);
    if (parsedBoolean === undefined) {
      errors.push('isDefault 필드는 불리언이어야 합니다.');
    } else {
      isDefault = parsedBoolean;
    }
  }

  if (errors.length > 0 || rateValue === undefined || mode === null) {
    return { success: false, errors };
  }

  return {
    success: true,
    value: {
      name,
      rate: rateValue,
      mode,
      isDefault,
    },
  };
}

function toResponse(record: TaxTypeRecord): ApiTaxType {
  return {
    id: record.id,
    name: record.name,
    rate: record.rate,
    mode: record.mode,
    isDefault: record.isDefault,
  };
}

export default async function taxTypesRoutes(server: FastifyInstance) {
  ensureTaxTypeSeedData();

  server.get('/', (_request, reply) => {
    const items = listTaxTypes().map((record) => toResponse(record));
    return reply.send({ success: true, items });
  });

  server.post('/', (request, reply) => {
    const validation = validateTaxTypePayload(request.body);
    if (!validation.success) {
      return reply.code(400).send({ success: false, error: '유효하지 않은 입력입니다.', details: validation.errors });
    }

    const { value } = validation;
    try {
      const payload: TaxTypePayload = {
        name: value.name,
        rate: value.rate,
        mode: value.mode,
        isDefault: value.isDefault,
      };
      const created = createTaxType(payload);
      return reply.code(201).send({ success: true, item: toResponse(created) });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '세금 유형을 생성하지 못했습니다.';
      return reply.code(400).send({ success: false, error: message });
    }
  });
}
