import type { FastifyInstance } from 'fastify';
import {
  cancelSalesOrder,
  createSalesOrder,
  getSalesOrder,
  listSalesOrders,
} from '../stores/salesOrdersStore.js';

interface CreateSalesOrderBody {
  customerId?: string;
  memo?: string;
  promisedDate?: string;
  lines?: Array<{ sku?: string; orderedQty?: number }>;
}

export default async function salesOrdersRoutes(server: FastifyInstance) {
  server.get('/', (_request, reply) => {
    return reply.send({ success: true, items: listSalesOrders() });
  });

  server.get('/:id', (request, reply) => {
    const { id } = request.params as { id: string };
    const order = getSalesOrder(id);
    if (!order) {
      return reply.code(404).send({ success: false, error: 'Sales order not found' });
    }
    return reply.send({ success: true, item: order });
  });

  server.post('/', (request, reply) => {
    const body = (request.body as CreateSalesOrderBody | undefined) ?? {};
    if (!body.customerId || !body.lines || body.lines.length === 0) {
      return reply.code(400).send({ success: false, error: 'customerId and lines are required' });
    }
    const sanitizedLines = body.lines.map((line) => ({
      sku: line.sku ?? '',
      orderedQty: typeof line.orderedQty === 'number' ? line.orderedQty : 0,
    }));
    const order = createSalesOrder({
      customerId: body.customerId,
      memo: body.memo,
      promisedDate: body.promisedDate,
      lines: sanitizedLines,
    });
    return reply.code(201).send({ success: true, item: order });
  });

  server.put('/:id/cancel', (request, reply) => {
    const { id } = request.params as { id: string };
    const order = cancelSalesOrder(id);
    if (!order) {
      return reply.code(404).send({ success: false, error: 'Sales order not found' });
    }
    return reply.send({ success: true, item: order });
  });
}
