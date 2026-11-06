import { z } from 'zod';
import { PASSWORD_POLICY } from '../../constants/appConstants.js';

/**
 * Auth request schemas.
 *
 * `strict()` is used deliberately: unknown keys (e.g. `role: 'admin'` on
 * registration) are rejected with a 400 instead of being silently ignored, so a
 * privilege-escalation attempt is both impossible and visible.
 */

const email = z
  .string({ error: 'Email is required' })
  .trim()
  .min(3, 'Email is required')
  .max(254, 'Email is too long')
  .email('Enter a valid email address')
  .transform((value) => value.toLowerCase());

const password = z
  .string({ error: 'Password is required' })
  .min(PASSWORD_POLICY.MIN_LENGTH, PASSWORD_POLICY.DESCRIPTION)
  .max(PASSWORD_POLICY.MAX_LENGTH, PASSWORD_POLICY.DESCRIPTION)
  .regex(PASSWORD_POLICY.PATTERN, PASSWORD_POLICY.DESCRIPTION);

export const loginSchema = z
  .object({
    // Login accepts any non-empty password (policy is enforced at creation time);
    // rejecting legacy passwords here would lock out valid users.
    email,
    password: z.string().min(1, 'Password is required').max(PASSWORD_POLICY.MAX_LENGTH),
  })
  .strict();

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
    email,
    password,
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .strict()
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: password,
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .strict()
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: 'New password must be different from the current password',
    path: ['newPassword'],
  });

export default { loginSchema, registerSchema, changePasswordSchema };
