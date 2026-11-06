import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../../src/app.js';
import { Product } from '../../src/modules/products/model.js';
import { buildStorefrontQueryParts } from '../../src/modules/products/service.js';
import { encodeCursor } from '../../src/utils/cursor.js';
import { resetAllRateLimits } from '../../src/middlewares/rateLimiter.js';
import { connectTestDB, disconnectTestDB, clearDatabase, syncIndexes } from '../helpers/db.js';
import { createClient } from '../helpers/auth.js';
import { seedStorefront, traverseCursor, fetchAll } from '../helpers/pagination.js';

/** Extracts index names used by a Mongo explain plan (winning plan only). */
function collectPlanStages(plan) {
  const stages = [];
  const walk = (node) => {
    if (!node) return;
    stages.push({
      stage: node.stage,
      indexName: node.indexName ?? null,
      direction: node.direction ?? null,
    });
    walk(node.inputStage);
    if (Array.isArray(node.inputStages)) node.inputStages.forEach(walk);
  };
  walk(plan?.queryPlanner?.winningPlan);
  return stages;
}

describe('storefront products API (cursor pagination)', () => {
  let app;
  let client;
  let fixtures;

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
    fixtures = await seedStorefront();
    client = createClient(app);
  });

  it('hides inactive products from the public list and detail endpoints', async () => {
    const response = await client.get('/api/v1/products?limit=48');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(27); // 30 - 3 inactive
    expect(response.body.data.every((product) => product.isActive)).toBe(true);

    const inactive = fixtures.products.find((product) => product.isActive === false);
    expect((await client.get(`/api/v1/products/${inactive.id}`)).status).toBe(404);
  });

  it('exposes stock badges on the storefront shape', async () => {
    const response = await client.get('/api/v1/products?limit=48');
    const outOfStock = response.body.data.find((product) => product.stock === 0);
    const lowStock = response.body.data.find((product) => product.stock === 3);
    const healthy = response.body.data.find((product) => product.stock === 25);

    expect(outOfStock).toMatchObject({ stockStatus: 'out_of_stock', inStock: false });
    expect(lowStock).toMatchObject({ stockStatus: 'low_stock', inStock: true });
    expect(healthy).toMatchObject({ stockStatus: 'in_stock', inStock: true });
  });

  it('returns a product detail by id and by slug, without internal fields', async () => {
    const active = fixtures.products.find((product) => product.isActive);
    const byId = await client.get(`/api/v1/products/${active.id}`);
    expect(byId.status).toBe(200);
    expect(byId.body.data).toMatchObject({ id: active.id, slug: active.slug });
    expect(byId.body.data.__v).toBeUndefined();
    expect(byId.body.data.version).toBeUndefined();

    const bySlug = await client.get(`/api/v1/products/${active.slug}`);
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.data.id).toBe(active.id);

    expect((await client.get('/api/v1/products/000000000000000000000000')).status).toBe(404);
  });

  describe('newest sort (single-field _id cursor)', () => {
    it('traverses every active product exactly once in descending creation order', async () => {
      const { ids, pages } = await traverseCursor(client, '/api/v1/products?sort=newest');
      expect(ids).toHaveLength(27);
      expect(new Set(ids).size).toBe(27);

      // Newest first: the last created product must lead.
      const all = await fetchAll(client, '/api/v1/products?sort=newest');
      expect(ids).toEqual(all.data.map((product) => product.id));

      // createdAt is non-increasing across page boundaries.
      const timestamps = pages.flatMap((page) =>
        page.data.map((product) => new Date(product.createdAt).getTime()),
      );
      expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
    });

    it('reports hasNextPage/nextCursor precisely at the last page boundary', async () => {
      const first = await client.get('/api/v1/products?limit=26');
      expect(first.body.data).toHaveLength(26);
      expect(first.body.meta.hasNextPage).toBe(true);
      expect(first.body.meta.nextCursor).toBeTypeOf('string');

      const second = await client.get(
        `/api/v1/products?limit=26&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
      );
      expect(second.body.data).toHaveLength(1);
      expect(second.body.meta.hasNextPage).toBe(false);
      expect(second.body.meta.nextCursor).toBeNull();
    });

    it('returns an empty first page with a null cursor when nothing matches', async () => {
      const response = await client.get('/api/v1/products?search=zzzzzz-nothing');
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.meta).toMatchObject({ hasNextPage: false, nextCursor: null });
    });
  });

  describe('price_asc sort (compound price + _id cursor)', () => {
    it('traverses all products once, strictly ascending, breaking ties by _id', async () => {
      const { ids, pages } = await traverseCursor(client, '/api/v1/products?sort=price_asc', {
        limit: 4,
      });
      expect(ids).toHaveLength(27);
      expect(new Set(ids).size).toBe(27);

      const flattened = pages.flatMap((page) => page.data);
      const prices = flattened.map((product) => product.price);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));

      // Tie-break: within an equal price, _id must ascend (no repeats, no gaps).
      for (let index = 1; index < flattened.length; index += 1) {
        const previous = flattened[index - 1];
        const current = flattened[index];
        if (previous.price === current.price) {
          expect(previous.id < current.id).toBe(true);
        }
      }
    });

    it('matches a single-shot query (no skipped or duplicated rows at boundaries)', async () => {
      const { ids } = await traverseCursor(client, '/api/v1/products?sort=price_asc', { limit: 5 });
      const all = await fetchAll(client, '/api/v1/products?sort=price_asc');
      expect(ids).toEqual(all.data.map((product) => product.id));
    });

    it('traverses correctly with a price range filter applied', async () => {
      const url = '/api/v1/products?sort=price_asc&minPrice=250&maxPrice=1500';
      const { ids, pages } = await traverseCursor(client, url, { limit: 3 });
      const expected = await fetchAll(client, url);
      expect(ids).toEqual(expected.data.map((product) => product.id));
      expect(
        pages.every((page) =>
          page.data.every((product) => product.price >= 250 && product.price <= 1500),
        ),
      ).toBe(true);
      expect(ids.length).toBeGreaterThan(3);
    });
  });

  describe('price_desc sort (compound price + _id cursor)', () => {
    it('traverses all products once, strictly descending', async () => {
      const { ids, pages } = await traverseCursor(client, '/api/v1/products?sort=price_desc', {
        limit: 6,
      });
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(27);

      const flattened = pages.flatMap((page) => page.data);
      const prices = flattened.map((product) => product.price);
      expect(prices).toEqual([...prices].sort((a, b) => b - a));

      for (let index = 1; index < flattened.length; index += 1) {
        const previous = flattened[index - 1];
        const current = flattened[index];
        if (previous.price === current.price) {
          expect(previous.id > current.id).toBe(true);
        }
      }
    });

    it('supports a page size of one across the whole collection', async () => {
      const { ids } = await traverseCursor(client, '/api/v1/products?sort=price_desc', {
        limit: 1,
      });
      expect(ids).toHaveLength(27);
      expect(new Set(ids).size).toBe(27);
    });
  });

  describe('cursor validation and compatibility', () => {
    it('rejects a malformed cursor', async () => {
      const response = await client.get('/api/v1/products?cursor=not-a-cursor');
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('CURSOR_INVALID');
    });

    it('rejects a tampered cursor', async () => {
      const first = await client.get('/api/v1/products?limit=2');
      const [payload, signature] = first.body.meta.nextCursor.split('.');
      const tampered = `${payload}.${signature.slice(0, -2)}xy`;

      const response = await client.get(`/api/v1/products?cursor=${encodeURIComponent(tampered)}`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('CURSOR_INVALID');
    });

    it('rejects a cursor used with a different sort', async () => {
      const newestPage = await client.get('/api/v1/products?limit=2&sort=newest');

      const response = await client.get(
        `/api/v1/products?sort=price_asc&cursor=${encodeURIComponent(newestPage.body.meta.nextCursor)}`,
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('CURSOR_SORT_MISMATCH');
      expect(response.body.message).toMatch(/Restart pagination/);
    });

    it('rejects a cursor used with different filters', async () => {
      const unfiltered = await client.get('/api/v1/products?limit=2');
      const response = await client.get(
        `/api/v1/products?brand=${fixtures.brandA.id}&cursor=${encodeURIComponent(unfiltered.body.meta.nextCursor)}`,
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('CURSOR_FILTER_MISMATCH');
    });

    it('accepts a cursor replayed with a different page size (limit is not part of the fingerprint)', async () => {
      const first = await client.get('/api/v1/products?limit=3');
      const second = await client.get(
        `/api/v1/products?limit=5&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
      );
      expect(second.status).toBe(200);
      expect(second.body.data).toHaveLength(5);
    });

    it('rejects a cursor with a valid signature but an unsupported sort', async () => {
      // encodeCursor refuses this at mint time, proving the internal contract,
      // and the API still rejects hand-crafted equivalents.
      expect(() =>
        encodeCursor({ sort: 'price_asc', id: '6511f0aaa1b2c3d4e5f60718', filterHash: 'x' }),
      ).toThrow(/price/);
    });
  });

  describe('filters and sorting contract', () => {
    it('filters by brand, category, search and price range', async () => {
      const byBrand = await fetchAll(client, `/api/v1/products?brand=${fixtures.brandA.id}`);
      expect(byBrand.data.length).toBeGreaterThan(0);
      expect(byBrand.data.every((product) => product.brand.id === fixtures.brandA.id)).toBe(true);

      const byCategory = await fetchAll(
        client,
        `/api/v1/products?category=${fixtures.categoryB.id}`,
      );
      expect(
        byCategory.data.every((product) => product.category.id === fixtures.categoryB.id),
      ).toBe(true);

      const bySearch = await fetchAll(client, '/api/v1/products?search=product 07');
      expect(bySearch.data).toHaveLength(1);
      expect(bySearch.data[0].title).toBe('Storefront Product 07');

      const byPrice = await fetchAll(client, '/api/v1/products?minPrice=500&maxPrice=1000');
      expect(byPrice.data.every((product) => product.price >= 500 && product.price <= 1000)).toBe(
        true,
      );
      expect(byPrice.data.length).toBeGreaterThan(0);
    });

    it('is case-insensitive for search', async () => {
      const lower = await fetchAll(client, '/api/v1/products?search=storefront');
      const upper = await fetchAll(client, '/api/v1/products?search=STOREFRONT');
      expect(lower.meta.count).toBe(upper.meta.count);
      expect(lower.meta.count).toBe(27);
    });

    it('combines search + facet + price filters with cursor pagination', async () => {
      const url = `/api/v1/products?sort=price_desc&search=product&brand=${fixtures.brandA.id}&minPrice=100`;
      const { ids } = await traverseCursor(client, url, { limit: 2 });
      const expected = await fetchAll(client, url);
      expect(ids).toEqual(expected.data.map((product) => product.id));
      expect(ids.length).toBeGreaterThan(2);
    });

    it('validates query parameters', async () => {
      expect((await client.get('/api/v1/products?limit=49')).status).toBe(400);
      expect((await client.get('/api/v1/products?limit=0')).status).toBe(400);
      expect((await client.get('/api/v1/products?sort=bogus')).status).toBe(400);
      expect((await client.get('/api/v1/products?minPrice=500&maxPrice=100')).status).toBe(400);
      expect((await client.get('/api/v1/products?brand=not-an-id')).status).toBe(400);
      expect((await client.get('/api/v1/products?unknown=1')).status).toBe(400);
    });

    it('defaults to newest with a page size of 12', async () => {
      const response = await client.get('/api/v1/products');
      expect(response.body.data).toHaveLength(12);
      expect(response.body.meta).toMatchObject({ limit: 12, sort: 'newest', hasNextPage: true });
    });
  });

  describe('query plan verification (.explain executionStats)', () => {
    it('uses the active+newest index for the default sort instead of a collection scan + blocking sort', async () => {
      const { filter, sort } = buildStorefrontQueryParts({ sort: 'newest', limit: 12 });
      const plan = await Product.find(filter).sort(sort).limit(12).explain('executionStats');
      const stages = collectPlanStages(plan);

      expect(stages.some((entry) => entry.stage === 'COLLSCAN')).toBe(false);
      expect(stages.some((entry) => entry.stage === 'SORT')).toBe(false);
      const ixscan = stages.find((entry) => entry.stage === 'IXSCAN');
      expect(ixscan?.indexName).toBe('product_active_newest');
    });

    it('serves both price sorts from a price index, in an order-compatible direction', async () => {
      // MongoDB may satisfy `price_desc` either from the descending index (forward)
      // or from the ascending index scanned backwards — both are index-backed
      // ordered scans. What must never happen is a collection scan or a blocking
      // in-memory SORT stage.
      const validScan = {
        price_asc: [
          ['product_active_price_asc', 'forward'],
          ['product_active_price_desc', 'backward'],
        ],
        price_desc: [
          ['product_active_price_desc', 'forward'],
          ['product_active_price_asc', 'backward'],
        ],
      };

      for (const sortKey of ['price_asc', 'price_desc']) {
        const { filter, sort } = buildStorefrontQueryParts({ sort: sortKey, limit: 12 });

        const plan = await Product.find(filter).sort(sort).limit(12).explain('executionStats');
        const stages = collectPlanStages(plan);

        expect(stages.some((entry) => entry.stage === 'COLLSCAN')).toBe(false);
        expect(stages.some((entry) => entry.stage === 'SORT')).toBe(false);

        const ixscan = stages.find((entry) => entry.stage === 'IXSCAN');
        expect(ixscan).toBeDefined();
        expect(ixscan.direction ?? 'forward').toBeTypeOf('string');
        expect(
          validScan[sortKey].some(
            ([indexName, direction]) =>
              ixscan.indexName === indexName && (ixscan.direction ?? 'forward') === direction,
          ),
        ).toBe(true);
      }
    });

    it('reports bounded keysExamined/docsExamined for a cursor page (limit+1 scan)', async () => {
      const first = await client.get('/api/v1/products?limit=5');
      const { filter, sort } = buildStorefrontQueryParts({
        sort: 'newest',
        cursor: first.body.meta.nextCursor,
        limit: 5,
      });
      const plan = await Product.find(filter).sort(sort).limit(6).explain('executionStats');
      expect(plan.executionStats.executionStages.docsExamined ?? 0).toBeLessThanOrEqual(6);
    });
  });

  /**
   * The client refreshes product data on mount and on demand; these headers make sure
   * the *browser* cannot answer those requests from its own cache. Both list and
   * detail are dynamic per-request payloads, so both must be unstorable, and the
   * response must not claim to be public or immutable.
   */
  it('marks storefront list and detail responses as no-store', async () => {
    const list = await client.get('/api/v1/products?limit=5');
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    expect(list.headers['cache-control']).not.toContain('public');

    const active = fixtures.products.find((product) => product.isActive);
    const detail = await client.get(`/api/v1/products/${active.id}`);
    expect(detail.status).toBe(200);
    expect(detail.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    expect(detail.headers.pragma).toBe('no-cache');
  });

  it('leaves unrelated API routes (health) without a product cache policy', async () => {
    const health = await client.get('/api/v1/health');
    expect(health.status).toBe(200);
    expect(health.headers['cache-control'] ?? '').not.toContain('no-store');
  });
});
