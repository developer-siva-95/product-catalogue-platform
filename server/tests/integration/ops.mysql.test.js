import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/app.js';
import { shouldSkipMysql } from '../helpers/mysql.js';
import { closePool, resetMysqlSchema } from '../helpers/mysql-db.js';
import { isPoolCreated } from '../../src/db/mysql/pool.js';
import * as mysqlProvider from '../../src/db/mysql/provider.js';
import * as mongoProvider from '../../src/db/mongo/provider.js';
import { assertTransactionCapability, getDatabaseState } from '../../src/db/index.js';

/**
 * Operational surface, MySQL provider (Phase 7).
 *
 * Runs with `DATABASE_PROVIDER=mysql`, so `/health` is answering through the MySQL
 * adapter exactly as it would in a MySQL deployment.
 */
const app = createApp();

/**
 * Asserts the `/health` envelope in full.
 *
 * "The degraded body shape is unchanged" is the part of the approved change that
 * could bite a dashboard: only the status code moves (200 → 503), the payload's
 * keys, order and meaning do not. Both providers are held to the same shape, so a
 * client can parse either.
 */
function expectHealthPayload(response, { status, database, state }) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/application\/json/);
  expect(Object.keys(response.body)).toEqual(['success', 'message', 'data', 'requestId']);
  expect(response.body.success).toBe(true);
  expect(response.body.requestId).toEqual(expect.any(String));
  expect(response.body.message).toBe(status === 200 ? 'Service healthy' : 'Service degraded');
  expect(Object.keys(response.body.data)).toEqual([
    'status',
    'uptimeSeconds',
    'database',
    'environment',
  ]);
  expect(response.body.data.status).toBe(state);
  expect(response.body.data.database).toBe(database);
  expect(typeof response.body.data.uptimeSeconds).toBe('number');
  expect(response.body.data.environment).toBe('test');
}

const skip =
  shouldSkipMysql() || process.env.DATABASE_PROVIDER !== 'mysql'
    ? 'set DATABASE_PROVIDER=mysql and the MYSQL_TEST_* credentials'
    : false;

describe.skipIf(skip)('health endpoint [mysql]', () => {
  beforeAll(async () => {
    await resetMysqlSchema();
    await mysqlProvider.connect();
  }, 90_000);

  afterAll(async () => {
    await mysqlProvider.disconnect();
    await closePool();
  }, 60_000);

  it('reports ok with 200 and the same payload shape as MongoDB', async () => {
    const response = await request(app).get('/api/v1/health');

    expectHealthPayload(response, { status: 200, database: 'connected', state: 'ok' });
    expect(getDatabaseState().provider).toBe('mysql');
  });

  it('reports degraded with 503 after disconnect, without reopening a pool', async () => {
    await mysqlProvider.disconnect();
    expect(isPoolCreated()).toBe(false);

    const response = await request(app).get('/api/v1/health');

    // Approved change (Phase 7): 503 on the degraded state, identical body shape.
    expectHealthPayload(response, { status: 503, database: 'disconnected', state: 'degraded' });
    // A health probe must never open sockets: that is how a monitoring loop
    // exhausts max_connections.
    expect(isPoolCreated()).toBe(false);
  });

  it('releases every pooled connection on disconnect (graceful shutdown)', async () => {
    await mysqlProvider.connect();
    const health = await mysqlProvider.health();
    expect(health.ok).toBe(true);
    expect(isPoolCreated()).toBe(true);

    await mysqlProvider.disconnect();
    expect(isPoolCreated()).toBe(false);
    expect(mysqlProvider.state()).toMatchObject({ status: 'disconnected', isConnected: false });
  });

  it('reports transaction capability for the deployment (policy D2(a))', async () => {
    await mysqlProvider.connect();
    const capabilities = await mysqlProvider.probe();

    expect(capabilities).toMatchObject({
      provider: 'mysql',
      transactions: true,
      storageEngine: 'InnoDB',
    });
    expect(assertTransactionCapability(capabilities, true)).toBe(true);
    expect(Object.keys(capabilities)).toEqual(expect.arrayContaining(['provider', 'transactions']));
  });
});

describe('provider parity of the operational contract', () => {
  it('both adapters expose the identical surface', () => {
    const surface = [
      'name',
      'connect',
      'disconnect',
      'state',
      'probe',
      'withTransaction',
      'health',
    ];

    for (const adapter of [mongoProvider, mysqlProvider]) {
      for (const member of surface) {
        expect({
          provider: adapter.name,
          member,
          present: typeof adapter[member] !== 'undefined',
        }).toEqual({ provider: adapter.name, member, present: true });
      }
    }
  });
});
