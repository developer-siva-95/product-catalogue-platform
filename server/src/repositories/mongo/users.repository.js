import bcrypt from 'bcrypt';
import { User } from '../../modules/auth/model.js';
import { ROLES } from '../../constants/appConstants.js';
import { defineRepository } from '../repository.js';
import { USERS_REPOSITORY_METHODS } from '../users.repository.js';

/**
 * Users repository — MongoDB (decision D4(a): users only, no session table).
 *
 * Passwords use bcrypt, a library rather than a database feature, so hashing and
 * verification live here: both providers must hash identically or a migrated
 * account could no longer sign in.
 *
 * A "record" is a plain object; `passwordHash` is only included when the caller
 * asks for it (`withHash: true`), mirroring the schema's `select: false`.
 *
 * Lockout bookkeeping deliberately reuses the schema's own instance methods
 * (`registerFailedLogin`, `resetLoginState`) so the counters, the lock window and
 * the `lastLoginAt`-only-on-first-success nuance stay bit-for-bit identical to the
 * Phase 0 behaviour. The MySQL implementation reproduces those rules in SQL.
 */

/** Converts a user document into a plain record. */
function toRecord(document, { withHash = false } = {}) {
  if (!document) return null;
  const record = {
    id: document._id.toString(),
    name: document.name,
    email: document.email,
    role: document.role,
    isActive: document.isActive,
    mustChangePassword: document.mustChangePassword,
    lastLoginAt: document.lastLoginAt ?? null,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    tokenVersion: document.tokenVersion ?? 0,
    loginAttempts: document.loginAttempts ?? 0,
    lockUntil: document.lockUntil ?? null,
    isLocked: Boolean(document.lockUntil && document.lockUntil.getTime() > Date.now()),
  };
  if (withHash) record.passwordHash = document.passwordHash;
  return record;
}

export const usersRepository = defineRepository('users', USERS_REPOSITORY_METHODS, {
  /** Case-insensitive lookup by email; `passwordHash` included when requested. */
  async findByEmail(email, { withHash = false } = {}) {
    const query = User.findOne({ email: String(email).trim().toLowerCase() });
    if (withHash) query.select('+passwordHash');
    return toRecord(await query.exec(), { withHash });
  },

  /** Lookup by canonical id. */
  async findById(id, { withHash = false } = {}) {
    const query = User.findById(id);
    if (withHash) query.select('+passwordHash');
    return toRecord(await query.exec(), { withHash });
  },

  /** Whether an account with this email already exists. */
  async existsByEmail(email) {
    return Boolean(await User.exists({ email: String(email).trim().toLowerCase() }));
  },

  /** Creates an account from an already-hashed password. */
  async create({
    name,
    email,
    passwordHash,
    role = ROLES.CUSTOMER,
    isActive = true,
    mustChangePassword = false,
  }) {
    const document = await User.create({
      name,
      email: String(email).trim().toLowerCase(),
      passwordHash,
      role,
      isActive,
      mustChangePassword,
    });
    return toRecord(document);
  },

  /** Clears the failure counters after a successful sign-in. */
  async recordLogin(id) {
    const document = await User.findById(id);
    if (!document) return null;
    await document.resetLoginState();
    return toRecord(document);
  },

  /** Increments the failure counter and locks the account when the limit is hit. */
  async recordFailedLogin(id) {
    const document = await User.findById(id);
    if (!document) return null;
    const { attempts, lockedUntil } = await document.registerFailedLogin();
    return { attempts, lockedUntil: lockedUntil ?? null };
  },

  /** Stores a new password hash and invalidates every existing session. */
  async rotatePassword(id, { passwordHash }) {
    const document = await User.findById(id).select('+passwordHash');
    if (!document) return null;

    document.passwordHash = passwordHash;
    document.mustChangePassword = false;
    document.passwordChangedAt = new Date();
    document.tokenVersion = (document.tokenVersion ?? 0) + 1;
    document.loginAttempts = 0;
    document.lockUntil = null;
    await document.save();

    return toRecord(document, { withHash: true });
  },

  /** bcrypt hashing (same cost factor the schema uses). */
  async hashPassword(plainPassword) {
    return User.hashPassword(plainPassword);
  },

  /** bcrypt verification. */
  async verifyPassword(plainPassword, passwordHash) {
    return bcrypt.compare(plainPassword, passwordHash);
  },
});

export default usersRepository;
