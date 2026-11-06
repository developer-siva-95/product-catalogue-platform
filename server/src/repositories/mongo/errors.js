/**
 * Driver-error detection for the MongoDB provider.
 *
 * These predicates are the only place that knows what a MongoDB duplicate-key or
 * optimistic-concurrency failure looks like. Services and controllers never see
 * raw driver errors — they receive `ApiError` instances with the codes the API
 * already publishes, which is what keeps the error payload identical when the
 * same failure comes from MySQL (`ER_DUP_ENTRY` / affectedRows = 0) instead.
 */

/**
 * True for a MongoDB unique-index violation.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isDuplicateKeyError(error) {
  return Boolean(error && (error.code === 11_000 || error.code === 'ER_DUP_ENTRY'));
}

/**
 * True when Mongoose refused a save because `__v` no longer matched
 * (`optimisticConcurrency`).
 * @param {unknown} error
 * @returns {boolean}
 */
export function isVersionError(error) {
  return Boolean(error && (error.name === 'VersionError' || error.code === 'STALE_RESOURCE'));
}

/** Which field a duplicate-key error refers to, from the index/key name. */
export function duplicateKeyField(error, fallback = null) {
  const target = error?.keyPattern ?? null;
  if (target) return Object.keys(target)[0] ?? fallback;
  const message = String(error?.message ?? '');
  if (/slug/.test(message)) return 'slug';
  if (/sku/.test(message)) return 'sku';
  if (/email/.test(message)) return 'email';
  if (/nameNormalized/.test(message)) return 'name';
  return fallback;
}

export default { isDuplicateKeyError, isVersionError, duplicateKeyField };
