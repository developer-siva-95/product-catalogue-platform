import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useAppDispatch, useAppSelector } from '../app/hooks.js';
import {
  filterBrandToggled,
  filterCategoryToggled,
  filterPriceChanged,
  filterSearchChanged,
  filterSortChanged,
  filtersReset,
  selectActiveFilterCount,
} from '../features/filters/storefrontFiltersSlice.js';
import {
  selectCachedListCursor,
  useGetBrandsQuery,
  useGetCategoriesQuery,
  useGetStorefrontProductsQuery,
} from '../api/apiSlice.js';
import { useUrlSyncedFilters, buildSearchParams } from '../hooks/useUrlSyncedFilters.js';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { useScrollRestoration } from '../hooks/useScrollRestoration.js';
import { SORT_OPTIONS, STOREFRONT_PAGE_SIZE } from '../utils/constants.js';
import { errorMessage } from '../utils/format.js';
import FilterSidebar from '../components/FilterSidebar.jsx';
import SearchInput from '../components/SearchInput.jsx';
import ActiveFilters from '../components/ActiveFilters.jsx';
import ProductGrid, { ProductGridSkeleton } from '../components/ProductGrid.jsx';
import EmptyState from '../components/EmptyState.jsx';
import RefreshButton from '../components/RefreshButton.jsx';

/**
 * Public storefront.
 *
 * Data flow: filters (Redux, mirrored to the URL) → RTK Query page requests.
 * Each additional page appends to the cached list (`merge`) and the *cursor is read
 * back out of that same cache entry*, so the paging position and the pages it
 * addresses always share one lifetime — and products already seen are never
 * re-fetched or re-rendered.
 *
 * Paging is driven by an IntersectionObserver sentinel instead of a "Load more"
 * button: the next page is requested only when the shopper approaches the bottom,
 * one page at a time, with the current filter set (the cursor is scoped to it).
 *
 * Two concerns are deliberately kept apart:
 *  - **data freshness** — the RTK Query cache is the single copy of the list; a
 *    detail fetch writes its fresher product back into the cached pages (see
 *    `patchCachedProductLists`), and mutations invalidate the list tag. Nothing
 *    here refetches pages that are already cached.
 *  - **UI state restoration** — filters/sort/search live in the URL (via
 *    `useUrlSyncedFilters`) because they are what someone shares or bookmarks; the
 *    scroll offset is restored from `sessionStorage`.
 *
 * Pagination state is deliberately *not* in the URL. The number of loaded pages is
 * internal: the RTK Query cache is the single copy of it (one entry per filter set,
 * one cursor per appended page, see `merge`), so a remount renders exactly the pages
 * the cache still holds and `selectCachedListCursor` resumes from the deepest one.
 * No `?page=` is generated, preserved or restored — a URL that carries one has it
 * stripped by `useUrlSyncedFilters` — and the backend's cursor parameters are passed
 * only through the RTK Query argument.
 */
