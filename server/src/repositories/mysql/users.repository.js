import bcrypt from 'bcrypt';
import { ROLES, BCRYPT_SALT_ROUNDS } from '../../constants/appConstants.js';
import { defineRepository } from '../repository.js';
import { USERS_REPOSITORY_METHODS } from '../users.repository.js';
import { query } from '../../db/mysql/pool.js';
import { newObjectIdHex } from './objectid.js';

/**
 * Users repository — MySQL (decision D4(a): users only, no session table).
 *
 * Same bcrypt cost factor as the MongoDB provider, so a password hash migrated
 * from one store still verifies in the other, and the same lockout bookkeeping:
 *
 *  - every failed attempt increments `login_attempts`;
 *  - on the 5th consecutive failure the counter resets to 0 and `lock_until` is set
 *    15 minutes ahead — the API reports `attempts: 0` at that point, exactly as the
 *    Mongoose instance method does;
 *  - a successful sign-in clears the counters and stamps `last_login_at`;
 *  - a password rotation bumps `token_version` (invalidating every issued JWT) and
 *    clears the lock state.
 */

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

const USER_COLUMNS = `
  id, name, email, role, is_active, must_change_password, password_changed_at,
  token_version, login_attempts, lock_until, last_login_at, created_at, updated_at`;

/** Plain record — same keys/order as the MongoDB `toRecord`. */
function toRecord(row, { withHash = false } = {}) {
  if (!row) return null;
  const record = {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isActive: Boolean(row.is_active),
    mustChangePassword: Boolean(row.must_change_password),
    lastLoginAt: row.last_login_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tokenVersion: Number(row.token_version ?? 0),
    loginAttempts: Number(row.login_attempts ?? 0),
    lockUntil: row.lock_until ?? null,
    isLocked: Boolean(row.lock_until && new Date(row.lock_until).getTime() > Date.now()),
  };
  if (withHash) record.passwordHash = row.password_hash;
  return record;
}

async function selectOne(where, params, { withHash = true } = {}) {
  const rows = await query(
    `SELECT ${USER_COLUMNS}${withHash ? ', password_hash' : ''} FROM users WHERE ${where} LIMIT 1`,
    params,
  );
  return toRecord(rows[0], { withHash });
}

export const usersRepository = defineRepository('users', USERS_REPOSITORY_METHODS, {
  async findByEmail(email, { withHash = false } = {}) {
    return selectOne('email = ?', [String(email).trim().toLowerCase()], { withHash });
  },

  async findById(id, { withHash = false } = {}) {
    return selectOne('id = ?', [id], { withHash });
  },

  async existsByEmail(email) {
    const rows = await query('SELECT 1 FROM users WHERE email = ? LIMIT 1', [
      String(email).trim().toLowerCase(),
    ]);
    return rows.length > 0;
  },

  async create({
    name,
    email,
    passwordHash,
    role = ROLES.CUSTOMER,
    isActive = true,
    mustChangePassword = false,
  }) {
    const id = newObjectIdHex();
    const now = new Date();

    await query(
      `INSERT INTO users
         (id, name, email, password_hash, role, is_active, must_change_password,
          password_changed_at, token_version, login_attempts, lock_until, last_login_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, NULL, NULL, ?, ?)`,
      [
        id,
        String(name).trim(),
        String(email).trim().toLowerCase(),
        passwordHash,
        role,
        isActive ? 1 : 0,
        mustChangePassword ? 1 : 0,
        now,
        now,
      ],
    );

    return selectOne('id = ?', [id], { withHash: false });
  },

  async recordLogin(id) {
    const current = await selectOne('id = ?', [id], { withHash: false });
    if (!current) return null;

    // Mirrors `resetLoginState()`: nothing to write when the counters are already
    // clean AND a successful login has been stamped before.
    if (current.loginAttempts === 0 && current.lockUntil === null && current.lastLoginAt) {
      return current;
    }

    await query(
      `UPDATE users
          SET login_attempts = 0, lock_until = NULL, last_login_at = ?, updated_at = ?
        WHERE id = ?`,
      [new Date(), new Date(), id],
    );
    return selectOne('id = ?', [id], { withHash: false });
  },

  async recordFailedLogin(id) {
    const current = await selectOne('id = ?', [id], { withHash: false });
    if (!current) return null;

    const attempts = current.loginAttempts + 1;
    const shouldLock = attempts >= MAX_LOGIN_ATTEMPTS;
    const storedAttempts = shouldLock ? 0 : attempts;
    const lockedUntil = shouldLock ? new Date(Date.now() + LOCK_DURATION_MS) : null;

    await query(
      `UPDATE users SET login_attempts = ?, lock_until = ?, updated_at = ? WHERE id = ?`,
      [storedAttempts, lockedUntil, new Date(), id],
    );

    return { attempts: storedAttempts, lockedUntil };
  },

  async rotatePassword(id, { passwordHash }) {
    const current = await selectOne('id = ?', [id], { withHash: true });
    if (!current) return null;

    const now = new Date();
    await query(
      `UPDATE users
          SET password_hash = ?, must_change_password = 0, password_changed_at = ?,
              token_version = token_version + 1, login_attempts = 0, lock_until = NULL,
              updated_at = ?
        WHERE id = ?`,
      [passwordHash, now, now, id],
    );

    return selectOne('id = ?', [id], { withHash: true });
  },

  async hashPassword(plainPassword) {
    return bcrypt.hash(plainPassword, BCRYPT_SALT_ROUNDS);
  },

  async verifyPassword(plainPassword, passwordHash) {
    return bcrypt.compare(plainPassword, passwordHash);
  },
});

export default usersRepository;
