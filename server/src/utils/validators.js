import { z } from 'zod';
import { ID_PATTERN, isValidId, toCanonicalId } from './id.js';

/**
 * Request-boundary validators.
 *
 * Driver-free on purpose: `isValidObjectId()` used to delegate to
 * `mongoose.isValidObjectId`, which meant route validation pulled the MongoDB
 * driver into every layer. It now delegates to `utils/id.js`, so the same
 * predicate protects both providers and can never disagree with the id
 * generator.
 */

/** 24-hex id pattern — checked before hitting the database. */
export const OBJECT_ID_REGEX = ID_PATTERN;

/**
 * True when the value is a canonical 24-hex id.
 *
 * Kept under its historical name because cursors and existing call sites use it;
 * behaviour is unchanged — a 12-byte string, a Buffer, a number or an ObjectId
 * instance all return `false`, exactly as before.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidObjectId(value) {
  return isValidId(value);
}

/** Zod schema for `:id` route params. */
export const objectIdParam = z
  .string()
  .trim()
  .refine(isValidObjectId, { message: 'Invalid identifier' });

export const idParamSchema = z.object({ id: objectIdParam });

/**
 * Escapes a user-supplied string so it can be embedded in a RegExp safely.
 * Without this, `search=".*"` or a catastrophic-backtracking pattern becomes a
 * filter/DoS vector.
 */
export function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { toCanonicalId };

export default {
  OBJECT_ID_REGEX,
  isValidObjectId,
  objectIdParam,
  idParamSchema,
  escapeRegex,
  toCanonicalId,
};
