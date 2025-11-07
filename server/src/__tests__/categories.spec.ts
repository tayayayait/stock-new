import assert from 'node:assert/strict';

import { buildServer } from '../app.js';
import { __resetCategoryStore, __getCategoryRecords } from '../stores/categoriesStore.js';

async function main() {
  __resetCategoryStore();

  const server = await buildServer();

  try {
    const seedResponse = await server.inject({ method: 'GET', url: '/api/categories' });
    assert.equal(seedResponse.statusCode, 200);
    const seedBody = seedResponse.json() as any;
    assert.equal(seedBody.count, __getCategoryRecords().length);
    assert.equal(seedBody.count, 0);
    assert.ok(
      seedBody.items.every(
        (item: any) => !['유제품', '가공식품', '신선식품'].includes(item.name as string),
      ),
    );

    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: '생활용품', description: '주방, 세제 등 생활 필수품' },
    });
    assert.equal(createResponse.statusCode, 201);
    const createdBody = createResponse.json() as any;
    assert.equal(createdBody.item.name, '생활용품');
    assert.equal(createdBody.item.description, '주방, 세제 등 생활 필수품');
    assert.equal(createdBody.item.productCount, 0);
    assert.equal(createdBody.item.parentId, null);

    const createdId = createdBody.item.id as string;

    const getResponse = await server.inject({ method: 'GET', url: `/api/categories/${createdId}` });
    assert.equal(getResponse.statusCode, 200);
    const getBody = getResponse.json() as any;
    assert.equal(getBody.item.name, '생활용품');
    assert.equal(getBody.item.parentId, null);

    const childCreate = await server.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: '주방 세제', description: '세제 소분류', parentId: createdId },
    });
    assert.equal(childCreate.statusCode, 201);
    const childBody = childCreate.json() as any;
    assert.equal(childBody.item.parentId, createdId);

    const childId = childBody.item.id as string;

    const searchResponse = await server.inject({
      method: 'GET',
      url: `/api/categories?q=${encodeURIComponent('생활')}`,
    });
    assert.equal(searchResponse.statusCode, 200);
    const searchBody = searchResponse.json() as any;
    assert.ok(searchBody.items.some((item: any) => item.id === createdId));
    assert.ok(searchBody.items.some((item: any) => item.id === childId));

    const updateResponse = await server.inject({
      method: 'PUT',
      url: `/api/categories/${createdId}`,
      payload: { name: '생활잡화', description: '세제, 주방, 생활잡화 카테고리' },
    });
    assert.equal(updateResponse.statusCode, 200);
    const updatedBody = updateResponse.json() as any;
    assert.equal(updatedBody.item.name, '생활잡화');
    assert.equal(updatedBody.item.description, '세제, 주방, 생활잡화 카테고리');
    assert.equal(updatedBody.item.productCount, 0);

    const duplicateCreate = await server.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: '생활잡화', description: '중복 생성 허용' },
    });
    assert.equal(duplicateCreate.statusCode, 201);
    const duplicateBody = duplicateCreate.json() as any;
    assert.notEqual(duplicateBody.item.id, createdId);
    assert.equal(duplicateBody.item.name, '생활잡화');

    const duplicateUpdate = await server.inject({
      method: 'PUT',
      url: `/api/categories/${duplicateBody.item.id as string}`,
      payload: { name: '유제품', description: '중복 편집 허용' },
    });
    assert.equal(duplicateUpdate.statusCode, 200);
    const duplicateUpdatedBody = duplicateUpdate.json() as any;
    assert.equal(duplicateUpdatedBody.item.name, '유제품');

    const invalidResponse = await server.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: '   ' },
    });
    assert.equal(invalidResponse.statusCode, 400);

    const deleteParentResponse = await server.inject({
      method: 'DELETE',
      url: `/api/categories/${createdId}`,
    });
    assert.equal(deleteParentResponse.statusCode, 204);

    const afterDelete = await server.inject({ method: 'GET', url: `/api/categories/${createdId}` });
    assert.equal(afterDelete.statusCode, 404);

    const afterChildDelete = await server.inject({ method: 'GET', url: `/api/categories/${childId}` });
    assert.equal(afterChildDelete.statusCode, 404);

    const deleteDuplicateResponse = await server.inject({
      method: 'DELETE',
      url: `/api/categories/${duplicateBody.item.id as string}`,
    });
    assert.equal(deleteDuplicateResponse.statusCode, 204);
  } finally {
    await server.close();
    __resetCategoryStore();
  }
}

await main();
