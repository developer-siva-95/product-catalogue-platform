import env from '../../config/env.js';
import logger from '../../utils/logger.js';
import { closePool, getPool, isPoolCreated, ping, withTransaction } from './pool.js';

/**
 * MySQL provider adapter — the mirror image of `db/mongo/provider.js`.
 *
 * The application never imports mysql2 directly: everything above this module
 * talks to the provider-neutral surface (connect / disconnect / state / probe /
 * withTransaction / health) or, for data access, to the repository layer.
 */

export const name = 'mysql';

let connected = false;

/** Opens the pool and verifies the server answers. */
export async function connect() {
  const result = await ping();
  if (!result.ok) {
    // Name the selected provider explicitly: this is the failure a developer hits
    // when DATABASE_PROVIDER is unset (MySQL is the default) and no MySQL server is
    // running. There is no fallback to MongoDB — say so instead of leaving them to
    // guess why the app exited.
    const target = `${env.MYSQL_HOST}:${env.MYSQL_PORT}/${env.MYSQL_DATABASE ?? '(no database)'}`;
    const error = new Error(
      `MySQL is the selected database provider (DATABASE_PROVIDER=${env.DATABASE_PROVIDER}, ` +
        `source: ${env.DATABASE_PROVIDER_SOURCE}) but the connection to ${target} failed: ${result.error}. ` +
        'Start an Oracle MySQL 8.0 server and check MYSQL_HOST / MYSQL_PORT / MYSQL_USER / ' +
        'MYSQL_PASSWORD / MYSQL_DATABASE, or select MongoDB explicitly with DATABASE_PROVIDER=mongodb. ' +
        'The application will not fall back to another database.',
    );
    error.name = 'DatabaseConnectionError';
    error.provider = name;
    throw error;
  }
  connected = true;
  logger.info('mysql connected', {
    database: env.MYSQL_DATABASE,
    version: result.version,
    poolLimit: env.MYSQL_CONNECTION_LIMIT,
  });
}

/** Closes the pool (graceful shutdown and test teardown). */
export async function disconnect() {
  await closePool();
  connected = false;
}

/** Provider-neutral connection state (same strings the /health contract uses). */
export function state() {
  // Never create a pool just to answer "are we connected?" — a health check must
  // not open connections.
  if (!connected && !isPoolCreated()) {
    return { provider: name, status: 'disconnected', isConnected: false };
  }
  return {
    provider: name,
    status: connected ? 'connected' : 'connecting',
    isConnected: connected,
  };
}

/**
 * Capability probe: InnoDB, transaction isolation and version.
 *
 * MySQL 8 with InnoDB always supports transactions, so this probe is a guard
 * against a mis-provisioned server (MyISAM default engine, read-only replica,
 * `autocommit=1`-only proxy) rather than a topology question — but it returns the
 * same shape as the MongoDB probe so one code path handles both providers.
 *
 * @returns {Promise<{provider: string, transactions: boolean, version?: string, storageEngine?: string, reason?: string}>}
 */
export async function probe() {
  try {
    const pool = getPool();
    const [versionRows] = await pool.query(
      'SELECT VERSION() AS version, @@default_storage_engine AS engine, @@transaction_isolation AS isolation',
    );
    const row = versionRows[0] ?? {};
    const [tableRows] = await pool.query(
      `SELECT COUNT(*) AS tables
         FROM information_schema.tables
        WHERE table_schema = ? AND engine <> 'InnoDB'`,
      [env.MYSQL_DATABASE ?? ''],
    );
    const nonInnoDbTables = Number(tableRows[0]?.tables ?? 0);
    let supportsTransactions =
      String(row.engine).toLowerCase() === 'innodb' && nonInnoDbTables === 0;

    // Engine flags alone are a weak promise; prove the deployment can actually
    // start, write inside and roll back a transaction. Everything runs on one
    // pooled connection: a TEMPORARY table is session-scoped, so probing it from a
    // different connection would report a false negative (found in P5).
    let rollbackProven = false;
    if (supportsTransactions) {
      const connection = await pool.getConnection();
      try {
        await connection.query('CREATE TEMPORARY TABLE __capability_probe (id INT) ENGINE=InnoDB');
        await connection.beginTransaction();
        await connection.query('INSERT INTO __capability_probe (id) VALUES (1)');
        await connection.rollback();
        const [rows] = await connection.query(
          'SELECT COUNT(*) AS rows_in_probe FROM __capability_probe',
        );
        rollbackProven = Number(rows[0]?.rows_in_probe ?? -1) === 0;
      } catch {
        rollbackProven = false;
      } finally {
        connection.release();
      }
    }
    supportsTransactions = supportsTransactions && rollbackProven;

    return {
      provider: name,
      transactions: supportsTransactions,
      version: row.version,
      storageEngine: row.engine,
      isolation: row.isolation,
      ...(supportsTransactions
        ? {}
        : { reason: `${nonInnoDbTables} non-InnoDB table(s) in ${env.MYSQL_DATABASE}` }),
    };
  } catch (error) {
    return { provider: name, transactions: false, reason: error.message };
  }
}

/** Liveness probe: server version + round-trip latency. */
export async function health() {
  return ping();
}

export { withTransaction };

export default { name, connect, disconnect, state, probe, withTransaction, health };
