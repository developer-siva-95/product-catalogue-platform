import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDownAllowed,
  checksumOf,
  discoverMigrations,
  splitStatements,
} from '../../src/db/mysql/migrate.js';

/**
 * Schema-level guarantees.
 *
 * These assertions are the machine-checked version of the DDL's design notes: if
 * someone edits 001_init.sql in a way that breaks contract parity with the Mongo
 * reference (a float price column, a timezone-less timestamp, a case-insensitive
 * slug unique, a missing FK), this suite fails before the change reaches MySQL.
 */

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'db',
  'mysql',
  'migrations',
);

const schema = readFileSync(path.join(MIGRATIONS_DIR, '001_init.sql'), 'utf8');

/** Very small helper: returns the column definition block of a CREATE TABLE. */
function tableBody(table) {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  expect(start, `table ${table} exists`).toBeGreaterThan(-1);
  const end = schema.indexOf('ENGINE = InnoDB', start);
  return schema.slice(start, end);
}

describe('MySQL schema (001_init)', () => {
  const tables = ['brands', 'categories', 'products', 'users'];

  it.each(tables)('%s has a 24-character binary id primary key', (table) => {
    const body = tableBody(table);
    expect(body).toMatch(/id CHAR\(24\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/);
    expect(body).toMatch(/PRIMARY KEY \(id\)/);
  });

  it.each(tables)('%s uses millisecond timestamps and InnoDB/utf8mb4', (table) => {
    const body = tableBody(table);
    expect(body).toMatch(/created_at DATETIME\(3\) NOT NULL/);
    expect(body).toMatch(/updated_at DATETIME\(3\) NOT NULL/);
    const tableStart = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const engineBlock = schema.slice(
      schema.indexOf('ENGINE = InnoDB', tableStart),
      tableStart + 4000,
    );
    expect(engineBlock).toMatch(/ENGINE = InnoDB/);
    expect(engineBlock).toMatch(/COLLATE = utf8mb4_0900_as_ci/);
  });

  it('stores money as DECIMAL(12,2), never a float type', () => {
    const products = tableBody('products');
    expect(products).toMatch(/price DECIMAL\(12, ?2\) NOT NULL/);
    expect(products).not.toMatch(/price (FLOAT|DOUBLE)/);
  });

  it('keeps slug/sku/email uniqueness binary-exact like the Mongo reference', () => {
    expect(tableBody('products')).toMatch(
      /slug VARCHAR\(200\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/,
    );
    expect(tableBody('products')).toMatch(
      /sku VARCHAR\(64\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL/,
    );
    expect(tableBody('users')).toMatch(
      /email VARCHAR\(254\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/,
    );
    expect(tableBody('brands')).toMatch(
      /name_normalized VARCHAR\(60\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/,
    );
  });

  it('models sparse unique SKUs with a nullable column (MySQL NULLs are distinct)', () => {
    const products = tableBody('products');
    expect(products).toMatch(/sku VARCHAR\(64\)[^,]*NULL,/);
    expect(products).toMatch(/UNIQUE KEY product_sku_unique_sparse \(sku\)/);
  });

  it('carries Mongo’s optimistic-concurrency version and stock checks', () => {
    const products = tableBody('products');
    expect(products).toMatch(/version INT NOT NULL DEFAULT 0/);
    expect(products).toMatch(/CONSTRAINT product_stock_range CHECK \(stock >= 0\)/);
    expect(products).toMatch(/CONSTRAINT product_price_range CHECK \(price >= 0\)/);
  });

  it('enforces referential integrity from products to both taxonomies', () => {
    const products = tableBody('products');
    expect(products).toMatch(/FOREIGN KEY \(brand_id\) REFERENCES brands \(id\)/);
    expect(products).toMatch(/FOREIGN KEY \(category_id\) REFERENCES categories \(id\)/);
  });

  it('indexes every storefront sort/filter path used by the query builder', () => {
    const products = tableBody('products');
    for (const index of [
      'product_active_newest',
      'product_active_price_asc',
      'product_active_price_desc',
      'product_active_brand',
      'product_active_category',
      'product_brand_category_price',
    ]) {
      expect(products).toContain(index);
    }
    expect(products).toMatch(/FULLTEXT KEY product_text_search \(title, description\)/);
  });

  it('restricts user roles and counters at the database level', () => {
    const users = tableBody('users');
    expect(users).toMatch(/CONSTRAINT user_role_check CHECK \(role IN \('admin', 'customer'\)\)/);
    expect(users).toMatch(/CONSTRAINT user_token_version_check CHECK \(token_version >= 0\)/);
  });

  it('declares every table with IF NOT EXISTS so a re-run is safe', () => {
    const createCount = (schema.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length;
    expect(createCount).toBe(tables.length);
    expect(schema).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
  });
});

describe('migration statement splitter', () => {
  it('splits on statement terminators', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ignores semicolons inside string literals', () => {
    expect(splitStatements("INSERT INTO t VALUES ('a;b');")).toEqual([
      "INSERT INTO t VALUES ('a;b')",
    ]);
  });

  it('ignores semicolons inside line comments', () => {
    expect(splitStatements('-- comment; here\nSELECT 1;')).toEqual(['SELECT 1']);
  });

  it('keeps a trailing statement without a terminator', () => {
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('produces no empty statements for blank input', () => {
    expect(splitStatements('\n\n-- nothing\n')).toEqual([]);
  });

  it('splits the real schema into executable single statements', () => {
    const statements = splitStatements(schema);
    expect(statements.length).toBeGreaterThanOrEqual(4);
    expect(statements.every((statement) => !statement.trim().endsWith(';'))).toBe(true);
    expect(statements.filter((statement) => statement.startsWith('CREATE TABLE'))).toHaveLength(4);
  });
});

describe('migration discovery and ledger helpers', () => {
  it('discovers the init migration with a matching down file', () => {
    const migrations = discoverMigrations();
    const init = migrations.find((migration) => migration.version === '001_init');
    expect(init).toBeDefined();
    expect(init.downFile).toBe('001_init.down.sql');
    expect(init.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(init.downStatements.length).toBeGreaterThan(0);
  });

  it('computes a stable checksum for identical content', () => {
    expect(checksumOf('SELECT 1')).toBe(checksumOf('SELECT 1'));
    expect(checksumOf('SELECT 1')).not.toBe(checksumOf('SELECT 2'));
  });

  it('orders migrations by version so dependencies apply deterministically', () => {
    const versions = discoverMigrations().map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort());
  });
});

describe('destructive-migration guard', () => {
  it('refuses to roll back a non-test database', () => {
    expect(() => assertDownAllowed('storefront', {})).toThrow(/Refusing to run migrations down/);
  });

  it('refuses a test database without the explicit opt-in', () => {
    expect(() => assertDownAllowed('storefront_test', {})).toThrow(/ALLOW_DESTRUCTIVE_MIGRATIONS/);
  });

  it('allows an allow-listed database with the opt-in', () => {
    expect(() =>
      assertDownAllowed('storefront_test', { ALLOW_DESTRUCTIVE_MIGRATIONS: 'true' }),
    ).not.toThrow();
  });

  it('allows an explicitly allow-listed non-test database', () => {
    expect(() =>
      assertDownAllowed('catalogue_scratch', {
        ALLOW_DESTRUCTIVE_MIGRATIONS: 'true',
        MYSQL_ALLOWED_DESTRUCTIVE_DATABASES: 'catalogue_scratch,other',
      }),
    ).not.toThrow();
    expect(() =>
      assertDownAllowed('catalogue_other', {
        ALLOW_DESTRUCTIVE_MIGRATIONS: 'true',
        MYSQL_ALLOWED_DESTRUCTIVE_DATABASES: 'catalogue_scratch,other',
      }),
    ).toThrow(/Refusing to run migrations down/);
  });
});
