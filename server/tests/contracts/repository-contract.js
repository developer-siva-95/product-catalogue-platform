import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { toAdminProduct, toPublicProduct } from '../../src/repositories/product.mapper.js';
import { mapDatabaseError } from '../../src/repositories/error-mapping.js';
import { encodeCursor } from '../../src/utils/cursor.js';
import { storefrontFilterHash } from '../../src/repositories/storefront-query.js';

/**
 * The shared repository contract suite.
 *
 * One definition, executed against **both** providers (real MongoDB replica set and
 * real MySQL). Every assertion here is provider-neutral by construction: it talks
 * only through the repository interfaces and asserts the semantics the services and
 * controllers depend on, so "the providers are interchangeable" is a statement the
 * test suite makes, not one the report claims.
 *
 * @param {{
 *   provider: string,
 *   skip: boolean,
 *   repositories: () => { products: object, brands: object, categories: object, users: object },
 *   setup: () => Promise<void>,
 *   teardown: () => Promise<void>,
 *   reset: () => Promise<void>,
 * }} adapter
 */
export function defineRepositoryContractSuite(adapter) {
  const { provider } = adapter;

  describe.skipIf(adapter.skip)(`repository contract [${provider}]`, () => {
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

    // Unique per call, so a test that creates two products does not collide on the
    // taxonomy's unique name (the label is part of the contract assertions below).
    let taxonomyCounter = 0;

    async function makeTaxonomy(suffix = '') {
      const brand = await repos.brands.create({
        name: `Contract Brand${suffix}`,
        description: 'brand description',
      });
      const category = await repos.categories.create({
        name: `Contract Category${suffix}`,
        description: 'category description',
      });
      return { brand, category };
    }

    async function makeProduct(overrides = {}) {
      const { image, thumbnail, ...fields } = overrides;
      taxonomyCounter += 1;
      const { brand, category } = await makeTaxonomy(
        fields.suffix ?? (taxonomyCounter === 1 ? '' : ` ${taxonomyCounter}`),
      );
      const record = await repos.products.create({
        payload: {
          title: fields.title ?? 'Contract Product',
          description: fields.description ?? 'contract product description',
          price: fields.price ?? 19.99,
          stock: fields.stock ?? 4,
          brand: brand.id,
          category: category.id,
          isActive: fields.isActive ?? true,
          sku: fields.sku,
        },
        slugSource: fields.title ?? 'Contract Product',
        skuPrefix: fields.skuPrefix ?? 'CON',
        image,
        thumbnail,
      });
      return { brand, category, record };
    }

    /* ------------------------------------------------------------------ products */

    it('returns a driver-free record with a canonical string id', async () => {
      const { brand, record } = await makeProduct();

      expect(typeof record._id).toBe('string');
      expect(record._id).toMatch(/^[0-9a-f]{24}$/);
      expect(record.brand).toEqual({
        _id: brand.id,
        name: 'Contract Brand',
        slug: 'contract-brand',
      });
      expect(record.__v).toBe(0);
      expect(typeof record.price).toBe('number');
      expect(record.price).toBe(19.99);
      expect(record.createdAt).toBeInstanceOf(Date);
    });

    it('maps to the public and admin wire shapes identically', async () => {
      const { record } = await makeProduct({ stock: 2 });
      const publicShape = toPublicProduct(record);
      const adminShape = toAdminProduct(record);

      expect(Object.keys(publicShape)).toEqual([
        'id',
        'title',
        'slug',
        'sku',
        'price',
        'stock',
        'inStock',
        'stockStatus',
        'description',
        'image',
        'thumbnail',
        'brand',
        'category',
        'isActive',
        'createdAt',
        'updatedAt',
      ]);
      expect(publicShape.stockStatus).toBe('low_stock');
      expect(adminShape.version).toBe(0);
      expect(Object.keys(adminShape).at(-1)).toBe('version');
    });

    it('keeps inactive products out of findById but not findAdminById', async () => {
      const { record } = await makeProduct({ title: 'Inactive Contract', isActive: false });

      expect(await repos.products.findById(record._id)).toBeNull();
      expect((await repos.products.findAdminById(record._id))._id).toBe(record._id);
    });

    it('resolves a product by slug as well as by id', async () => {
      const { record } = await makeProduct({ title: 'Slug Contract' });
      expect((await repos.products.findById('slug-contract'))._id).toBe(record._id);
    });

    it('returns null (never undefined) for a missing product', async () => {
      expect(await repos.products.findById('000000000000000000000000')).toBeNull();
      expect(await repos.products.deleteById('000000000000000000000000')).toBeNull();
      expect(await repos.products.updateStock('000000000000000000000000', { delta: 1 })).toBeNull();
    });

    it('adjusts stock atomically and refuses to overdraw', async () => {
      const { record } = await makeProduct({ title: 'Stock Contract', stock: 3 });

      const decremented = await repos.products.updateStock(record._id, { delta: -2 });
      expect(decremented.record.stock).toBe(1);
      expect(decremented.record.__v).toBe(1);

      const overdrawn = await repos.products.updateStock(record._id, { delta: -5 });
      expect(overdrawn).toMatchObject({
        record: null,
        insufficient: true,
        available: 1,
        requested: 5,
      });

      const absolute = await repos.products.updateStock(record._id, { stock: 12 });
      expect(absolute.record.stock).toBe(12);
    });

    it('never oversells under concurrent decrements', async () => {
      const { record } = await makeProduct({ title: 'Contended Contract', stock: 3 });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => repos.products.updateStock(record._id, { delta: -1 })),
      );
      const applied = results.filter((result) => result && !result.insufficient).length;
      const after = await repos.products.findAdminById(record._id);

      expect(applied).toBe(3);
      expect(after.stock).toBe(0);
      expect(results.filter((result) => result.insufficient)).toHaveLength(7);
    });

    it('rejects a stale version, then accepts the current one', async () => {
      const { record } = await makeProduct({ title: 'Versioned Contract', price: 4 });

      await expect(
        repos.products.replaceFields(record._id, { price: 9, version: 99 }, { partial: true }),
      ).rejects.toMatchObject({ code: 'STALE_RESOURCE', statusCode: 409 });

      const updated = await repos.products.replaceFields(
        record._id,
        { price: 9, version: 0 },
        { partial: true },
      );
      expect(updated.record.price).toBe(9);
      expect(updated.record.__v).toBe(1);
      expect(updated.previous).toEqual({ image: '', thumbnail: '' });
    });

    it('re-slugs only when the title actually changes', async () => {
      const { record } = await makeProduct({ title: 'Stable Title' });
      expect(record.slug).toBe('stable-title');

      const untouched = await repos.products.replaceFields(
        record._id,
        { price: 21, version: 0 },
        { partial: true },
      );
      expect(untouched.record.slug).toBe('stable-title');

      const renamed = await repos.products.replaceFields(
        record._id,
        { title: 'Renamed Title', version: 1 },
        { partial: true },
      );
      expect(renamed.record.slug).toBe('renamed-title');
      expect((await repos.products.findById('renamed-title'))._id).toBe(record._id);
    });

    it('cursor-pages the storefront with limit+1 rows and no overlap', async () => {
      const { brand, category } = await makeTaxonomy();
      for (let index = 1; index <= 5; index += 1) {
        await repos.products.create({
          payload: {
            title: `Paged Contract ${index}`,
            description: `paged ${index}`,
            price: index * 10,
            stock: 1,
            brand: brand.id,
            category: category.id,
          },
          slugSource: `Paged Contract ${index}`,
        });
      }

      const query = { sort: 'newest', limit: 2 };
      const first = await repos.products.listStorefront({ query, limit: 2 });
      expect(first.fetched).toBe(3);

      const boundary = first.records[1];
      const cursor = encodeCursor({
        sort: 'newest',
        id: boundary._id,
        filterHash: storefrontFilterHash(query),
      });
      const second = await repos.products.listStorefront({ query: { ...query, cursor }, limit: 2 });

      const seen = new Set(first.records.slice(0, 2).map((row) => row._id));
      expect(second.records.some((row) => seen.has(row._id))).toBe(false);
      expect(second.records.length).toBeGreaterThan(0);
    });

    it('orders by price in both directions with a stable id tie-break', async () => {
      const { brand, category } = await makeTaxonomy();
      for (const price of [30, 10, 20, 10]) {
        await repos.products.create({
          payload: {
            title: `Price Contract ${price}`,
            description: 'price contract',
            price,
            stock: 1,
            brand: brand.id,
            category: category.id,
          },
          slugSource: `Price Contract ${price}`,
        });
      }

      const ascending = await repos.products.listStorefront({
        query: { sort: 'price_asc', limit: 10 },
        limit: 10,
      });
      expect(ascending.records.map((row) => row.price)).toEqual([10, 10, 20, 30]);

      const descending = await repos.products.listStorefront({
        query: { sort: 'price_desc', limit: 10 },
        limit: 10,
      });
      expect(descending.records.map((row) => row.price)).toEqual([30, 20, 10, 10]);

      // The two equal-price rows must appear in the same relative order in both
      // directions (id ascending vs descending).
      const ascTies = ascending.records.filter((row) => row.price === 10).map((row) => row._id);
      const descTies = descending.records.filter((row) => row.price === 10).map((row) => row._id);
      expect(descTies).toEqual([...ascTies].reverse());
    });

    it('gives an exact admin total and honours page/limit', async () => {
      const { brand, category } = await makeTaxonomy();
      for (let index = 1; index <= 5; index += 1) {
        await repos.products.create({
          payload: {
            title: `Admin Page Contract ${index}`,
            description: 'admin page',
            price: index,
            stock: 1,
            brand: brand.id,
            category: category.id,
          },
          slugSource: `Admin Page Contract ${index}`,
        });
      }

      const page1 = await repos.products.listAdmin({ page: 1, limit: 2, sort: 'price' });
      const page3 = await repos.products.listAdmin({ page: 3, limit: 2, sort: 'price' });
      expect(page1.total).toBe(5);
      expect(page1.records).toHaveLength(2);
      expect(page1.records[0].price).toBe(1);
      expect(page3.records).toHaveLength(1);

      const inactive = await repos.products.listAdmin({
        page: 1,
        limit: 10,
        sort: 'price',
        isActive: false,
      });
      expect(inactive.total).toBe(0);
    });

    it('searches case-insensitively and treats wildcards as literal text', async () => {
      await makeProduct({ title: 'Searchable Widget', sku: 'WID-001' });

      const direct = await repos.products.listStorefront({
        query: { sort: 'newest', search: 'widget', limit: 10 },
        limit: 10,
      });
      expect(direct.records).toHaveLength(1);

      const upper = await repos.products.listStorefront({
        query: { sort: 'newest', search: 'WIDGET', limit: 10 },
        limit: 10,
      });
      expect(upper.records).toHaveLength(1);

      // A SKU match counts too (the reference provider searches title + SKU), and
      // must be case-insensitive even though `sku` is stored with a binary
      // collation for exact uniqueness.
      const bySku = await repos.products.listStorefront({
        query: { sort: 'newest', search: 'wid-001', limit: 10 },
        limit: 10,
      });
      expect(bySku.records).toHaveLength(1);

      const wildcard = await repos.products.listStorefront({
        query: { sort: 'newest', search: '.*', limit: 10 },
        limit: 10,
      });
      expect(wildcard.records).toHaveLength(0);

      const underscore = await repos.products.listStorefront({
        query: { sort: 'newest', search: 'wid_001', limit: 10 },
        limit: 10,
      });
      expect(underscore.records).toHaveLength(0);
    });

    it('applies price, brand and category facets together', async () => {
      const { brand, category } = await makeTaxonomy();
      const other = await repos.brands.create({ name: 'Other Contract Brand' });

      for (const product of [
        { title: 'Facet Cheap A', price: 5, brand: brand.id },
        { title: 'Facet Mid A', price: 50, brand: brand.id },
        { title: 'Facet Mid B', price: 60, brand: other.id },
        { title: 'Facet Expensive', price: 500, brand: brand.id },
      ]) {
        await repos.products.create({
          payload: {
            title: product.title,
            description: 'facet',
            price: product.price,
            stock: 1,
            brand: product.brand,
            category: category.id,
          },
          slugSource: product.title,
        });
      }

      const byPrice = await repos.products.listStorefront({
        query: { sort: 'newest', minPrice: 40, maxPrice: 100, limit: 10 },
        limit: 10,
      });
      expect(byPrice.records.map((row) => row.title).sort()).toEqual([
        'Facet Mid A',
        'Facet Mid B',
      ]);

      const byBrand = await repos.products.listStorefront({
        query: { sort: 'newest', brand: brand.id, limit: 10 },
        limit: 10,
      });
      expect(byBrand.records).toHaveLength(3);

      const combined = await repos.products.listStorefront({
        query: { sort: 'newest', brand: brand.id, minPrice: 40, limit: 10 },
        limit: 10,
      });
      expect(combined.records.map((row) => row.title).sort()).toEqual([
        'Facet Expensive',
        'Facet Mid A',
      ]);
    });

    it('deletes a product and reports what was removed', async () => {
      const { record } = await makeProduct({ title: 'Doomed Contract' });

      const deleted = await repos.products.deleteById(record._id);
      expect(deleted).toMatchObject({ id: record._id, title: 'Doomed Contract' });
      expect(await repos.products.findById(record._id)).toBeNull();
    });

    it('counts per taxonomy and reports referenced image files', async () => {
      const { brand } = await makeProduct({
        title: 'Counted Contract',
        image: '/uploads/contract-one.svg',
        thumbnail: '/uploads/contract-one-thumb.svg',
      });
      await makeProduct({ title: 'Counted Contract Inactive', isActive: false });

      const counts = await repos.products.countByTaxonomy('brand', [brand.id]);
      expect(counts.get(brand.id)).toEqual({ total: 1, active: 1 });

      const files = await repos.products.collectReferencedImageFiles();
      expect(files.has('contract-one.svg')).toBe(true);
      expect(files.has('contract-one-thumb.svg')).toBe(true);

      expect(await repos.products.countByTaxonomy('brand', [])).toEqual(new Map());
    });

    it('allocates unique slugs and SKUs', async () => {
      await makeProduct({ title: 'Allocated Contract' });

      expect(await repos.products.existsBySlug('allocated-contract')).toBe(true);
      expect(
        await repos.products.existsBySlug('allocated-contract', {
          excludeId: '0000000000000000000000ff',
        }),
      ).toBe(true);
      const next = await repos.products.allocateSlug('Allocated Contract');
      expect(next).not.toBe('allocated-contract');
      expect(await repos.products.existsBySlug(next)).toBe(false);

      const sku = await repos.products.allocateSku({ prefix: 'All' });
      expect(sku).toMatch(/^ALL-/);
      expect(await repos.products.existsBySku(sku)).toBe(false);
    });

    it('rejects a malformed excludeId identically on both providers', async () => {
      const { record } = await makeProduct({ title: 'Identifier Contract' });

      // A valid exclusion is accepted and is genuinely an exclusion.
      await expect(
        repos.products.existsBySlug(record.slug, { excludeId: record._id }),
      ).resolves.toBe(false);
      await expect(
        repos.products.existsBySlug(record.slug, { excludeId: '0000000000000000000000ff' }),
      ).resolves.toBe(true);
      // Absent exclusion keeps working.
      await expect(repos.products.existsBySlug(record.slug)).resolves.toBe(true);

      const malformed = ['not-an-id', 'xyz', '65a00000000000000000001', record._id.toUpperCase()];

      for (const excludeId of malformed) {
        const attempts = [
          () => repos.products.existsBySlug(record.slug, { excludeId }),
          () => repos.products.existsBySku(record.sku, { excludeId }),
          () => repos.products.allocateSku({ prefix: 'IDC', excludeId }),
          () => repos.products.allocateSlug('Identifier Contract', { excludeId }),
          () => repos.brands.existsByName('contract brand', { excludeId }),
          () => repos.categories.existsByName('contract category', { excludeId }),
        ];

        for (const attempt of attempts) {
          // Identical outcome on both providers: a 400 the HTTP layer can render as
          // a normal error payload, never a driver `CastError` (Mongo) or a silent
          // `false` (MySQL).
          await expect(attempt).rejects.toMatchObject({
            statusCode: 400,
            code: 'INVALID_IDENTIFIER',
            message: 'Invalid excludeId: expected a 24-character lowercase hexadecimal identifier',
            details: { field: 'excludeId', value: excludeId },
          });
        }
      }
    });

    it('surfaces duplicate keys through the provider-neutral mapper', async () => {
      await makeProduct({ title: 'Duplicate Source', sku: 'DUPT-1' });
      const { brand, category } = await makeTaxonomy('-dup');

      const error = await repos.products
        .create({
          payload: {
            title: 'Duplicate Target',
            description: 'dup',
            price: 1,
            stock: 1,
            brand: brand.id,
            category: category.id,
            sku: 'DUPT-1',
          },
          slugSource: 'Duplicate Target',
        })
        .catch((caught) => caught);

      expect(mapDatabaseError(error)).toMatchObject({
        statusCode: 409,
        code: 'DUPLICATE_KEY',
        details: { field: 'sku' },
      });
    });

    /* ------------------------------------------------------------------ taxonomies */

    it('creates, lists and counts brands with product references', async () => {
      const brand = await repos.brands.create({ name: 'Listing Brand' });
      const category = await repos.categories.create({ name: 'Listing Category' });
      await repos.products.create({
        payload: {
          title: 'Listing Contract Product',
          description: 'listing',
          price: 8,
          stock: 8,
          brand: brand.id,
          category: category.id,
        },
        slugSource: 'Listing Contract Product',
      });

      const list = await repos.brands.list({});
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: brand.id,
        name: 'Listing Brand',
        slug: 'listing-brand',
        productCount: 1,
        activeProductCount: 1,
      });
      expect(Object.keys(list[0])).toEqual([
        'id',
        'name',
        'slug',
        'description',
        'logo',
        'productCount',
        'activeProductCount',
        'createdAt',
        'updatedAt',
      ]);

      const detail = await repos.brands.findByIdentifier('listing-brand');
      expect(detail.productCount).toBe(1);
      expect(Object.keys(detail)).toEqual([
        'name',
        'slug',
        'description',
        'logo',
        'createdAt',
        'updatedAt',
        'id',
        'productCount',
        'activeProductCount',
      ]);

      expect(await repos.brands.existsByName('listing brand')).toBe(true);
      expect(await repos.brands.existsByName('listing brand', { excludeId: brand.id })).toBe(false);
      expect(await repos.brands.countProducts(brand.id)).toEqual({
        activeReferences: 1,
        inactiveReferences: 0,
      });
    });

    it('re-slugs a renamed taxonomy and refuses a duplicate name', async () => {
      const category = await repos.categories.create({ name: 'Original Contract Name' });
      const updated = await repos.categories.update(category.id, { name: 'Renamed Contract Name' });
      expect(updated.slug).toBe('renamed-contract-name');

      const error = await repos.categories
        .create({ name: ' renamed contract name ' })
        .catch((caught) => caught);
      expect(mapDatabaseError(error)).toMatchObject({ statusCode: 409, code: 'DUPLICATE_KEY' });

      expect(await repos.categories.update('000000000000000000000000', { name: 'x' })).toBeNull();
      expect(await repos.brands.delete('000000000000000000000000')).toBeNull();
    });

    it('sorts taxonomy lists by name in both directions', async () => {
      await repos.brands.create({ name: 'zeta contract' });
      await repos.brands.create({ name: 'Alpha Contract' });
      await repos.brands.create({ name: 'Beta Contract' });

      const ascending = await repos.brands.list({ sort: 'name' });
      expect(ascending.map((row) => row.name)).toEqual([
        'Alpha Contract',
        'Beta Contract',
        'zeta contract',
      ]);

      const descending = await repos.brands.list({ sort: '-name' });
      expect(descending.map((row) => row.name)).toEqual([
        'zeta contract',
        'Beta Contract',
        'Alpha Contract',
      ]);

      expect(await repos.brands.list({ search: 'contract' })).toHaveLength(3);
      expect(await repos.brands.list({ search: 'nothing-matches' })).toHaveLength(0);
    });

    it('omits the category image key when no image exists', async () => {
      const category = await repos.categories.create({ name: 'Image Contract' });
      const detail = await repos.categories.findByIdentifier(category.id);
      expect(Object.keys(detail)).not.toContain('image');
    });

    /* ------------------------------------------------------------------ users */

    it('hashes and verifies passwords with the shared bcrypt cost', async () => {
      const passwordHash = await repos.users.hashPassword('Adm1n!Passw0rd');
      expect(passwordHash.startsWith('$2b$12$')).toBe(true);

      const user = await repos.users.create({
        name: 'Contract User',
        email: 'Contract.User@Test.Local',
        passwordHash,
      });

      expect(user.email).toBe('contract.user@test.local');
      expect(user).not.toHaveProperty('passwordHash');
      expect(await repos.users.existsByEmail('contract.user@test.local')).toBe(true);
      expect(await repos.users.verifyPassword('Adm1n!Passw0rd', passwordHash)).toBe(true);
      expect(await repos.users.verifyPassword('wrong-password', passwordHash)).toBe(false);

      const withHash = await repos.users.findByEmail('contract.user@test.local', {
        withHash: true,
      });
      expect(withHash.passwordHash).toBe(passwordHash);
    });

    it('locks after five failures and clears the lock on a successful login', async () => {
      const user = await repos.users.create({
        name: 'Lock Contract',
        email: 'lock.contract@test.local',
        passwordHash: await repos.users.hashPassword('Adm1n!Passw0rd'),
      });

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        expect(await repos.users.recordFailedLogin(user.id)).toMatchObject({
          attempts: attempt,
          lockedUntil: null,
        });
      }
      const locked = await repos.users.recordFailedLogin(user.id);
      expect(locked.attempts).toBe(0);
      expect(locked.lockedUntil).toBeInstanceOf(Date);
      expect((await repos.users.findById(user.id)).isLocked).toBe(true);

      const afterLogin = await repos.users.recordLogin(user.id);
      expect(afterLogin).toMatchObject({ loginAttempts: 0, lockUntil: null, isLocked: false });
      expect(afterLogin.lastLoginAt).toBeInstanceOf(Date);
    });

    it('rotates the password, bumping the token version and clearing the lock', async () => {
      const user = await repos.users.create({
        name: 'Rotate Contract',
        email: 'rotate.contract@test.local',
        passwordHash: await repos.users.hashPassword('Adm1n!Passw0rd'),
      });
      await repos.users.recordFailedLogin(user.id);

      const rotated = await repos.users.rotatePassword(user.id, {
        passwordHash: await repos.users.hashPassword('N3w!Passw0rd'),
      });
      expect(rotated.tokenVersion).toBe(1);
      expect(rotated.loginAttempts).toBe(0);
      expect(rotated.lockUntil).toBeNull();
      expect(await repos.users.verifyPassword('N3w!Passw0rd', rotated.passwordHash)).toBe(true);
    });

    it('returns the documented user record key order', async () => {
      const user = await repos.users.create({
        name: 'Shape Contract',
        email: 'shape.contract@test.local',
        passwordHash: await repos.users.hashPassword('Adm1n!Passw0rd'),
        role: 'admin',
        mustChangePassword: true,
      });

      expect(Object.keys(user)).toEqual([
        'id',
        'name',
        'email',
        'role',
        'isActive',
        'mustChangePassword',
        'lastLoginAt',
        'createdAt',
        'updatedAt',
        'tokenVersion',
        'loginAttempts',
        'lockUntil',
        'isLocked',
      ]);
    });
  });
}

export default { defineRepositoryContractSuite };
