import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MYSQL_TEST_DATABASE,
  createTestDatabase,
  rawConnection,
  serverVersion,
  shouldSkipMysql,
} from '../helpers/mysql.js';
import {
  discoverMigrations,
  migrateDown,
  migrateStatus,
  migrateUp,
} from '../../src/db/mysql/migrate.js';
import { closePool, getPool, query, withTransaction } from '../../src/db/mysql/pool.js';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase, getProviderName } from '../../src/db/index.js';

/**
 * Phase 3 evidence: the MySQL foundation against a REAL MySQL server.
 *
 * Skips when no credentials are supplied; fails when MYSQL_REQUIRE=1 and the
 * server is missing. Every destructive step (DROP TABLE) is confined to a
 * database whose name ends with `_test`, enforced by the migration runner's own
 * guard — the same guard the tests assert.
 */

const shouldSkip = shouldSkipMysql();
const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'db',
  'mysql',
  'migrations',
);

process.env.ALLOW_DESTRUCTIVE_MIGRATIONS = 'true';

describe.skipIf(shouldSkip)('MySQL foundation (real server)', () => {
  let version;
  // Expected ledger contents are derived from the migration files, so adding a
  // migration does not mean editing this suite.
  const MIGRATION_VERSIONS = discoverMigrations().map((migration) => migration.version);

  beforeAll(async () => {
    await createTestDatabase();
    version = await serverVersion();
    // Start from a clean slate: the runner's own down path removes any tables a
    // previous run left behind (no-op when the database is empty).
    await migrateDown({ allowDestructive: true });
    await migrateUp();
  }, 60_000);

  afterAll(async () => {
    await migrateDown({ allowDestructive: true }).catch(() => {});
    await closePool();
  }, 60_000);

  it('runs against a MySQL 8.0 server', () => {
    expect(version).toMatch(/^8\.0\./);
    expect(MYSQL_TEST_DATABASE.endsWith('_test')).toBe(true);
  });

  it('creates the four tables plus the migration ledger', async () => {
    const rows = await query(
      `SELECT table_name AS name, engine AS engine, table_collation AS collation
         FROM information_schema.tables
        WHERE table_schema = ? ORDER BY table_name`,
      [MYSQL_TEST_DATABASE],
    );
    const names = rows.map((row) => row.name);
    expect(names).toEqual(['brands', 'categories', 'products', 'schema_migrations', 'users']);
    for (const row of rows) {
      expect(row.engine).toBe('InnoDB');
      expect(row.collation).toBe('utf8mb4_0900_as_ci');
    }
  });

  it('records the migration in the ledger with a checksum', async () => {
    const rows = await query('SELECT version, checksum, statements FROM schema_migrations');
    expect(rows.map((row) => row.version)).toEqual(MIGRATION_VERSIONS);
    for (const row of rows) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(row.statements).toBeGreaterThan(0);
    }
  });

  it('is idempotent: a second run applies nothing', async () => {
    const result = await migrateUp();
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(MIGRATION_VERSIONS);

    const status = await migrateStatus();
    expect(status.pending).toEqual([]);
    expect(status.applied).toHaveLength(MIGRATION_VERSIONS.length);
  });

  it('supports a --dry-run that reports without writing', async () => {
    const before = await query('SELECT COUNT(*) AS n FROM schema_migrations');
    // Down then dry-run up: the file must be reported as "would apply".
    await migrateDown({ allowDestructive: true });
    const dryRun = await migrateUp({ dryRun: true });
    expect(dryRun.applied).toEqual(MIGRATION_VERSIONS);

    const tablesAfterDryRun = await query(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'products'`,
      [MYSQL_TEST_DATABASE],
    );
    expect(Number(tablesAfterDryRun[0].n)).toBe(0); // dry run wrote nothing

    await migrateUp();
    const after = await query('SELECT COUNT(*) AS n FROM schema_migrations');
    expect(Number(after[0].n)).toBe(Number(before[0].n));
  });

  it('detects a modified migration instead of silently diverging', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'mysql-migrations-'));
    try {
      for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'))) {
        copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(scratch, file));
      }
      await expect(migrateUp({ directory: scratch })).resolves.toMatchObject({ applied: [] });

      const tampered = readFileSync(path.join(scratch, '001_init.sql'), 'utf8').replace(
        'VARCHAR(60)',
        'VARCHAR(61)',
      );
      writeFileSync(path.join(scratch, '001_init.sql'), tampered);

      await expect(migrateUp({ directory: scratch })).rejects.toThrow(
        /was modified after it was applied/,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('maps money to DECIMAL and reads it back as a string (no float drift)', async () => {
    await insertBrand('b1', 'Money Brand');
    await insertProduct({ id: 'p1', title: 'Money Product', price: '19.99' });

    const [row] = await query('SELECT price FROM products WHERE id = ?', ['p1']);
    expect(typeof row.price).toBe('string');
    expect(row.price).toBe('19.99');

    const [typo] = await query(
      `SELECT column_type AS type, numeric_precision AS p, numeric_scale AS s
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = 'products' AND column_name = 'price'`,
      [MYSQL_TEST_DATABASE],
    );
    expect(typo.type).toBe('decimal(12,2)');
    expect(Number(typo.p)).toBe(12);
    expect(Number(typo.s)).toBe(2);
  });

  it('round-trips timestamps as UTC dates', async () => {
    const [row] = await query('SELECT created_at FROM products WHERE id = ?', ['p1']);
    expect(row.created_at).toBeInstanceOf(Date);
    // Inserted with a UTC literal; the driver must hand back the same instant.
    expect(row.created_at.toISOString()).toBe('2026-01-02T12:00:00.000Z');

    const [tz] = await query('SELECT @@session.time_zone AS zone');
    expect(['+00:00', 'UTC', 'SYSTEM']).toContain(tz.zone);
  });

  it('commits a transaction and rolls back on error', async () => {
    await withTransaction(async (connection) => {
      await connection.query(
        `INSERT INTO brands (id, name, name_normalized, slug, description, logo, created_at, updated_at)
         VALUES ('b2', 'Tx Brand', 'tx brand', 'tx-brand', '', '', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      );
    });
    expect(await countRows('brands', "id = 'b2'")).toBe(1);

    await expect(
      withTransaction(async (connection) => {
        await connection.query(
          `INSERT INTO brands (id, name, name_normalized, slug, description, logo, created_at, updated_at)
           VALUES ('b3', 'Rollback Brand', 'rollback brand', 'rollback-brand', '', '', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await countRows('brands', "id = 'b3'")).toBe(0);
  });

  it('rejects a duplicate unique key with ER_DUP_ENTRY (1062)', async () => {
    const error = await insertBrand('b4', 'Tx Brand').catch((err) => err);
    expect(error.code).toBe('ER_DUP_ENTRY');
    expect(error.errno).toBe(1062);
    expect(error.message).toMatch(/brand_name_normalized_unique|brand_slug_unique/);
  });

  it('keeps binary slug uniqueness (case-sensitive), matching Mongo', async () => {
    // Same slug in a different case: MongoDB's binary unique index allows both,
    // so MySQL must too — a case-insensitive unique here would start rejecting
    // writes the reference provider accepts.
    await expect(
      query(
        `INSERT INTO brands (id, name, name_normalized, slug, description, logo, created_at, updated_at)
         VALUES ('b5', 'Case Brand', 'case brand', 'case-brand', '', '', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      ),
    ).resolves.toBeDefined();
    await expect(
      query(
        `INSERT INTO brands (id, name, name_normalized, slug, description, logo, created_at, updated_at)
         VALUES ('b6', 'Case Brand Upper', 'case brand upper', 'CASE-BRAND', '', '', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      ),
    ).resolves.toBeDefined();

    // An exact duplicate slug still collides (uniqueness is enforced at all)...
    await expect(
      query(
        `INSERT INTO brands (id, name, name_normalized, slug, description, logo, created_at, updated_at)
         VALUES ('b7', 'Case Brand Dup', 'case brand dup', 'case-brand', '', '', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      ),
    ).rejects.toMatchObject({ errno: 1062 });
    // ...and so does a duplicate of the application-lowercased nameNormalized,
    // which is what makes "Acme" and "acme" the same brand on both providers.
    await expect(insertBrand('b8', 'case brand')).rejects.toMatchObject({ errno: 1062 });
  });

  it('enforces the products → brands/categories foreign keys', async () => {
    const error = await insertProduct({
      id: 'p2',
      title: 'Orphan Product',
      brandId: 'ffffffffffffffffffffffff',
    }).catch((err) => err);
    expect(error.errno).toBe(1452);
    expect(error.code).toBe('ER_NO_REFERENCED_ROW_2');

    const deleteError = await query('DELETE FROM brands WHERE id = ?', ['b1']).catch((err) => err);
    expect(deleteError.errno).toBe(1451);
  });

  it('cannot oversell stock under concurrent guarded decrements', async () => {
    await insertProduct({ id: 'p3', title: 'Contended Product', stock: 5 });

    const guarded = async () => {
      const connection = await rawConnection();
      try {
        await connection.beginTransaction();
        const [result] = await connection.query(
          'UPDATE products SET stock = stock - 1 WHERE id = ? AND stock >= 1',
          ['p3'],
        );
        await connection.commit();
        return result.affectedRows;
      } finally {
        await connection.end();
      }
    };

    const results = await Promise.all(Array.from({ length: 12 }, guarded));
    const succeeded = results.filter((rows) => rows === 1).length;
    const stock = await query('SELECT stock FROM products WHERE id = ?', ['p3']);

    expect(succeeded).toBe(5); // exactly the available units, never more
    expect(Number(stock[0].stock)).toBe(0);
  });

  it('retries a deadlocked transaction instead of surfacing the error', async () => {
    let attempts = 0;
    const result = await withTransaction(async (connection) => {
      attempts += 1;
      if (attempts < 3) {
        const deadlock = new Error(
          'Deadlock found when trying to get lock; try restarting transaction',
        );
        deadlock.code = 'ER_LOCK_DEADLOCK';
        deadlock.errno = 1213;
        throw deadlock;
      }
      const [rows] = await connection.query('SELECT 1 + 1 AS sum');
      return rows[0].sum;
    });

    expect(attempts).toBe(3);
    expect(result).toBe(2);
  });

  it('stops retrying after the attempt budget and rethrows the original error', async () => {
    let attempts = 0;
    const error = await withTransaction(
      async () => {
        attempts += 1;
        const deadlock = new Error('lock wait timeout exceeded');
        deadlock.errno = 1205;
        throw deadlock;
      },
      { attempts: 2 },
    ).catch((err) => err);

    expect(attempts).toBe(2);
    expect(error.errno).toBe(1205);
  });

  it('rolls the schema back down and can rebuild it (down → up round trip)', async () => {
    const result = await migrateDown({ allowDestructive: true });
    expect(result.rolledBack).toEqual([...MIGRATION_VERSIONS].reverse());

    const tables = await query(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = ? AND table_name IN ('products','users','brands','categories')`,
      [MYSQL_TEST_DATABASE],
    );
    expect(tables).toHaveLength(0);

    const rebuilt = await migrateUp();
    expect(rebuilt.applied).toEqual(MIGRATION_VERSIONS);
  });

  it('refuses a destructive rollback of a non-test database', async () => {
    const { assertDownAllowed } = await import('../../src/db/mysql/migrate.js');
    // The suite sets ALLOW_DESTRUCTIVE_MIGRATIONS=true, so only the database-name
    // rule stands between a rollback and a real catalogue — assert it holds.
    expect(() => assertDownAllowed('storefront', { ALLOW_DESTRUCTIVE_MIGRATIONS: 'true' })).toThrow(
      /Refusing to run migrations down against "storefront"/,
    );
    expect(() => assertDownAllowed(MYSQL_TEST_DATABASE, process.env)).not.toThrow();
  });

  it('exposes the pool through the provider-neutral facade', async () => {
    const pool = getPool();
    expect(pool).toBeDefined();
    const [rows] = await pool.query('SELECT VERSION() AS version');
    expect(rows[0].version).toBe(version);
  });

  /* ------------------------------- helpers ------------------------------- */

  async function insertBrand(id, name) {
    return query(
      `INSERT INTO brands (id, name, name_normalized, slug, description, logo, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', '', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      [id, name, name.toLowerCase(), name.toLowerCase().replace(/\s+/g, '-')],
    );
  }

  async function insertProduct({
    id,
    title,
    price = '10.00',
    stock = 1,
    brandId = 'b1',
    categoryId = undefined,
  }) {
    const category = categoryId ?? (await ensureCategory());
    return query(
      `INSERT INTO products
         (id, title, slug, sku, price, stock, description, image, thumbnail,
          brand_id, category_id, is_active, version, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, 'desc', '', '', ?, ?, 1, 0, ?, ?)`,
      [
        id,
        title,
        title.toLowerCase().replace(/\s+/g, '-'),
        price,
        stock,
        brandId,
        category,
        new Date('2026-01-02T12:00:00.000Z'),
        new Date('2026-01-02T12:00:00.000Z'),
      ],
    );
  }

  async function ensureCategory() {
    await query(
      `INSERT IGNORE INTO categories (id, name, name_normalized, slug, description, image, created_at, updated_at)
       VALUES ('c1', 'Test Category', 'test category', 'test-category', '', '', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
    );
    return 'c1';
  }

  async function countRows(table, where) {
    const rows = await query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`);
    return Number(rows[0].n);
  }
});

/**
 * Provider isolation (approved behaviour change: MySQL is the application default).
 *
 * Selecting MySQL must not initialise MongoDB: no Mongoose connection is opened and
 * no MongoDB-specific initialisation runs. This is asserted through the same facade
 * the API uses, not by inspecting code.
 */
describe.skipIf(shouldSkip || process.env.DATABASE_PROVIDER !== 'mysql')(
  'provider isolation — MySQL selected',
  () => {
    afterAll(async () => {
      await disconnectDatabase().catch(() => {});
    });

    it('connecting the application to MySQL leaves Mongoose disconnected', async () => {
      expect(process.env.DATABASE_PROVIDER).toBe('mysql');

      await connectDatabase();

      expect(getProviderName()).toBe('mysql');
      expect(mongoose.connection.readyState).toBe(0); // 0 = disconnected: nothing was opened
      expect(getPool()).toBeTruthy(); // and the selected provider really is live
    });
  },
);
