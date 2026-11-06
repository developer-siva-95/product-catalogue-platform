import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Test environment bootstrap.
 * Runs before every test file is imported, so `config/env.js` (which validates at
 * import time) sees a complete, intentional configuration.
 *
 * The database URI is a MongoDB Memory Server bound to 127.0.0.1:27999 started in
 * globalSetup — tests can never touch a developer's real database.
 */
export const TEST_MONGO_URI = 'mongodb://127.0.0.1:27999/catalogue_test';

process.env.NODE_ENV = 'test';
// The test harness is MongoDB-first: the application default is now MySQL, so the
// suite states its provider explicitly rather than inheriting it. `??=` keeps an
// explicit value (npm run test:mysql sets mysql) authoritative.
process.env.DATABASE_PROVIDER ??= 'mongodb';
process.env.PORT = '5099';
process.env.MONGO_URI = TEST_MONGO_URI;
process.env.JWT_SECRET = 'test-secret-3f8a1c9d2b7e4f6a8c0d1e3f5a7b9c2d4e6f8a0b';
process.env.JWT_EXPIRES_IN = '1h';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.COOKIE_SECURE = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.RATE_LIMIT_MAX = '10000';
// Uploads during tests go to a throwaway directory: the developer's uploads/
// folder is never touched, and files can be dropped wholesale afterwards.
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'catalogue-test-uploads');
process.env.LOGIN_RATE_LIMIT_MAX = '10000';

// MySQL suite credentials. Never committed: they come from MYSQL_TEST_* (the
// harness in tests/helpers/mysql.js). When absent the MySQL suites skip, so the
// default `npm run verify` needs no MySQL server at all; `MYSQL_REQUIRE=1` turns
// a missing server into a failure instead of a silent skip.
if (process.env.MYSQL_TEST_USER) {
  process.env.MYSQL_HOST = process.env.MYSQL_TEST_HOST ?? '127.0.0.1';
  process.env.MYSQL_PORT = process.env.MYSQL_TEST_PORT ?? '3306';
  process.env.MYSQL_USER = process.env.MYSQL_TEST_USER;
  process.env.MYSQL_PASSWORD = process.env.MYSQL_TEST_PASSWORD ?? '';
  process.env.MYSQL_DATABASE = process.env.MYSQL_TEST_DATABASE ?? 'storefront_it_test';
}

beforeEach((context) => {
  // Give every test a unique client IP so per-IP rate-limit counters from a
  // previous test can never interfere with this one.
  context.__clientIp = `10.0.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Removes every document from every collection. Called by integration specs in
 * beforeEach so state can never leak between tests.
 */
export async function clearDatabase() {
  if (mongoose.connection.readyState !== 1) return;
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

export { mongoose };
