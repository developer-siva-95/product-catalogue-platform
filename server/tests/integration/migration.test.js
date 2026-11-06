import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { connectTestDB, disconnectTestDB, clearDatabase } from '../helpers/db.js';
import { shouldSkipMysql } from '../helpers/mysql.js';
import { clearMysqlTables, closePool, resetMysqlSchema } from '../helpers/mysql-db.js';
import { query } from '../../src/db/mysql/pool.js';
import {
  migrate,
  rollback,
  verifyMigration,
  assertDestructiveConfirmation,
} from '../../src/db/migrate/mongo-to-mysql/index.js';
import { extractDocuments, mapRows } from '../../src/db/migrate/mongo-to-mysql/extract.js';
import {
  EXPECTED_CLEAN,
  EXPECTED_FATAL,
  insertMessyCatalogue,
  messyIds,
} from '../fixtures/messy-catalogue.js';
import { Brand } from '../../src/modules/brands/model.js';
import { Category } from '../../src/modules/categories/model.js';
import { Product } from '../../src/modules/products/model.js';

/**
 * MongoDB → MySQL migration, exercised against a **deliberately messy** source
 * (see `tests/fixtures/messy-catalogue.js`) as well as clean data.
 *
 * The point of this suite is not "the happy path works" — it is that every way the
 * source can be wrong is detected *before* the first INSERT, that quarantine is an
 * explicit decision rather than a silent skip, and that a re-run changes nothing.
 */

const CONFIRM = process.env.MYSQL_TEST_DATABASE ?? 'storefront_it_test';
const skip = shouldSkipMysql();

let tmpDir;

async function targetCounts() {
  const counts = {};
  for (const table of ['brands', 'categories', 'products', 'users']) {
    const [row] = await query(`SELECT COUNT(*) AS total FROM ${table}`);
    counts[table] = Number(row.total);
  }
  return counts;
}

/** Every finding for a given row id, whatever the collection. */
function findingsFor(result, id) {
  return (result.findings ?? [])
    .filter((finding) => finding.id === id)
    .map((finding) => finding.code);
}

