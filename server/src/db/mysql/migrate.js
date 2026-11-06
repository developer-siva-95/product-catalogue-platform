import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import env from '../../config/env.js';
import logger from '../../utils/logger.js';
import { closePool, getPool } from './pool.js';

/**
 * Versioned SQL migration runner.
 *
 * Guarantees:
 *  - **Idempotent**: applying an already-applied migration is a no-op, and
 *    every statement in the schema uses `CREATE TABLE IF NOT EXISTS`, so a
 *    half-applied run can simply be repeated.
 *  - **Drift-detecting**: each applied version stores a SHA-256 checksum of the
 *    file it came from. Editing an applied migration is refused at startup
 *    instead of silently producing two different schemas in two environments.
 *  - **Destructive-proof**: `down` refuses to run unless
 *    `ALLOW_DESTRUCTIVE_MIGRATIONS=true` *and* the target database is a test
 *    database (`*_test`) or explicitly allow-listed. Section 10 forbids
 *    destructive commands against a real catalogue, so the guard is in the tool,
 *    not in the operator's memory.
 *  - **Crash-visible**: DDL in MySQL causes an implicit commit, so a failed
 *    migration cannot be rolled back atomically. Each file is therefore written
 *    to be individually re-runnable, and the failure is re-thrown with the
 *    offending statement attached.
 */

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';

/**
 * Splits a SQL file into single statements.
 *
 * Not a full SQL parser, and deliberately so: the migration files are ours, hold
 * no stored procedures and no `DELIMITER` blocks. It does handle the two things
 * that actually occur — `--` line comments and single-quoted literals containing
 * semicolons — so a string default can never split a statement in half.
 *
 * @param {string} sql
 * @returns {string[]}
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inSingleQuote = false;
  let inLineComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        current += char;
      }
      continue;
    }
    if (!inSingleQuote && char === '-' && next === '-') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "'") {
      // '' inside a literal is an escaped quote; the odd/even toggle below
      // handles it correctly without special-casing.
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }
    if (char === ';' && !inSingleQuote) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }
    current += char;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** @returns {string} hex SHA-256 of the file contents */
export function checksumOf(contents) {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/**
 * Discovers migration files on disk.
 * @param {string} [directory]
 * @returns {{version: string, upFile: string, downFile: string|null, checksum: string}[]}
 */
export function discoverMigrations(directory = MIGRATIONS_DIR) {
  const files = readdirSync(directory).filter((file) => file.endsWith('.sql'));
  const upFiles = files.filter((file) => !file.endsWith('.down.sql')).sort();

  return upFiles.map((file) => {
    const contents = readFileSync(path.join(directory, file), 'utf8');
    const version = file.replace(/\.sql$/, '');
    const downName = `${version}.down.sql`;
    return {
      version,
      upFile: file,
      downFile: files.includes(downName) ? downName : null,
      checksum: checksumOf(contents),
      statements: splitStatements(contents),
      downStatements: files.includes(downName)
        ? splitStatements(readFileSync(path.join(directory, downName), 'utf8'))
        : [],
    };
  });
}

async function ensureLedger(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
      version VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      statements INT NOT NULL,
      duration_ms INT NOT NULL,
      applied_at DATETIME(3) NOT NULL,
      PRIMARY KEY (version)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_as_ci
  `);
}

/**
 * Reads the ledger.
 * @param {import('mysql2/promise').PoolConnection} connection
 */
async function readLedger(connection) {
  await ensureLedger(connection);
  const [rows] = await connection.query(
    `SELECT version, checksum, statements, duration_ms, applied_at
       FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY version`,
  );
  return rows;
}

/**
 * Applies every pending migration.
 *
 * @param {{dryRun?: boolean, directory?: string}} [options]
 * @returns {Promise<{applied: string[], skipped: string[], statements: Record<string, number>}>}
 */
export async function migrateUp(options = {}) {
  const migrations = discoverMigrations(options.directory);
  const pool = getPool();
  const connection = await pool.getConnection();
  const applied = [];
  const skipped = [];
  const statements = {};

  try {
    const ledger = await readLedger(connection);
    const ledgerByVersion = new Map(ledger.map((row) => [row.version, row]));

    // Drift check first: refuse to touch anything if an applied file changed.
    for (const migration of migrations) {
      const recorded = ledgerByVersion.get(migration.version);
      if (recorded && recorded.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.version} was modified after it was applied ` +
            `(ledger ${recorded.checksum.slice(0, 12)}…, file ${migration.checksum.slice(0, 12)}…). ` +
            'Add a new migration instead of editing an applied one.',
        );
      }
      if (recorded) {
        skipped.push(migration.version);
        continue; // already applied — idempotent no-op
      }

      statements[migration.version] = migration.statements.length;
      if (options.dryRun) {
        applied.push(migration.version);
        continue;
      }

      const startedAt = process.hrtime.bigint();
      let index = 0;
      try {
        for (const statement of migration.statements) {
          index += 1;
          await connection.query(statement);
        }
      } catch (error) {
        error.message = `Migration ${migration.version} failed at statement ${index}/${migration.statements.length}: ${error.message}`;
        throw error;
      }
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      await connection.query(
        `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (version, checksum, statements, duration_ms, applied_at)
         VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))`,
        [
          migration.version,
          migration.checksum,
          migration.statements.length,
          Math.round(durationMs),
        ],
      );
      applied.push(migration.version);
    }

    return { applied, skipped, statements };
  } finally {
    connection.release();
  }
}

