import env from '../config/env.js';
import { COOKIE_NAMES, ROLES } from '../constants/appConstants.js';
import { HTTP_STATUS } from '../constants/httpStatusCodes.js';
import { ApiError } from '../utils/ApiError.js';
import { verifyAccessToken } from '../modules/auth/service.js';
import { getRepositories } from '../repositories/index.js';

/**
 * Extracts the access token.
 *
 * Cookie first (browser SPA, CSRF-protected), then `Authorization: Bearer`
 * (server-to-server / API clients, which carry no ambient credentials and are
 * therefore exempt from CSRF).
 */
export function extractAccessToken(req) {
  const cookieToken = req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];
  if (cookieToken) return cookieToken;

  const header = req.get('authorization') ?? '';
  if (header.startsWith('Bearer ')) {
    const bearer = header.slice('Bearer '.length).trim();
    if (bearer) return bearer;
  }
  return null;
}

/**
 * Requires a valid session.
 *
 * The user is re-read from the database on every request (not trusted from the
 * token) so that deactivation, role changes and password resets take effect
 * immediately; the token's `ver` claim is compared with `tokenVersion` to revoke
 * tokens issued before a password change.
 */
export async function authenticate(req, _res, next) {
  try {
    const token = extractAccessToken(req);
    if (!token) {
      throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Authentication required', {
        code: 'AUTH_REQUIRED',
      });
    }

    const payload = verifyAccessToken(token);
    const { users } = getRepositories();
    const user = await users.findById(payload.sub);
    if (!user || !user.isActive) {
      throw new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Session is no longer valid', {
        code: 'SESSION_INVALID',
      });
    }
    if ((user.tokenVersion ?? 0) !== (payload.ver ?? 0)) {
      throw new ApiError(
        HTTP_STATUS.UNAUTHORIZED,
        'Session has been revoked, please sign in again',
        {
          code: 'SESSION_REVOKED',
        },
      );
    }

    req.user = user;
    req.authMethod = req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN] ? 'cookie' : 'bearer';
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Role gate. Use after `authenticate`.
 * @param {...string} roles
 */
export function authorize(...roles) {
  const allowed = roles.length > 0 ? roles : [ROLES.ADMIN];
  return function authorizeRoles(req, _res, next) {
    if (!req.user) {
      return next(
        new ApiError(HTTP_STATUS.UNAUTHORIZED, 'Authentication required', {
          code: 'AUTH_REQUIRED',
        }),
      );
    }
    if (!allowed.includes(req.user.role)) {
      return next(
        new ApiError(HTTP_STATUS.FORBIDDEN, 'You do not have permission to perform this action', {
          code: 'INSUFFICIENT_ROLE',
        }),
      );
    }
    return next();
  };
}

/** Convenience: authenticate + admin-only. */
export const requireAdmin = [authenticate, authorize(ROLES.ADMIN)];

/**
 * Blocks privileged work until a flagged account has rotated its password
 * (the seeded development admin must not keep using the published password).
 */
export function enforcePasswordRotation(req, _res, next) {
  if (req.user?.mustChangePassword) {
    return next(
      new ApiError(HTTP_STATUS.FORBIDDEN, 'You must change your password before continuing', {
        code: 'PASSWORD_CHANGE_REQUIRED',
      }),
    );
  }
  return next();
}

/** Exposed for tests; keeps the cookie name list in one place. */
export const AUTH_COOKIE_NAMES = COOKIE_NAMES;
export const FRONTEND_ORIGIN = env.FRONTEND_URL;
