import { randomBytes } from 'node:crypto';

/**
 * Canonical identifier for every persisted record.
 *
 * Why this module exists (and why nothing else may mint ids):
 *  - the public API contract is a 24-character lowercase hexadecimal string. The
 *    MongoDB implementation happens to store those as ObjectIds; MySQL stores the
 *    same 24 characters in a `CHAR(24) CHARACTER SET ascii COLLATE ascii_bin`
 *    column. Generating them in the application — through THIS single generator —
 *    is what keeps `id` values identical across providers, so an id minted while
 *    `DATABASE_PROVIDER=mongodb` is still valid when the same row is read back
 *    with `DATABASE_PROVIDER=mysql`. ObjectIds are never mapped to UUIDs and no
 *    provider is allowed to invent its own identifier format.
 *  - the layout follows the 12-byte ObjectId layout (4-byte big-endian seconds |
 *    5-byte per-process random | 3-byte incrementing counter) on purpose. The
 *    storefront's `newest` sort is `_id DESC`, which relies on the embedded
 *    timestamp to mean "creation order". A random 24-hex generator would produce
 *    a different page order on MySQL, so the layout is part of the contract, not
 *    an implementation detail.
 *
 * Deliberately free of driver imports (no Mongoose, no mysql2): everything above
 * the repository layer may use it.
 */

/** Canonical id pattern: exactly 24 hexadecimal characters. */
export const ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/** Length of a canonical id, in characters. */
export const ID_LENGTH = 24;

const HEX4_BYTES = 4;
const RANDOM_BYTES = 5;
const COUNTER_BYTES = 3;
const COUNTER_MAX = 0xff_ff_ff;

// Per-process random prefix (5 bytes) and counter seed (3 bytes), exactly like
// the ObjectId spec: unique across processes, incrementing within one.
const PROCESS_RANDOM = randomBytes(RANDOM_BYTES);
let counter = randomBytes(COUNTER_BYTES).readUIntBE(0, COUNTER_BYTES);

/**
 * True when the value is a canonical 24-hex id.
 *
 * Stricter than `mongoose.isValidObjectId`, which also accepts 12-byte strings,
 * 12-character buffers and numbers. This predicate is the single source of truth
 * for "is this an id" and is used by route validation, cursor codecs and every
 * repository.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/**
 * @param {unknown} value
 * @returns {string} the value, lowercased
 * @throws {TypeError} when the value is not a canonical id
 */
export function assertValidId(value) {
  if (!isValidId(value)) {
    throw new TypeError(`Invalid identifier: expected 24 hexadecimal characters`);
  }
  return value.toLowerCase();
}

/**
 * Normalises anything id-like (a 24-hex string, or a driver value whose
 * `toString()` yields one) to the canonical lowercase string.
 *
 * Repositories use this at their boundary so no driver-native identity object
 * (`ObjectId`, MySQL `CHAR(24)` with padding/case quirks) can ever leak upward.
 *
 * @param {{ toString(): string } | string} value
 * @returns {string}
 */
export function toCanonicalId(value) {
  const hex = typeof value === 'string' ? value : String(value?.toString?.() ?? '');
  if (!isValidId(hex)) throw new TypeError(`Invalid identifier: ${hex}`);
  return hex.toLowerCase();
}

/**
 * Mints a new canonical id. The only id generator in the codebase.
 *
 * Monotonic within a process and time-sortable across processes, so
 * `ORDER BY id DESC` (MySQL) and `_id DESC` (MongoDB) agree on "newest".
 *
 * @param {Date} [now] injectable clock, used by tests
 * @returns {string} 24 lowercase hex characters
 */
export function generateId(now = new Date()) {
  const seconds = Math.floor(now.getTime() / 1000) >>> 0;
  const timestamp = Buffer.alloc(HEX4_BYTES);
  timestamp.writeUInt32BE(seconds, 0);

  const counterBuffer = Buffer.alloc(COUNTER_BYTES);
  counterBuffer.writeUIntBE(counter, 0, COUNTER_BYTES);
  counter = (counter + 1) % COUNTER_MAX;

  return Buffer.concat([timestamp, PROCESS_RANDOM, counterBuffer]).toString('hex');
}

/**
 * Parses the creation timestamp embedded in a canonical id.
 * @param {string} id
 * @returns {Date}
 */
export function timestampFromId(id) {
  if (!isValidId(id)) throw new TypeError(`Invalid identifier: ${id}`);
  return new Date(Number.parseInt(id.slice(0, 8), 16) * 1000);
}

export default {
  ID_PATTERN,
  ID_LENGTH,
  isValidId,
  assertValidId,
  toCanonicalId,
  generateId,
  timestampFromId,
};
