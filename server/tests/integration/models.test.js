import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Brand } from '../../src/modules/brands/model.js';
import { Category } from '../../src/modules/categories/model.js';
import { Product } from '../../src/modules/products/model.js';
import { User } from '../../src/modules/auth/model.js';
import { connectTestDB, disconnectTestDB, clearDatabase, syncIndexes } from '../helpers/db.js';

describe('data models: uniqueness, indexes, stock badges, OCC', () => {
  let brandId;
  let categoryId;

  beforeAll(async () => {
    await connectTestDB();
    await syncIndexes();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearDatabase();
    const brand = await Brand.create({ name: 'Acme', slug: 'acme' });
    const category = await Category.create({ name: 'Audio', slug: 'audio' });
    brandId = brand._id;
    categoryId = category._id;
  });

  describe('brands & categories', () => {
    it('normalises the name and auto-populates nameNormalized', async () => {
      const brand = await Brand.create({ name: '  NovaTech  ', slug: 'novatech' });
      expect(brand.name).toBe('NovaTech');
      expect(brand.nameNormalized).toBe('novatech');
    });

    it('enforces case-insensitive uniqueness at the database level', async () => {
      await expect(Brand.create({ name: 'ACME', slug: 'acme-2' })).rejects.toMatchObject({
        code: 11000,
      });
      await expect(Category.create({ name: 'AUDIO', slug: 'audio-2' })).rejects.toMatchObject({
        code: 11000,
      });
    });

    it('enforces case-insensitive uniqueness on categories too', async () => {
      await Category.create({ name: 'Wearables', slug: 'wearables' });
      await expect(
        Category.create({ name: 'wearables', slug: 'wearables-2' }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('enforces unique slugs independently of the name', async () => {
      await expect(Brand.create({ name: 'Different', slug: 'acme' })).rejects.toMatchObject({
        code: 11000,
      });
    });

    it('rejects names outside the allowed length', async () => {
      await expect(Brand.create({ name: 'A', slug: 'a' })).rejects.toThrow(/at least 2 characters/);
      await expect(Brand.create({ name: 'x'.repeat(61), slug: 'too-long' })).rejects.toThrow(
        /at most 60 characters/,
      );
    });
  });

  describe('products', () => {
    const baseProduct = {
      title: 'Studio Headphones',
      slug: 'studio-headphones',
      sku: 'AUD-ABC2345',
      price: 199.999,
      stock: 10,
      description: 'Comfortable over-ear headphones.',
    };

    it('rounds price to two decimals and keeps timestamps', async () => {
      const product = await Product.create({
        ...baseProduct,
        brand: brandId,
        category: categoryId,
      });
      expect(product.price).toBe(200);
      expect(product.createdAt).toBeInstanceOf(Date);
      expect(product.updatedAt).toBeInstanceOf(Date);
      expect(product.isActive).toBe(true);
    });

    it('rejects negative price and negative stock', async () => {
      await expect(
        Product.create({ ...baseProduct, price: -1, brand: brandId, category: categoryId }),
      ).rejects.toThrow(/cannot be negative/);
      await expect(
        Product.create({ ...baseProduct, stock: -5, brand: brandId, category: categoryId }),
      ).rejects.toThrow(/cannot be negative/);
    });

    it('requires a whole-number stock value', async () => {
      await expect(
        Product.create({ ...baseProduct, stock: 1.5, brand: brandId, category: categoryId }),
      ).rejects.toThrow(/whole number/);
    });

    it('enforces unique slug and unique SKU', async () => {
      await Product.create({ ...baseProduct, brand: brandId, category: categoryId });
      await expect(
        Product.create({
          ...baseProduct,
          sku: 'AUD-ZZZ2345',
          brand: brandId,
          category: categoryId,
        }),
      ).rejects.toMatchObject({ code: 11000 });
      await expect(
        Product.create({
          ...baseProduct,
          slug: 'other-slug',
          brand: brandId,
          category: categoryId,
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('allows a missing SKU because the SKU index is sparse', async () => {
      const withoutSku = { ...baseProduct, slug: 'no-sku', sku: undefined };
      const first = await Product.create({ ...withoutSku, brand: brandId, category: categoryId });
      const second = await Product.create({
        ...withoutSku,
        slug: 'no-sku-2',
        brand: brandId,
        category: categoryId,
      });
      expect(first.sku).toBeUndefined();
      expect(second.sku).toBeUndefined();
    });

    it('exposes stock badges: out_of_stock / low_stock / in_stock', async () => {
      const outOfStock = await Product.create({
        ...baseProduct,
        slug: 'oos',
        sku: 'AUD-OOS2345',
        stock: 0,
        brand: brandId,
        category: categoryId,
      });
      const lowStock = await Product.create({
        ...baseProduct,
        slug: 'low',
        sku: 'AUD-LOW2345',
        stock: 3,
        brand: brandId,
        category: categoryId,
      });
      const healthy = await Product.create({
        ...baseProduct,
        slug: 'ok',
        sku: 'AUD-OKK2345',
        stock: 40,
        brand: brandId,
        category: categoryId,
      });

      expect(outOfStock.stockStatus).toBe('out_of_stock');
      expect(outOfStock.inStock).toBe(false);
      expect(lowStock.stockStatus).toBe('low_stock');
      expect(healthy.stockStatus).toBe('in_stock');
      expect(healthy.toJSON().stockStatus).toBe('in_stock');
    });

    it('raises VersionError when two admins save the same version (OCC)', async () => {
      const product = await Product.create({
        ...baseProduct,
        brand: brandId,
        category: categoryId,
      });

      const firstEditor = await Product.findById(product._id);
      const secondEditor = await Product.findById(product._id);

      firstEditor.title = 'Studio Headphones (first editor)';
      await firstEditor.save();

      secondEditor.title = 'Studio Headphones (second editor)';
      await expect(secondEditor.save()).rejects.toMatchObject({ name: 'VersionError' });

      const reloaded = await Product.findById(product._id);
      expect(reloaded.title).toBe('Studio Headphones (first editor)');
      expect(reloaded.__v).toBe(product.__v + 1);
    });

    it('declares the compound and text indexes required by the query plans', () => {
      const names = Product.schema.indexes().map(([, options]) => options?.name);
      expect(names).toContain('product_brand_category_price');
      expect(names).toContain('product_active_newest');
      expect(names).toContain('product_active_price_asc');
      expect(names).toContain('product_active_price_desc');
      expect(names).toContain('product_text_search');
      expect(names).toContain('product_sku_unique_sparse');

      const compound = Product.schema
        .indexes()
        .find(([, options]) => options?.name === 'product_brand_category_price');
      expect(compound[0]).toEqual({ brand: 1, category: 1, price: 1 });
    });

    it('serialises docs with id and __v, without leaking internal fields', async () => {
      const product = await Product.create({
        ...baseProduct,
        brand: brandId,
        category: categoryId,
      });
      const json = product.toJSON();
      expect(json.id).toBe(product._id.toString());
      expect(json._id).toBeUndefined();
      expect(json.__v).toBe(0);
      expect(json).not.toHaveProperty('__v', undefined);
    });
  });

  describe('users', () => {
    it('never selects passwordHash by default', async () => {
      const user = await User.create({
        name: 'Admin User',
        email: 'ADMIN@Example.com',
        passwordHash: await User.hashPassword('Str0ng!Passw0rd'),
        role: 'admin',
      });
      expect(user.email).toBe('admin@example.com');

      const found = await User.findById(user._id);
      expect(found.passwordHash).toBeUndefined();
      expect(found.toSafeJSON()).not.toHaveProperty('passwordHash');
    });

    it('enforces unique, lowercased emails', async () => {
      await User.create({
        name: 'One',
        email: 'one@example.com',
        passwordHash: await User.hashPassword('Str0ng!Passw0rd'),
      });
      await expect(
        User.create({
          name: 'Two',
          email: 'ONE@example.com',
          passwordHash: await User.hashPassword('Str0ng!Passw0rd'),
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('locks an account after repeated failed logins', async () => {
      const user = await User.create({
        name: 'Locked User',
        email: 'lock@example.com',
        passwordHash: await User.hashPassword('Str0ng!Passw0rd'),
      });
      const loaded = await User.findById(user._id).select('+passwordHash');

      for (let attempt = 1; attempt <= User.MAX_LOGIN_ATTEMPTS; attempt += 1) {
        await loaded.registerFailedLogin();
      }

      const locked = await User.findById(user._id);
      expect(locked.isLocked).toBe(true);
      expect(locked.lockUntil.getTime()).toBeGreaterThan(Date.now());
      expect(locked.loginAttempts).toBe(0);

      await locked.resetLoginState();
      const unlocked = await User.findById(user._id);
      expect(unlocked.isLocked).toBe(false);
      expect(unlocked.loginAttempts).toBe(0);
    });

    it('verifies passwords with bcrypt', async () => {
      const user = await User.create({
        name: 'Bcrypt User',
        email: 'bcrypt@example.com',
        passwordHash: await User.hashPassword('Str0ng!Passw0rd'),
      });
      const loaded = await User.findById(user._id).select('+passwordHash');
      await expect(loaded.comparePassword('Str0ng!Passw0rd')).resolves.toBe(true);
      await expect(loaded.comparePassword('wrong')).resolves.toBe(false);
    });
  });
});
