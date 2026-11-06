import rateLimit, { MemoryStore } from 'express-rate-limit';
import env from '../config/env.js';
import { HTTP_STATUS } from '../constants/httpStatusCodes.js';
import { RATE_LIMITS } from '../constants/appConstants.js';

/**
 * Rate limiters.
 *
 * `test` environment gets the same limits (behaviour must be testable) but tests
 * reset the store between cases via `resetAllRateLimits()`.
 */
const commonOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  // Rate limiting is disabled only when explicitly opted out (e.g. load tests).
  skip: () => process.env.DISABLE_RATE_LIMIT === 'true',
  handler: (req, res) => {
    res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
      success: false,
      message: 'Too many requests, please slow down and try again later.',
      error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: 60 } },
      requestId: req.id ?? null,
    });
  },
};

/**
 * Explicit store instances (instead of the implicit default) so the counters can
 * be inspected/reset programmatically — required by the rate-limit tests and by
 * operational tooling. In a multi-instance deployment these would be swapped for
 * a Redis store without touching call sites.
 */
export const limiterStores = {
  api: new MemoryStore(),
  login: new MemoryStore(),
  upload: new MemoryStore(),
};

/** Coarse protection for the whole API surface. */
export const apiLimiter = rateLimit({
  ...commonOptions,
  store: limiterStores.api,
  windowMs: env.RATE_LIMIT_WINDOW_MS ?? RATE_LIMITS.WINDOW_MS,
  // Evaluated per request: lets tests tighten the ceiling and operators tune it
  // without rebuilding the middleware.
  limit: () => Number(process.env.RATE_LIMIT_MAX ?? env.RATE_LIMIT_MAX ?? RATE_LIMITS.MAX),
});

/**
 * Brute-force protection for credential endpoints: per-IP, much tighter window.
 * (Per-account lockout is enforced independently in the auth service, so an
 * attacker rotating IPs still gets locked out on the target account.)
 */
export const loginLimiter = rateLimit({
  ...commonOptions,
  store: limiterStores.login,
  windowMs: RATE_LIMITS.LOGIN_WINDOW_MS,
  limit: () =>
    Number(process.env.LOGIN_RATE_LIMIT_MAX ?? env.LOGIN_RATE_LIMIT_MAX ?? RATE_LIMITS.LOGIN_MAX),
  // Successful sign-ins do not count against the brute-force budget.
  skipSuccessfulRequests: true,
});

/** Prevents abusive upload volume (each upload is CPU-expensive due to sharp). */
export const uploadLimiter = rateLimit({
  ...commonOptions,
  store: limiterStores.upload,
  windowMs: 60 * 1000,
  limit: () => 30,
});

/**
 * Clears every counter. Used by tests (deterministic isolation) and by operators
 * after an incident (e.g. wrongly tripped limits).
 */
export function resetAllRateLimits() {
  for (const store of Object.values(limiterStores)) {
    store.resetAll();
  }
}

export default { apiLimiter, loginLimiter, uploadLimiter, resetAllRateLimits };
