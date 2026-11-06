import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * Text-search parity suite.
 *
 * Phase 4 measured text-mode search by hand and found one honest divergence:
 * InnoDB FULLTEXT has no stemmer, so inflected forms (`sneakers`, `sandals`) match
 * in MongoDB but not in MySQL. That measurement is turned into a test here so the
 * divergence is **pinned**, per provider, instead of being folklore:
 *
 *  - `regex` mode (the default, what the storefront actually uses) must be
 *    byte-for-byte equivalent on both providers;
 *  - `text` mode must match the provider's documented capability. If someone later
 *    "fixes" the MySQL side by quietly adding a stemmer, or if Mongo regresses,
 *    this suite fails and the report has to be updated.
 *
 * @param {{
 *   provider: string,
 *   skip: boolean,
 *   repositories: () => { products: object },
 *   setup: () => Promise<void>,
 *   teardown: () => Promise<void>,
 *   reset: () => Promise<void>,
 *   textSearch: {
 *     stems: boolean,
 *     expected: Record<string, number>,
 *     reason?: string,
 *   },
 * }} adapter
 */
export function defineTextSearchSuite(adapter) {
  const { provider, textSearch } = adapter;

  describe.skipIf(adapter.skip)(`text search [${provider}]`, () => {
    /** @type {ReturnType<typeof adapter.repositories>} */
    let repos;

    beforeAll(async () => {
      await adapter.setup();
      repos = adapter.repositories();
    }, 90_000);

    afterAll(async () => {
      await adapter.teardown();
    }, 60_000);

    beforeEach(async () => {
      await adapter.reset();
    });

    /* Six products, one per vocabulary word plus a control. */
    const CORPUS = [
      { title: 'Trail Sneaker', description: 'A light sneaker for the trail' },
      { title: 'Beach Sandal', description: 'A sandal that dries fast' },
      { title: 'Everyday Cap', description: 'A cap with a soft brim' },
      { title: 'Hiking Boot', description: 'A boot with a stiff sole' },
      { title: 'The Beanie', description: 'The beanie of the season' },
      { title: 'Plain Tee', description: 'A plain tee' },
    ];

    async function seed() {
      const brand = await repos.brands.create({ name: 'Text Brand', description: 'brand' });
      const category = await repos.categories.create({ name: 'Text Category', description: 'cat' });
      let index = 0;
      for (const item of CORPUS) {
        index += 1;
        await repos.products.create({
          payload: {
            title: item.title,
            description: item.description,
            price: 10 + index,
            stock: 3,
            brand: brand.id,
            category: category.id,
            isActive: true,
            sku: `TXT-${String(index).padStart(3, '0')}`,
          },
          slugSource: item.title,
          skuPrefix: 'TXT',
        });
      }
    }

    async function count(mode, search) {
      const result = await repos.products.listAdmin({
        search,
        searchMode: mode,
        page: 1,
        limit: 50,
        sort: '-createdAt',
      });
      return result.total;
    }

    /** The default mode: plain substring matching, identical on both providers. */
    const REGEX_CASES = [
      ['sneaker', 1],
      ['sneakers', 0],
      ['Sandal', 1],
      ['sandals', 0],
      ['cap', 1],
      ['boot', 1],
      // `the` and `be` occur inside real words here (beanie/beach), which is exactly
      // the behaviour substring mode must keep: no stopword filtering.
      ['the', 1],
      ['be', 2],
      ['TXT-004', 1],
      ['nothing-matches-this', 0],
    ];

    it('matches substrings identically in the default regex mode', async () => {
      await seed();
      for (const [term, expected] of REGEX_CASES) {
        expect({ term, total: await count('regex', term) }).toEqual({ term, total: expected });
      }
    });

    it('applies the documented text-mode vocabulary', async () => {
      await seed();
      for (const [term, expected] of Object.entries(textSearch.expected)) {
        expect({ term, total: await count('text', term) }).toEqual({ term, total: expected });
      }
    });

    it('documents whether this provider stems inflected forms', async () => {
      await seed();
      const singular = await count('text', 'sneaker');
      const plural = await count('text', 'sneakers');

      if (textSearch.stems) {
        expect({ singular, plural }).toEqual({ singular: 1, plural: 1 });
      } else {
        expect({ singular, plural }).toEqual({ singular: 1, plural: 0 });
        // The limitation is spelled out rather than left implicit.
        expect(textSearch.reason).toMatch(/stemmer/i);
      }
    });

    it('matches nothing for a whitespace-only text query, on both providers', async () => {
      await seed();
      const result = await repos.products.listAdmin({
        search: '   ',
        searchMode: 'text',
        page: 1,
        limit: 50,
        sort: '-createdAt',
      });
      // Mongo's `$text` and InnoDB's MATCH…AGAINST both treat a query with no terms
      // as "no match". Callers strip blanks before this point, so the parity that
      // matters is simply that the two agree.
      expect(result.total).toBe(0);
    });
  });
}
