import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import env from '../../config/env.js';
import { COOKIE_NAMES, ROLES } from '../../constants/appConstants.js';
import { HTTP_STATUS } from '../../constants/httpStatusCodes.js';
import { ApiError } from '../../utils/ApiError.js';
import logger from '../../utils/logger.js';
import { getRepositories } from '../../repositories/index.js';
import { issueCsrfToken } from '../../middlewares/csrf.js';
import { toSafeUser } from '../../repositories/users.mapper.js';

/**
 * Auth domain service.
 *
 * Storage-agnostic: users come from the users repository as plain records, so the
 * same service runs on MongoDB and MySQL (decision D4(a) — users only, sessions are
 * stateless JWTs whose validity is bound to `tokenVersion`).
 */

/** A valid bcrypt hash of a throwaway string; only used to equalise timing. */
const DUMMY_HASH = '$2b$12$5SPe2JxfnqejVTPVV6216./dTIQc8BsA155Y4.bdOXHK1MEXtH2ey';

/** JWT claims: the API refuses tokens minted for another service. */
const JWT_ISSUER = 'catalogue-api';
const JWT_AUDIENCE = 'catalogue-web';

/**
 * Authenticates a user.
 *
 * The same generic error is returned for unknown email and wrong password (no
 * account enumeration), and account lockout is checked before the password
 * comparison to stop unlimited guesses.
 *
 * @param {{ email: string, password: string, ip?: string }} credentials
 * @returns {Promise<object>} plain user record
 */
export async function authenticateUser({ email, password, ip }) {
  const { users } = getRepositories();
  const user = await users.findByEmail(email, { withHash: true });

  if (!user) {
    // Burn a comparable amount of CPU so timing does not reveal existence.
    await bcrypt.compare(password, DUMMY_HASH);
    logger.warn('auth: login failed (unknown email)', { email, ip });
    throw ApiError.unauthorized('Invalid email or password', { code: 'INVALID_CREDENTIALS' });
  }

  if (user.isLocked) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((user.lockUntil.getTime() - Date.now()) / 1000),
    );
    logger.warn('auth: login blocked (account locked)', { userId: user.id, ip });
    throw new ApiError(
      HTTP_STATUS.TOO_MANY_REQUESTS,
      'Too many failed attempts. Please try again later.',
      { code: 'ACCOUNT_LOCKED', details: { retryAfterSeconds } },
    );
  }

  if (!user.isActive) {
    logger.warn('auth: login blocked (inactive account)', { userId: user.id, ip });
    throw ApiError.unauthorized('Invalid email or password', { code: 'INVALID_CREDENTIALS' });
  }

  const passwordMatches = await users.verifyPassword(password, user.passwordHash);
  if (!passwordMatches) {
    const { attempts, lockedUntil } = await users.recordFailedLogin(user.id);
    logger.warn('auth: login failed (bad password)', { userId: user.id, ip, attempts });
    if (lockedUntil) {
      throw new ApiError(
        HTTP_STATUS.TOO_MANY_REQUESTS,
        'Too many failed attempts. Account locked for 15 minutes.',
        {
          code: 'ACCOUNT_LOCKED',
          details: { retryAfterSeconds: Math.ceil((lockedUntil.getTime() - Date.now()) / 1000) },
        },
      );
    }
    throw ApiError.unauthorized('Invalid email or password', { code: 'INVALID_CREDENTIALS' });
  }

  const loggedIn = await users.recordLogin(user.id);
  return { ...user, ...loggedIn };
}

/**
 * Registers a customer account.
 * The role is hard-coded: public registration can never create an admin.
 */
export async function registerCustomer({ name, email, password }) {
  const { users } = getRepositories();
  const normalizedEmail = email.trim().toLowerCase();

  if (await users.existsByEmail(normalizedEmail)) {
    throw ApiError.conflict('An account with this email already exists', {
      code: 'EMAIL_IN_USE',
    });
  }

  const passwordHash = await users.hashPassword(password);
  const user = await users.create({
    name: name.trim(),
    email: normalizedEmail,
    passwordHash,
    role: ROLES.CUSTOMER,
    isActive: true,
    mustChangePassword: false,
  });

  logger.info('auth: customer registered', { userId: user.id });
  return user;
}

/**
 * Changes the caller's password and invalidates every existing session.
 * @param {{ userId: string, currentPassword: string, newPassword: string }} params
 */
export async function changePassword({ userId, currentPassword, newPassword }) {
  const { users } = getRepositories();

  const user = await users.findById(userId, { withHash: true });
  if (!user) throw ApiError.unauthorized('Session is no longer valid', { code: 'USER_NOT_FOUND' });

  const matches = await users.verifyPassword(currentPassword, user.passwordHash);
  if (!matches) {
    throw ApiError.badRequest('Current password is incorrect', {
      code: 'CURRENT_PASSWORD_INVALID',
    });
  }
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw ApiError.badRequest('New password must be different from the current password', {
      code: 'PASSWORD_REUSED',
    });
  }

  const rotated = await users.rotatePassword(userId, {
    passwordHash: await users.hashPassword(newPassword),
  });
  if (!rotated)
    throw ApiError.unauthorized('Session is no longer valid', { code: 'USER_NOT_FOUND' });

  logger.info('auth: password changed, sessions invalidated', { userId });
  return rotated;
}

/** Loads the authenticated user for /me. */
export async function getProfile(userId) {
  const { users } = getRepositories();
  const user = await users.findById(userId);
  if (!user) throw ApiError.unauthorized('Session is no longer valid', { code: 'USER_NOT_FOUND' });
  return user;
}

// ---------------------------------------------------------------- sessions
// Stateless JWT sessions: the token carries the user id and the `tokenVersion` it
// was issued with, so a password change invalidates every older token without a
// session store.

/** Converts "1h"/"15m"/"900000" into milliseconds. */
export function parseDurationToMs(value) {
  if (typeof value === 'number') return value;
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(String(value).trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}

/** Signs an access token for a user record. */
export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      ver: user.tokenVersion ?? 0,
    },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN, issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
  );
}

/** Verifies an access token; throws a 401 ApiError on any failure. */
export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  } catch (error) {
    if (error?.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('Session has expired, please sign in again', {
        code: 'TOKEN_EXPIRED',
      });
    }
    throw ApiError.unauthorized('Session is invalid, please sign in again', {
      code: 'SESSION_INVALID',
    });
  }
}

/** Issues the session cookie and a fresh CSRF token for the response. */
export function issueSession(res, user) {
  const token = signAccessToken(user);
  const expiresInMs = parseDurationToMs(env.JWT_EXPIRES_IN);

  res.cookie(COOKIE_NAMES.ACCESS_TOKEN, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    maxAge: expiresInMs,
    path: '/',
  });

  // A fresh CSRF token is rotated on every sign-in.
  const csrfToken = issueCsrfToken(res);

  return { csrfToken, expiresInMs };
}

/** Clears the session cookie. */
export function destroySession(res) {
  res.clearCookie(COOKIE_NAMES.ACCESS_TOKEN, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    path: '/',
  });
}

export { toSafeUser };

export default {
  authenticateUser,
  registerCustomer,
  changePassword,
  getProfile,
  issueSession,
  destroySession,
  signAccessToken,
  verifyAccessToken,
  parseDurationToMs,
  toSafeUser,
};
