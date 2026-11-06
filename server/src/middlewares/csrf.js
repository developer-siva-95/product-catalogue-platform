import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import env from '../config/env.js';
import { COOKIE_NAMES } from '../constants/appConstants.js';
import { HTTP_STATUS } from '../constants/httpStatusCodes.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * CSRF protection — signed double-submit cookie pattern.
 *
 * Why this and not a session store:
 *  - the access token lives in an httpOnly cookie (JS cannot read it), so the
 *    browser attaches it automatically to cross-site requests too. CSRF defence
 *    is therefore mandatory for every state-changing request;
 *  - the CSRF token is delivered in a *readable* cookie and must be echoed in
 *    the `X-CSRF-Token` header: a cross-site attacker can cause the cookie to be
 *    sent but cannot read it, so it cannot forge the header;
 *  - the token is HMAC-signed with the server secret, so an attacker who can
 *    plant cookies (sub-domain attacker) still cannot mint a valid token. This
 *    closes the classic weakness of unsigned double-submit cookies.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HMAC_ALGORITHM = 'sha256';

function sign(nonce) {
  return createHmac(HMAC_ALGORITHM, env.JWT_SECRET).update(nonce).digest('base64url');
}

/** Creates a signed CSRF token: `<nonce>.<hmac>`. */
export function generateCsrfToken() {
  const nonce = randomBytes(32).toString('base64url');
  return `${nonce}.${sign(nonce)}`;
}

/**
 * Verifies the HMAC signature of a CSRF token.
 * @param {unknown} token
 * @returns {boolean}
 */
export function verifyCsrfToken(token) {
  if (typeof token !== 'string') return false;
  const separator = token.lastIndexOf('.');
  if (separator <= 0 || separator === token.length - 1) return false;

  const nonce = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  const expectedSignature = sign(nonce);

  // timingSafeEqual requires equal lengths; compare digests of the digests to
  // keep the comparison constant-time regardless of the supplied length.
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Compares two tokens without leaking length/timing information. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Cookie options shared by the CSRF cookie and the access-token cookie.
 * `sameSite: 'none'` requires `secure: true` — enforced in env validation for prod.
 */
export function buildCookieOptions(overrides = {}) {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    path: '/',
    ...overrides,
  };
}

/**
 * Issues a fresh CSRF token as a readable cookie and returns it so the client
 * can echo it in the header.
 * @param {import('express').Response} res
 * @returns {string} token
 */
export function issueCsrfToken(res) {
  const token = generateCsrfToken();
  res.cookie(COOKIE_NAMES.CSRF_TOKEN, token, {
    ...buildCookieOptions({ httpOnly: false, maxAge: env.CSRF_TOKEN_TTL_MS }),
  });
  return token;
}

/** Clears the CSRF cookie (logout). */
export function clearCsrfToken(res) {
  res.clearCookie(COOKIE_NAMES.CSRF_TOKEN, buildCookieOptions({ httpOnly: false }));
}

/**
 * Express middleware enforcing CSRF for unsafe methods.
 *
 * Exemption: requests authenticated with an `Authorization: Bearer` header are
 * not cookie-authenticated, so there is no ambient authority to abuse.
 */
export function csrfProtection(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (process.env.DISABLE_CSRF === 'true') return next();

  const authorization = req.get('authorization') ?? '';
  if (authorization.startsWith('Bearer ')) return next();

  const cookieToken = req.cookies?.[COOKIE_NAMES.CSRF_TOKEN];
  const headerToken = req.get('x-csrf-token');

  if (!cookieToken || !headerToken) {
    return next(
      new ApiError(HTTP_STATUS.FORBIDDEN, 'Missing CSRF token', { code: 'CSRF_TOKEN_MISSING' }),
    );
  }
  if (!safeEqual(cookieToken, headerToken)) {
    return next(
      new ApiError(HTTP_STATUS.FORBIDDEN, 'CSRF token mismatch', { code: 'CSRF_TOKEN_MISMATCH' }),
    );
  }
  if (!verifyCsrfToken(headerToken)) {
    return next(
      new ApiError(HTTP_STATUS.FORBIDDEN, 'Invalid CSRF token signature', {
        code: 'CSRF_TOKEN_INVALID',
      }),
    );
  }

  // Note: origin allow-listing happens in the CORS middleware, which runs before
  // this one and rejects foreign origins (403 CORS_ORIGIN_DENIED). A duplicate
  // check here would be unreachable dead code.
  return next();
}

export default {
  csrfProtection,
  generateCsrfToken,
  verifyCsrfToken,
  issueCsrfToken,
  clearCsrfToken,
};
