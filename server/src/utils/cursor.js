import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import env from '../config/env.js';
import { ApiError } from './ApiError.js';
// Driver-free id predicate: cursors must validate identically on MongoDB and
// MySQL, so they cannot depend on a Mongoose helper.
import { isValidId } from './id.js';
import { PRODUCT_SORTS } from '../constants/appConstants.js';

/**
 * Opaque, tamper-evident pagination cursors.
 *
 * Format: base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload))
 *
 * Why signed cursors instead of raw `_id` values:
 *  - a cursor encodes the sort key(s) AND the filter fingerprint, so a client
 *    cannot silently mix a cursor from one sort/filter set with another (which
 *    would produce gaps or duplicates);
 *  - tampering is detectable: a forged price in a `price_asc` cursor is rejected
 *    with 400 instead of returning a wrong page;
 *  - clients treat it as opaque, so the internal shape can evolve.
 *
 * The HMAC key is domain-separated from the JWT secret so cursor signatures can
 * never be confused with session tokens.
 */

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 512;
const CURSOR_HMAC_KEY = createHash('sha256')
  .update(`${env.JWT_SECRET}:storefront-cursor:v1`)
  .digest();

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload) {
  return createHmac('sha256', CURSOR_HMAC_KEY).update(payload).digest('base64url');
}

/**
 * Stable fingerprint of the active filters + sort. Any change produces a
 * different hash, so stale cursors are rejected rather than silently applied.
 * @param {object} filters
 * @returns {string} 16 hex chars
 */
export function hashFilters(filters = {}) {
  const normalized = Object.keys(filters)
    .filter((key) => filters[key] !== undefined && filters[key] !== null && filters[key] !== '')
    .sort()
    .map((key) => `${key}=${String(filters[key])}`)
    .join('&');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Builds a cursor for the last row of a page.
 *
 * @param {{ sort: string, id: string, price?: number, filterHash: string }} params
 * @returns {string} opaque cursor
 */
export function encodeCursor({ sort, id, price, filterHash }) {
  if (!PRODUCT_SORTS.includes(sort)) {
    throw new Error(`Cannot encode a cursor for unsupported sort: ${sort}`);
  }
  if (!isValidId(id)) {
    throw new Error('Cannot encode a cursor without a valid ObjectId');
  }

  const payload = { v: CURSOR_VERSION, s: sort, i: id, f: filterHash };
  if (sort !== 'newest') {
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      throw new Error(`Sort "${sort}" requires a numeric price in the cursor`);
    }
    payload.p = price;
  }

  const serialized = base64url(JSON.stringify(payload));
  return `${serialized}.${sign(serialized)}`;
}

function invalidCursor(reason, code = 'CURSOR_INVALID') {
  return ApiError.badRequest(reason, { code });
}

/**
 * Decodes and fully validates a cursor against the current request context.
 *
 * Rejections (all 400):
 *  - malformed base64/JSON, missing fields, wrong types;
 *  - bad HMAC signature (tampering);
 *  - wrong version;
 *  - cursor issued for a different sort (`CURSOR_SORT_MISMATCH`);
 *  - cursor issued for different filters (`CURSOR_FILTER_MISMATCH`);
 *  - non-ObjectId `i`, non-numeric `p`.
 *
 * @param {unknown} token
 * @param {{ sort: string, filterHash: string }} context
 * @returns {{ sort: string, id: string, price?: number }}
 */
export function decodeCursor(token, context) {
  if (typeof token !== 'string' || token.length === 0) {
    throw invalidCursor('Cursor must be a non-empty string');
  }
  if (token.length > MAX_CURSOR_LENGTH) {
    throw invalidCursor('Cursor is too long');
  }

  const parts = token.split('.');
  if (parts.length !== 2) throw invalidCursor('Cursor is malformed');

  const [serialized, signature] = parts;
  const expected = sign(serialized);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw invalidCursor('Cursor signature is invalid');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(serialized, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor('Cursor payload is not valid JSON');
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalidCursor('Cursor payload has an invalid shape');
  }
  if (payload.v !== CURSOR_VERSION) {
    throw invalidCursor('Cursor version is not supported');
  }
  if (typeof payload.s !== 'string' || !PRODUCT_SORTS.includes(payload.s)) {
    throw invalidCursor('Cursor has an unknown sort');
  }
  // Cross-sort compatibility: a cursor minted for one ordering cannot be applied
  // to another, because the comparison operators differ per sort direction.
  if (payload.s !== context.sort) {
    throw invalidCursor(
      `Cursor was issued for sort "${payload.s}" but this request uses "${context.sort}". Restart pagination.`,
      'CURSOR_SORT_MISMATCH',
    );
  }
  if (payload.f !== context.filterHash) {
    throw invalidCursor(
      'Cursor does not match the current filters. Restart pagination after changing filters.',
      'CURSOR_FILTER_MISMATCH',
    );
  }
  if (!isValidId(payload.i)) {
    throw invalidCursor('Cursor does not contain a valid ObjectId');
  }
  if (payload.s !== 'newest') {
    if (typeof payload.p !== 'number' || !Number.isFinite(payload.p) || payload.p < 0) {
      throw invalidCursor('Cursor does not contain a valid price');
    }
  }

  const decoded = { sort: payload.s, id: payload.i };
  if (payload.s !== 'newest') decoded.price = payload.p;
  return decoded;
}

export default { encodeCursor, decodeCursor, hashFilters };
