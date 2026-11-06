import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import { Product } from '../../src/modules/products/model.js';
import { resetAllRateLimits } from '../../src/middlewares/rateLimiter.js';
import { connectTestDB, disconnectTestDB, clearDatabase, syncIndexes } from '../helpers/db.js';
import { createAdmin, createClient } from '../helpers/auth.js';

/**
 * Malformed identifiers must be rejected the same way on every admin route that
 * declares `:id` — one status, one error code, one details shape. A provider swap
 * must not be able to change this, so the assertions are on the payload, not on
 * the message wording alone.
 */
const MALFORMED_IDS = [
  ['letters', 'not-an-id'],
  ['23 hex characters', '65a00000000000000000000'],
  ['25 hex characters', '65a0000000000000000000001'],
  ['non-hex characters', 'zzzzzzzzzzzzzzzzzzzzzzzz'],
  ['hyphenated', '65a0000-0000000000000000'],
  ['12-character ObjectId shorthand', 'aaaaaaaaaaaa'],
  ['sql-ish payload', '1 OR 1=1--'],
];

const ABSENT_BUT_VALID_ID = '000000000000000000000000';

describe('malformed id rejection is consistent across routes', () => {
  let app;
  let admin;

  beforeAll(async () => {
    await connectTestDB();
    await syncIndexes();
    app = createApp();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearDatabase();
    resetAllRateLimits();
    await createAdmin({ email: 'id-admin@test.local' });
    admin = createClient(app);
    await admin.login('id-admin@test.local', 'Adm1n!Passw0rd');
  });

  const adminProductRoutes = [
    ['GET', (id) => admin.get(`/api/v1/admin/products/${id}`)],
    ['DELETE', (id) => admin.del(`/api/v1/admin/products/${id}`)],
    ['PATCH', (id) => admin.patch(`/api/v1/admin/products/${id}`, { price: 1, version: 0 })],
    ['PATCH stock', (id) => admin.patch(`/api/v1/admin/products/${id}/stock`, { delta: -1 })],
    [
      'PUT',
      (id) =>
        admin.put(`/api/v1/admin/products/${id}`, {
          title: 'Replacement',
          description: 'Replacement description',
          price: 10,
          stock: 1,
          brand: '650000000000000000000001',
          category: '651000000000000000000001',
          version: 0,
        }),
    ],
  ];

  describe.each(adminProductRoutes)('admin products %s /:id', (_label, send) => {
    it.each(MALFORMED_IDS)(
      'rejects a %s id with 400 VALIDATION_ERROR on params.id',
      async (_l, id) => {
        const response = await send(id);
        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: 'params.id', message: 'Invalid identifier' }),
          ]),
        );
      },
    );
  });

  it('accepts a well-formed id that simply does not exist (404, not 400)', async () => {
    const response = await admin.get(`/api/v1/admin/products/${ABSENT_BUT_VALID_ID}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('rejects malformed ids on the taxonomy admin routes with the same payload', async () => {
    for (const url of ['/api/v1/brands/not-an-id', '/api/v1/categories/not-an-id']) {
      const response = await admin.del(url);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'params.id', message: 'Invalid identifier' }),
        ]),
      );
    }
  });

  it('leaves the storefront detail contract unchanged: unknown identifiers are 404s', async () => {
    // Pre-existing behaviour (verified against the Phase 0 baseline): the public
    // detail route treats anything unknown as "no such product" instead of 400.
    const response = await admin.get('/api/v1/products/not-an-id');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('never lets a malformed id reach the query layer', async () => {
    await Product.create({
      title: 'Query Probe',
      slug: 'query-probe',
      price: 1,
      stock: 1,
      description: 'Probe product',
      brand: '650000000000000000000001',
      category: '651000000000000000000001',
    });
    const response = await admin.get('/api/v1/admin/products/1 OR 1=1--');
    expect(response.status).toBe(400);
    const remaining = await Product.countDocuments({});
    expect(remaining).toBe(1);
  });
});
