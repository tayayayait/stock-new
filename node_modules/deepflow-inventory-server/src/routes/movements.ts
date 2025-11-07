import type { FastifyInstance } from 'fastify';

import { findWarehouseByCode } from '../stores/warehousesStore.js';
import { findLocationByCode } from '../stores/locationsStore.js';
import { listMovementRecords, clearMovementStore } from '../stores/movementsStore.js';
import {
  enqueuePendingMovement,
  clearPendingMovements,
} from '../stores/pendingMovementsStore.js';
import { __resetMovementAnalytics } from '../stores/movementAnalyticsStore.js';
import {
  finalizeMovementDraft,
  getInventoryBalancesSnapshot,
  InventoryConflictError,
  resetMovementProcessorState,
} from '../services/movementProcessor.js';
import { validateMovementDraft } from '../../../shared/movements/validation.js';
import { type MovementDraft, type MovementRecord, type MovementType } from '../../../shared/movements/types.js';

type MovementQuerystring = {
  type?: MovementType;
  sku?: string;
  warehouse?: string;
  location?: string;
  partnerId?: string;
  refNo?: string;
  userId?: string;
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
};

class ValidationError extends Error {
  errors: string[];

  constructor(errors: string[]) {
    super('Movement validation failed');
    this.errors = errors;
  }
}

const validateWarehouseConstraints = (draft: MovementDraft): void => {
  const errors: string[] = [];
  const { type, fromWarehouse, toWarehouse, fromLocation, toLocation } = draft;

  const requireFrom = type === 'ISSUE' || type === 'TRANSFER';
  const requireTo = type === 'RECEIPT' || type === 'RETURN' || type === 'TRANSFER' || type === 'ADJUST';

  if (requireFrom && !fromWarehouse) {
    errors.push(`${type} 유형에서는 fromWarehouse 필드가 필요합니다.`);
  }

  if (requireTo && !toWarehouse) {
    errors.push(`${type} 유형에서는 toWarehouse 필드가 필요합니다.`);
  }

  if (fromWarehouse && !findWarehouseByCode(fromWarehouse)) {
    errors.push(`존재하지 않는 출고 물류센터 코드입니다: ${fromWarehouse}`);
  }

  if (toWarehouse && !findWarehouseByCode(toWarehouse)) {
    errors.push(`존재하지 않는 입고 물류센터 코드입니다: ${toWarehouse}`);
  }

  if (fromLocation) {
    const location = findLocationByCode(fromLocation);
    if (!location) {
      errors.push(`알 수 없는 출고 로케이션 코드입니다: ${fromLocation}`);
    } else if (fromWarehouse && location.warehouseCode !== fromWarehouse) {
      errors.push('출고 로케이션이 지정된 물류센터에 속하지 않습니다.');
    }
  }

  if (toLocation) {
    const location = findLocationByCode(toLocation);
    if (!location) {
      errors.push(`알 수 없는 입고 로케이션 코드입니다: ${toLocation}`);
    } else if (toWarehouse && location.warehouseCode !== toWarehouse) {
      errors.push('입고 로케이션이 지정된 물류센터에 속하지 않습니다.');
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors);
  }
};

const compareMovements = (a: MovementRecord, b: MovementRecord) => {
  const aTime = Date.parse(a.occurredAt);
  const bTime = Date.parse(b.occurredAt);
  if (aTime !== bTime) {
    return bTime - aTime;
  }

  const aCreated = Date.parse(a.createdAt);
  const bCreated = Date.parse(b.createdAt);
  return bCreated - aCreated;
};

const parseQueryDates = (query: MovementQuerystring) => {
  let from: number | undefined;
  let to: number | undefined;

  if (query.from) {
    const parsed = Date.parse(query.from);
    if (Number.isNaN(parsed)) {
      throw new ValidationError(['from 파라미터가 올바른 날짜 형식이 아닙니다.']);
    }
    from = parsed;
  }

  if (query.to) {
    const parsed = Date.parse(query.to);
    if (Number.isNaN(parsed)) {
      throw new ValidationError(['to 파라미터가 올바른 날짜 형식이 아닙니다.']);
    }
    to = parsed;
  }

  return { from, to };
};

export default async function movementRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: unknown }>('/', async (request, reply) => {
    const validation = validateMovementDraft(request.body as Record<string, unknown>, {
      requireOccurredAt: true,
    });

    if (!validation.success) {
      return reply.status(400).send({ errors: validation.errors });
    }

    const draft: MovementDraft = validation.data;

    try {
      validateWarehouseConstraints(draft);
    } catch (error) {
      if (error instanceof ValidationError) {
        return reply.status(400).send({ errors: error.errors });
      }
      throw error;
    }

    const now = new Date();
    const occurredTime = new Date(draft.occurredAt).getTime();
    if (!Number.isNaN(occurredTime) && occurredTime > now.getTime()) {
      const pending = enqueuePendingMovement(draft);
      return reply
        .status(202)
        .send({ pendingId: pending.id, scheduledFor: pending.draft.occurredAt, success: true });
    }

    try {
      const result = finalizeMovementDraft(draft);
      return reply.status(201).send(result);
    } catch (error) {
      if (error instanceof InventoryConflictError) {
        return reply.status(409).send({ message: error.message });
      }
      throw error;
    }
  });

  fastify.get<{ Querystring: MovementQuerystring }>('/', async (request, reply) => {
    let parsedDates: { from?: number; to?: number };
    try {
      parsedDates = parseQueryDates(request.query);
    } catch (error) {
      if (error instanceof ValidationError) {
        return reply.status(400).send({ errors: error.errors });
      }
      throw error;
    }

    const limit = request.query.limit ? Number.parseInt(request.query.limit, 10) : 100;
    const offset = request.query.offset ? Number.parseInt(request.query.offset, 10) : 0;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;

    const typeFilter = request.query.type ? (String(request.query.type).toUpperCase() as MovementType) : undefined;

    const filtered = listMovementRecords().filter((movement) => {
      if (typeFilter && movement.type !== typeFilter) return false;
      if (request.query.sku && movement.sku !== request.query.sku) return false;
      if (request.query.partnerId && movement.partnerId !== request.query.partnerId) return false;
      if (request.query.refNo && movement.refNo !== request.query.refNo) return false;
      if (request.query.userId && movement.userId !== request.query.userId) return false;

      if (request.query.warehouse) {
        const matchWarehouse =
          movement.fromWarehouse === request.query.warehouse || movement.toWarehouse === request.query.warehouse;
        if (!matchWarehouse) return false;
      }

      if (request.query.location) {
        const matchLocation =
          movement.fromLocation === request.query.location || movement.toLocation === request.query.location;
        if (!matchLocation) return false;
      }

      if (parsedDates.from !== undefined && Date.parse(movement.occurredAt) < parsedDates.from) {
        return false;
      }

      if (parsedDates.to !== undefined && Date.parse(movement.occurredAt) > parsedDates.to) {
        return false;
      }

      return true;
    });

    const sorted = [...filtered].sort(compareMovements);
    const total = sorted.length;
    const paginated = sorted.slice(safeOffset, safeOffset + safeLimit);

    return reply.send({
      total,
      count: paginated.length,
      offset: safeOffset,
      limit: safeLimit,
      items: paginated.map((item) => ({ ...item })),
      balances: getInventoryBalancesSnapshot(),
    });
  });
}

export function __resetMovementStore() {
  clearMovementStore();
  resetMovementProcessorState();
  clearPendingMovements();
  __resetMovementAnalytics();
}
