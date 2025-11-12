import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  approvePurchaseOrder,
  savePurchaseOrderDraft,
  parseOrderDateContext,
  peekNextPurchaseOrderNumberForContext,
  deletePurchaseOrder,
} from '../stores/purchaseOrdersStore.js';
import type { CreatePurchaseOrderInput } from '../stores/purchaseOrdersStore.js';
import { MAX_PURCHASE_ORDER_RANGE_MS } from '../../../shared/datetime/ranges.js';

interface CreatePurchaseOrderBody {
  vendorId?: string;
  vendorName?: string;
  orderNumber?: string;
  orderDate?: string;
  memo?: string;
  promisedDate?: string;
  lines?: Array<{
    sku?: string;
    orderedQty?: number;
    productName?: string;
    unit?: string;
    unitPrice?: number;
    amount?: number;
    taxAmount?: number;
    taxLabel?: string;
    currency?: string;
    taxTypeId?: string;
  }>;
}

const parseUtcTimestamp = (value?: string) => {
  if (!value) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
};

const rangeError = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ success: false, error: message });

const normalizePurchaseOrderLines = (lines?: CreatePurchaseOrderBody['lines']) => {
  if (!Array.isArray(lines)) {
    return [];
  }
  return lines.map((line) => ({
    sku: typeof line.sku === 'string' ? line.sku : '',
    orderedQty: typeof line.orderedQty === 'number' ? line.orderedQty : 0,
    productName: typeof line.productName === 'string' ? line.productName : undefined,
    unit: typeof line.unit === 'string' ? line.unit : undefined,
    unitPrice: typeof line.unitPrice === 'number' ? line.unitPrice : undefined,
    amount: typeof line.amount === 'number' ? line.amount : undefined,
    taxAmount: typeof line.taxAmount === 'number' ? line.taxAmount : undefined,
    taxLabel: typeof line.taxLabel === 'string' ? line.taxLabel : undefined,
    currency: typeof line.currency === 'string' ? line.currency : undefined,
    taxTypeId: typeof line.taxTypeId === 'string' ? line.taxTypeId : undefined,
  }));
};

const buildPurchaseOrderPayload = (body: CreatePurchaseOrderBody): CreatePurchaseOrderInput => ({
  vendorId: body.vendorId!.trim(),
  vendorName: typeof body.vendorName === 'string' ? body.vendorName : undefined,
  orderNumber: typeof body.orderNumber === 'string' ? body.orderNumber : undefined,
  orderDate: typeof body.orderDate === 'string' ? body.orderDate : undefined,
  memo: body.memo,
  promisedDate: body.promisedDate,
  lines: normalizePurchaseOrderLines(body.lines),
});

export default async function purchaseOrdersRoutes(server: FastifyInstance) {
  server.get('/', (request, reply) => {
    const { from, to } = request.query as { from?: string; to?: string };
    const parsedFrom = parseUtcTimestamp(from);
    const parsedTo = parseUtcTimestamp(to);

    if (from && parsedFrom === null) {
      return rangeError(reply, '올바른 시작일을 입력해 주세요.');
    }
    if (to && parsedTo === null) {
      return rangeError(reply, '올바른 종료일을 입력해 주세요.');
    }
    if (parsedFrom !== null && parsedTo !== null && parsedFrom > parsedTo) {
      return rangeError(reply, '시작일은 종료일보다 앞서야 합니다.');
    }
    if (parsedFrom !== null) {
      const effectiveTo = parsedTo ?? Date.now();
      if (effectiveTo - parsedFrom > MAX_PURCHASE_ORDER_RANGE_MS) {
        return rangeError(reply, '최대 조회 가능 기간은 365일입니다.');
      }
    }

    return reply.send({
      success: true,
      items: listPurchaseOrders({
        from: parsedFrom ?? undefined,
        to: parsedTo ?? undefined,
      }),
    });
  });

  server.get('/next-number', (request, reply) => {
    const { orderDate } = request.query as { orderDate?: string };
    const parsedOrderDate = parseOrderDateContext(orderDate);
    if (!parsedOrderDate) {
      return rangeError(reply, '올바른 발주일을 입력해 주세요.');
    }
    const nextNumber = peekNextPurchaseOrderNumberForContext(parsedOrderDate);
    return reply.send({
      success: true,
      item: {
        orderNumber: nextNumber.orderNumber,
        orderDate: nextNumber.orderDate,
        sequence: nextNumber.sequence,
      },
    });
  });

  server.get('/:id', (request, reply) => {
    const { id } = request.params as { id: string };
    const order = getPurchaseOrder(id);
    if (!order) {
      return reply.code(404).send({ success: false, error: 'Purchase order not found' });
    }
    return reply.send({ success: true, item: order });
  });

  server.post('/', (request, reply) => {
    const body = (request.body as CreatePurchaseOrderBody | undefined) ?? {};
    if (!body.vendorId || !body.lines || body.lines.length === 0) {
      return reply.code(400).send({ success: false, error: 'vendorId and lines are required' });
    }
    const payload = buildPurchaseOrderPayload(body);
    const order = createPurchaseOrder(payload);
    return reply.code(201).send({ success: true, item: order });
  });

  server.post('/drafts', (request, reply) => {
    const body = (request.body as CreatePurchaseOrderBody | undefined) ?? {};
    if (!body.vendorId || !body.lines || body.lines.length === 0) {
      return reply.code(400).send({ success: false, error: 'vendorId and lines are required' });
    }
    try {
      const payload = buildPurchaseOrderPayload(body);
      const draft = savePurchaseOrderDraft({ ...payload, status: 'draft' });
      return reply.code(201).send({ success: true, item: draft });
    } catch (error) {
      console.error('[purchaseOrders] failed to save draft', error);
      return reply.code(500).send({ success: false, error: '임시 저장에 실패했습니다.' });
    }
  });

  server.put('/drafts/:id', (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as CreatePurchaseOrderBody | undefined) ?? {};
    if (!body.vendorId || !body.lines || body.lines.length === 0) {
      return reply.code(400).send({ success: false, error: 'vendorId and lines are required' });
    }
    try {
      const payload = buildPurchaseOrderPayload(body);
      const draft = savePurchaseOrderDraft({ ...payload, id, status: 'draft' });
      return reply.send({ success: true, item: draft });
    } catch (error) {
      console.error('[purchaseOrders] failed to update draft', error);
      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          return reply.code(404).send({ success: false, error: '발주서를 찾을 수 없습니다.' });
        }
        if (error.message.includes('Drafts can only be updated')) {
          return reply.code(400).send({ success: false, error: '임시 저장 중인 발주서만 수정할 수 있습니다.' });
        }
      }
      return reply.code(500).send({ success: false, error: '임시 저장 업데이트에 실패했습니다.' });
    }
  });

  server.put('/:id/approve', (request, reply) => {
    const { id } = request.params as { id: string };
    const order = approvePurchaseOrder(id);
    if (!order) {
      return reply.code(404).send({ success: false, error: 'Purchase order not found' });
    }
    return reply.send({ success: true, item: order });
  });

  server.put('/:id/cancel', (request, reply) => {
    const { id } = request.params as { id: string };
    const order = cancelPurchaseOrder(id);
    if (!order) {
      return reply.code(404).send({ success: false, error: 'Purchase order not found' });
    }
    return reply.send({ success: true, item: order });
  });

  server.delete('/:id', (request, reply) => {
    const { id } = request.params as { id: string };
    const order = deletePurchaseOrder(id);
    if (!order) {
      return reply.code(404).send({ success: false, error: 'Purchase order not found' });
    }
    return reply.send({ success: true, item: order });
  });
}
