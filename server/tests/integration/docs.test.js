import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { openApiSpec } from '../../src/config/swagger.js';
import { API_PREFIX } from '../../src/constants/appConstants.js';
import { apiRouter, routeMounts } from '../../src/routes/index.js';

/**
 * Lowest-level introspection of the Express router so the OpenAPI document can
 * be compared against reality (rather than against a hand-maintained list).
 *
 * Express 5 replaced `layer.regexp` with opaque path-to-regexp matchers, so a
 * mounted router's path can no longer be recovered from the layer itself. The
 * mount table exported by `src/routes/index.js` is therefore used as the prefix
 * source, and the walker refuses to pass if the router tree contains a mount
 * that the table does not know about — the documented surface still cannot drift
 * away from the implemented one.
 */
function collectExpressOperations(app, apiRouter) {
  const operations = [];

  /** Collects `METHOD /path` pairs from a router (recursively, for nested mounts). */
  const walkRouter = (router, prefix) => {
    const mounts = [];
    for (const layer of router.stack) {
      if (layer.route) {
        const raw = `${prefix}${layer.route.path}`.replace(/\/+$/, '');
        const path = raw === '' ? '/' : raw;
        for (const method of Object.keys(layer.route.methods)) {
          operations.push({ method: method.toUpperCase(), path });
        }
      } else if (layer.handle?.stack) {
        mounts.push(layer);
      }
    }
    return mounts;
  };

  // Routes registered directly on the app (the API banner and the spec itself).
  walkRouter(app.router, '');

  // Routes registered directly on the versioned API router (`/health`).
  walkRouter(apiRouter, API_PREFIX);

  // Every mounted domain router, using the exported mount table.
  for (const mount of routeMounts) {
    walkRouter(mount.router, `${API_PREFIX}${mount.path}`);
  }

  // Guard: the API router must not contain a sub-router that is missing from the
  // mount table (otherwise those routes would silently escape the comparison).
  const unknownMounts = walkRouter(apiRouter, API_PREFIX).length - routeMounts.length;
  if (unknownMounts !== 0) {
    throw new Error(
      `API router exposes ${unknownMounts} mount(s) missing from routeMounts — update src/routes/index.js`,
    );
  }

  return operations;
}

/** Non-API-project surface: the API root banner and the spec itself. */
const EXCLUDED_PATHS = new Set(['/', `${API_PREFIX}/docs.json`]);

describe('OpenAPI documentation', () => {
  let app;
  let expressOperations;

  beforeAll(() => {
    app = createApp();
    expressOperations = collectExpressOperations(app, apiRouter).filter(
      (operation) => !EXCLUDED_PATHS.has(operation.path),
    );
  });

  it('is a valid OpenAPI 3 document with components and tags', () => {
    expect(openApiSpec.openapi).toMatch(/^3\./);
    expect(openApiSpec.info.title).toBe('Product Catalogue API');
    expect(Object.keys(openApiSpec.components.securitySchemes)).toEqual(
      expect.arrayContaining(['cookieAuth', 'bearerAuth']),
    );
    expect(openApiSpec.tags.map((tag) => tag.name)).toEqual(
      expect.arrayContaining(['Authentication', 'Storefront', 'Admin', 'Taxonomy']),
    );
  });

  it('documents every route registered on the Express app', () => {
    const documented = new Set();
    for (const [path, item] of Object.entries(openApiSpec.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        if (item[method]) documented.add(`${method.toUpperCase()} ${path}`);
      }
    }

    const missing = expressOperations
      .map(({ method, path }) => `${method} ${path.replace(/:(\w+)/g, '{$1}')}`)
      .filter((operation) => !documented.has(operation));

    expect(missing).toEqual([]);
    expect(expressOperations.length).toBeGreaterThan(20);
  });

  it('does not document endpoints that do not exist', () => {
    const implemented = new Set(
      expressOperations.map(({ method, path }) => `${method} ${path.replace(/:(\w+)/g, '{$1}')}`),
    );

    const phantom = [];
    for (const [path, item] of Object.entries(openApiSpec.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        if (item[method] && !implemented.has(`${method.toUpperCase()} ${path}`)) {
          phantom.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(phantom).toEqual([]);
  });

  it('requires the CSRF header on every unsafe operation', () => {
    const unsafe = [];
    for (const [path, item] of Object.entries(openApiSpec.paths)) {
      for (const method of ['post', 'put', 'patch', 'delete']) {
        const operation = item[method];
        if (!operation) continue;
        const hasCsrf = (operation.parameters ?? []).some(
          (parameter) => parameter.in === 'header' && parameter.name === 'X-CSRF-Token',
        );
        if (!hasCsrf) unsafe.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(unsafe).toEqual([]);
  });

  it('declares authentication and a 403 response for every admin operation', () => {
    for (const [path, item] of Object.entries(openApiSpec.paths)) {
      if (!path.startsWith(`${API_PREFIX}/admin`)) continue;
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        const operation = item[method];
        if (!operation) continue;
        expect(operation.security, `${method} ${path} must declare security`).toBeDefined();
        expect(Object.keys(operation.responses)).toContain('403');
      }
    }
  });

  it('marks public storefront reads as unauthenticated', () => {
    for (const path of [
      `${API_PREFIX}/products`,
      `${API_PREFIX}/products/{id}`,
      `${API_PREFIX}/brands`,
      `${API_PREFIX}/categories`,
      `${API_PREFIX}/health`,
    ]) {
      expect(openApiSpec.paths[path].get.security).toEqual([]);
    }
  });

  it('serves the machine-readable spec at /docs.json', async () => {
    const response = await request(app).get(`${API_PREFIX}/docs.json`);
    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe(openApiSpec.openapi);
    expect(Object.keys(response.body.paths).length).toBe(Object.keys(openApiSpec.paths).length);
  });

  it('serves the Swagger UI with a CSP that allows it to render', async () => {
    const response = await request(app).get(`${API_PREFIX}/docs/`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.headers['content-security-policy']).toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(response.text).toContain('swagger-ui');
  });
});
