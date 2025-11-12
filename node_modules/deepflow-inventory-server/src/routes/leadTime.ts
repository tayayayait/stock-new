import type { FastifyInstance } from 'fastify';
import { getLeadTimeStats } from '../stores/leadTimeStore.js';

export default async function leadTimeRoutes(server: FastifyInstance) {
  server.get('/stats', (request, reply) => {
    const sku = (request.query as { sku?: string }).sku;
    const vendorId = (request.query as { vendorId?: string }).vendorId;

    if (!sku || !vendorId) {
      return reply.code(400).send({ success: false, error: 'sku와 vendorId가 필요합니다.' });
    }

    const stats = getLeadTimeStats(sku, vendorId);
    if (!stats) {
      return reply.send({ success: true, stats: null });
    }

    return reply.send({ success: true, stats });
  });
}