export function StorefrontPage() {
  useDocumentTitle('Shop the catalogue');
  const dispatch = useAppDispatch();
  const { filters, ready } = useUrlSyncedFilters();
  const activeFilterCount = useAppSelector(selectActiveFilterCount);

  const location = useLocation();
  const isMobile = useMediaQuery('(max-width: 900px)');
  const [filtersOpen, setFiltersOpen] = useState(false);
  /**
   * The drawer is a mobile-only surface, so `isMobile` gates it on every render:
   * resizing past the breakpoint cannot leave an open drawer (or its scroll lock)
   * behind, and no effect has to synchronise the two.
   */
  const drawerOpen = isMobile && filtersOpen;

  /**
   * The cursor is *derived from the cache*, never kept in Redux.
   *
   * That was the root cause of the pagination reset: the cursor used to live in the
   * store while the pages it addressed lived in an RTK Query entry that expires
   * after `keepUnusedDataFor`. When the entry was evicted (a detail page left open
   * for a couple of minutes), the replayed cursor produced page 2 into an empty
   * cache — the shopper came back to 8 mid-catalogue products instead of the 20 they
   * had loaded. Deriving the cursor from `cursors` (recorded by `merge`) makes the
   * position and the data it refers to the same lifetime: no pages ⇒ no cursor.
   */
  const [paging, setPaging] = useState({ signature: null, cursor: null });

  /** Filter args only — the identity of the cache entry (see `serializeQueryArgs`). */
  const { search, brand, category, minPrice, maxPrice, sort } = filters;
  const filterArgs = useMemo(
    () => ({
      limit: STOREFRONT_PAGE_SIZE,
      search: search || undefined,
      brand: brand || undefined,
      category: category || undefined,
      minPrice,
      maxPrice,
      sort,
    }),
    [search, brand, category, minPrice, maxPrice, sort],
  );

  /**
   * Which cursor the query should be sitting on, resolved **before** the query hook
   * runs: either this mount asked for one (`paging`), or the cache is already parked
   * on one (`cursors`, recorded by `merge`). The `paging` stamp carries the filter
   * signature, so a cursor can never leak into a different filter set — a stale
   * stamp is simply not trusted.
   */
  const filterSignature = JSON.stringify(filters);
  const cachedCursor = useAppSelector((state) => selectCachedListCursor(state, filterArgs));
  const pendingCursor = paging.signature === filterSignature ? paging.cursor : cachedCursor;

  const queryArgs = useMemo(
    () => ({ ...filterArgs, cursor: pendingCursor ?? undefined }),
    [filterArgs, pendingCursor],
  );

  const { data, currentData, error, isFetching, isLoading, refetch } =
    useGetStorefrontProductsQuery(
      queryArgs,
      // Hold the first request until the URL and the store agree, so a filtered
      // deep link fetches once (filtered) instead of twice.
      //
      // `refetchOnMountOrArgChange: true` makes *navigation* a freshness event:
      // coming back to the list (or to a different filter set) always re-reads the
      // page it is parked on instead of rendering the retained cache entry.
      { skip: !ready, refetchOnMountOrArgChange: true },
    );

  const { data: brandsResponse, isLoading: brandsLoading } = useGetBrandsQuery({ sort: 'name' });
  const { data: categoriesResponse, isLoading: categoriesLoading } = useGetCategoriesQuery({
    sort: 'name',
  });

  const brands = brandsResponse?.data ?? [];
  const categories = categoriesResponse?.data ?? [];
  /**
   * `currentData` is only defined when the cache entry matches the *current* args,
   * so a response that arrives for a superseded filter set can never be rendered
   * (those responses land in their own cache entry, keyed by the filter set). While
   * a page is being appended the merged list stays on screen via `data`.
   */
  const listData = currentData ?? data;
  const products = listData?.data ?? [];
  const meta = listData?.meta;

  // ---- Cursor lifecycle -------------------------------------------------
  const nextCursor = meta?.nextCursor ?? null;
  const hasNextPage = meta?.hasNextPage ?? Boolean(nextCursor);
  const isLoadingFirstPage = (isLoading || !ready) && products.length === 0;
  const isFetchingMore = isFetching && products.length > 0;
  /** Never fire two requests for the same cursor (the observer can fire repeatedly). */
  const inFlightCursor = useRef(null);

  const canLoadMore = Boolean(nextCursor) && !isFetching && !error && products.length > 0;

  useEffect(() => {
    if (!isFetching) inFlightCursor.current = null;
  }, [isFetching]);

  const loadMore = useCallback(() => {
    if (!canLoadMore || inFlightCursor.current === nextCursor) return;
    inFlightCursor.current = nextCursor;
    setPaging({ signature: filterSignature, cursor: nextCursor });
  }, [canLoadMore, filterSignature, nextCursor]);

  const { sentinelRef, supported: observerSupported } = useInfiniteScroll({
    onLoadMore: loadMore,
    canLoadMore,
  });

  /**
   * Scroll restoration is keyed by the *filter set*, so appending a page does not
   * re-scroll the page, while switching filters starts at the top. It becomes ready
   * as soon as the pages the cache holds are on screen — with no depth in the URL
   * there is no target to replay, and nothing here ever costs a request.
   */
  const scrollKey = `${location.pathname}?${buildSearchParams(filters).toString()}`;
  useScrollRestoration(scrollKey, {
    ready: ready && products.length > 0,
  });

  /**
   * Manual refresh: force the query the list is currently subscribed to.
   *
   * `refetch()` is RTK Query's own escape hatch from the cache — it issues the same
   * request the endpoint would make, for the same arguments (the accumulated
   * filter set and the deepest cursor), and RTK Query replaces the payload of that
   * cache entry with the response. Nothing is cleared: the filters, the sort, the
   * loaded depth and the scroll position all survive, and an in-flight/duplicate
   * click is rejected by the button's disabled state plus this guard.
   */
  const handleRefresh = useCallback(() => {
    if (isFetching) return;
    refetch();
  }, [isFetching, refetch]);

  // Keep the shopper at the top guard when the filter set restarts the list.
  const gridTopRef = useRef(null);
  const handleReset = useCallback(() => {
    dispatch(filtersReset());
    // The cursor follows the cache: a new filter set is a new entry, so the
    // accumulated pages (and with them the depth) start over by construction.
    setPaging({ signature: null, cursor: null });
    gridTopRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [dispatch]);

  const brandName = brands.find((item) => item.id === filters.brand)?.name;
  const categoryName = categories.find((item) => item.id === filters.category)?.name;

  const showSkeleton = isLoadingFirstPage;
  const showEmpty = !isLoading && !error && products.length === 0;
  /** A failure after the first page must not wipe the products already shown. */
  const fatalError = Boolean(error) && products.length === 0;
  const pageError = Boolean(error) && products.length > 0;

  const subtitle =
    products.length === 0
      ? 'Browse our latest arrivals'
      : `Showing ${products.length} product${products.length === 1 ? '' : 's'}${
          hasNextPage ? ' · more available' : ''
        }`;

  return (
    <div className="container page">
      <div className="page-heading">
        <div>
          <h1>Shop the catalogue</h1>
          <p className="page-heading__subtitle">
            {subtitle}
            {activeFilterCount > 0 ? ` · ${activeFilterCount} filter(s) applied` : ''}
          </p>
        </div>
      </div>

      <div className="storefront-layout">
        <FilterSidebar
          brands={brands}
          categories={categories}
          brandsLoading={brandsLoading}
          categoriesLoading={categoriesLoading}
          brand={filters.brand}
          category={filters.category}
          minPrice={filters.minPrice}
          maxPrice={filters.maxPrice}
          activeCount={activeFilterCount}
          onBrandToggle={(id) => dispatch(filterBrandToggled(id))}
          onCategoryToggle={(id) => dispatch(filterCategoryToggled(id))}
          onPriceApply={(range) => dispatch(filterPriceChanged(range))}
          onReset={handleReset}
          isMobile={isMobile}
          mobileOpen={drawerOpen}
          onMobileOpen={() => setFiltersOpen(true)}
          onMobileClose={() => setFiltersOpen(false)}
        />

        <section aria-label="Products" ref={gridTopRef}>
          <div className="toolbar">
            <SearchInput
              value={filters.search}
              onCommit={(value) => dispatch(filterSearchChanged(value))}
            />
            <RefreshButton
              onRefresh={handleRefresh}
              isFetching={isFetching}
              label="Refresh"
              title="Reload this list from the server"
            />
            <label className="visually-hidden" htmlFor="sort-select">
              Sort products
            </label>
            <select
              id="sort-select"
              className="select toolbar__sort"
              value={filters.sort}
              onChange={(event) => dispatch(filterSortChanged(event.target.value))}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <ActiveFilters
            search={filters.search}
            brandName={brandName}
            categoryName={categoryName}
            minPrice={filters.minPrice}
            maxPrice={filters.maxPrice}
            onClearSearch={() => dispatch(filterSearchChanged(''))}
            onClearBrand={() => dispatch(filterBrandToggled(filters.brand))}
            onClearCategory={() => dispatch(filterCategoryToggled(filters.category))}
            onClearPrice={() => dispatch(filterPriceChanged({ minPrice: '', maxPrice: '' }))}
          />

          {fatalError ? (
            <div className="alert alert--error" role="alert" style={{ marginBottom: 16 }}>
              <span aria-hidden="true">⚠</span>
              <span>
                {errorMessage(error, 'Could not load products.')}{' '}
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => refetch()}>
                  Retry
                </button>
              </span>
            </div>
          ) : null}

          {showSkeleton ? <ProductGridSkeleton count={8} /> : null}

          {showEmpty ? (
            <EmptyState
              icon="⌕"
              title="No products match your filters"
              description="Try a different search term, widen the price range, or clear the filters to see everything."
              action={
                <button type="button" className="btn btn--primary" onClick={handleReset}>
                  Clear filters
                </button>
              }
            />
          ) : null}

          {products.length > 0 ? <ProductGrid products={products} /> : null}

          {products.length > 0 ? (
            <div className="infinite-scroll">
              {pageError ? (
                <div className="alert alert--error" role="alert">
                  <span aria-hidden="true">⚠</span>
                  <span>
                    {errorMessage(error, 'Could not load more products.')}{' '}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => refetch()}
                    >
                      Retry
                    </button>
                  </span>
                </div>
              ) : null}

              {/* Observed by the infinite-scroll hook: when it comes into view the
                  next page is requested. Purely a scroll trigger, so it carries no
                  content of its own. */}
              {observerSupported && canLoadMore ? (
                <div ref={sentinelRef} className="infinite-scroll__sentinel" aria-hidden="true" />
              ) : null}

              {/* Fallback for environments without IntersectionObserver, so paging
                  still works (one page per activation). */}
              {!observerSupported && canLoadMore ? (
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={loadMore}
                  disabled={isFetching}
                >
                  {isFetching ? <span className="btn__spinner" aria-hidden="true" /> : null}
                  Load more products
                </button>
              ) : null}

              <p className="infinite-scroll__status" role="status" aria-live="polite">
                {isFetchingMore ? (
                  <>
                    <span className="btn__spinner" aria-hidden="true" /> Loading more products…
                  </>
                ) : pageError ? (
                  'Loading stopped. Retry to continue where you left off.'
                ) : !hasNextPage ? (
                  `You have reached the end · ${products.length} products`
                ) : (
                  ''
                )}
              </p>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

export default StorefrontPage;
