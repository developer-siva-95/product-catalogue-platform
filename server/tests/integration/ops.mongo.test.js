import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/app.js';
import { connectTestDB, disconnectTestDB } from '../helpers/db.js';
import { getDatabaseState } from '../../src/db/index.js';

/**
 * Operational surface, MongoDB provider (Phase 7).
 *
 * `/health` is the only endpoint here and its **response shape does not change**:
 * these tests pin the 200-healthy / 503-degraded behaviour and the exact key order
 * an orchestrator or dashboard already depends on.
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

describe('health endpoint [mongodb]', () => {
  beforeAll(async () => {
    await connectTestDB();
  });

  afterAll(async () => {
    await connectTestDB();
    await disconnectTestDB();
  });

  it('reports ok with 200 when the provider is connected', async () => {
    const response = await request(app).get('/api/v1/health');

    expectHealthPayload(response, { status: 200, database: 'connected', state: 'ok' });
  });

  it('reports degraded with 503 when the database is disconnected', async () => {
    await disconnectTestDB();
    // Proof that the state really changed before the request: if this assertion
    // fails the test below is meaningless.
    expect(getDatabaseState().status).toBe('disconnected');

    const response = await request(app).get('/api/v1/health');

    // Approved change (Phase 7): the status code is 503, the body is untouched.
    expectHealthPayload(response, { status: 503, database: 'disconnected', state: 'degraded' });

    await connectTestDB();
  }, 30_000);
});
