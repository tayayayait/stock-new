import assert from 'node:assert/strict';

import { buildServer } from '../app.js';

async function main() {
  const server = await buildServer();

  try {
    const success = await server.inject({ method: 'GET', url: '/api/forecast/101' });
    assert.equal(success.statusCode, 200);
    const body = success.json() as any;
    assert.ok(body.product?.sku === 'D1E2F3G');
    assert.ok(Array.isArray(body.timeline));
    assert.ok(body.timeline.length > 6);
    assert.ok(body.timeline.some((point: any) => point.phase === 'forecast'));
    assert.ok(body.metrics?.weeklyOutlook);
    ['week1', 'week2', 'week4', 'week8'].forEach((key) => {
      const value = body.metrics.weeklyOutlook?.[key];
      assert.equal(typeof value, 'number');
    });
    assert.ok(body.explanation?.summary);

    const notFound = await server.inject({ method: 'GET', url: '/api/forecast/9999' });
    assert.equal(notFound.statusCode, 404);

    const createProduct = await server.inject({
      method: 'POST',
      url: '/api/products',
      payload: {
        sku: 'SKU-FORECAST',
        name: 'Synthetic Forecast Product',
        category: 'Test Category',
        subCategory: 'Test Subcategory',
        abcGrade: 'A',
        xyzGrade: 'X',
        unit: 'EA',
        packCase: '1/10',
        pack: 1,
        casePack: 10,
        bufferRatio: 0.2,
        dailyAvg: 25,
        dailyStd: 6,
        totalInbound: 0,
        totalOutbound: 0,
        avgOutbound7d: 25,
        isActive: true,
        onHand: 500,
        reserved: 40,
        risk: '정상',
        inventory: [
          {
            warehouseCode: 'WH-SEOUL',
            locationCode: 'SEOUL-A1',
            onHand: 500,
            reserved: 40,
          },
        ],
      },
    });
    assert.equal(createProduct.statusCode, 201);
    const createdBody = createProduct.json() as any;
    const created = createdBody?.item;
    assert.ok(created);
    assert.ok(typeof created.legacyProductId === 'number');

    const fallbackForecast = await server.inject({
      method: 'GET',
      url: `/api/forecast/${created.legacyProductId}`,
    });
    assert.equal(fallbackForecast.statusCode, 200);
    const fallbackBody = fallbackForecast.json() as any;
    assert.ok(Array.isArray(fallbackBody.timeline));
    assert.ok(fallbackBody.timeline.length >= 6);
    assert.ok(fallbackBody.metrics?.weeklyOutlook?.week1 > 0);
    assert.ok(fallbackBody.metrics?.avgDailyDemand > 0);
    assert.ok(fallbackBody.product?.safetyStock > 0);
  } finally {
    await server.close();
  }
}

await main();
