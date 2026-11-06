import { randomBytes } from 'node:crypto';

/**
 * ObjectId-compatible identifiers for the MySQL provider.
 *
 * Ids are the same 24-hex strings MongoDB produces: 4-byte big-endian seconds
 * timestamp + 5 random bytes + 3-byte incrementing counter. Two consequences make
 * this worth doing rather than using UUIDs or auto-increment integers:
 *
 *  1. `ORDER BY id` in MySQL is byte order on the hex string, which equals
 *     ObjectId numeric order — so the storefront's `newest` sort
 *     (`sort({ _id: -1 })`) can be expressed as `ORDER BY id DESC` and returns the
 *     same rows in the same order.
 *  2. Ids are portable: a catalogue migrated from MongoDB keeps its identifiers,
 *     so existing URLs, cursors and client caches stay valid.
 */

const PROCESS_UNIQUE = randomBytes(5);
let counter = Math.floor(Math.random() * 0xffffff);
const MAX_COUNTER = 0xffffff;

/**
 * @param {Date} [now]
 * @returns {string} 24 lowercase hex characters
 */
export function newObjectIdHex(now = new Date()) {
  const timestamp = Math.floor(now.getTime() / 1000) >>> 0;
  counter = (counter + 1) % MAX_COUNTER;
  // Counter rolls over silently; the random process-unique part keeps collisions
  // negligible within a second (same guarantee the BSON driver gives).
  return (
    timestamp.toString(16).padStart(8, '0') +
    PROCESS_UNIQUE.toString('hex') +
    counter.toString(16).padStart(6, '0')
  );
}

/** @returns {number} seconds encoded in an ObjectId-compatible hex id */
export function timestampOf(id) {
  return Number.parseInt(String(id).slice(0, 8), 16);
}

export default { newObjectIdHex, timestampOf };
