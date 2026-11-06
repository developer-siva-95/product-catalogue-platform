import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import env from './config/env.js';
import logger from './utils/logger.js';
import { API_PREFIX, JSON_BODY_SIZE_LIMIT, BODY_SIZE_LIMIT } from './constants/appConstants.js';
import { requestId } from './middlewares/requestId.js';
import { sanitizeRequest } from './middlewares/sanitize.js';
import { apiLimiter } from './middlewares/rateLimiter.js';
import { csrfProtection } from './middlewares/csrf.js';
import { notFoundHandler } from './middlewares/notFound.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { apiRouter } from './routes/index.js';
import { sendSuccess } from './utils/apiResponse.js';
import { mountApiDocs } from './config/swagger.js';
import { ApiError } from './utils/ApiError.js';

/**
 * Builds the Express application.
 *
 * Ordering matters and is deliberate:
 *  1. security headers   (helmet)
 *  2. CORS               (must run before anything that can respond 4xx)
 *  3. cookie/body parse  (needed by validators)
 *  4. sanitisation       (before validation)
 *  5. request id + logs
 *  6. static uploads
 *  7. rate limiting      (never cushions static asset delivery)
 *  8. API routes
 *  9. 404 + central error handler (must be last)
 */
export function createApp() {
  const app = express();

  app.locals.logger = logger;
  app.disable('x-powered-by');

  // Behind a trusted reverse proxy (nginx/ALB) req.ip must be derived from
  // X-Forwarded-For, otherwise rate limiting would key on the proxy IP.
  app.set('trust proxy', env.isProduction ? 1 : false);

  app.use(
    helmet({
      // Product images are served from this origin and embedded by the SPA on
      // another origin, so CORP must allow cross-origin consumption.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: env.isProduction ? undefined : false,
    }),
  );

  const allowedOrigins = new Set([env.FRONTEND_URL]);
  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin/server-to-server requests have no Origin header.
        if (!origin) return callback(null, true);
        if (allowedOrigins.has(origin)) return callback(null, true);
        return callback(
          ApiError.forbidden(`Origin ${origin} is not allowed by CORS`, {
            code: 'CORS_ORIGIN_DENIED',
          }),
        );
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id', 'Accept'],
      exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'Retry-After'],
      maxAge: 600,
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: JSON_BODY_SIZE_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: BODY_SIZE_LIMIT }));

  app.use(sanitizeRequest);
  app.use(requestId);

  // Structured access log (skipped in tests to keep output readable).
  if (!env.isTest) {
    app.use((req, res, next) => {
      const startedAt = process.hrtime.bigint();
      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
        logger[level]('http request', {
          requestId: req.id,
          method: req.method,
          url: req.originalUrl,
          statusCode: res.statusCode,
          durationMs: Number(durationMs.toFixed(2)),
        });
      });
      next();
    });
  }

  // Uploaded images: long-lived cache, no directory listing, no dotfiles.
  app.use(
    env.PUBLIC_UPLOAD_PATH,
    express.static(env.uploadDir, {
      index: false,
      dotfiles: 'deny',
      maxAge: '7d',
      immutable: true,
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      },
    }),
  );

  // API documentation (Swagger UI + machine-readable spec). Mounted before the
  // router so it is not subject to the API rate limiter.
  mountApiDocs(app);

  app.get('/', (_req, res) =>
    sendSuccess(res, {
      message: 'Catalogue API',
      data: { name: 'Catalogue API', version: 'v1', docs: `${API_PREFIX}/docs` },
    }),
  );

  // Rate limit first (cheap rejection), then CSRF for every unsafe method, then
  // the versioned API surface.
  app.use(API_PREFIX, apiLimiter, csrfProtection, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
