import mongoose from 'mongoose';
import { Brand } from '../../src/modules/brands/model.js';
import { Category } from '../../src/modules/categories/model.js';
import { Product } from '../../src/modules/products/model.js';
import { User } from '../../src/modules/auth/model.js';

/**
 * A deliberately *dirty* MongoDB catalogue.
 *
 * Seeded data is the easy case: every document was written by Mongoose, so it
 * already satisfies every constraint the MySQL schema imposes. A real migration
 * meets documents written by older code, by hand, or by a script that bypassed
 * validation — so every document here is inserted through the **raw collection
 * driver**, exactly the way a legacy database acquired its junk.
 *
 * What it contains, and why:
 *  - **orphaned references** — products pointing at a brand/category that does
 *    not exist (the FK MySQL will refuse);
 *  - **missing required fields** — a product with no description, a user with no
 *    password hash;
 *  - **duplicate-looking values** — two brands whose names differ only by
 *    trailing whitespace (both normalise to the same `name_normalized`, which is
 *    UNIQUE in MySQL), and two users whose emails differ only in case;
 *  - **prices with many decimals** — `19.999`, `0.005`, `1234567.891`, plus an
 *    out-of-range `1e10` for DECIMAL(12,2);
 *  - **timestamps near the boundaries** — the epoch, `2038-01-19T03:14:07Z`
 *    (32-bit rollover), a leap day, MySQL's maximum `9999-12-31T23:59:59.999Z`,
 *    and one year-10000 date that DATETIME cannot store;
 *  - **over-long strings** — an SKU longer than VARCHAR(64);
 *  - **null vs missing** — a category with `image: null`, one with the key
 *    absent, and a product with `sku: null` (sparse unique) next to one with
 *    `sku: ''`.
 *
 * Every id is a fixed ObjectId so assertions can name the offending row.
 */

const ids = {
  brandClean: '660000000000000000000001',
  brandDuplicateA: '660000000000000000000002',
  brandDuplicateB: '660000000000000000000003',
  brandOrphanTarget: '6600000000000000000000ff', // deliberately never inserted

  categoryClean: '661000000000000000000001',
  categoryNullImage: '661000000000000000000002',
  categoryMissingImage: '661000000000000000000003',
  categoryOrphanTarget: '6610000000000000000000ff',

  productClean: '65a100000000000000000001',
  productOrphanBrand: '65a100000000000000000002',
  productOrphanCategory: '65a100000000000000000003',
  productMissingDescription: '65a100000000000000000004',
  productPrecision: '65a100000000000000000005',
  productPrecisionSmall: '65a100000000000000000006',
  productOutOfRangePrice: '65a100000000000000000007',
  productLongSku: '65a100000000000000000008',
  productNullSku: '65a100000000000000000009',
  productEmptySku: '65a10000000000000000000a',
  productEpoch: '65a10000000000000000000b',
  productY2038: '65a10000000000000000000c',
  productLeapDay: '65a10000000000000000000d',
  productMaxDate: '65a10000000000000000000e',
  productYearTenThousand: '65a10000000000000000000f',

  userClean: '652100000000000000000001',
  userDuplicateEmailA: '652100000000000000000002',
  userDuplicateEmailB: '652100000000000000000003',
  userNoPasswordHash: '652100000000000000000004',
};

const objectId = (hex) => new mongoose.Types.ObjectId(hex);

/** Rows that a correct migration must refuse without an explicit quarantine. */
export const EXPECTED_FATAL = [
  ['products', ids.productOrphanBrand, 'ORPHAN_REFERENCE'],
  ['products', ids.productOrphanCategory, 'ORPHAN_REFERENCE'],
  ['products', ids.productMissingDescription, 'MISSING_REQUIRED'],
  ['products', ids.productPrecision, 'DECIMAL_PRECISION'],
  ['products', ids.productPrecisionSmall, 'DECIMAL_PRECISION'],
  ['products', ids.productOutOfRangePrice, 'DECIMAL_PRECISION'],
  ['products', ids.productLongSku, 'STRING_TOO_LONG'],
  ['products', ids.productYearTenThousand, 'DATE_OUT_OF_RANGE'],
  ['users', ids.userDuplicateEmailB, 'UNIQUE_COLLISION'],
  ['users', ids.userNoPasswordHash, 'MISSING_REQUIRED'],
  ['brands', ids.brandDuplicateB, 'UNIQUE_COLLISION'],
];

