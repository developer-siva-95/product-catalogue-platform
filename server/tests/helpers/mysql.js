import mysql from 'mysql2/promise';
import env from '../../src/config/env.js';

/**
 * Real-MySQL test harness.
 *
 * There is no in-memory MySQL, so — unlike the Mongo suite — these tests need a
 * live server. Credentials are never committed: they arrive through
 * `MYSQL_TEST_*` environment variables (see tests/setup.js, which maps them onto
 * the real `MYSQL_*` variables before `config/env.js` is imported).
 *
 * Safety rules baked in here:
 *  - the target database name MUST end with `_test`;
 *  - the database is created if missing and its tables are dropped/created by the
 *    migration runner itself, so the suite is re-runnable and self-contained;
 *  - when credentials are absent the suite SKIPS (so `npm run verify` works on a
 *    machine without MySQL), unless `MYSQL_REQUIRE=1`, in which case a missing
 *    or unreachable server is a hard failure — that is the CI posture, so a
 *    skipped MySQL suite can never masquerade as a passing one.
 */

export const MYSQL_TEST_DATABASE = env.MYSQL_DATABASE;

/** @returns {boolean} true when the caller supplied MySQL test credentials */
export function hasMysqlCredentials() {
  return Boolean(process.env.MYSQL_TEST_USER);
}

/** @returns {boolean} true when a missing server must fail rather than skip */
export function mysqlIsRequired() {
  return process.env.MYSQL_REQUIRE === '1' || process.env.MYSQL_REQUIRE === 'true';
}

/** Fails loudly (when required) or returns false (when optional). */
export function shouldSkipMysql() {
  if (hasMysqlCredentials()) return false;
  if (mysqlIsRequired()) {
    throw new Error(
      'MYSQL_REQUIRE=1 but no MySQL credentials were provided. Set MYSQL_TEST_USER ' +
        '(and MYSQL_TEST_PASSWORD / MYSQL_TEST_DATABASE) or drop MYSQL_REQUIRE.',
    );
  }
  return true;
}

/**
 * Creates the (empty) test database using a connection that is not bound to it.
 * Must run before the shared pool is touched, because the pool connects with
 * `database` already selected.
 */
export async function createTestDatabase() {
  if (!MYSQL_TEST_DATABASE || !MYSQL_TEST_DATABASE.endsWith('_test')) {
    throw new Error(
      `Refusing to run the MySQL suite against "${MYSQL_TEST_DATABASE}": the database name must end with "_test".`,
    );
  }
  const connection = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    multipleStatements: false,
    timezone: 'Z',
  });
  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${MYSQL_TEST_DATABASE}\` ` +
        'CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci',
    );
  } finally {
    await connection.end();
  }
}

/** Raw connection for assertions that must bypass the application pool. */
export async function rawConnection(overrides = {}) {
  return mysql.createConnection({
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: MYSQL_TEST_DATABASE,
    timezone: 'Z',
    decimalNumbers: false,
    ...overrides,
  });
}

/** Reads the server version (evidence for the final report). */
export async function serverVersion() {
  const connection = await rawConnection();
  try {
    const [rows] = await connection.query('SELECT VERSION() AS version');
    return rows[0].version;
  } finally {
    await connection.end();
  }
}
