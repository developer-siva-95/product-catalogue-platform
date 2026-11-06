import { randomInt } from 'node:crypto';
import { withDuplicateKeyRetry } from './slugify.js';

/**
 * SKU generation.
 *
 * Format: <PREFIX>-<BASE36 RANDOM>  e.g.  ELE-7K2M9QX
 * - prefix derives from the category name (human-scannable in the admin table);
 * - random suffix from node:crypto avoids the predictability of Date.now();
 * - uniqueness is guaranteed by the unique+sparse index and a duplicate-key
 *   retry loop, which is race-safe across concurrent requests and processes.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no look-alikes (0/O, 1/I)
const SKU_PREFIX_LENGTH = 3;
const SKU_RANDOM_LENGTH = 7;

export function normalizeSkuPrefix(prefix) {
  const cleaned = String(prefix ?? '')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
  return (cleaned || 'SKU').slice(0, SKU_PREFIX_LENGTH).padEnd(SKU_PREFIX_LENGTH, 'X');
}

/**
 * Builds a random, crypto-strong SKU candidate.
 * @param {{ prefix?: string }} [options]
 * @returns {string}
 */
export function generateSku(options = {}) {
  const prefix = normalizeSkuPrefix(options.prefix);
  let suffix = '';
  for (let i = 0; i < SKU_RANDOM_LENGTH; i += 1) {
    suffix += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return `${prefix}-${suffix}`;
}

/**
 * Reserves a SKU that does not collide with an existing product.
 *
 * The loop is bounded: after `maxAttempts` collisions (probability ~0 for 32^7
 * combinations) it throws rather than spinning forever.
 *
 * @param {{ exists: (filter: object) => Promise<boolean> } | ((candidate: string, ctx: { excludeId?: string }) => Promise<boolean>)} model
 *        Mongoose model or a provider-neutral probe function (see slugify.js)
 * @param {{ prefix?: string, excludeId?: string, maxAttempts?: number }} [options]
 * @returns {Promise<string>}
 */
export async function createUniqueSku(model, options = {}) {
  const { prefix, excludeId, maxAttempts = 10 } = options;

  // Test the "model-like" case first: a Mongoose model is itself a function.
  const isTaken =
    typeof model?.exists === 'function'
      ? async (candidate, ctx) => {
          const filter = { sku: candidate };
          if (ctx?.excludeId) filter._id = { $ne: ctx.excludeId };
          return Boolean(await model.exists(filter));
        }
      : model;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateSku({ prefix });
    const taken = await isTaken(candidate, { excludeId });
    if (!taken) return candidate;
  }

  throw Object.assign(new Error('Unable to allocate a unique SKU, please retry'), {
    statusCode: 503,
    code: 'SKU_ALLOCATION_FAILED',
  });
}

/**
 * Persists a product, replacing the SKU on duplicate-key races.
 * Exposed separately so the products service stays readable.
 *
 * @template T
 * @param {() => Promise<T>} operation must (re)assign a fresh SKU before saving
 * @param {{ maxAttempts?: number }} [options]
 */
export function saveWithSkuRetry(operation, options = {}) {
  return withDuplicateKeyRetry(operation, options);
}

export default { generateSku, createUniqueSku, normalizeSkuPrefix, saveWithSkuRetry };
