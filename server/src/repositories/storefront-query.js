import { hashFilters } from '../utils/cursor.js';

/**
 * Storefront filter fingerprint — shared by both providers.
 *
 * A cursor token is bound to the filter set that produced it. If the two providers
 * computed that fingerprint slightly differently, a cursor minted by MongoDB would
 * be rejected by MySQL (and vice versa), so the definition lives here, once:
 *
 *   `activeOnly` + `search` + `minPrice` + `maxPrice` + `brand` + `category` + `sort`
 *
 * The shape (including which keys are always present) is part of the contract:
 * changing it invalidates every cursor already in a client's cache.
 */

/**
 * The exact object whose hash is embedded in a cursor.
 * @param {object} query validated storefront query
 */
export function storefrontFilterSet(query) {
  return {
    activeOnly: true,
    search: query.search,
    minPrice: query.minPrice,
    maxPrice: query.maxPrice,
    brand: query.brand,
    category: query.category,
    sort: query.sort,
  };
}

/**
 * 16-hex-char fingerprint of the active storefront filters.
 * @param {object} query
 * @returns {string}
 */
export function storefrontFilterHash(query) {
  return hashFilters(storefrontFilterSet(query));
}

export default { storefrontFilterSet, storefrontFilterHash };
