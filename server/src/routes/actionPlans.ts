import type { FastifyInstance } from 'fastify';

import {
  getActionPlan,
  listActionPlans,
  saveActionPlan,
  transitionActionPlanStatus,
  updateActionPlan,
} from '../stores/actionPlanStore.js';
import type { ActionPlanUpsertPayload } from '../../../shared/actionPlans/types.js';

export default async function actionPlanRoutes(server: FastifyInstance) {
  server.get('/', async (request, reply) => {
    const { sku, productId, status, limit } = request.query as {
      sku?: string;
      productId?: string;
      status?: 'draft' | 'reviewed' | 'approved';
      limit?: string;
    };

    const parsedLimit = limit ? Number(limit) : undefined;
    const parsedProductId = productId ? Number(productId) : undefined;

    const records = listActionPlans({
      sku: sku?.trim() || undefined,
      productId: Number.isFinite(parsedProductId) ? parsedProductId : undefined,
      status: status && ['draft', 'reviewed', 'approved'].includes(status) ? status : undefined,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });

    return reply.send({ items: records });
  });

  server.post('/', async (request, reply) => {
    const payload = request.body as ActionPlanUpsertPayload;
    if (!payload || typeof payload !== 'object') {
      return reply.code(400).send({ error: '유효한 본문이 필요합니다.' });
    }
    if (typeof payload.sku !== 'string' || !payload.sku.trim()) {
      return reply.code(400).send({ error: 'sku 필드는 필수입니다.' });
    }
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      return reply.code(400).send({ error: 'items 배열은 비워둘 수 없습니다.' });
    }

    const record = saveActionPlan({
      ...payload,
      sku: payload.sku.trim(),
    });
    return reply.code(201).send({ plan: record });
  });

  server.put('/:planId', async (request, reply) => {
    const planId = (request.params as { planId: string }).planId;
    try {
      const existing = getActionPlan(planId);
      if (!existing) {
        return reply.code(404).send({ error: '요청한 실행계획을 찾지 못했습니다.' });
      }

      const payload = request.body as Partial<ActionPlanUpsertPayload> & { items?: ActionPlanUpsertPayload['items'] };
      if (!payload?.items || payload.items.length === 0) {
        return reply.code(400).send({ error: 'items 배열은 필수입니다.' });
      }

      const updated = updateActionPlan(planId, {
        items: payload.items,
        status: payload.status ?? existing.status,
      });
      return reply.send({ plan: updated });
    } catch (error) {
      request.log.error(error, 'Failed to update action plan');
      return reply.code(500).send({ error: '실행계획을 업데이트하지 못했습니다.' });
    }
  });

  server.post('/:planId/submit', async (request, reply) => {
    const planId = (request.params as { planId: string }).planId;
    try {
      const updated = transitionActionPlanStatus(planId, 'reviewed', {
        name: 'sales-planning-team',
        role: 'planner',
      });
      return reply.send({ plan: updated });
    } catch (error) {
      request.log.warn(error, 'Failed to submit action plan');
      return reply.code(400).send({ error: error instanceof Error ? error.message : '실행계획 전환에 실패했습니다.' });
    }
  });

  server.post('/:planId/approve', async (request, reply) => {
    const planId = (request.params as { planId: string }).planId;
    try {
      const updated = transitionActionPlanStatus(planId, 'approved', {
        name: 'sales-lead',
        role: 'approver',
      });
      return reply.send({ plan: updated });
    } catch (error) {
      request.log.warn(error, 'Failed to approve action plan');
      return reply.code(400).send({ error: error instanceof Error ? error.message : '실행계획 승인에 실패했습니다.' });
    }
  });
}
