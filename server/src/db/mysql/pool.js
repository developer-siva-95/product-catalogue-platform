import mysql from 'mysql2/promise';
import env from '../../config/env.js';
import logger from '../../utils/logger.js';

/**
 * MySQL connection pool.
 *
 * Everything provider-specific about *talking* to MySQL lives here so the
 * repository implementations only ever see `query`, `execute` and
 * `withTransaction`.
 *
 * Settings that are load-bearing for contract parity:
 *  - `timezone: 'Z'`      → DATETIME values are read/written as UTC. Without it
 *                           the driver applies the *server's* local offset and
 *                           every timestamp in the JSON payload shifts.
 *  - `decimalNumbers:false` → DECIMAL arrives as a string ('19.99'); the
 *                           repositories convert explicitly, so money never
 *                           round-trips through a float.
 *  - `supportBigNumbers`  → no silent precision loss on large COUNT(*) results.
 *  - `charset utf8mb4_0900_as_ci` → the session collation matches the schema, so
 *                           LIKE comparisons are case/accent-insensitive exactly
 *                           like Mongo's /i regex in the reference provider.
 *  - `multipleStatements: false` → a single injected string can never chain DDL.
 *                           The migration runner splits files itself.
 */

const DEADLOCK_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
const DEADLOCK_ERRNOS = new Set([1205, 1213]);

/** @type {import('mysql2/promise').Pool | null} */
let pool = null;

/**
 * Builds the pool configuration from validated env, with optional overrides.
 * Exported so migration tooling and tests can point at a different database
 * without duplicating (or drifting from) the production settings.
 *
 * @param {object} [overrides]
 * @returns {import('mysql2').PoolOptions}
 */
export function mysqlPoolConfig(overrides = {}) {
  return {
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    connectionLimit: env.MYSQL_CONNECTION_LIMIT,
    waitForConnections: true,
    queueLimit: 0,
    timezone: 'Z',
    charset: 'utf8mb4',
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    ssl: env.MYSQL_SSL ? { rejectUnauthorized: true } : undefined,
    ...overrides,
  };
}

/**
 * Lazily creates (and memoises) the shared pool.
 * @param {object} [overrides]
 */
export function getPool(overrides = {}) {
  if (pool) return pool;
  pool = mysql.createPool(mysqlPoolConfig(overrides));

  // Pin the session collation on every new connection so `LIKE`/`=` comparisons
  // inside a pooled connection behave like the schema default, regardless of the
  // server's configured default collation.
  pool.on('connection', (connection) => {
    connection.query("SET SESSION collation_connection = 'utf8mb4_0900_as_ci'");
  });

  return pool;
}

/** True when a pool object exists. Never creates one (state probes call this). */
export function isPoolCreated() {
  return pool !== null;
}

/** Replaces the shared pool (tests / tooling pass their own). */
export function setPool(nextPool) {
  pool = nextPool;
}

/**
 * Runs a statement on the shared pool.
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<any>}
 */
export async function query(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

/**
 * Runs a prepared statement (server-side statement cache, typed params).
 * @param {string} sql
 * @param {unknown[]} [params]
 */
export async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

function isRetryableTransactionError(error) {
  return DEADLOCK_CODES.has(error?.code) || DEADLOCK_ERRNOS.has(error?.errno);
}

/**
 * Runs `handler(connection)` inside a transaction, committing on success and
 * rolling back on any thrown error.
 *
 * Deadlocks (1213) and lock-wait timeouts (1205) are *expected* under
 * concurrency in InnoDB; the whole transaction is retried with a small jittered
 * backoff instead of surfacing a 500 to the client. This is the MySQL
 * counterpart of the Mongo provider's optimistic retry on a write conflict.
 *
 * @template T
 * @param {(connection: import('mysql2/promise').PoolConnection) => Promise<T>} handler
 * @param {{attempts?: number, isolation?: string}} [options]
 * @returns {Promise<T>}
 */
export async function withTransaction(handler, options = {}) {
  const attempts = options.attempts ?? 3;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const connection = await getPool().getConnection();
    try {
      if (options.isolation) {
        await connection.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation}`);
      }
      await connection.beginTransaction();
      const result = await handler(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        logger.error('mysql rollback failed', { err: rollbackError });
      }
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === attempts) throw error;
      // Jittered backoff (10-40 ms): two deadlocked transactions must not retry
      // in lockstep or they simply deadlock again.
      const delay = 10 + Math.random() * 30 * attempt;
      logger.warn('mysql transaction retry', { err: error, attempt, delayMs: Math.round(delay) });
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      connection.release();
    }
  }

  throw lastError;
}

/**
 * Cheap liveness probe used by /health and by the startup capability check.
 * @returns {Promise<{ok: boolean, latencyMs: number, version?: string, error?: string}>}
 */
export async function ping() {
  const startedAt = process.hrtime.bigint();
  try {
    const rows = await query('SELECT VERSION() AS version');
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return { ok: true, latencyMs: Number(latencyMs.toFixed(1)), version: rows[0]?.version };
  } catch (error) {
    return { ok: false, latencyMs: -1, error: error.message };
  }
}

/** Closes the shared pool. Safe to call twice (graceful shutdown + tests). */
export async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

export default { getPool, query, execute, withTransaction, ping, closePool, setPool };
