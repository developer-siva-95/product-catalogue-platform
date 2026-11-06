import { createTestDatabase, MYSQL_TEST_DATABASE } from './mysql.js';
import { migrateDown, migrateUp } from '../../src/db/mysql/migrate.js';
import { closePool, query } from '../../src/db/mysql/pool.js';

/**
 * Clean-schema helper for MySQL integration suites.
 *
 * `resetMysqlSchema()` rebuilds the schema from the migration files, which is both
 * the fastest way to get a known-empty database and a continuous test that the
 * migrations still apply cleanly. It is destructive by design and therefore
 * confined to a `*_test` database — `createTestDatabase()` refuses anything else
 * and the migration runner's own guard repeats the check.
 */
export async function resetMysqlSchema() {
  process.env.ALLOW_DESTRUCTIVE_MIGRATIONS = 'true';
  await createTestDatabase();
  await migrateDown({ allowDestructive: true });
  await migrateUp();
}

/** Empties every table without touching the schema (keeps the ledger intact). */
export async function clearMysqlTables() {
  await query('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of ['products', 'users', 'categories', 'brands']) {
    await query(`TRUNCATE TABLE ${table}`);
  }
  await query('SET FOREIGN_KEY_CHECKS = 1');
}

export { MYSQL_TEST_DATABASE, closePool };
