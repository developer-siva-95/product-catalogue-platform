import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { createApp } from '../../src/app.js';
import { Product } from '../../src/modules/products/model.js';
import { resetAllRateLimits } from '../../src/middlewares/rateLimiter.js';
import { connectTestDB, disconnectTestDB, clearDatabase } from '../helpers/db.js';
import { createClient } from '../helpers/auth.js';
import { decodeCursor, encodeCursor } from '../../src/utils/cursor.js';
import { buildStorefrontQueryParts } from '../../src/modules/products/service.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Fixture loaded via fs: ESLint's parser does not yet accept import attributes. */
const legacy = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/p1/legacy-cursors.json', import.meta.url)),
    'utf8',
  ),
);

/**
 * Cursor format compatibility.
 *
 * `fixtures/p1/legacy-cursors.json` holds tokens minted by the Phase 0
 * implementation before any refactoring. They must keep decoding after the P1
 * extraction (and after the MySQL work), because cursors are handed to clients and
 * are never re-issued by the server.
 */

const PRODUCT_IDS = [1, 2, 3, 4, 5, 6].map((n) => `65a00000000000000000000${n}`);
const BRAND_ID = '650000000000000000000001';
const CATEGORY_ID = '651000000000000000000001';

function productDoc({ index, title, price, stock, isActive = true }) {
  const created = new Date(Date.UTC(2026, 0, index, 12, 0, 0, 0));
  return {
    _id: new mongoose.Types.ObjectId(PRODUCT_IDS[index - 1]),
    title,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    sku: `SKU-${index}`,
    price,
    stock,
    description: `${title} description`,
    image: '/uploads/placeholder.svg',
    thumbnail: '/uploads/placeholder-thumb.svg',
    brand: new mongoose.Types.ObjectId(BRAND_ID),
    category: new mongoose.Types.ObjectId(CATEGORY_ID),
    isActive,
    createdAt: created,
    updatedAt: created,
    __v: 0,
  };
}

describe('pre-P1 cursors still decode', () => {
  let app;
  let client;

  beforeAll(async () => {
    await connectTestDB();
    await Product.syncIndexes();
    app = createApp();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearDatabase();
    resetAllRateLimits();
    client = createClient(app);
    // Same fixture shape the cursors were minted against.
    await Product.collection.insertMany([
      productDoc({ index: 1, title: 'Alpha Sneaker', price: 19.99, stock: 10 }),
      productDoc({ index: 2, title: 'alpha runner', price: 100, stock: 3 }),
      productDoc({ index: 3, title: 'Beta Boot', price: 250.5, stock: 0 }),
      productDoc({ index: 4, title: 'Gamma Sandal', price: 1000, stock: 5 }),
      productDoc({ index: 5, title: 'Delta Cap', price: 5.25, stock: 25 }),
      productDoc({ index: 6, title: 'Epsilon Belt', price: 300, stock: 0, isActive: false }),
    ]);
  });

  it('has legacy tokens captured from the pre-refactor implementation', () => {
    expect(legacy.cursors).toHaveLength(2);
    for (const entry of legacy.cursors) {
      expect(typeof entry.token).toBe('string');
      expect(entry.token.split('.')).toHaveLength(2);
    }
  });

  describe.each(legacy.cursors.map((entry) => [entry.sort, entry]))('%s cursor', (_sort, entry) => {
    it('decodes to the exact payload it was issued with', () => {
      const decoded = decodeCursor(entry.token, {
        sort: entry.payload.s,
        filterHash: entry.payload.f,
      });
      expect(decoded).toEqual({
        sort: entry.payload.s,
        id: entry.payload.i,
        ...(entry.payload.s === 'newest' ? {} : { price: entry.payload.p }),
      });
    });

    it('is accepted by the live storefront endpoint', async () => {
      const limit = entry.payload.s === 'newest' ? 3 : 2;
      const response = await client.get(
        `/api/v1/products?limit=${limit}&sort=${entry.payload.s}&cursor=${entry.token}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.meta.sort).toBe(entry.payload.s);
      // The page after the cursor: strictly "older" than the cursor position.
      const ids = response.body.data.map((product) => product.id);
      expect(ids).not.toContain(entry.payload.id);
      expect(ids.length).toBeLessThanOrEqual(limit);
    });

    it('re-encodes to the identical token (format is stable, not just decodable)', () => {
      const decoded = decodeCursor(entry.token, {
        sort: entry.payload.s,
        filterHash: entry.payload.f,
      });
      expect(
        encodeCursor({
          sort: decoded.sort,
          id: decoded.id,
          price: decoded.price,
          filterHash: entry.payload.f,
        }),
      ).toBe(entry.token);
    });
  });

  it('still rejects a legacy cursor used with the wrong sort', async () => {
    const newest = legacy.cursors.find((entry) => entry.sort === 'newest');
    const response = await client.get(`/api/v1/products?sort=price_asc&cursor=${newest.token}`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CURSOR_SORT_MISMATCH');
  });

  it('still rejects a legacy cursor used with different filters', async () => {
    const newest = legacy.cursors.find((entry) => entry.sort === 'newest');
    const response = await client.get(`/api/v1/products?search=alpha&cursor=${newest.token}`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('CURSOR_FILTER_MISMATCH');
  });

  it('computes the same filter fingerprint the legacy cursors carry', () => {
    for (const entry of legacy.cursors) {
      const { filterHash } = buildStorefrontQueryParts({ limit: 3, sort: entry.payload.s });
      expect(filterHash).toBe(entry.payload.f);
    }
  });
});
