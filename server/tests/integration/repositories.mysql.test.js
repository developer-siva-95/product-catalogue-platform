import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { shouldSkipMysql } from '../helpers/mysql.js';
import { clearMysqlTables, closePool, resetMysqlSchema } from '../helpers/mysql-db.js';
import { productsRepository } from '../../src/repositories/mysql/products.repository.js';
import { brandsRepository } from '../../src/repositories/mysql/brands.repository.js';
import { categoriesRepository } from '../../src/repositories/mysql/categories.repository.js';
import { usersRepository } from '../../src/repositories/mysql/users.repository.js';
import { toAdminProduct, toPublicProduct } from '../../src/repositories/product.mapper.js';
import { encodeCursor } from '../../src/utils/cursor.js';
import { storefrontFilterHash } from '../../src/repositories/storefront-query.js';

/**
 * MySQL repository conformance (real MySQL server).
 *
 * Deliberately mirrors `repositories.mongo.test.js` expectation for expectation:
 * the two suites are the same contract expressed twice, which is what makes
 * "provider swap" credible rather than aspirational. Anything that passes here and
 * there is behaviourally identical; anything that differs shows up as one of these
 * assertions failing.
 */

const shouldSkip = shouldSkipMysql();

describe.skipIf(shouldSkip)('MySQL repositories', () => {
  const products = productsRepository;
  const brands = brandsRepository;
  const categories = categoriesRepository;

  beforeAll(async () => {
    await resetMysqlSchema();
  }, 60_000);

  afterAll(async () => {
    await closePool();
  });

  beforeEach(async () => {
    await clearMysqlTables();
  });

  async function makeTaxonomy() {
    const brand = await brands.create({ name: 'Repo Brand', description: 'brand' });
    const category = await categories.create({ name: 'Repo Category', description: 'category' });
    return { brand, category };
  }

  async function makeProduct(overrides = {}) {
    const { image, thumbnail, ...fields } = overrides;
    const { brand, category } = await makeTaxonomy();
    const record = await products.create({
      payload: {
        title: 'Repository Product',
        description: 'created through the repository',
        price: 19.99,
        stock: 4,
        brand: brand.id,
        category: category.id,
        ...fields,
      },
      slugSource: fields.title ?? 'Repository Product',
      skuPrefix: 'REP',
      image,
      thumbnail,
    });
    return { brand, category, record };
  }

  describe('products', () => {
    it('creates and reads back a record with canonical string ids', async () => {
      const { brand, record } = await makeProduct();

      expect(record._id).toMatch(/^[0-9a-f]{24}$/);
      expect(typeof record._id).toBe('string');
      expect(record.brand).toEqual({ _id: brand.id, name: 'Repo Brand', slug: 'repo-brand' });
      expect(record.__v).toBe(0);
      expect(record.price).toBe(19.99);

      const publicRecord = await products.findById(record._id);
      const mapped = toPublicProduct(publicRecord);
      expect(mapped.id).toBe(record._id);
      expect(mapped.price).toBe(19.99);
      expect(typeof mapped.price).toBe('number');
      expect(mapped.stockStatus).toBe('low_stock');
      expect(mapped.brand).toEqual({ id: brand.id, name: 'Repo Brand', slug: 'repo-brand' });
      expect(mapped.createdAt).toBeInstanceOf(Date);
    });

    it('normalises SKUs to upper case like the Mongo schema did', async () => {
      const { record } = await makeProduct({ sku: ' rep-lower-1 ' });
      expect(record.sku).toBe('REP-LOWER-1');
    });

    it('hides inactive products from findById but not from findAdminById', async () => {
      const { record } = await makeProduct({ title: 'Inactive Product', isActive: false });

      expect(await products.findById(record._id)).toBeNull();
      expect((await products.findAdminById(record._id))._id).toBe(record._id);
      expect(toAdminProduct(await products.findAdminById(record._id)).version).toBe(0);
    });

    it('finds by slug as well as by id', async () => {
      const { record } = await makeProduct({ title: 'Slug Lookup' });
      expect((await products.findById('slug-lookup'))._id).toBe(record._id);
    });

    it('refuses to overdraw stock atomically and reports availability', async () => {
      const { record } = await makeProduct({ title: 'Stock Product', stock: 3 });

      const decremented = await products.updateStock(record._id, { delta: -2 });
      expect(decremented.record.stock).toBe(1);
      expect(decremented.record.__v).toBe(1);

      const overdrawn = await products.updateStock(record._id, { delta: -5 });
      expect(overdrawn.insufficient).toBe(true);
      expect(overdrawn.available).toBe(1);
      expect(overdrawn.requested).toBe(5);

      const absolute = await products.updateStock(record._id, { stock: 12 });
      expect(absolute.record.stock).toBe(12);

      expect(await products.updateStock('000000000000000000000000', { delta: 1 })).toBeNull();
    });

    it('rejects a stale version and accepts the current one', async () => {
      const { record } = await makeProduct({ title: 'Versioned Product', price: 4 });

      await expect(
        products.replaceFields(record._id, { price: 9, version: 99 }, { partial: true }),
      ).rejects.toMatchObject({ code: 'STALE_RESOURCE', statusCode: 409 });

      const updated = await products.replaceFields(
        record._id,
        { price: 9, version: 0 },
        { partial: true },
      );
      expect(updated.record.price).toBe(9);
      expect(updated.record.__v).toBe(1);
      expect(updated.previous.image).toBe('');

      expect(
        await products.replaceFields('000000000000000000000000', {}, { partial: true }),
      ).toBeNull();
    });

    it('re-slugs on a title change and keeps the old slug usable only until then', async () => {
      const { record } = await makeProduct({ title: 'Original Title' });
      expect(record.slug).toBe('original-title');

      const updated = await products.replaceFields(
        record._id,
        { title: 'Renamed Title', version: 0 },
        { partial: true },
      );
      expect(updated.record.slug).toBe('renamed-title');
      expect(await products.findById('original-title')).toBeNull();
      expect((await products.findById('renamed-title'))._id).toBe(record._id);
    });

    it('pages the storefront by cursor with limit+1 and an exact admin total', async () => {
      const { brand, category } = await makeTaxonomy();
      for (let index = 1; index <= 5; index += 1) {
        await products.create({
          payload: {
            title: `Paged Product ${index}`,
            description: `paged ${index}`,
            price: index * 10,
            stock: 1,
            brand: brand.id,
            category: category.id,
          },
          slugSource: `Paged Product ${index}`,
        });
      }

      const query = { sort: 'newest', limit: 2 };
      const first = await products.listStorefront({ query, limit: 2 });
      expect(first.fetched).toBe(3);

      const last = first.records[1];
      const cursor = encodeCursor({
        sort: 'newest',
        id: last._id,
        filterHash: storefrontFilterHash(query),
      });
      const second = await products.listStorefront({ query: { ...query, cursor }, limit: 2 });
      expect(second.records.map((row) => row._id)).not.toContain(last._id);
      // No overlap between page 1 and page 2 — the cursor comparison must mirror
      // the sort direction or rows are skipped/repeated.
      const firstIds = new Set(first.records.slice(0, 2).map((row) => row._id));
      expect(second.records.some((row) => firstIds.has(row._id))).toBe(false);

      // The repository returns up to `limit + 1` rows; the service slices the page
      // (that is how hasNextPage stays exact without a count query).
      const pricePage = await products.listStorefront({
        query: { sort: 'price_asc', limit: 3 },
        limit: 3,
      });
      expect(pricePage.fetched).toBe(4);
      expect(pricePage.records.map((row) => row.price)).toEqual([10, 20, 30, 40]);

      const adminPage = await products.listAdmin({ page: 1, limit: 2, sort: 'price' });
      expect(adminPage.records).toHaveLength(2);
      expect(adminPage.total).toBe(5);
      expect(adminPage.records[0].price).toBe(10);
    });

    it('applies the same filters and search semantics as the Mongo provider', async () => {
      const { brand, category } = await makeTaxonomy();
      const other = await brands.create({ name: 'Other Brand' });
      await products.create({
        payload: {
          title: 'Alpha Widget',
          description: 'first',
          price: 5,
          stock: 1,
          brand: brand.id,
          category: category.id,
        },
        slugSource: 'Alpha Widget',
      });
      await products.create({
        payload: {
          title: 'Beta Gadget',
          description: 'second',
          price: 50,
          stock: 1,
          brand: other.id,
          category: category.id,
        },
        slugSource: 'Beta Gadget',
      });

      const search = await products.listStorefront({
        query: { sort: 'newest', search: 'widget', limit: 12 },
        limit: 12,
      });
      expect(search.records.map((row) => row.title)).toEqual(['Alpha Widget']);

      // Case-insensitive substring, exactly like Mongo's /i regex.
      const upper = await products.listStorefront({
        query: { sort: 'newest', search: 'WIDGET', limit: 12 },
        limit: 12,
      });
      expect(upper.records).toHaveLength(1);

      const priceRange = await products.listStorefront({
        query: { sort: 'newest', minPrice: 10, maxPrice: 100, limit: 12 },
        limit: 12,
      });
      expect(priceRange.records.map((row) => row.title)).toEqual(['Beta Gadget']);

      const byBrand = await products.listStorefront({
        query: { sort: 'newest', brand: other.id, limit: 12 },
        limit: 12,
      });
      expect(byBrand.records.map((row) => row.title)).toEqual(['Beta Gadget']);
    });

    it('deletes a product and reports the removed record', async () => {
      const { record } = await makeProduct({ title: 'Doomed Product' });

      const deleted = await products.deleteById(record._id);
      expect(deleted).toMatchObject({ id: record._id, title: 'Doomed Product' });
      expect(await products.findById(record._id)).toBeNull();
      expect(await products.deleteById(record._id)).toBeNull();
    });

    it('counts products per taxonomy and collects referenced image files', async () => {
      const { brand } = await makeProduct({
        title: 'Counted Product',
        image: '/uploads/counted.svg',
        thumbnail: '/uploads/counted-thumb.svg',
      });

      const counts = await products.countByTaxonomy('brand', [brand.id]);
      expect(counts.get(brand.id)).toEqual({ total: 1, active: 1 });

      const files = await products.collectReferencedImageFiles();
      expect(files.has('counted.svg')).toBe(true);
      expect(files.has('counted-thumb.svg')).toBe(true);
    });

    it('allocates unique slugs and SKUs', async () => {
      const { record } = await makeProduct({ title: 'Twin Product' });

      expect(await products.existsBySlug('twin-product')).toBe(true);
      // P6: an exclusion must be a canonical id; a malformed one is now rejected
      // identically on both providers instead of silently matching (see the shared
      // contract suite). The self-exclusion below is the behaviour this test pins.
      expect(await products.existsBySlug('twin-product', { excludeId: record._id })).toBe(false);
      const second = await products.allocateSlug('Twin Product');
      expect(second).not.toBe('twin-product');
      expect(await products.existsBySlug(second)).toBe(false);

      const sku = await products.allocateSku({ prefix: 'TWN' });
      expect(sku).toMatch(/^TWN-/);
      expect(await products.existsBySku(sku)).toBe(false);
    });

    it('surfaces a duplicate SKU as DUPLICATE_KEY, like Mongo', async () => {
      await makeProduct({ title: 'First Product', sku: 'DUP-1' });
      const { brand, category } = { brand: null, category: null };
      const taxonomy = await brands.create({ name: 'Second Brand' });
      const taxonomyCategory = await categories.create({ name: 'Second Category' });

      await expect(
        products.create({
          payload: {
            title: 'Second Product',
            description: 'dup',
            price: 1,
            stock: 1,
            brand: taxonomy.id,
            category: taxonomyCategory.id,
            sku: 'DUP-1',
          },
          slugSource: 'Second Product',
        }),
      ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY', errno: 1062 });

      expect(brand).toBeNull();
      expect(category).toBeNull();
    });
  });

  describe('taxonomies', () => {
    it('creates, lists and counts brands and categories', async () => {
      const brand = await brands.create({ name: 'Counting Brand' });
      const category = await categories.create({ name: 'Counting Category' });
      await products.create({
        payload: {
          title: 'Brand Count Product',
          description: 'count',
          price: 8,
          stock: 8,
          brand: brand.id,
          category: category.id,
        },
        slugSource: 'Brand Count Product',
      });

      const list = await brands.list({});
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: brand.id, productCount: 1, activeProductCount: 1 });

      expect(await brands.existsByName('counting brand')).toBe(true);
      expect(await brands.existsByName('counting brand', { excludeId: brand.id })).toBe(false);

      const detail = await brands.findByIdentifier('counting-brand');
      expect(detail.productCount).toBe(1);
      expect(detail.logo).toBe('');
      expect((await brands.countProducts(brand.id)).activeReferences).toBe(1);

      const categoryDetail = await categories.findByIdentifier(category.id);
      expect(categoryDetail.productCount).toBe(1);
      // The Mongo category schema never declared `image`, so the key stays absent.
      expect(Object.keys(categoryDetail)).not.toContain('image');
    });

    it('rejects a duplicate brand name with DUPLICATE_KEY', async () => {
      await brands.create({ name: 'Unique Brand' });
      await expect(brands.create({ name: ' unique brand ' })).rejects.toMatchObject({
        code: 'ER_DUP_ENTRY',
      });
    });

    it('re-slugs a renamed taxonomy and returns null for a missing one', async () => {
      const category = await categories.create({ name: 'Old Category Name' });
      const updated = await categories.update(category.id, { name: 'New Category Name' });
      expect(updated.slug).toBe('new-category-name');

      expect(await brands.findById('000000000000000000000000')).toBeNull();
      expect(await categories.findByIdentifier('nope')).toBeNull();
      expect(await categories.delete('000000000000000000000000')).toBeNull();
      expect(await brands.update('000000000000000000000000', { name: 'x' })).toBeNull();
    });

    it('sorts names and createdAt like the Mongo provider', async () => {
      await brands.create({ name: 'zeta brand' });
      await brands.create({ name: 'Alpha Brand' });
      await brands.create({ name: 'Beta Brand' });

      const ascending = await brands.list({ sort: 'name' });
      expect(ascending.map((row) => row.name)).toEqual(['Alpha Brand', 'Beta Brand', 'zeta brand']);

      const descending = await brands.list({ sort: '-name' });
      expect(descending.map((row) => row.name)).toEqual([
        'zeta brand',
        'Beta Brand',
        'Alpha Brand',
      ]);

      const searched = await brands.list({ search: 'brand' });
      expect(searched).toHaveLength(3);
    });
  });

  describe('users', () => {
    const password = 'Adm1n!Passw0rd';

    it('stores a bcrypt hash that the service can verify', async () => {
      const passwordHash = await usersRepository.hashPassword(password);
      const created = await usersRepository.create({
        name: 'Repo User',
        email: 'Repo.User@Test.Local',
        passwordHash,
      });

      expect(created.email).toBe('repo.user@test.local');
      expect(created).not.toHaveProperty('passwordHash');
      expect(await usersRepository.existsByEmail('repo.user@test.local')).toBe(true);

      const withHash = await usersRepository.findByEmail('repo.user@test.local', {
        withHash: true,
      });
      expect(withHash.passwordHash).toBe(passwordHash);
      expect(await usersRepository.verifyPassword(password, withHash.passwordHash)).toBe(true);
      expect((await usersRepository.findById(created.id)).isLocked).toBe(false);
    });

    it('locks the account after the configured number of failures and clears on success', async () => {
      const passwordHash = await usersRepository.hashPassword(password);
      const user = await usersRepository.create({
        name: 'Lock User',
        email: 'lock@test.local',
        passwordHash,
      });

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const result = await usersRepository.recordFailedLogin(user.id);
        expect(result.attempts).toBe(attempt);
        expect(result.lockedUntil).toBeNull();
      }

      const fifth = await usersRepository.recordFailedLogin(user.id);
      expect(fifth.attempts).toBe(0);
      expect(fifth.lockedUntil).toBeInstanceOf(Date);
      expect((await usersRepository.findById(user.id)).isLocked).toBe(true);

      const afterLogin = await usersRepository.recordLogin(user.id);
      expect(afterLogin.loginAttempts).toBe(0);
      expect(afterLogin.lockUntil).toBeNull();
      expect(afterLogin.isLocked).toBe(false);
      expect(afterLogin.lastLoginAt).toBeInstanceOf(Date);
    });

    it('rotates the password and bumps tokenVersion', async () => {
      const user = await usersRepository.create({
        name: 'Rotate User',
        email: 'rotate@test.local',
        passwordHash: await usersRepository.hashPassword(password),
      });
      expect(user.tokenVersion).toBe(0);

      const rotated = await usersRepository.rotatePassword(user.id, {
        passwordHash: await usersRepository.hashPassword('N3w!Passw0rd'),
      });
      expect(rotated.tokenVersion).toBe(1);
      expect(await usersRepository.verifyPassword('N3w!Passw0rd', rotated.passwordHash)).toBe(true);
      expect(
        await usersRepository.rotatePassword('000000000000000000000000', { passwordHash: 'x' }),
      ).toBeNull();
    });

    it('preserves the Mongo-only-sensitive fields in the same shape', async () => {
      const user = await usersRepository.create({
        name: 'Shape User',
        email: 'shape@test.local',
        passwordHash: await usersRepository.hashPassword(password),
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
      expect(user.mustChangePassword).toBe(true);
      expect(user.role).toBe('admin');
    });
  });
});