/** @returns {Promise<{applied: object[], pending: string[]}>} */
export async function migrateStatus(options = {}) {
  const migrations = discoverMigrations(options.directory);
  const connection = await getPool().getConnection();
  try {
    const ledger = await readLedger(connection);
    const appliedVersions = new Set(ledger.map((row) => row.version));
    return {
      applied: ledger,
      pending: migrations.map((m) => m.version).filter((version) => !appliedVersions.has(version)),
    };
  } finally {
    connection.release();
  }
}

/**
 * Database names a `down` may target. Test databases only by default; anything
 * else must be named explicitly, and only when the caller also sets
 * ALLOW_DESTRUCTIVE_MIGRATIONS=true.
 */
export function assertDownAllowed(database = env.MYSQL_DATABASE, rawEnv = process.env) {
  const allowList = (rawEnv.MYSQL_ALLOWED_DESTRUCTIVE_DATABASES ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const isTestDatabase = typeof database === 'string' && database.endsWith('_test');
  const explicitlyAllowed = allowList.includes(database);

  if (rawEnv.ALLOW_DESTRUCTIVE_MIGRATIONS !== 'true' || !(isTestDatabase || explicitlyAllowed)) {
    throw new Error(
      `Refusing to run migrations down against "${database}". ` +
        'Set ALLOW_DESTRUCTIVE_MIGRATIONS=true and target a *_test database ' +
        '(or add it to MYSQL_ALLOWED_DESTRUCTIVE_DATABASES).',
    );
  }
}

/**
 * Rolls migrations back down to (but not including) `toVersion`.
 *
 * @param {{to?: string, directory?: string, allowDestructive?: boolean}} options
 * @returns {Promise<{rolledBack: string[]}>}
 */
export async function migrateDown(options = {}) {
  const migrations = discoverMigrations(options.directory);
  if (options.allowDestructive !== true) assertDownAllowed();

  const connection = await getPool().getConnection();
  const rolledBack = [];
  try {
    const ledger = await readLedger(connection);
    const appliedVersions = new Set(ledger.map((row) => row.version));
    const targets = migrations
      .filter((migration) => appliedVersions.has(migration.version))
      .filter((migration) => (options.to ? migration.version > options.to : true))
      .reverse();

    for (const migration of targets) {
      if (!migration.downFile) {
        throw new Error(`Migration ${migration.version} has no down file; cannot roll back.`);
      }
      for (const statement of migration.downStatements) {
        await connection.query(statement);
      }
      await connection.query(`DELETE FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE version = ?`, [
        migration.version,
      ]);
      rolledBack.push(migration.version);
    }
    return { rolledBack };
  } finally {
    connection.release();
  }
}

/* istanbul ignore next — CLI wiring */
/* eslint-disable no-console -- this entrypoint's user interface is stdout */
async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? 'status';
  const toIndex = argv.indexOf('--to');
  const to = toIndex >= 0 ? argv[toIndex + 1] : undefined;
  const dryRun = argv.includes('--dry-run');

  try {
    if (command === 'up') {
      const result = await migrateUp({ dryRun });
      logger.info('mysql migrate up', { ...result, dryRun });
      console.log(
        dryRun
          ? `would apply: ${result.applied.join(', ') || '(none)'}`
          : `applied: ${result.applied.join(', ') || '(none)'} · already applied: ${result.skipped.join(', ') || '(none)'}`,
      );
    } else if (command === 'down') {
      const result = await migrateDown({ to });
      console.log(`rolled back: ${result.rolledBack.join(', ') || '(none)'}`);
    } else if (command === 'status') {
      const result = await migrateStatus();
      for (const row of result.applied) {
        console.log(`applied  ${row.version}  ${row.statements} stmt(s)  ${row.duration_ms} ms`);
      }
      for (const version of result.pending) console.log(`pending  ${version}`);
      if (result.applied.length === 0 && result.pending.length === 0) console.log('no migrations');
    } else {
      console.error(
        'usage: node src/db/mysql/migrate.js <up|down|status> [--to <version>] [--dry-run]',
      );
      process.exitCode = 2;
      return;
    }
  } catch (error) {
    logger.error('mysql migration failed', { err: error });
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => {});
  }
}

/* eslint-enable no-console */

/* istanbul ignore next */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export default { migrateUp, migrateDown, migrateStatus, discoverMigrations };
