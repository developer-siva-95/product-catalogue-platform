/**
 * Shared SQL helpers for the MySQL repositories.
 *
 * Small and boring on purpose: this is the MySQL counterpart of `mongo/objectid.js`
 * — the one place where MySQL-flavoured details (LIKE escaping, placeholder lists,
 * type coercion) live, so the four repositories stay readable and consistent.
 */

/**
 * Escapes MySQL `LIKE` metacharacters so a user search matches *literally*.
 *
 * MongoDB's provider escapes regex metacharacters instead; the observable contract
 * (`search=50%` matches the text "50%") is identical, this is just the other
 * dialect's way of saying "no wildcards".
 *
 * @param {string} term
 * @returns {string}
 */
export function escapeLike(term) {
  return String(term ?? '').replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Builds a `%term%` pattern for a case-insensitive substring match.
 * @param {string} term
 */
export function containsPattern(term) {
  return `%${escapeLike(term)}%`;
}

/**
 * `?, ?, ?` for an IN list. Returns `NULL` for an empty list so the caller can
 * short-circuit instead of emitting invalid SQL.
 * @param {number} count
 */
export function placeholders(count) {
  return count > 0 ? new Array(count).fill('?').join(', ') : 'NULL';
}

/**
 * mysql2 returns DECIMAL/BIGINT as strings to avoid precision loss.
 * Money is stored as DECIMAL(12,2) and must reach JSON as a `number` — this is the
 * single conversion point, so no float arithmetic is ever done on a string.
 *
 * @param {string|number|null} value
 * @returns {number|null}
 */
export function toNumber(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value);
}

/**
 * `TINYINT(1)` → boolean, preserving `null`.
 * @param {number|boolean|null} value
 */
export function toBoolean(value) {
  if (value === null || value === undefined) return null;
  return Boolean(value);
}

/**
 * MySQL's `ORDER BY` on a `utf8mb4_0900_as_ci` column ignores case and accents,
 * whereas MongoDB sorts by raw bytes. Pinning the collation per ORDER BY term is
 * what makes the two providers return the same page for the same request.
 *
 * @param {string} column fully-qualified column reference, e.g. `p.title`
 * @param {'ASC'|'DESC'} direction
 */
export function orderByBinary(column, direction = 'ASC') {
  return `${column} COLLATE utf8mb4_bin ${direction}`;
}

export default {
  escapeLike,
  containsPattern,
  placeholders,
  toNumber,
  toBoolean,
  orderByBinary,
};
