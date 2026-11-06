/**
 * Pagination is *internal* state of the customer listing.
 *
 * This module used to own `?page=N`: it read the depth out of the router and wrote
 * it back on every appended page. That is gone. The customer URL now carries the
 * filter set only (`search`, `brand`, `category`, `minPrice`, `maxPrice`, `sort`),
 * while the number of loaded pages is owned by the RTK Query cache — one entry per
 * filter set, one cursor per appended page (see `merge` in
 * `getStorefrontProducts`), resumed by `selectCachedListCursor`.
 *
 * What is left is the negative half of that contract: a listing URL must never
 * carry pagination again, whoever produced it — an old bookmark, a hand-edited
 * address, a link from a build that still had `?page=`, or a redirect that appended
 * one. `stripPagination` is applied by `useUrlSyncedFilters` before the URL is
 * compared with the store, so the parameter is dropped (with `replace`, i.e. without
 * adding a history entry) and can never be restored by back/forward.
 *
 * The module keeps its original path to avoid deleting a file; the only export is
 * the guard below.
 */
export const PAGINATION_PARAM = 'page';

/**
 * Returns `searchParams` without the pagination parameter.
 *
 * @param {URLSearchParams} searchParams
 * @returns {URLSearchParams} the same instance when there was nothing to strip
 */
export function stripPagination(searchParams) {
  if (!searchParams || !searchParams.has(PAGINATION_PARAM)) return searchParams;
  const cleaned = new URLSearchParams(searchParams);
  cleaned.delete(PAGINATION_PARAM);
  return cleaned;
}

export default stripPagination;
