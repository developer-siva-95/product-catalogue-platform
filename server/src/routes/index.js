import { Router } from 'express';
import { sendSuccess } from '../utils/apiResponse.js';
import { getDatabaseState } from '../db/index.js';
import { HTTP_STATUS } from '../constants/httpStatusCodes.js';
import { authRouter } from '../modules/auth/routes.js';
import { brandRouter } from '../modules/brands/routes.js';
import { categoryRouter } from '../modules/categories/routes.js';
import { adminProductRouter, productRouter } from '../modules/products/routes.js';

/**
 * Versioned API surface aggregator (`/api/v1`).
 * Each domain module exports its own router; this file is the only place that
 * knows the URL layout, which keeps modules independent of each other.
 */
export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  const db = getDatabaseState();
  const healthy = db.status === 'connected';
  // The status code MUST be passed through `sendSuccess`: setting it beforehand
  // was silently overwritten by the helper's default 200, so a degraded service
  // answered `200` with `"status": "degraded"` in the body. Every orchestrator and
  // load balancer keys off the code, not the body (found in Phase 7).
  return sendSuccess(res, {
    statusCode: healthy ? HTTP_STATUS.OK : HTTP_STATUS.SERVICE_UNAVAILABLE,
    message: healthy ? 'Service healthy' : 'Service degraded',
    data: {
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      database: db.status,
      environment: process.env.NODE_ENV ?? 'development',
    },
  });
});

/**
 * Single source of truth for where each domain router is mounted. Exported so
 * documentation tooling (and the OpenAPI parity test) can walk the real router
 * tree instead of re-declaring the URL layout: Express 5 no longer exposes a
 * mounted router's path on its layer, and duplicating the paths in a test would
 * let the documented surface drift away from the implemented one.
 */
export const routeMounts = [
  { path: '/auth', router: authRouter },
  { path: '/brands', router: brandRouter },
  { path: '/categories', router: categoryRouter },
  { path: '/products', router: productRouter },
  { path: '/admin/products', router: adminProductRouter },
];

for (const mount of routeMounts) {
  apiRouter.use(mount.path, mount.router);
}

export default apiRouter;
