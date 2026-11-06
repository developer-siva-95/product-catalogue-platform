import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useAppDispatch, useAppSelector } from '../app/hooks.js';
import { filtersReplaced, selectFilters } from '../features/filters/storefrontFiltersSlice.js';
import { PRODUCT_SORTS } from '../utils/constants.js';
import { stripPagination } from './useListingDepth.js';

const FILTER_KEYS = ['search', 'brand', 'category', 'minPrice', 'maxPrice', 'sort'];

/** Reads the filter set out of the URL (the durable representation). */
export function parseFiltersFromParams(searchParams) {
  const sort = searchParams.get('sort');
  return {
    search: searchParams.get('search') ?? '',
    brand: searchParams.get('brand') ?? '',
    category: searchParams.get('category') ?? '',
    minPrice: searchParams.get('minPrice') ?? '',
    maxPrice: searchParams.get('maxPrice') ?? '',
    sort: Object.values(PRODUCT_SORTS).includes(sort) ? sort : PRODUCT_SORTS.NEWEST,
  };
}

/** Builds a canonical query string (omits defaults so URLs stay short). */
export function buildSearchParams(filters) {
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.brand) params.set('brand', filters.brand);
  if (filters.category) params.set('category', filters.category);
  if (filters.minPrice !== '' && filters.minPrice !== null && filters.minPrice !== undefined) {
    params.set('minPrice', String(filters.minPrice));
  }
  if (filters.maxPrice !== '' && filters.maxPrice !== null && filters.maxPrice !== undefined) {
    params.set('maxPrice', String(filters.maxPrice));
  }
  if (filters.sort && filters.sort !== PRODUCT_SORTS.NEWEST) params.set('sort', filters.sort);
  return params;
}

export function filtersEqual(a, b) {
  return FILTER_KEYS.every((key) => String(a?.[key] ?? '') === String(b?.[key] ?? ''));
}

/**
 * The URL carries the filter set and nothing else.
 *
 * `search`, `brand`, `category`, `minPrice`, `maxPrice` and `sort` are the only
 * supported parameters. Pagination is *not* one of them: how many pages are loaded
 * is internal state owned by the RTK Query cache, so a `?page=` (legacy bookmarks,
 * hand-edited URLs, a shared link from an older build) is stripped on sight — it is
 * never generated, preserved or restored.
 *
 * Two-way sync between the URL query string and the filters slice.
 *
 * Direction rules:
 *  - **store → URL** whenever the store is what changed (in-app filter
 *    interaction). The URL is updated with `replace`, so the back button is not
 *    flooded with one history entry per keystroke.
 *  - **URL → store** whenever the URL is what changed (browser back/forward, a
 *    deep link, a shared link, or the "back to results" action on a detail page).
 *  - **first mount with a bare URL but a populated store** counts as a store
 *    change, so returning from a product detail page restores the shopper's
 *    filters into the URL instead of clearing them.
 *
 * A single effect reconciles both sides by comparing each one against the value it
 * had at the last commit, which makes the sync converge instead of looping.
 */
export function useUrlSyncedFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const dispatch = useAppDispatch();
  const filters = useAppSelector(selectFilters);
  // A legacy `?page=` is dropped before the URL is interpreted, so pagination can
  // never re-enter the listing state through a bookmark, a shared link or history.
  const urlFilters = useMemo(
    () => parseFiltersFromParams(stripPagination(searchParams)),
    [searchParams],
  );
  /** `null` until the first commit; then the values both sides last agreed on. */
  const lastCommitted = useRef(null);
  /**
   * `false` until the URL and the store agree for the first time. Consumers use it
   * to hold back the first fetch, so a filtered deep link never fires an
   * unfiltered request and then a filtered one.
   */
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // ---- first commit: decide once which side wins -----------------------
    if (lastCommitted.current === null) {
      lastCommitted.current = { url: urlFilters, store: filters };
      const urlHasFilters = FILTER_KEYS.some((key) => searchParams.has(key));

      if (urlHasFilters) {
        // A deep link / bookmark: the URL is the user's actual request.
        if (!filtersEqual(urlFilters, filters)) dispatch(filtersReplaced(urlFilters));
        setReady(true);
        return;
      }
      // A bare URL while the store still holds filters (back from a detail
      // page): keep the shopper's selection and put it back in the URL.
      if (!filtersEqual(urlFilters, filters)) {
        setSearchParams(buildSearchParams(filters), { replace: true });
      }
      setReady(true);
      return;
    }

    // ---- steady state: whoever changed wins -----------------------------
    const urlChanged = !filtersEqual(urlFilters, lastCommitted.current.url);
    const storeChanged = !filtersEqual(filters, lastCommitted.current.store);

    if (urlChanged) {
      // External navigation (back/forward, link) — mirror it into the store.
      lastCommitted.current = { url: urlFilters, store: urlFilters };
      if (!filtersEqual(urlFilters, filters)) dispatch(filtersReplaced(urlFilters));
      setReady(true);
      return;
    }

    if (storeChanged) {
      // In-app interaction — mirror it into the URL without adding history.
      lastCommitted.current = { url: filters, store: filters };
      setSearchParams(buildSearchParams(filters), { replace: true });
    }
    setReady(true);
  }, [filters, urlFilters, dispatch, searchParams, setSearchParams]);

  /**
   * Drop pagination from the URL, whoever put it there: a legacy bookmark, a
   * hand-edited address, a link shared from a build that still had `?page=`, or the
   * `fromSearch` state of a detail page opened before this change. Other parameters
   * are left alone — only pagination is ours to police. `replace`, so normalising
   * never adds a history entry (and therefore never comes back via back/forward).
   *
   * `stripPagination` returns the same instance when there is nothing to strip, so
   * this effect settles after a single pass.
   */
  useEffect(() => {
    if (stripPagination(searchParams) === searchParams) return;
    setSearchParams(stripPagination(searchParams), { replace: true });
  }, [searchParams, setSearchParams]);

  return { filters, urlFilters, ready };
}

export default useUrlSyncedFilters;
