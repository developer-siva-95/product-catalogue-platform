import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  noStoreDynamic,
  noStorePrivate,
} from '../../src/middlewares/noStore.js';

/**
 * Unit coverage for the HTTP-cache policy.
 *
 * The RTK Query cache is a *client* cache and is irrelevant here: these headers are
 * what stop the browser (or an intermediary) from answering a navigation or a
 * refresh with a stored copy of a dynamic product response. The middleware is
 * mounted only on the product routers, so it is exercised on a minimal app rather
 * than through the whole products module (which would need a database for no extra
 * signal).
 */

function buildApp(handler) {
  const app = express();
  app.get('/public/products', noStoreDynamic, handler);
  app.get('/admin/products', noStorePrivate, handler);
  app.get('/uploads/product.png', (req, res) => res.type('png').send('binary'));
  app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));
  return app;
}

const echo = (_req, res) => res.json({ data: [{ id: 'p1' }] });

describe('noStoreDynamic', () => {
  it('forbids storing a dynamic storefront response', async () => {
    const response = await request(buildApp(echo)).get('/public/products');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers.expires).toBe('0');
  });

  it('applies the same policy to error responses on the same route', async () => {
    const app = buildApp((_req, res) => res.status(500).json({ error: { code: 'X' } }));
    const response = await request(app).get('/public/products');

    expect(response.status).toBe(500);
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('does not add a public/immutable policy — that would be the opposite claim', async () => {
    const response = await request(buildApp(echo)).get('/public/products');
    expect(response.headers['cache-control']).not.toContain('public');
    expect(response.headers['cache-control']).not.toContain('immutable');
  });
});

describe('noStorePrivate', () => {
  it('marks authenticated admin payloads as private and unstorable', async () => {
    const response = await request(buildApp(echo)).get('/admin/products');

    expect(response.headers['cache-control']).toBe(
      'no-store, no-cache, must-revalidate, private',
    );
    expect(response.headers.vary).toMatch(/Cookie/);
    expect(response.headers.vary).toMatch(/Authorization/);
  });
});

describe('cache policy is scoped to the product routers', () => {
  it('leaves static uploads on their long-lived immutable policy', async () => {
    const response = await request(buildApp(echo)).get('/uploads/product.png');
    // The middleware was never applied to this route; whatever the static handler
    // sets is untouched (here: nothing, because this stub sets no policy at all).
    expect(response.headers['cache-control']).toBeUndefined();
  });

  it('leaves non-product API routes untouched', async () => {
    const response = await request(buildApp(echo)).get('/api/v1/health');
    expect(response.headers['cache-control']).toBeUndefined();
  });
});