/** Rows that are merely odd, and must migrate unchanged. */
export const EXPECTED_CLEAN = [
  ['brands', ids.brandClean],
  ['brands', ids.brandDuplicateA],
  ['categories', ids.categoryClean],
  ['categories', ids.categoryNullImage],
  ['categories', ids.categoryMissingImage],
  ['products', ids.productClean],
  ['products', ids.productNullSku],
  ['products', ids.productEmptySku],
  ['products', ids.productEpoch],
  ['products', ids.productY2038],
  ['products', ids.productLeapDay],
  ['products', ids.productMaxDate],
  ['users', ids.userClean],
  ['users', ids.userDuplicateEmailA],
];

export { ids as messyIds };

/**
 * Inserts the dirty catalogue with the raw driver (no schema validation, no
 * defaults, no casting) and returns the documents it wrote.
 */
export async function insertMessyCatalogue() {
  const now = new Date('2026-01-01T00:00:00.000Z');

  await Brand.collection.insertMany([
    {
      _id: objectId(ids.brandClean),
      name: 'Clean Brand',
      nameNormalized: 'clean brand',
      slug: 'clean-brand',
      description: 'a brand that is perfectly fine',
      logo: '',
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: objectId(ids.brandDuplicateA),
      name: 'Aurora',
      nameNormalized: 'aurora',
      slug: 'aurora',
      description: 'first of a duplicate pair',
      logo: '',
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: objectId(ids.brandDuplicateB),
      // Same name, different *raw* nameNormalized (trailing space). MySQL trims
      // and lower-cases into one UNIQUE key, so this pair cannot both migrate.
      name: 'Aurora',
      nameNormalized: 'aurora ',
      slug: 'aurora-duplicate',
      description: 'second of a duplicate pair',
      logo: '',
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await Category.collection.insertMany([
    {
      _id: objectId(ids.categoryClean),
      name: 'Clean Category',
      nameNormalized: 'clean category',
      slug: 'clean-category',
      description: 'a category that is perfectly fine',
      image: 'https://cdn.example.test/categories/clean.png',
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: objectId(ids.categoryNullImage),
      name: 'Null Image Category',
      nameNormalized: 'null image category',
      slug: 'null-image-category',
      description: 'image is explicitly null',
      image: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: objectId(ids.categoryMissingImage),
      name: 'Missing Image Category',
      nameNormalized: 'missing image category',
      slug: 'missing-image-category',
      description: 'the image key is absent entirely',
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const baseProduct = {
    sku: 'MESSY-001',
    price: 19.99,
    stock: 3,
    description: 'a product that is perfectly fine',
    image: '',
    thumbnail: '',
    brand: objectId(ids.brandClean),
    category: objectId(ids.categoryClean),
    isActive: true,
    __v: 0,
    createdAt: now,
    updatedAt: now,
  };

  await Product.collection.insertMany([
    {
      ...baseProduct,
      _id: objectId(ids.productClean),
      title: 'Clean Product',
      slug: 'clean-product',
    },

    {
      ...baseProduct,
      _id: objectId(ids.productOrphanBrand),
      title: 'Orphan Brand Product',
      slug: 'orphan-brand-product',
      sku: 'MESSY-002',
      brand: objectId(ids.brandOrphanTarget),
    },
    {
      ...baseProduct,
      _id: objectId(ids.productOrphanCategory),
      title: 'Orphan Category Product',
      slug: 'orphan-category-product',
      sku: 'MESSY-003',
      category: objectId(ids.categoryOrphanTarget),
    },
    {
      ...baseProduct,
      _id: objectId(ids.productMissingDescription),
      title: 'Missing Description Product',
      slug: 'missing-description-product',
      sku: 'MESSY-004',
      description: undefined,
    },
    {
      ...baseProduct,
      _id: objectId(ids.productPrecision),
      title: 'Precision Product',
      slug: 'precision-product',
      sku: 'MESSY-005',
      price: 19.999,
    },
    {
      ...baseProduct,
      _id: objectId(ids.productPrecisionSmall),
      title: 'Small Precision Product',
      slug: 'small-precision-product',
      sku: 'MESSY-006',
      price: 0.005,
    },
    {
      ...baseProduct,
      _id: objectId(ids.productOutOfRangePrice),
      title: 'Out Of Range Price Product',
      slug: 'out-of-range-price-product',
      sku: 'MESSY-007',
      price: 10_000_000_000,
    },
    {
      ...baseProduct,
      _id: objectId(ids.productLongSku),
      title: 'Long Sku Product',
      slug: 'long-sku-product',
      sku: 'X'.repeat(80),
    },
    {
      ...baseProduct,
      _id: objectId(ids.productNullSku),
      title: 'Null Sku Product',
      slug: 'null-sku-product',
      sku: null,
    },
    {
      ...baseProduct,
      _id: objectId(ids.productEmptySku),
      title: 'Empty Sku Product',
      slug: 'empty-sku-product',
      sku: '',
    },
    {
      ...baseProduct,
      _id: objectId(ids.productEpoch),
      title: 'Epoch Product',
      slug: 'epoch-product',
      sku: 'MESSY-010',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    {
      ...baseProduct,
      _id: objectId(ids.productY2038),
      title: 'Y2038 Product',
      slug: 'y2038-product',
      sku: 'MESSY-011',
      createdAt: new Date('2038-01-19T03:14:07.000Z'),
      updatedAt: new Date('2038-01-19T03:14:07.000Z'),
    },
    {
      ...baseProduct,
      _id: objectId(ids.productLeapDay),
      title: 'Leap Day Product',
      slug: 'leap-day-product',
      sku: 'MESSY-012',
      createdAt: new Date('2024-02-29T12:00:00.000Z'),
      updatedAt: new Date('2024-02-29T12:00:00.000Z'),
    },
    {
      ...baseProduct,
      _id: objectId(ids.productMaxDate),
      title: 'Max Date Product',
      slug: 'max-date-product',
      sku: 'MESSY-013',
      createdAt: new Date('9999-12-31T23:59:59.999Z'),
      updatedAt: new Date('9999-12-31T23:59:59.999Z'),
    },
    {
      ...baseProduct,
      _id: objectId(ids.productYearTenThousand),
      title: 'Year Ten Thousand Product',
      slug: 'year-ten-thousand-product',
      sku: 'MESSY-014',
      // MySQL DATETIME stops at 9999-12-31; this cannot be stored faithfully.
      createdAt: new Date('+010000-01-01T00:00:00.000Z'),
      updatedAt: new Date('+010000-01-01T00:00:00.000Z'),
    },
  ]);

  await User.collection.insertMany([
    {
      _id: objectId(ids.userClean),
      name: 'Clean User',
      email: 'clean.user@example.test',
      passwordHash: '$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      role: 'admin',
      isActive: true,
      mustChangePassword: false,
      passwordChangedAt: null,
      tokenVersion: 2,
      loginAttempts: 1,
      lockUntil: new Date('2026-01-01T00:15:00.000Z'),
      lastLoginAt: new Date('2026-01-01T00:00:00.000Z'),
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: objectId(ids.userDuplicateEmailA),
      name: 'Duplicate Email A',
      email: 'duplicate@example.test',
      passwordHash: '$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012346',
      role: 'customer',
      isActive: true,
      mustChangePassword: false,
      tokenVersion: 0,
      loginAttempts: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: objectId(ids.userDuplicateEmailB),
      // Differs from the row above only by case; MySQL compares binary after the
      // mapping lower-cases both to the same value.
      name: 'Duplicate Email B',
      email: 'Duplicate@Example.Test',
      passwordHash: '$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012347',
      role: 'customer',
      isActive: true,
      mustChangePassword: false,
      tokenVersion: 0,
      loginAttempts: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: objectId(ids.userNoPasswordHash),
      name: 'No Password User',
      email: 'no.password@example.test',
      role: 'customer',
      isActive: true,
      mustChangePassword: false,
      tokenVersion: 0,
      loginAttempts: 0,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  return { ids, objectId };
}
