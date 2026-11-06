import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { runSeed, assertSeedableEnvironment } from '../../src/config/seed.js';
import { User } from '../../src/modules/auth/model.js';
import { Brand } from '../../src/modules/brands/model.js';
import { Category } from '../../src/modules/categories/model.js';
import { Product } from '../../src/modules/products/model.js';
import { DEFAULT_ADMIN, ROLES } from '../../src/constants/appConstants.js';
import { connectTestDB, disconnectTestDB, clearDatabase } from '../helpers/db.js';

describe('database seed (idempotency & admin safety)', () => {
  let summary;

  beforeAll(async () => {
    await connectTestDB();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  it('seeds admin, taxonomies and products on a fresh database', async () => {
    summary = await runSeed();

    expect(summary.admin).toEqual({ created: true, email: DEFAULT_ADMIN.email });

    const admin = await User.findOne({ email: DEFAULT_ADMIN.email }).select('+passwordHash');
    expect(admin).not.toBeNull();
    expect(admin.role).toBe(ROLES.ADMIN);
    expect(admin.mustChangePassword).toBe(true);
    expect(admin.passwordHash).not.toBe(DEFAULT_ADMIN.password);
    await expect(admin.comparePassword(DEFAULT_ADMIN.password)).resolves.toBe(true);

    expect(await Category.countDocuments()).toBe(summary.categories);
    expect(await Brand.countDocuments()).toBe(summary.brands);
    expect(await Product.countDocuments()).toBe(summary.products.created);
    expect(summary.products.created).toBeGreaterThan(10);

    const product = await Product.findOne({ stock: 0 });
    expect(product.stockStatus).toBe('out_of_stock');
    expect(product.image).toMatch(/^\/uploads\/products\//);
    expect(product.thumbnail).toMatch(/-thumb\.(webp|jpg)$/);
  }, 120_000);

  it('is idempotent: re-running creates nothing and duplicates nothing', async () => {
    const first = await runSeed();
    const countsBefore = {
      users: await User.countDocuments(),
      categories: await Category.countDocuments(),
      brands: await Brand.countDocuments(),
      products: await Product.countDocuments(),
    };

    const dbSized = first.products.created;
    const second = await runSeed();

    expect(second.admin.created).toBe(false);
    expect(second.products.created).toBe(0);
    expect(second.products.skipped).toBe(dbSized);
    expect(await User.countDocuments()).toBe(countsBefore.users);
    expect(await Category.countDocuments()).toBe(countsBefore.categories);
    expect(await Brand.countDocuments()).toBe(countsBefore.brands);
    expect(await Product.countDocuments()).toBe(countsBefore.products);
  }, 120_000);

  it('never overwrites an existing admin password or its flags', async () => {
    await runSeed();

    const admin = await User.findOne({ email: DEFAULT_ADMIN.email }).select('+passwordHash');
    const originalHash = admin.passwordHash;
    admin.passwordHash = await User.hashPassword('Rotated!Passw0rd9');
    admin.mustChangePassword = false;
    await admin.save();

    const rotatedHash = (await User.findOne({ email: DEFAULT_ADMIN.email }).select('+passwordHash'))
      .passwordHash;
    expect(rotatedHash).not.toBe(originalHash);

    const second = await runSeed();
    expect(second.admin.created).toBe(false);

    const after = await User.findOne({ email: DEFAULT_ADMIN.email }).select('+passwordHash');
    expect(after.passwordHash).toBe(rotatedHash);
    expect(after.mustChangePassword).toBe(false);
    await expect(after.comparePassword(DEFAULT_ADMIN.password)).resolves.toBe(false);
  }, 120_000);

  it('refuses to seed a production database', () => {
    expect(() => assertSeedableEnvironment('production')).toThrow(
      /Refusing to seed a "production"/,
    );
    expect(() => assertSeedableEnvironment('production')).toThrow(/local\/test environments only/);
    expect(() => assertSeedableEnvironment('development')).not.toThrow();
    expect(() => assertSeedableEnvironment('test')).not.toThrow();
  });
});
