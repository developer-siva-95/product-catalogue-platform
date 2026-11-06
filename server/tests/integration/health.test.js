import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { connectTestDB, disconnectTestDB } from '../helpers/db.js';

describe('core infrastructure (health, 404, CORS, body limits)', () => {
  let app;

  beforeAll(async () => {
    await connectTestDB();
    app = createApp();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  it('GET /api/v1/health returns the standard envelope and a request id header', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(/[a-z0-9-]{8,}/i);
    expect(res.body).toMatchObject({
      success: true,
      data: { status: 'ok', database: 'connected' },
    });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('echoes a caller-supplied request id when it is well formed', async () => {
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'abc-123-def-456');
    expect(res.headers['x-request-id']).toBe('abc-123-def-456');
  });

  it('discards a malformed caller-supplied request id and mints its own', async () => {
    // Values with CRLF cannot be sent by a well-behaved client (Node refuses the
    // header outright) — the CRLF path is covered in tests/unit/requestId.test.js.
    const res = await request(app).get('/api/v1/health').set('X-Request-Id', 'bad value!');
    expect(res.headers['x-request-id']).not.toBe('bad value!');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns a 404 envelope for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'ROUTE_NOT_FOUND' } });
  });

  it('allows the configured frontend origin and sends credentials headers', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects an unknown origin with 403 (CORS is not a wildcard)', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORS_ORIGIN_DENIED');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('responds 413 for an oversized JSON body', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(200 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('responds 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"broken": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('exposes the API root document', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe('v1');
  });
});
