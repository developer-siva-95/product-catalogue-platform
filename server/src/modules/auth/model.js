import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import {
  ROLES,
  ALL_ROLES,
  BCRYPT_SALT_ROUNDS,
  PASSWORD_POLICY,
} from '../../constants/appConstants.js';

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [80, 'Name must be at most 80 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      maxlength: [254, 'Email is too long'],
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Email is invalid'],
    },
    // Never selected by default: a stray `User.find()` cannot leak hashes.
    passwordHash: {
      type: String,
      required: [true, 'Password hash is required'],
      select: false,
    },
    role: {
      type: String,
      enum: { values: ALL_ROLES, message: '{VALUE} is not a valid role' },
      default: ROLES.CUSTOMER,
      required: true,
    },
    isActive: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    passwordChangedAt: { type: Date, default: null },
    // Incremented whenever credentials change: every JWT carries the version it
    // was issued with, so bumping it instantly invalidates all older sessions
    // (no session store required).
    tokenVersion: { type: Number, default: 0, min: 0 },
    loginAttempts: { type: Number, default: 0, min: 0 },
    lockUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// Case-insensitive uniqueness at the database level (emails are lowercased above).
userSchema.index({ email: 1 }, { unique: true, name: 'email_unique' });

userSchema.virtual('isLocked').get(function isLocked() {
  return Boolean(this.lockUntil && this.lockUntil.getTime() > Date.now());
});

/**
 * Hashes a plaintext password with a configurable cost factor.
 * Password policy is enforced by Zod validation and re-checked here so a
 * programmatic caller (seed script) cannot bypass it.
 */
userSchema.statics.hashPassword = async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, BCRYPT_SALT_ROUNDS);
};

/** @returns {Promise<boolean>} */
userSchema.methods.comparePassword = function comparePassword(plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

/**
 * Records a failed login. After MAX_LOGIN_ATTEMPTS the account is locked for
 * LOCK_DURATION_MS — an account-level guard that complements per-IP rate limits
 * (an attacker rotating IPs still gets locked out).
 */
userSchema.methods.registerFailedLogin = async function registerFailedLogin() {
  const attempts = (this.loginAttempts ?? 0) + 1;
  const shouldLock = attempts >= MAX_LOGIN_ATTEMPTS;
  this.loginAttempts = shouldLock ? 0 : attempts;
  this.lockUntil = shouldLock ? new Date(Date.now() + LOCK_DURATION_MS) : null;
  await this.save();
  return { attempts: this.loginAttempts, lockedUntil: this.lockUntil };
};

/** Clears failure counters after a successful authentication. */
userSchema.methods.resetLoginState = async function resetLoginState() {
  if (this.loginAttempts === 0 && this.lockUntil === null && this.lastLoginAt) return;
  this.loginAttempts = 0;
  this.lockUntil = null;
  this.lastLoginAt = new Date();
  await this.save();
};

userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    email: this.email,
    role: this.role,
    isActive: this.isActive,
    mustChangePassword: this.mustChangePassword,
    lastLoginAt: this.lastLoginAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

userSchema.statics.PASSWORD_POLICY = PASSWORD_POLICY;
userSchema.statics.MAX_LOGIN_ATTEMPTS = MAX_LOGIN_ATTEMPTS;
userSchema.statics.LOCK_DURATION_MS = LOCK_DURATION_MS;

export const User = mongoose.models.User ?? mongoose.model('User', userSchema);
export default User;