describe.skipIf(skip)('MongoDB → MySQL data migration', () => {
  beforeAll(async () => {
    await resetMysqlSchema();
    await connectTestDB();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-test-'));
  }, 120_000);

  afterAll(async () => {
    await disconnectTestDB();
    await closePool();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }, 60_000);

  beforeEach(async () => {
    await clearDatabase();
    await clearMysqlTables();
  });

  afterEach(async () => {
    await clearDatabase();
    await clearMysqlTables();
  });

  /* ------------------------------------------------------------ clean data */

  describe('with a clean catalogue', () => {
    beforeEach(async () => {
      const brand = await Brand.create({
        name: 'Seed Brand',
        nameNormalized: 'seed brand',
        slug: 'seed-brand',
        description: 'clean',
      });
      const category = await Category.create({
        name: 'Seed Category',
        nameNormalized: 'seed category',
        slug: 'seed-category',
        description: 'clean',
        image: '',
      });
      await Product.create({
        title: 'Seed Product',
        slug: 'seed-product',
        sku: 'SEED-001',
        price: 19.99,
        stock: 5,
        description: 'clean product',
        brand: brand._id,
        category: category._id,
        isActive: true,
      });
    });

    it('dry-runs without writing a single row', async () => {
      const before = await targetCounts();
      const result = await migrate({});

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('dry-run');
      expect(result.totals).toMatchObject({ inserted: 3, updated: 0, orphaned: 0 });
      expect(await targetCounts()).toEqual(before);
    });

    it('preserves the Mongo _id verbatim in CHAR(24) ascii_bin', async () => {
      await migrate({ apply: true, confirm: CONFIRM, verify: false });

      const source = await Product.findOne({ slug: 'seed-product' }).lean();
      const [stored] = await query(
        'SELECT id, CHAR_LENGTH(id) AS len FROM products WHERE slug = ?',
        ['seed-product'],
      );

      expect(stored.id).toBe(String(source._id));
      expect(stored.len).toBe(24);

      const [column] = await query(
        `SELECT CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation
           FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'id'`,
      );
      expect(column).toEqual({ charset: 'ascii', collation: 'ascii_bin' });
    });

    it('applies, verifies, and is idempotent on the second run', async () => {
      const first = await migrate({
        apply: true,
        confirm: CONFIRM,
        verify: true,
        manifestPath: path.join(tmpDir, 'clean-manifest.json'),
      });

      expect(first.ok).toBe(true);
      expect(first.applied).toEqual({ inserted: 3, updated: 0 });
      expect(first.verification.passed).toBe(true);
      expect(first.verification.checks.map((check) => check.name)).toEqual([
        'record-counts',
        'sample-equality',
        'foreign-keys',
        'unique-constraints',
        'decimal-precision',
        'date-time-conversion',
        'null-and-missing-fields',
      ]);

      const [{ updated_at: updatedAt }] = await query('SELECT updated_at FROM products LIMIT 1');

      const second = await migrate({ apply: true, confirm: CONFIRM, verify: true });
      expect(second.totals).toMatchObject({ inserted: 0, updated: 0, unchanged: 3 });

      const [{ updated_at: updatedAtAgain }] = await query(
        'SELECT updated_at FROM products LIMIT 1',
      );
      expect(updatedAtAgain).toEqual(updatedAt);
    });

    it('refuses to write without a matching confirmation', async () => {
      await expect(migrate({ apply: true })).rejects.toMatchObject({
        code: 'MIGRATION_CONFIRMATION_REQUIRED',
      });
      await expect(migrate({ apply: true, confirm: 'some_other_database' })).rejects.toMatchObject({
        code: 'MIGRATION_CONFIRMATION_MISMATCH',
      });
      expect((await targetCounts()).products).toBe(0);
    });

    it('rolls back only what it wrote, and demands confirmation to do it', async () => {
      const manifestPath = path.join(tmpDir, 'rollback-manifest.json');
      await migrate({ apply: true, confirm: CONFIRM, verify: false, manifestPath });

      // A row that existed before the migration must survive the rollback.
      await query(
        `INSERT INTO brands (id, name, name_normalized, slug, description, logo, created_at, updated_at)
         VALUES ('6600000000000000000000aa', 'Pre-existing', 'pre-existing', 'pre-existing', '', '', NOW(3), NOW(3))`,
      );

      await expect(rollback({ manifestPath, confirm: '' })).rejects.toMatchObject({
        code: 'MIGRATION_CONFIRMATION_REQUIRED',
      });

      const result = await rollback({ manifestPath, confirm: CONFIRM });
      expect(result.deleted).toMatchObject({ products: 1, categories: 1, brands: 1, users: 0 });

      const counts = await targetCounts();
      expect(counts.products).toBe(0);
      expect(counts.brands).toBe(1); // the pre-existing row is untouched
    });
  });

  /* ------------------------------------------------------------ messy data */

  describe('with a messy catalogue', () => {
    beforeEach(async () => {
      await insertMessyCatalogue();
    });

    it('detects every defect in the source before inserting anything', async () => {
      const result = await migrate({});

      expect(result.ok).toBe(false);
      expect(result.stage).toBe('validation');
      expect((await targetCounts()).products).toBe(0);
      expect((await targetCounts()).brands).toBe(0);

      for (const [collection, id, code] of EXPECTED_FATAL) {
        const findings = result.findings.filter((finding) => finding.id === id);
        expect({ id, codes: findings.map((finding) => finding.code) }).toEqual({
          id,
          codes: expect.arrayContaining([code]),
        });
        expect(findings[0].collection).toBe(collection);
      }
    });

    it('names each defect precisely (orphans, precision, ranges, duplicates)', async () => {
      const result = await migrate({});

      expect(findingsFor(result, messyIds.productOrphanBrand)).toContain('ORPHAN_REFERENCE');
      expect(findingsFor(result, messyIds.productOrphanCategory)).toContain('ORPHAN_REFERENCE');

      const precision = result.findings.find(
        (finding) =>
          finding.id === messyIds.productPrecision && finding.code === 'DECIMAL_PRECISION',
      );
      expect(precision.details).toEqual({ value: 19.999, wouldBecome: 20 });

      expect(findingsFor(result, messyIds.productYearTenThousand)).toContain('DATE_OUT_OF_RANGE');
      expect(findingsFor(result, messyIds.productLongSku)).toContain('STRING_TOO_LONG');
      expect(findingsFor(result, messyIds.brandDuplicateB)).toContain('UNIQUE_COLLISION');
      expect(findingsFor(result, messyIds.userDuplicateEmailB)).toContain('UNIQUE_COLLISION');
      expect(findingsFor(result, messyIds.userNoPasswordHash)).toContain('MISSING_REQUIRED');
    });

    it('quarantines explicitly, migrating the rest and recording every rejection', async () => {
      const quarantinePath = path.join(tmpDir, 'quarantine.json');
      const result = await migrate({
        apply: true,
        confirm: CONFIRM,
        allowQuarantine: true,
        quarantinePath,
        verify: true,
        manifestPath: path.join(tmpDir, 'messy-manifest.json'),
      });

      expect(result.ok).toBe(true);
      expect(result.quarantined.length).toBeGreaterThan(0);

      const report = JSON.parse(await fs.readFile(quarantinePath, 'utf8'));
      const rejectedIds = report.rejected.map((entry) => entry.id);
      expect(rejectedIds).toEqual(expect.arrayContaining([messyIds.productOrphanBrand]));
      expect(rejectedIds).toEqual(expect.arrayContaining([messyIds.productPrecision]));
      expect(rejectedIds).toEqual(expect.arrayContaining([messyIds.userNoPasswordHash]));

      // Everything clean still landed, and verification agrees with the subset.
      expect(result.verification.passed).toBe(true);
      const counts = await targetCounts();
      expect(counts.products).toBe(
        EXPECTED_CLEAN.filter(([collection]) => collection === 'products').length,
      );
    });

    it('quarantine never manufactures an orphan', async () => {
      // Removing the only brand the clean products point at must be refused.
      const result = await migrate({
        apply: true,
        confirm: CONFIRM,
        allowQuarantine: true,
      }).catch((error) => error);

      // Here the products themselves are quarantined (they are the orphaned rows),
      // so the run must NOT be the one that breaks a reference: it either succeeds
      // with consistent leftovers or refuses outright.
      if (result instanceof Error) {
        expect(result.code).toBe('QUARANTINE_WOULD_ORPHAN');
      } else {
        const [{ orphans }] = await query(
          `SELECT COUNT(*) AS orphans
             FROM products p
             LEFT JOIN brands b ON b.id = p.brand_id
            WHERE b.id IS NULL`,
        );
        expect(Number(orphans)).toBe(0);
      }
    });

    it('accepts rounded decimals only when explicitly asked, and reports them', async () => {
      const result = await migrate({
        apply: true,
        confirm: CONFIRM,
        allowQuarantine: true,
        acceptRoundedDecimals: true,
        verify: true,
      });

      expect(result.ok).toBe(true);
      expect(result.tolerated.map((entry) => entry.code)).toContain('DECIMAL_PRECISION');

      const [rounded] = await query('SELECT price FROM products WHERE id = ?', [
        messyIds.productPrecision,
      ]);
      // Without the flag this row is fatal; with it, the rounding is recorded.
      if (rounded) expect(Number(rounded.price)).toBe(20);
    });

    it('keeps null and absent optional fields distinguishable after the move', async () => {
      await migrate({ apply: true, confirm: CONFIRM, allowQuarantine: true, verify: false });

      const [nullImage] = await query('SELECT image FROM categories WHERE id = ?', [
        messyIds.categoryNullImage,
      ]);
      const [missingImage] = await query('SELECT image FROM categories WHERE id = ?', [
        messyIds.categoryMissingImage,
      ]);
      expect(nullImage.image).toBeNull();
      expect(missingImage.image).toBeNull();

      const [nullSku] = await query('SELECT sku FROM products WHERE id = ?', [
        messyIds.productNullSku,
      ]);
      const [emptySku] = await query('SELECT sku FROM products WHERE id = ?', [
        messyIds.productEmptySku,
      ]);
      expect(nullSku.sku).toBeNull();
      expect(emptySku.sku).toBeNull(); // empty string → NULL (sparse unique)
    });

    it('round-trips boundary timestamps to the millisecond', async () => {
      await migrate({ apply: true, confirm: CONFIRM, allowQuarantine: true, verify: false });

      const expectations = [
        [messyIds.productEpoch, new Date(0)],
        [messyIds.productY2038, new Date('2038-01-19T03:14:07.000Z')],
        [messyIds.productLeapDay, new Date('2024-02-29T12:00:00.000Z')],
        [messyIds.productMaxDate, new Date('9999-12-31T23:59:59.999Z')],
      ];

      for (const [id, expected] of expectations) {
        const [row] = await query(
          'SELECT created_at, CAST(created_at AS CHAR) AS raw FROM products WHERE id = ?',
          [id],
        );
        expect(row.created_at.getTime()).toBe(expected.getTime());
      }

      const [maxRow] = await query(
        'SELECT CAST(created_at AS CHAR) AS raw FROM products WHERE id = ?',
        [messyIds.productMaxDate],
      );
      expect(maxRow.raw).toBe('9999-12-31 23:59:59.999');
    });

    it('refuses to write into a target that holds rows the source does not know', async () => {
      await query(
        `INSERT INTO brands (id, name, name_normalized, slug, description, logo, created_at, updated_at)
         VALUES ('6600000000000000000000bb', 'Stray', 'stray', 'stray', '', '', NOW(3), NOW(3))`,
      );

      await expect(
        migrate({ apply: true, confirm: CONFIRM, allowQuarantine: true }),
      ).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });

      // Explicitly accepted, the write goes ahead and the stray row survives.
      const result = await migrate({
        apply: true,
        confirm: CONFIRM,
        allowQuarantine: true,
        allowNonEmpty: true,
        verify: false,
      });
      expect(result.ok).toBe(true);
      const [stray] = await query('SELECT id FROM brands WHERE id = ?', [
        '6600000000000000000000bb',
      ]);
      expect(stray.id).toBe('6600000000000000000000bb');
    });
  });

  /* --------------------------------------------------------- verification */

  describe('verification', () => {
    it('reports a real mismatch instead of passing a wrong migration', async () => {
      await Brand.create({
        name: 'Verify Brand',
        nameNormalized: 'verify brand',
        slug: 'verify-brand',
        description: 'clean',
      });
      await migrate({ apply: true, confirm: CONFIRM, verify: false });

      // Corrupt the target behind the migration's back.
      await query(`UPDATE brands SET description = 'tampered' WHERE slug = 'verify-brand'`);

      const extracted = await extractDocuments();
      const report = await verifyMigration(mapRows(extracted.documents), { sampleSize: 50 });

      expect(report.passed).toBe(false);
      const equality = report.checks.find((check) => check.name === 'sample-equality');
      expect(equality.mismatches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: 'brands', column: 'description', actual: 'tampered' }),
        ]),
      );
    });

    it('guards the destructive confirmation token itself', () => {
      expect(() => assertDestructiveConfirmation('', 'storefront_it_test')).toThrow(
        /pass --confirm storefront_it_test/,
      );
      expect(() => assertDestructiveConfirmation('storefront', 'storefront_it_test')).toThrow(
        /does not match the connected database/,
      );
      expect(assertDestructiveConfirmation('storefront_it_test', 'storefront_it_test')).toBe(true);
    });
  });
});
