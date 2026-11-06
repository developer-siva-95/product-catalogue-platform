import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { runSeed } from '../../src/config/seed.js';

/**
 * Seed idempotency contract.
 *
 * "Idempotent" is asserted twice over, on **both** providers:
 *   1. no duplicates — the record count after a second run equals the count after
 *      the first, and equals the fixture size;
 *   2. **no changes** — a full fingerprint of every record (id, every column,
 *      `createdAt`, `updatedAt`, version) is byte-identical across runs. A seed
 *      that "upserts" and rewrites `updatedAt` would pass (1) and fail (2).
 *
 * The suite also proves the provider-neutral property directly: `runSeed()` talks
 * only to `getRepositories()`, so the same fixture set lands in either database.
 *
 * @param {{
 *   provider: string,
 *   skip: boolean,
 *   setup: () => Promise<void>,
 *   teardown: () => Promise<void>,
 *   reset: () => Promise<void>,
 *   repositories: () => object,
 *   snapshot: () => Promise<object>,
 * }} adapter
 */
export function defineSeedSuite(adapter) {
  const { provider } = adapter;

  describe.skipIf(adapter.skip)(`seed contract [${provider}]`, () => {
    beforeAll(async () => {
      await adapter.setup();
    }, 90_000);

    afterAll(async () => {
      await adapter.teardown();
    }, 60_000);

    beforeEach(async () => {
      await adapter.reset();
    });

    const seed = () => runSeed({ repositories: adapter.repositories() });

    it('loads the full fixture set on the first run', async () => {
      const summary = await seed();

      expect(summary.provider).toBe(provider);
      expect(summary.categories).toBe(6);
      expect(summary.detail.categories).toEqual({ total: 6, created: 6, skipped: 0 });
      expect(summary.brands).toBe(6);
      expect(summary.detail.brands).toEqual({ total: 6, created: 6, skipped: 0 });
      // The P0 fixture set: 22 products across 6 categories and 6 brands.
      expect(summary.products).toMatchObject({ total: 22, created: 22, skipped: 0 });
      expect(summary.admin).toMatchObject({ created: true, email: 'admin@catalogue.com' });
      expect(summary.changed).toBe(35);
    }, 120_000);

    it('is idempotent: a second run duplicates nothing and changes nothing', async () => {
      const first = adapter.repositories();
      await runSeed({ repositories: first });
      const before = await adapter.snapshot();

      const summary = await runSeed({ repositories: adapter.repositories() });
      const after = await adapter.snapshot();

      expect(summary.changed).toBe(0);
      expect(summary.detail.categories).toEqual({ total: 6, created: 0, skipped: 6 });
      expect(summary.detail.brands).toEqual({ total: 6, created: 0, skipped: 6 });
      expect(summary.products).toMatchObject({ total: 22, created: 0, skipped: 22 });
      expect(summary.admin.created).toBe(false);

      // Not merely "no duplicates": not a single field moved.
      expect(after).toEqual(before);
      expect(after.counts).toEqual({ brands: 6, categories: 6, products: 22, users: 1 });
    }, 180_000);

    /**
     * Fixture pinning.
     *
     * Phase 6 shipped a rewritten seeder that replaced the *contents* of the
     * fixture catalogue with a similar-looking one. Every unit and integration
     * suite stayed green; only the browser audits caught it (they assert against
     * the seeded data). This test is that audit's fast equivalent: the numbers the
     * E2E specs, the API audit and the DOM-budget control all depend on are now
     * asserted on both providers, in-process, in milliseconds.
     */
    it('pins the seeded fixture catalogue exactly', async () => {
      const repositories = adapter.repositories();
      await runSeed({ repositories });

      // `list()` returns an array (the controller wraps it); `listAdmin()` on
      // products returns `{ records, total }`.
      const [brands, categories] = await Promise.all([
        repositories.brands.list({ sort: 'name' }),
        repositories.categories.list({ sort: 'name' }),
      ]);

      expect(brands).toHaveLength(6);
      expect(categories).toHaveLength(6);
      expect(brands.map((brand) => brand.name)).toEqual([
        'Aurora',
        'Kettle & Co',
        'Lumen',
        'NovaTech',
        'Trailmade',
        'Vertex',
      ]);
      expect(categories.map((category) => category.name)).toEqual([
        'Accessories',
        'Audio',
        'Computing',
        'Home & Kitchen',
        'Photography',
        'Wearables',
      ]);

      // 22 products in total, 2 of them retired (`isActive: false`). The
      // storefront-visible 20 is the number the E2E specs ("keeps the seeded
      // 20-product grid fully mounted") and the DOM-budget control run on.
      const admin = await repositories.products.listAdmin({
        page: 1,
        limit: 100,
        sort: '-createdAt',
      });
      expect(admin.total).toBe(22);

      const retired = admin.records
        .filter((record) => record.isActive === false)
        .map((record) => record.title)
        .sort();
      expect(retired).toEqual(['Lumen Ring Sleep Tracker', 'Trailmade Hard Case for Earbuds']);

      // The storefront hides retired products, so it must serve exactly 20.
      const storefront = await repositories.products.listStorefront({
        query: { sort: 'newest', limit: 100 },
        limit: 100,
      });
      expect(storefront.records).toHaveLength(20);
    }, 120_000);

    it('keeps the search=aurora fixture count the audits assert (5)', async () => {
      const repositories = adapter.repositories();
      await runSeed({ repositories });

      const result = await repositories.products.listStorefront({
        query: { sort: 'newest', search: 'aurora', limit: 100 },
        limit: 100,
      });

      // `audit/api-audit.mjs` asserts `meta.count === 5` for this exact query; if
      // the seed drifts, this fails here rather than two minutes into the audits.
      expect(result.records).toHaveLength(5);
      expect(result.records.every((record) => record.isActive !== false)).toBe(true);
    }, 120_000);

    it('survives a partial seed without duplicating the surviving rows', async () => {
      const repositories = adapter.repositories();
      await runSeed({ repositories });
      const before = await adapter.snapshot();

      // Simulate an operator deleting part of the catalogue, then re-seeding.
      await adapter.removeSomeProducts(5);
      const afterDelete = await adapter.snapshot();
      expect(afterDelete.counts.products).toBe(before.counts.products - 5);

      const summary = await runSeed({ repositories });
      const after = await adapter.snapshot();

      // The missing rows come back (slug is the natural key), the survivors do not move.
      expect(summary.products.created).toBe(5);
      expect(summary.products.skipped).toBe(17);
      expect(after.counts).toEqual(before.counts);
    }, 180_000);
  });
}
