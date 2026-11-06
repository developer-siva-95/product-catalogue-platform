import { ApiError } from '../utils/ApiError.js';

/**
 * Identifier validation shared by every provider.
 *
 * Earlier phases exposed an asymmetry: a malformed `excludeId` made Mongoose throw
 * a `CastError` ("Cast to ObjectId failed…") while the MySQL provider happily ran
 * a `WHERE id <> ?` against the garbage and returned `false`. Same call, two
 * different outcomes — one of them a 500. Both providers now reject it here,
 * before any query is built, with an identical error.
 *
 * Only *exclusions* are validated. A lookup identifier may legitimately be a slug
 * (`findById('aurora-buds-pro')`), so lookups keep their existing "not found →
 * null" contract; an exclusion can never be a slug and must be a stored id.
 */

const CANONICAL_ID = /^[0-9a-f]{24}$/;

/** @param {unknown} value @returns {boolean} */
export function isCanonicalId(value) {
  return typeof value === 'string' && CANONICAL_ID.test(value);
}

/**
 * Returns the value, or throws a provider-neutral `400 INVALID_IDENTIFIER`.
 *
 * `undefined`/`null`/`''` mean "no exclusion" and pass through untouched, so
 * optional call styles keep working.
 *
 * @param {unknown} value
 * @param {{ field?: string }} [options]
 * @returns {string|undefined|null}
 */
export function assertCanonicalId(value, { field = 'excludeId' } = {}) {
  if (value === undefined || value === null || value === '') return value;

  if (isCanonicalId(value)) return /** @type {string} */ (value);

  throw ApiError.badRequest(
    `Invalid ${field}: expected a 24-character lowercase hexadecimal identifier`,
    {
      code: 'INVALID_IDENTIFIER',
      details: { field, value: typeof value === 'string' ? value : typeof value },
    },
  );
}

export default { isCanonicalId, assertCanonicalId };
