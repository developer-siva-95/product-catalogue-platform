import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createApp } from '../../src/app.js';
import { errorHandler } from '../../src/middlewares/errorHandler.js';
import { notFoundHandler } from '../../src/middlewares/notFound.js';
import { ApiError } from '../../src/utils/ApiError.js';
import * as productController from '../../src/modules/products/controller.js';
import * as brandController from '../../src/modules/brands/controller.js';
import * as categoryController from '../../src/modules/categories/controller.js';
import * as authController from '../../src/modules/auth/controller.js';
import { connectTestDB, disconnectTestDB, clearDatabase } from '../helpers/db.js';
import { resetAllRateLimits } from '../../src/middlewares/rateLimiter.js';

/**
 * Express 5 forwards rejected promises from async handlers and middleware to the
 * error middleware automatically, which is why the codebase no longer wraps
 * controllers in `asyncHandler`. These tests pin that behaviour end-to-end so the
 * guarantee can never silently regress:
 *
 *  - a rejected controller promise reaches the *real* global error handler;
 *  - the response keeps the standard envelope (`success:false`, `error.code`, `requestId`);
 *  - plain `Error`s become 500s, `ApiError`s keep their status/code;
 *  - rejections from middleware (not just controllers) are caught too;
 *  - nothing escapes as an unhandled rejection.
 */
describe('Express 5 native async rejection handling', () => {
  let app;
  const unhandled = [];

  const onUnhandled = (reason) => unhandled.push(reason);

  beforeAll(async () => {
    await connectTestDB();
    app = createApp();
    process.on('unhandledRejection', onUnhandled);
  });

  afterAll(async () => {
    process.off('unhandledRejection', onUnhandled);
    await disconnectTestDB();
  });

  afterEach(async () => {
    resetAllRateLimits();
    await clearDatabase();
  });

  it('routes a rejected controller promise to the global error handler (real app)', async () => {
    const response = await request(app).get('/api/v1/products/zzzz-not-a-product');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toMatchObject({
      success: false,
      message: 'Product not found',
      error: { code: 'PRODUCT_NOT_FOUND' },
    });
    expect(response.body.requestId).toBeTruthy();
  });

  it('routes a rejected auth middleware promise to the global error handler (real app)', async () => {
    const response = await request(app).get('/api/v1/admin/products');

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('AUTH_REQUIRED');
    expect(response.body.requestId).toBeTruthy();
  });

  it('no controller is wrapped in a manual async wrapper any more', () => {
    const controllers = {
      ...productController,
      ...brandController,
      ...categoryController,
      ...authController,
    };
    const handlers = Object.entries(controllers).filter(([, value]) => typeof value === 'function');

    expect(handlers.length).toBeGreaterThanOrEqual(26);
    for (const [name, handler] of handlers) {
      // A wrapper would expose arity 3 and lose the AsyncFunction prototype.
      expect(handler.constructor.name, `${name} should be a plain async function`).toBe(
        'AsyncFunction',
      );
      expect(handler.length, `${name} should not be a wrapper`).toBeLessThanOrEqual(2);
    }
  });

  describe('in a minimal app using the real error middleware', () => {
    const buildApp = (register) => {
      const mini = express();
      mini.use(express.json());
      register(mini);
      mini.use(notFoundHandler);
      mini.use(errorHandler);
      return mini;
    };

    it('converts a rejected promise with an unexpected Error into a generic 500 envelope', async () => {
      const mini = buildApp((instance) => {
        instance.get('/boom', async () => {
          throw new Error('kaboom');
        });
      });

      const response = await request(mini).get('/boom');

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        success: false,
        message: 'Something went wrong',
        error: { code: 'INTERNAL_ERROR' },
      });
      // The thrown message is never surfaced as the client-facing message
      // (outside production it is still available in the dev-only stack field).
      expect(response.body.message).not.toBe('kaboom');
    });

    it('attaches a stack trace outside production and omits it in production', async () => {
      const mini = buildApp((instance) => {
        instance.get('/boom', async () => {
          throw new ApiError(409, 'Version mismatch', { code: 'STALE_RESOURCE' });
        });
      });

      const previous = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'test';
        const dev = await request(mini).get('/boom');
        expect(dev.status).toBe(409);
        expect(typeof dev.body.error.stack).toBe('string');

        process.env.NODE_ENV = 'production';
        const prod = await request(mini).get('/boom');
        expect(prod.status).toBe(409);
        expect(prod.body.error.stack).toBeUndefined();
        // Operational errors keep their message in production.
        expect(prod.body.message).toBe('Version mismatch');
      } finally {
        process.env.NODE_ENV = previous;
      }
    });

    it('preserves the status and code of an ApiError thrown asynchronously', async () => {
      const mini = buildApp((instance) => {
        instance.post('/conflict', async () => {
          throw new ApiError(409, 'Version mismatch', { code: 'STALE_RESOURCE' });
        });
      });

      const response = await request(mini).post('/conflict').send({});

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        success: false,
        message: 'Version mismatch',
        error: { code: 'STALE_RESOURCE' },
      });
    });

    it('catches synchronous throws inside async handlers as well', async () => {
      const mini = buildApp((instance) => {
        instance.get('/sync-throw', async () => {
          throw new ApiError(418, 'Teapot', { code: 'TEAPOT' });
        });
      });

      const response = await request(mini).get('/sync-throw');

      expect(response.status).toBe(418);
      expect(response.body.error.code).toBe('TEAPOT');
    });

    it('catches rejections raised by async middleware before the handler runs', async () => {
      let handlerRan = false;
      const mini = buildApp((instance) => {
        instance.get(
          '/guarded',
          async (_req, _res, next) => {
            await Promise.resolve();
            next(new ApiError(403, 'Nope', { code: 'GUARD_DENIED' }));
          },
          async (_req, res) => {
            handlerRan = true;
            res.json({ ok: true });
          },
        );
        instance.get(
          '/rejecting-middleware',
          async () => {
            await Promise.resolve();
            throw new ApiError(403, 'Rejected in middleware', { code: 'MW_REJECTED' });
          },
          async (_req, res) => {
            handlerRan = true;
            res.json({ ok: true });
          },
        );
      });

      const denied = await request(mini).get('/guarded');
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('GUARD_DENIED');

      const rejected = await request(mini).get('/rejecting-middleware');
      expect(rejected.status).toBe(403);
      expect(rejected.body.error.code).toBe('MW_REJECTED');

      expect(handlerRan).toBe(false);
    });

    it('still returns the 404 envelope for unmatched routes', async () => {
      const mini = buildApp((instance) => {
        instance.get('/exists', (_req, res) => res.json({ ok: true }));
      });

      const response = await request(mini).get('/nope');

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        success: false,
        error: { code: 'ROUTE_NOT_FOUND' },
      });
    });
  });

  it('leaves no unhandled promise rejections behind', async () => {
    // Give the microtask/event loop a chance to surface anything that escaped.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });
});
