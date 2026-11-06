import { Router } from 'express';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/auth.js';
import { loginLimiter } from '../../middlewares/rateLimiter.js';
import { changePasswordSchema, loginSchema, registerSchema } from './validation.js';
import * as authController from './controller.js';

/**
 * Auth routes — mounted at /api/v1/auth.
 * Brute-force protection is applied per-credential-endpoint on top of the global
 * API limiter.
 */
export const authRouter = Router();

authRouter.get('/csrf', authController.getCsrfToken);

authRouter.post('/login', loginLimiter, validate({ body: loginSchema }), authController.login);

authRouter.post(
  '/register',
  loginLimiter,
  validate({ body: registerSchema }),
  authController.register,
);

authRouter.post('/logout', authController.logout);

authRouter.get('/me', authenticate, authController.me);

authRouter.post(
  '/change-password',
  authenticate,
  validate({ body: changePasswordSchema }),
  authController.changePassword,
);

export default authRouter;
