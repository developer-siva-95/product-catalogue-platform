/**
 * Self-contained API for end-to-end tests — on either provider.
 *
 * `DATABASE_PROVIDER=mongodb`: boots a disposable in-memory MongoDB.
 * `DATABASE_PROVIDER=mysql`: rebuilds the schema of a dedicated `*_test` database
 * from the migration files and seeds it. Nothing else changes — the same seeds,
 * the same API, the same SPA; only the storage behind the repository layer moves,
 * which is exactly what "the frontend behaves identically on both providers" has
 * to mean.
 *
 * Environment variables must be set *before* `config/env.js` is imported, because
 * that module validates and freezes the configuration at import time; hence the
 * dynamic imports below.
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Same default as the application (src/config/env.js): MySQL. Every caller that
// wants MongoDB — playwright.config.js, the audit scripts — passes it explicitly,
// so a harness run never picks a provider by accident.
const provider = process.env.DATABASE_PROVIDER ?? 'mysql';
const apiPort = Number(process.env.E2E_API_PORT ?? 5050);
const mongoPort = Number(process.env.E2E_MONGO_PORT ?? 27998);
const webOrigin = process.env.E2E_WEB_ORIGIN ?? 'http://127.0.0.1:4173';

// Scratch space lives under the repo's (snapshot-excluded) `.cache` directory
// rather than the OS temp dir: a seeded run writes ~20 product images plus a
// MongoDB data directory, which is enough to fill a small /tmp tmpfs.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratchRoot = process.env.E2E_SCRATCH_DIR ?? path.join(repoRoot, '.cache', 'catalogue-e2e');
const mongoDir = path.join(scratchRoot, 'mongo');
const uploadsDir = path.join(scratchRoot, 'uploads');

if (!['mongodb', 'mysql'].includes(provider)) {
  throw new Error(`Unsupported DATABASE_PROVIDER "${provider}" for the E2E server.`);
}

if (provider === 'mysql') {
  const database = process.env.MYSQL_DATABASE ?? '';
  if (!database.endsWith('_test')) {
    throw new Error(
      `Refusing to run the MySQL E2E server against "${database || '<unset>'}": the database name must end with "_test".`,
    );
  }
  for (const key of ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER']) {
    if (!process.env[key])
      throw new Error(`MYSQL_* is incomplete for the E2E server: ${key} unset.`);
  }
}

// Always start from an empty database and empty upload directory.
await fs.rm(scratchRoot, { recursive: true, force: true });
await fs.mkdir(mongoDir, { recursive: true });
await fs.mkdir(uploadsDir, { recursive: true });

let mongo = null;

if (provider === 'mongodb') {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  mongo = await MongoMemoryServer.create({
    instance: {
      port: mongoPort,
      dbName: 'catalogue-e2e',
      dbPath: mongoDir,
      args: ['--wiredTigerCacheSizeGB', '0.25'],
    },
  });
  process.env.MONGO_URI = mongo.getUri('catalogue-e2e');
}

process.env.NODE_ENV = 'development';
process.env.DATABASE_PROVIDER = provider;
process.env.JWT_SECRET ??= 'e2e-only-secret-5c1d8fa4b27e9306d1c47ab8';
process.env.FRONTEND_URL = webOrigin;
process.env.PORT = String(apiPort);
process.env.COOKIE_SECURE = 'false';
process.env.COOKIE_SAME_SITE = 'lax';
process.env.UPLOAD_DIR = uploadsDir;
// Keep the API quiet: the SPA intentionally probes /auth/me before login, and a
// 401 there is expected behaviour, not something the test output should shout about.
process.env.LOG_LEVEL ??= 'error';

if (provider === 'mysql') {
  // Rebuild the schema from the migration files: the E2E database must match
  // production DDL exactly, and every run has to start from a known-empty state.
  process.env.ALLOW_DESTRUCTIVE_MIGRATIONS = 'true';
  const { migrateDown, migrateUp } = await import('../src/db/mysql/migrate.js');
  try {
    await migrateDown({ allowDestructive: true });
  } catch (error) {
    // A database that has never been migrated has nothing to roll back.
    if (error.code !== 'MIGRATION_LEDGER_MISSING') throw error;
  }
  await migrateUp();
}

const { connectDatabase, disconnectDatabase } = await import('../src/db/index.js');
const { runSeed } = await import('../src/config/seed.js');
const { createApp } = await import('../src/app.js');

const capabilities = await connectDatabase();
const summary = await runSeed();

const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(apiPort, '0.0.0.0', resolve));

process.stdout.write(
  `e2e api ready on http://127.0.0.1:${apiPort} ` +
    `(provider: ${provider}, products: ${summary.products.created}, ` +
    `brands: ${summary.brands}, categories: ${summary.categories}, ` +
    `transactions: ${capabilities.transactions})\n`,
);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise((resolve) => server.close(resolve));
  await disconnectDatabase();
  if (mongo) await mongo.stop();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
