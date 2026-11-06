import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import { Product } from '../../src/modules/products/model.js';
import { createUniqueSku } from '../../src/utils/skuGenerator.js';
import { resetAllRateLimits } from '../../src/middlewares/rateLimiter.js';
import { connectTestDB, disconnectTestDB, clearDatabase, syncIndexes } from '../helpers/db.js';
import { createAdmin, createClient } from '../helpers/auth.js';
import {
  createBrandRecord,
  createCategoryRecord,
  createProductRecord,
} from '../helpers/factories.js';

describe('product concurrency guarantees', () => {
  let app;
  let adminClient;
  let brand;
  let category;

  const payload = (overrides = {}) => ({
    title: 'Contended Product',
    description: 'A product created by many parallel requests.',
    price: 1000,
    stock: 5,
    brand: brand.id,
    category: category.id,
    ...overrides,
  });

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
    brand = await createBrandRecord({ name: 'Racer' });
    category = await createCategoryRecord({ name: 'Race' });
    await createAdmin({ email: 'race-admin@test.local' });
    adminClient = createClient(app);
    await adminClient.login('race-admin@test.local', 'Adm1n!Passw0rd');
  });

  it('allocates unique slugs and SKUs for parallel creates with the same title', async () => {
    const requests = Array.from({ length: 12 }, () =>
      adminClient.post('/api/v1/admin/products', payload()),
    );
    const responses = await Promise.all(requests);

    const failures = responses
      .filter((response) => response.status !== 201)
      .map((response) => ({ status: response.status, body: response.body }));
    expect(failures, `unexpected failures: ${JSON.stringify(failures)}`).toEqual([]);

    const slugs = responses.map((response) => response.body.data.slug);
    const skus = responses.map((response) => response.body.data.sku);
    expect(new Set(slugs).size).toBe(12);
    expect(new Set(skus).size).toBe(12);
    expect(await Product.countDocuments()).toBe(12);

    // Every slug keeps the readable base (suffixes only disambiguate).
    expect(slugs.every((slug) => slug.startsWith('contended-product'))).toBe(true);
    expect(slugs).toContain('contended-product');
  }, 60_000);

  it('accepts exactly one of several parallel creates that share an explicit SKU', async () => {
    const requests = Array.from({ length: 8 }, (_, index) =>
      adminClient.post(
        '/api/v1/admin/products',
        payload({ title: `Unique Title ${index}`, sku: 'RACE-00001' }),
      ),
    );
    const responses = await Promise.all(requests);
    const statuses = responses.map((response) => response.status);

    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(7);
    expect(await Product.countDocuments({ sku: 'RACE-00001' })).toBe(1);
  }, 60_000);

  it('never oversells stock under parallel decrements (atomic $inc + guard)', async () => {
    const created = await adminClient.post('/api/v1/admin/products', payload({ stock: 25 }));
    const id = created.body.data.id;

    const requests = Array.from({ length: 40 }, () =>
      adminClient.patch(`/api/v1/admin/products/${id}/stock`, { delta: -1 }),
    );
    const responses = await Promise.all(requests);
    const statuses = responses.map((response) => response.status);

    expect(statuses.filter((status) => status === 200)).toHaveLength(25);
    expect(statuses.filter((status) => status === 409)).toHaveLength(15);

    const product = await Product.findById(id);
    expect(product.stock).toBe(0);
    expect(responses.every((response) => response.body.error?.code !== 'INTERNAL_ERROR')).toBe(
      true,
    );
  }, 60_000);

  it('does not lose increments under parallel restocks', async () => {
    const created = await adminClient.post('/api/v1/admin/products', payload({ stock: 0 }));
    const id = created.body.data.id;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        adminClient.patch(`/api/v1/admin/products/${id}/stock`, { delta: 1 }),
      ),
    );

    const product = await Product.findById(id);
    expect(product.stock).toBe(20);
  }, 60_000);

  it('lets only one of two edits from the same version win (OCC)', async () => {
    const created = await adminClient.post('/api/v1/admin/products', payload());
    const id = created.body.data.id;
    expect(created.body.data.version).toBe(0);

    const [first, _second] = await Promise.all([
      adminClient.patch(`/api/v1/admin/products/${id}`, { price: 111, version: 0 }),
      adminClient.patch(`/api/v1/admin/products/${id}`, { price: 222, version: 0 }),
    ]);

    const responses = [first, _second];
    const successes = responses.filter((response) => response.status === 200);
    const conflicts = responses.filter((response) => response.status === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].body.error.code).toBe('STALE_RESOURCE');

    const product = await Product.findById(id);
    expect([111, 222]).toContain(product.price);
    expect(product.__v).toBe(1);
  }, 60_000);

  it('generates unique SKUs under parallel low-level allocation', async () => {
    const skus = await Promise.all(
      Array.from({ length: 25 }, () => createUniqueSku(Product, { prefix: 'race' })),
    );
    expect(new Set(skus).size).toBe(25);

    const products = await Promise.all(
      skus.map((sku, index) =>
        createProductRecord({
          brand: brand._id,
          category: category._id,
          sku,
          title: `Parallel SKU ${index}`,
        }),
      ),
    );
    expect(products).toHaveLength(25);
    expect(await Product.countDocuments()).toBe(25);
  }, 60_000);

  it('keeps stock badge semantics correct immediately after an atomic update', async () => {
    const created = await adminClient.post('/api/v1/admin/products', payload({ stock: 6 }));
    const id = created.body.data.id;

    const drained = await adminClient.patch(`/api/v1/admin/products/${id}/stock`, { delta: -4 });
    expect(drained.body.data).toMatchObject({ stock: 2, stockStatus: 'low_stock', inStock: true });

    const soldOut = await adminClient.patch(`/api/v1/admin/products/${id}/stock`, { delta: -2 });
    expect(soldOut.body.data).toMatchObject({
      stock: 0,
      stockStatus: 'out_of_stock',
      inStock: false,
    });

    // The storefront badge reflects the same state.
    const publicView = await createClient(app).get(`/api/v1/products/${id}`);
    expect(publicView.body.data.stockStatus).toBe('out_of_stock');
  });
});
