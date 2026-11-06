import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectTestDB, disconnectTestDB, clearDatabase, syncIndexes } from '../helpers/db.js';
import { getRepositories } from '../../src/repositories/index.js';
import { toPublicProduct } from '../../src/repositories/product.mapper.js';
import { usersRepository } from '../../src/repositories/mongo/users.repository.js';

/**
 * Repository-layer conformance (MongoDB implementation).
 *
 * These tests exercise the interface the MySQL implementation must match, not the
 * HTTP surface: canonical string ids, plain records (no driver objects), `null`
 * instead of `undefined`, atomic guarded stock updates and optimistic concurrency.
 * The dual-provider contract suite in P5 reuses the same expectations.
 */
describe('MongoDB repositories', () => {
  const repositories = getRepositories();
  const { products, brands, categories } = repositories;

  beforeAll(async () => {
    await connectTestDB();
    await syncIndexes();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  async function makeTaxonomy() {
    const brand = await brands.create({ name: 'Repo Brand', description: 'brand' });
    const category = await categories.create({ name: 'Repo Category', description: 'category' });
    return { brand, category };
  }

  describe('products', () => {
    it('creates and reads back a record with canonical string ids', async () => {
      const { brand, category } = await makeTaxonomy();
      const record = await products.create({
        payload: {
          title: 'Repository Product',
          description: 'created through the repository',
          price: 19.99,
          stock: 4,
          brand: brand.id,
          category: category.id,
        },
        slugSource: 'Repository Product',
        skuPrefix: 'REP',
      });

      expect(record._id).toMatch(/^[0-9a-f]{24}$/);
      expect(typeof record._id).toBe('string');
      expect(record.brand).toEqual({ _id: brand.id, name: 'Repo Brand', slug: 'repo-brand' });
      expect(record.__v).toBe(0);

      const publicRecord = await products.findById(record._id);
      expect(publicRecord._id).toBe(record._id);
      const mapped = toPublicProduct(publicRecord);
      expect(mapped.id).toBe(record._id);
      expect(mapped.price).toBe(19.99);
      expect(mapped.stockStatus).toBe('low_stock');
      expect(mapped.brand).toEqual({ id: brand.id, name: 'Repo Brand', slug: 'repo-brand' });
      expect(mapped.createdAt).toBeInstanceOf(Date);
    });

    it('hides inactive products from findById but not from findAdminById', async () => {
      const { brand, category } = await makeTaxonomy();
      const record = await products.create({
        payload: {
          title: 'Inactive Product',
          description: 'inactive',
          price: 1,
          stock: 1,
          brand: brand.id,
          category: category.id,
          isActive: false,
        },
        slugSource: 'Inactive Product',
      });

      expect(await products.findById(record._id)).toBeNull();
      expect((await products.findAdminById(record._id))._id).toBe(record._id);
    });

    it('finds by slug as well as by id', async () => {
      const { brand, category } = await makeTaxonomy();
      const record = await products.create({
        payload: {
          title: 'Slug Lookup',
          description: 'slug',
          price: 2,
          stock: 2,
          brand: brand.id,
          category: category.id,
        },
        slugSource: 'Slug Lookup',
      });

      expect((await products.findById('slug-lookup'))._id).toBe(record._id);
    });

    it('refuses to overdraw stock atomically and reports availability', async () => {
      const { brand, category } = await makeTaxonomy();
      const record = await products.create({
        payload: {
          title: 'Stock Product',
          description: 'stock',
          price: 3,
          stock: 3,
          brand: brand.id,
          category: category.id,
        },
        slugSource: 'Stock Product',
      });

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
      const { brand, category } = await makeTaxonomy();
      const record = await products.create({
        payload: {
          title: 'Versioned Product',
          description: 'occ',
          price: 4,
          stock: 4,
          brand: brand.id,
          category: category.id,
        },
        slugSource: 'Versioned Product',
      });

      await expect(
        products.replaceFields(record._id, { price: 9, version: 99 }, { partial: true }),
      ).rejects.toMatchObject({ code: 'STALE_RESOURCE' });

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

    it('paginates the storefront with limit+1 and an exact admin total', async () => {
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

      // The repository returns up to `limit + 1` rows; the service slices the page
      // and derives hasNextPage, so no count query is needed.
      const page = await products.listStorefront({ query: { sort: 'newest', limit: 2 }, limit: 2 });
      expect(page.fetched).toBe(3);
      expect(page.records).toHaveLength(3);

      const adminPage = await products.listAdmin({ page: 1, limit: 2, sort: 'price' });
      expect(adminPage.records).toHaveLength(2);
      expect(adminPage.total).toBe(5);
      expect(adminPage.records[0].price).toBe(10);
    });

    it('deletes a product and reports the removed record', async () => {
      const { brand, category } = await makeTaxonomy();
      const record = await products.create({
        payload: {
          title: 'Doomed Product',
          description: 'bye',
          price: 5,
          stock: 5,
          brand: brand.id,
          category: category.id,
        },
        slugSource: 'Doomed Product',
      });

      const deleted = await products.deleteById(record._id);
      expect(deleted).toMatchObject({ id: record._id, title: 'Doomed Product' });
      expect(await products.findById(record._id)).toBeNull();
      expect(await products.deleteById(record._id)).toBeNull();
    });

    it('counts products per taxonomy and collects referenced image files', async () => {
      const { brand, category } = await makeTaxonomy();
      await products.create({
        payload: {
          title: 'Counted Product',
          description: 'count',
          price: 6,
          stock: 6,
          brand: brand.id,
          category: category.id,
        },
        slugSource: 'Counted Product',
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
      const { brand, category } = await makeTaxonomy();
      await products.create({
        payload: {
          title: 'Twin Product',
          description: 'twin',
          price: 7,
          stock: 7,
          brand: brand.id,
          category: category.id,
        },
        slugSource: 'Twin Product',
      });

      expect(await products.existsBySlug('twin-product')).toBe(true);
      const second = await products.allocateSlug('Twin Product');
      expect(second).not.toBe('twin-product');
      expect(await products.existsBySlug(second)).toBe(false);

      const sku = await products.allocateSku({ prefix: 'TWN' });
      expect(sku).toMatch(/^TWN-/);
    });
  });

  describe('taxonomies', () => {
    it('creates, lists and counts brands', async () => {
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
      expect((await brands.countProducts(brand.id)).activeReferences).toBe(1);
    });

    it('returns null (not undefined) for a missing taxonomy', async () => {
      expect(await brands.findById('000000000000000000000000')).toBeNull();
      expect(await categories.findByIdentifier('nope')).toBeNull();
      expect(await categories.delete('000000000000000000000000')).toBeNull();
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
      expect(fifth.attempts).toBe(0); // counter resets when the lock engages
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
  });
});
