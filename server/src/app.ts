import Fastify from 'fastify';
import cors from '@fastify/cors';

import healthRoutes from './routes/health.js';
import forecastRoutes from './routes/forecast.js';
import movementRoutes from './routes/movements.js';
import policyRoutes from './routes/policies.js';
import productsRoutes from './routes/products.js';
import csvRoutes from './routes/csv.js';
import warehousesRoutes from './routes/warehouses.js';
import locationsRoutes from './routes/locations.js';
import categoriesRoutes from './routes/categories.js';
import productImagesRoutes from './routes/productImages.js';
import inventoryDashboardRoutes from './routes/inventoryDashboard.js';
import actionPlanRoutes from './routes/actionPlans.js';
import purchaseOrdersRoutes from './routes/purchaseOrders.js';
import salesOrdersRoutes from './routes/salesOrders.js';
import leadTimeRoutes from './routes/leadTime.js';
import taxTypesRoutes from './routes/taxTypes.js';
import { ensureWarehouseSeedData } from './stores/warehousesStore.js';
import { ensureLocationSeedData } from './stores/locationsStore.js';
import {
  startPendingMovementScheduler,
  stopPendingMovementScheduler,
} from './services/pendingMovementScheduler.js';

export async function buildServer() {
  const server = Fastify({
    logger: true,
  });

  await server.register(cors, { origin: true });

  await server.register(healthRoutes, { prefix: '/api/health' });
  await server.register(forecastRoutes, { prefix: '/api/forecast' });
  await server.register(movementRoutes, { prefix: '/api/movements' });
  await server.register(policyRoutes, { prefix: '/api/policies' });
  await server.register(warehousesRoutes, { prefix: '/api/warehouses' });
  await server.register(locationsRoutes, { prefix: '/api/locations' });
  await server.register(categoriesRoutes, { prefix: '/api/categories' });
  await server.register(taxTypesRoutes, { prefix: '/api/tax-types' });
  ensureWarehouseSeedData();
  ensureLocationSeedData();
  await server.register(productsRoutes, { prefix: '/api/products' });
  await server.register(csvRoutes, { prefix: '/api/csv' });
  await server.register(productImagesRoutes, { prefix: '/api/product-images' });
  await server.register(actionPlanRoutes, { prefix: '/api/action-plans' });
  await server.register(inventoryDashboardRoutes, { prefix: '/api/inventory' });
  await server.register(leadTimeRoutes, { prefix: '/api/leadtime' });
  await server.register(purchaseOrdersRoutes, { prefix: '/api/purchase-orders' });
  await server.register(salesOrdersRoutes, { prefix: '/api/sales-orders' });

  startPendingMovementScheduler();
  server.addHook('onClose', () => {
    stopPendingMovementScheduler();
  });

  return server;
}
