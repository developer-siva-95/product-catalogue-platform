import { randomBytes } from 'node:crypto';

/**
 * Slug generation + collision handling.
 *
 * Slugs are URL identity, so they must be stable, unique and ASCII-only. Rather
 * than relying on a `pre-save` hook (which cannot know about rows being written
 * concurrently), uniqueness is resolved against the database with a bounded
 * retry loop; the unique index remains the final arbiter and the services retry
 * on duplicate-key errors (see `withDuplicateKeyRetry`).
 */

const MAX_SLUG_LENGTH = 80;

/**
 * Converts arbitrary text into a URL-safe slug.
 * @param {string} input
 * @returns {string} lowercased, hyphen-separated, ASCII-only slug
 */
export function slugify(input) {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * Appends a suffix to a slug, keeping the total length within the cap.
 * @param {string} base
 * @param {number|string} index
 */
export function withSuffix(base, index) {
  const suffix = `-${index}`;
  return `${base.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
}

/** Short random token (6 hex chars) used once numeric suffixes stop working. */
function randomToken() {
  return randomBytes(3).toString('hex');
}

/**
 * Produces a slug that does not yet exist for `Model`.
 *
 * Concurrency contract (exercised by the parallel-create tests):
 *  - `startIndex` lets a retrying caller resume probing *after* the range it
 *    already lost, instead of restarting at `-2` and colliding with the same
 *    competitors again (the classic retry stampede);
 *  - beyond `randomizeAfter`, candidates gain 6 random hex characters, because a
 *    sequential integer space cannot converge when many writers race for the
 *    same base slug (1-in-16M collision chance per attempt instead).
 *
 * Note that the `exists()` probe is an optimisation for the common sequential
 * case, not a guarantee: only the unique index is authoritative, which is why
 * callers wrap the insert in `withDuplicateKeyRetry`.
 *
 * @param {{ exists: (filter: object) => Promise<boolean> } | ((candidate: string, ctx: { excludeId?: string }) => Promise<boolean>)} model
 *        either a Mongoose model (uses `model.exists({ slug })`) or a
 *        provider-neutral probe function, which is how the MySQL repository
 *        reuses this exact candidate sequence
 * @param {string} text source text (e.g. product title)
 * @param {{
 *   excludeId?: string,
 *   fallback?: string,
 *   maxAttempts?: number,
 *   startIndex?: number,
 *   randomizeAfter?: number
 * }} [options]
 * @returns {Promise<string>}
 */
export async function createUniqueSlug(model, text, options = {}) {
  const {
    excludeId,
    fallback = 'item',
    maxAttempts = 25,
    startIndex = 2,
    randomizeAfter = 3,
  } = options;

  const base = slugify(text) || slugify(fallback) || 'item';
  const isTaken = toExistsProbe(model, 'slug');

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // attempt 0 -> the bare base slug; then -2, -3, ... so the familiar
    // "base, base-2, base-3" sequence is preserved for sequential callers.
    const index = startIndex + attempt - 1;
    let candidate;

    if (attempt === 0 && startIndex <= 2) {
      candidate = base;
    } else if (index > randomizeAfter) {
      candidate = withSuffix(base, `${index}${randomToken()}`);
    } else {
      candidate = withSuffix(base, index);
    }

    const taken = await isTaken(candidate, { excludeId });
    if (!taken) return candidate;
  }

  // Last resort: a unique-enough suffix so a request never fails purely because a
  // name is popular. The unique index still validates the final write.
  return withSuffix(base, `${Date.now() % 1_000_000}${randomToken()}`);
}

/**
 * Normalises the two supported probe styles into `(candidate, { excludeId })`.
 *
 * Kept as one tiny adapter so the candidate-generation sequence (which decides
 * *which* slug a caller ends up with) is literally the same code for both
 * providers — a divergent suffix sequence would be a visible behaviour change.
 *
 * @param {object|Function} target
 * @param {string} field
 * @returns {(candidate: string, ctx: { excludeId?: string }) => Promise<boolean>}
 */
function toExistsProbe(target, field) {
  // A Mongoose model is *also* a function (it is the model constructor), so the
  // "has an exists() method" case must be tested first — otherwise the model would
  // be invoked as a provider-neutral probe.
  if (typeof target?.exists === 'function') {
    return async (candidate, { excludeId } = {}) => {
      const filter = { [field]: candidate };
      if (excludeId) filter._id = { $ne: excludeId };
      return Boolean(await target.exists(filter));
    };
  }
  if (typeof target === 'function') return target;
  return async (candidate, { excludeId } = {}) => {
    const filter = { [field]: candidate };
    if (excludeId) filter._id = { $ne: excludeId };
    return Boolean(await target.exists(filter));
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `operation` and retries when the database reports a duplicate key, which
 * is the definitive race guard between two concurrent slug/SKU assignments.
 *
 * A short randomised backoff between attempts is essential: without it, N
 * concurrent writers that collide re-probe at the same instant, keep picking the
 * same candidate slug, and exhaust their retries (a retry stampede).
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation receives the 1-based attempt
 * @param {{ maxAttempts?: number, baseDelayMs?: number, onRetry?: (attempt: number, error: Error) => void }} [options]
 * @returns {Promise<T>}
 */
export async function withDuplicateKeyRetry(operation, options = {}) {
  const { maxAttempts = 12, baseDelayMs = 5, onRetry } = options;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      // 11000 is MongoDB's duplicate-key code; ER_DUP_ENTRY is MySQL's. Both mean
      // "someone else won the race", which is exactly what this retries.
      if (error?.code !== 11000 && error?.code !== 'ER_DUP_ENTRY') throw error;
      lastError = error;
      onRetry?.(attempt, error);
      if (attempt < maxAttempts) {
        await sleep(Math.random() * baseDelayMs * attempt);
      }
    }
  }

  throw lastError;
}

export default { slugify, createUniqueSlug, withSuffix, withDuplicateKeyRetry };
