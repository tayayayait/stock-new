import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildServer } from '../app.js';
import { listPolicyDrafts, __test__ as policiesStoreTestUtils } from '../stores/policiesStore.js';

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-upsert-'));
  const storeFile = path.join(tempRoot, 'policies.json');
  policiesStoreTestUtils.setStoragePathForTests(storeFile);

  const server = await buildServer();

  try {
    const createResponse = await server.inject({
      method: 'PUT',
      url: '/api/policies/SKU-AUTO-1',
      payload: {
        name: '테스트 상품',
        forecastDemand: 180,
        demandStdDev: 24,
        leadTimeDays: 12,
        serviceLevelPercent: 95,
      },
    });
    assert.equal(createResponse.statusCode, 201);
    const createBody = createResponse.json() as any;
    assert.equal(createBody.success, true);
    assert.equal(createBody.item.sku, 'SKU-AUTO-1');
    assert.equal(createBody.item.leadTimeDays, 12);

    const storedAfterCreate = listPolicyDrafts();
    assert.equal(storedAfterCreate.length, 1);
    assert.equal(storedAfterCreate[0]?.forecastDemand, 180);

    const updateResponse = await server.inject({
      method: 'PUT',
      url: '/api/policies/SKU-AUTO-1',
      payload: {
        forecastDemand: 205,
        demandStdDev: 38,
        leadTimeDays: 10,
        serviceLevelPercent: 97.5,
      },
    });
    assert.equal(updateResponse.statusCode, 200);
    const updateBody = updateResponse.json() as any;
    assert.equal(updateBody.success, true);
    assert.equal(updateBody.item.forecastDemand, 205);
    assert.equal(updateBody.item.serviceLevelPercent, 97.5);

    const storedAfterUpdate = listPolicyDrafts();
    assert.equal(storedAfterUpdate.length, 1);
    assert.equal(storedAfterUpdate[0]?.forecastDemand, 205);
    assert.equal(storedAfterUpdate[0]?.serviceLevelPercent, 97.5);

    const invalidResponse = await server.inject({
      method: 'PUT',
      url: '/api/policies/',
      payload: {},
    });
    assert.equal(invalidResponse.statusCode, 404);

    const emptySkuResponse = await server.inject({
      method: 'PUT',
      url: '/api/policies/%20',
      payload: { forecastDemand: 50 },
    });
    assert.equal(emptySkuResponse.statusCode, 400);
  } finally {
    await server.close();
    policiesStoreTestUtils.clearStore();
    policiesStoreTestUtils.deleteStoreFile();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
