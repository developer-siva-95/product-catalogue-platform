/**
 * Users repository contract (decision D4(a): users only — no session or
 * refresh-token store, because authentication is stateless JWT plus the
 * `tokenVersion` counter that invalidates previously issued tokens).
 *
 *  - `findByEmail`  exact, case-insensitive match on the normalised email.
 *  - `findById`     `null` when absent.
 *  - `create`       duplicate email surfaces as `DUPLICATE_KEY` (409).
 *  - `recordLogin`  sets `lastLoginAt`, resets `failedLoginAttempts`, clears
 *                   `lockedUntil` in one write.
 *  - `recordFailedLogin` increments the attempt counter and sets `lockedUntil`
 *                   when the supplied policy threshold is reached.
 *  - `rotatePassword` stores the new hash and increments `tokenVersion`.
 */

/** Methods every users repository must expose. */
export const USERS_REPOSITORY_METHODS = Object.freeze([
  'findByEmail',
  'findById',
  'existsByEmail',
  'create',
  'recordLogin',
  'recordFailedLogin',
  'rotatePassword',
  'hashPassword',
  'verifyPassword',
]);

export default { USERS_REPOSITORY_METHODS };
