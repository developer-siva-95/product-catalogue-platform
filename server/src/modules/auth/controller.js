import { sendSuccess } from '../../utils/apiResponse.js';
import { HTTP_STATUS } from '../../constants/httpStatusCodes.js';
import { issueCsrfToken } from '../../middlewares/csrf.js';
import * as authService from './service.js';
import { toSafeUser } from '../../repositories/users.mapper.js';

/**
 * Auth controllers. Thin by design: parse validated input (`req.validated`),
 * delegate to the service, shape the response envelope.
 */

/** GET /api/v1/auth/csrf — bootstraps the readable CSRF cookie. */
export const getCsrfToken = async (_req, res) => {
  const csrfToken = issueCsrfToken(res);
  return sendSuccess(res, { message: 'CSRF token issued', data: { csrfToken } });
};

/** POST /api/v1/auth/login */
export const login = async (req, res) => {
  const { email, password } = req.validated.body;
  const user = await authService.authenticateUser({ email, password, ip: req.ip });
  const { csrfToken, expiresInMs } = authService.issueSession(res, user);

  return sendSuccess(res, {
    message: 'Signed in successfully',
    data: {
      user: toSafeUser(user),
      csrfToken,
      expiresInMs,
    },
  });
};

/** POST /api/v1/auth/register — customers only (role is never client-controlled). */
export const register = async (req, res) => {
  const { name, email, password } = req.validated.body;
  const user = await authService.registerCustomer({ name, email, password });
  const { csrfToken, expiresInMs } = authService.issueSession(res, user);

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.CREATED,
    message: 'Account created',
    data: { user: toSafeUser(user), csrfToken, expiresInMs },
  });
};

/** POST /api/v1/auth/logout — idempotent; always clears cookies. */
export const logout = async (req, res) => {
  authService.destroySession(res);
  return sendSuccess(res, {
    message: 'Signed out',
    data: { csrfToken: issueCsrfToken(res) },
  });
};

/** GET /api/v1/auth/me — session restoration for the SPA. */
export const me = async (req, res) => {
  const user = await authService.getProfile(req.user.id);
  return sendSuccess(res, {
    message: 'Current session',
    data: { user: toSafeUser(user) },
  });
};

/** POST /api/v1/auth/change-password — rotates the password and the session. */
export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.validated.body;
  const user = await authService.changePassword({
    userId: req.user.id,
    currentPassword,
    newPassword,
  });

  // Re-issue cookies: the old token is now invalid (tokenVersion bumped).
  const { csrfToken, expiresInMs } = authService.issueSession(res, user);

  return sendSuccess(res, {
    message: 'Password updated. Other sessions have been signed out.',
    data: { user: toSafeUser(user), csrfToken, expiresInMs },
  });
};

export default { getCsrfToken, login, register, logout, me, changePassword };
