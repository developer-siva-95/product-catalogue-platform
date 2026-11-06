import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import {
  apiSlice,
  patchCachedProductLists,
  selectCachedListCursor,
  useGetProductQuery,
} from './apiSlice.js';
import { createAppStore } from '../app/store.js';
import { jsonResponse } from '../test/utils.jsx';

/**
 * Cache-contract tests for the storefront list endpoint.
 *
 * These run against a real store + real RTK Query middleware (only `fetch` is
 * stubbed), because the behaviour under test *is* the cache: page accumulation,
 * page accounting, the cursor the cache is parked on, and the write-back of a
 * freshly fetched product into the cached pages.
 */

const product = (id, overrides = {}) => ({
  id,
  title: `Product ${id}`,
  price: 1000,
  stock: 5,
  stockStatus: 'in_stock',
  image: null,
  thumbnail: null,
  isActive: true,
  brand: { id: 'b1', name: 'Aurora' },
  category: { id: 'c1', name: 'Lighting' },
  ...overrides,
});

const listArgs = { limit: 2, sort: 'newest' };

/**
 * Threshold used by the two cache-age tests below. The *pages* now subscribe with
 * `refetchOnMountOrArgChange: true`; these two tests keep covering the underlying
 * mechanism with an explicit numeric threshold so the endpoint's cache-age
 * behaviour stays pinned.
 */
const REVALIDATE_SECONDS = 15;

function listPayload(items, { nextCursor = null, count } = {}) {
  return {
    data: items,
    meta: {
      nextCursor,
      hasNextPage: Boolean(nextCursor),
      limit: 2,
      sort: 'newest',
      count: count ?? items.length,
    },
  };
}

/** Serves page 1 (`p1`,`p2`) then page 2 (`p3`) and counts the requests. */
function stubStorefrontFetch({ pages } = {}) {
  const calls = [];
  const responses = pages ?? {
    '': listPayload([product('p1'), product('p2')], { nextCursor: 'cursor-2' }),
    'cursor-2': listPayload([product('p3')]),
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      calls.push(Object.fromEntries(url.searchParams));

      if (url.pathname.endsWith('/products')) {
        const cursor = url.searchParams.get('cursor') ?? '';
        // Any other cursor is a contract violation the tests want to see fail loudly.
        const body = responses[cursor];
        if (!body) return jsonResponse({ error: { code: 'CURSOR_INVALID' } }, { status: 400 });
        return jsonResponse(body);
      }

      if (url.pathname.match(/\/products\/[^/]+$/)) {
        const id = url.pathname.split('/').pop();
        return jsonResponse({
          data: product(id, { stock: 99, stockStatus: 'in_stock', price: 4242 }),
        });
      }

      return jsonResponse({ error: { code: 'ROUTE_NOT_FOUND' } }, { status: 404 });
    }),
  );

  return calls;
}

const listState = (store) => store.getState()[apiSlice.reducerPath];

/**
 * The cache key RTK derives for a filter set. Mirrors the endpoint's
 * `serializeQueryArgs` (cursor excluded, `undefined` fields dropped by JSON).
 */
const listKey = (args) => {
  const { cursor: _cursor, ...filters } = args;
  return `getStorefrontProducts-${JSON.stringify(filters)}`;
};

const listEntry = (store, args = listArgs) => listState(store).queries[listKey(args)];

/** Root state — what `patchCachedProductLists`/`selectInvalidatedBy` expect. */
const rootState = (store) => store.getState();

describe('storefront list cache', () => {
  let store;

  beforeEach(() => {
    vi.unstubAllGlobals();
    store = createAppStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accumulates pages and reports the depth it holds', async () => {
    stubStorefrontFetch();

    await store.dispatch(apiSlice.endpoints.getStorefrontProducts.initiate(listArgs));
    let entry = listEntry(store);
    expect(entry.data.data.map((item) => item.id)).toEqual(['p1', 'p2']);
    // A first page into an empty entry is written as-is (nothing to merge), so the
    // UI reads depth defensively: `pageCount ?? 1`.
    expect(entry.data.pageCount ?? 1).toBe(1);
    expect(entry.data.cursors ?? []).toEqual([]);

    await store.dispatch(
      apiSlice.endpoints.getStorefrontProducts.initiate({ ...listArgs, cursor: 'cursor-2' }),
    );
    entry = listEntry(store);
    expect(entry.data.data.map((item) => item.id)).toEqual(['p1', 'p2', 'p3']);
    expect(entry.data.pageCount).toBe(2);
    expect(entry.data.cursors).toEqual(['cursor-2']);
  });

  it('does not count a retried cursor as an extra page', async () => {
    stubStorefrontFetch();
    await store.dispatch(apiSlice.endpoints.getStorefrontProducts.initiate(listArgs));
    await store.dispatch(
      apiSlice.endpoints.getStorefrontProducts.initiate({ ...listArgs, cursor: 'cursor-2' }),
    );
    // Retry the same cursor (what the error Retry button does).
    await store.dispatch(
      apiSlice.endpoints.getStorefrontProducts.initiate(
        { ...listArgs, cursor: 'cursor-2' },
        { forceRefetch: true },
      ),
    );

    const entry = listEntry(store);
    expect(entry.data.pageCount).toBe(2);
    expect(entry.data.data).toHaveLength(3);
  });

  it('exposes the cursor the cache is parked on, so a remount can resume', async () => {
    stubStorefrontFetch();
    await store.dispatch(apiSlice.endpoints.getStorefrontProducts.initiate(listArgs));
    expect(selectCachedListCursor(rootState(store), listArgs)).toBeNull();

    await store.dispatch(
      apiSlice.endpoints.getStorefrontProducts.initiate({ ...listArgs, cursor: 'cursor-2' }),
    );
    expect(selectCachedListCursor(rootState(store), listArgs)).toBe('cursor-2');
    // The cursor is not part of the cache identity, so an arg carrying some
    // *other* cursor still resolves the same entry.
    expect(selectCachedListCursor(rootState(store), { ...listArgs, cursor: 'ignored' })).toBe(
      'cursor-2',
    );
  });

  it('writes a fresher product back into the cached pages', async () => {
    stubStorefrontFetch();
    await store.dispatch(apiSlice.endpoints.getStorefrontProducts.initiate(listArgs));

    patchCachedProductLists(store.dispatch, rootState(store), {
      ...product('p2'),
      stock: 3,
      stockStatus: 'low_stock',
      price: 777,
    });

    const entry = listEntry(store);
    const updated = entry.data.data.find((item) => item.id === 'p2');
    expect(updated.stock).toBe(3);
    expect(updated.stockStatus).toBe('low_stock');
    expect(updated.price).toBe(777);
    // The untouched sibling keeps its own values.
    expect(entry.data.data.find((item) => item.id === 'p1').stock).toBe(5);
  });

  it('refreshes the listing from a detail fetch without requesting the list again', async () => {
    const calls = stubStorefrontFetch();
    await store.dispatch(apiSlice.endpoints.getStorefrontProducts.initiate(listArgs));
    const listRequests = calls.filter((call) => !call.cursor).length;
    expect(listRequests).toBe(1);

    await store.dispatch(apiSlice.endpoints.getProduct.initiate('p2'));

    // Only the detail request was added; the list was patched, not refetched.
    expect(calls).toHaveLength(2);
    const entry = listEntry(store);
    expect(entry.data.data.find((item) => item.id === 'p2').stock).toBe(99);
    expect(entry.data.data.find((item) => item.id === 'p2').price).toBe(4242);
  });

  it('keeps the accumulated pages for 15 minutes while a detail page is open', async () => {
    stubStorefrontFetch();
    const subscription = store.dispatch(
      apiSlice.endpoints.getStorefrontProducts.initiate(listArgs),
    );
    await subscription;
    const key = listKey(listArgs);

    vi.useFakeTimers();
    try {
      subscription.unsubscribe();
      // The old failure mode appeared after ~2 minutes away. A paged list must
      // still be there.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(store.getState()[apiSlice.reducerPath].queries[key]).toBeDefined();

      await vi.advanceTimersByTimeAsync(790_000);
      expect(store.getState()[apiSlice.reducerPath].queries[key]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still expires ordinary entries on the default 60 s window', async () => {
    stubStorefrontFetch();
    const detail = store.dispatch(apiSlice.endpoints.getProduct.initiate('p1'));
    await detail;
    const key = Object.keys(store.getState()[apiSlice.reducerPath].queries).find((entry) =>
      entry.startsWith('getProduct-'),
    );

    vi.useFakeTimers();
    try {
      detail.unsubscribe();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(store.getState()[apiSlice.reducerPath].queries[key]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves a fresh cached detail document without a request on re-entry', async () => {
    const calls = stubStorefrontFetch();
    const wrapper = ({ children }) => createElement(Provider, { store }, children);
    const options = { refetchOnMountOrArgChange: REVALIDATE_SECONDS };

    const first = renderHook(() => useGetProductQuery('p1', options), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();
    expect(calls).toHaveLength(1);

    // Straight back in: the document is younger than the threshold, so the cache
    // answers and no request is made.
    const second = renderHook(() => useGetProductQuery('p1', options), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    second.unmount();
    expect(calls).toHaveLength(1);
  });

  it('revalidates on re-entry once the document is past the threshold', async () => {
    const calls = stubStorefrontFetch();
    const wrapper = ({ children }) => createElement(Provider, { store }, children);
    // Same mechanism the detail page uses, with a threshold the test can cross.
    const options = { refetchOnMountOrArgChange: 0.001 };

    const first = renderHook(() => useGetProductQuery('p1', options), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();
    expect(calls).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = renderHook(() => useGetProductQuery('p1', options), { wrapper });
    await waitFor(() => expect(calls).toHaveLength(2));
    second.unmount();
  });
});

/**
 * Tag contract.
 *
 * This is what makes mutations refresh the *right* data with zero manual
 * `refetch()` calls: a write invalidates the document it changed, the lists that
 * contain it, and the inventory views — active queries refetch immediately,
 * inactive entries are marked invalid so a later subscription cannot treat them as
 * fresh.
 *
 * The assertions below are **runtime** ones: every test drives the real store, the
 * real RTK Query middleware and the real tag graph (only `fetch` is stubbed), then
 * inspects the resulting cache entries with `selectInvalidatedBy` and the requests
 * that actually went out. Nothing reads endpoint definitions off the endpoint
 * object — RTK Query does not expose `providesTags`/`invalidatesTags` there, and
 * the contract that matters is the invalidation that happens at runtime.
 */

/** GET requests that were actually issued to a path (mutations are filtered out). */
const getCount = (calls, pathname) =>
  calls.filter((call) => call.method === 'GET' && call.pathname.endsWith(pathname)).length;

describe('apiSlice tag contract (product / inventory)', () => {
  let store;

  beforeEach(() => {
    store = createAppStore();
    apiSlice.util.resetApiState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    apiSlice.util.resetApiState();
  });

  /** Cache entries the invalidation engine would select for `tag`. */
  const entriesFor = (tag) =>
    apiSlice.util.selectInvalidatedBy(
      { [apiSlice.reducerPath]: store.getState()[apiSlice.reducerPath] },
      [tag],
    );

  /** Does `endpointName` hold a cache entry that provides `tag`? */
  const hasEntry = (endpointName, tag) =>
    entriesFor(tag).some((entry) => entry.endpointName === endpointName);

  it('publishes per-document product and inventory tags from the admin list', async () => {
    stubTagContractFetch();
    const list = store.dispatch(
      apiSlice.endpoints.getAdminProducts.initiate({ page: 1, limit: 10 }),
    );
    await list;

    for (const tag of [
      { type: 'Product', id: 'LIST' },
      { type: 'Inventory', id: 'LIST' },
      { type: 'Product', id: 'p1' },
      { type: 'Product', id: 'p2' },
      { type: 'Inventory', id: 'p1' },
      { type: 'Inventory', id: 'p2' },
    ]) {
      expect(
        hasEntry('getAdminProducts', tag),
        `the admin list must provide ${tag.type}:${tag.id}`,
      ).toBe(true);
    }

    // Granularity: a product the list does not contain is not covered by it.
    expect(entriesFor({ type: 'Product', id: 'p3' })).toHaveLength(0);
    expect(entriesFor({ type: 'Inventory', id: 'p3' })).toHaveLength(0);

    list.unsubscribe();
  });

  it('publishes product and inventory tags from the admin detail', async () => {
    stubTagContractFetch();
    const detail = store.dispatch(apiSlice.endpoints.getAdminProduct.initiate('p1'));
    await detail;

    expect(hasEntry('getAdminProduct', { type: 'Product', id: 'p1' })).toBe(true);
    expect(hasEntry('getAdminProduct', { type: 'Inventory', id: 'p1' })).toBe(true);

    // The admin detail is the stock view of *that* product, not of the catalogue.
    expect(entriesFor({ type: 'Inventory', id: 'p2' })).toHaveLength(0);
    expect(entriesFor({ type: 'Product', id: 'LIST' })).toHaveLength(0);
    expect(entriesFor({ type: 'Inventory', id: 'LIST' })).toHaveLength(0);

    detail.unsubscribe();
  });

  it.each([
    ['updateProduct', { id: 'p1', body: { title: 'Renamed' } }],
    ['updateStock', { id: 'p1', delta: 1 }],
    ['deleteProduct', 'p1'],
  ])('%s refreshes the open list and the open document', async (endpoint, arg) => {
    const calls = stubTagContractFetch();
    const list = store.dispatch(
      apiSlice.endpoints.getAdminProducts.initiate({ page: 1, limit: 10 }),
    );
    await list;
    const detail = store.dispatch(apiSlice.endpoints.getAdminProduct.initiate('p1'));
    await detail;

    expect([getCount(calls, '/admin/products'), getCount(calls, '/admin/products/p1')]).toEqual([
      1, 1,
    ]);

    await store.dispatch(apiSlice.endpoints[endpoint].initiate(arg));

    // Both entries were active, so the invalidation refetches them immediately —
    // no manual `refetch()` anywhere in the app.
    await waitFor(() => expect(getCount(calls, '/admin/products')).toBe(2));
    await waitFor(() => expect(getCount(calls, '/admin/products/p1')).toBe(2));

    list.unsubscribe();
    detail.unsubscribe();
  });

  it('treats the admin list and the admin detail as inventory views', async () => {
    const calls = stubTagContractFetch();
    const list = store.dispatch(
      apiSlice.endpoints.getAdminProducts.initiate({ page: 1, limit: 10 }),
    );
    await list;
    const detail = store.dispatch(apiSlice.endpoints.getAdminProduct.initiate('p1'));
    await detail;

    expect([getCount(calls, '/admin/products'), getCount(calls, '/admin/products/p1')]).toEqual([
      1, 1,
    ]);

    // `updateStock` invalidates exactly these two Inventory tags; invalidating them
    // directly shows that both views are subscribed to the inventory contract.
    store.dispatch(
      apiSlice.util.invalidateTags([
        { type: 'Inventory', id: 'p1' },
        { type: 'Inventory', id: 'LIST' },
      ]),
    );

    await waitFor(() => expect(getCount(calls, '/admin/products/p1')).toBe(2));
    await waitFor(() => expect(getCount(calls, '/admin/products')).toBe(2));

    list.unsubscribe();
    detail.unsubscribe();
  });

  it('createProduct refreshes the product lists and both taxonomy facets', async () => {
    const calls = stubTagContractFetch();
    const list = store.dispatch(
      apiSlice.endpoints.getAdminProducts.initiate({ page: 1, limit: 10 }),
    );
    await list;
    const brands = store.dispatch(apiSlice.endpoints.getBrands.initiate({}));
    await brands;
    const categories = store.dispatch(apiSlice.endpoints.getCategories.initiate({}));
    await categories;

    expect([
      getCount(calls, '/admin/products'),
      getCount(calls, '/brands'),
      getCount(calls, '/categories'),
    ]).toEqual([1, 1, 1]);

    await store.dispatch(apiSlice.endpoints.createProduct.initiate(new FormData()));

    // A new product can introduce a brand/category, so the facets are refreshed too.
    await waitFor(() => expect(getCount(calls, '/admin/products')).toBe(2));
    await waitFor(() => expect(getCount(calls, '/brands')).toBe(2));
    await waitFor(() => expect(getCount(calls, '/categories')).toBe(2));

    list.unsubscribe();
    brands.unsubscribe();
    categories.unsubscribe();
  });

  it('resolves a mutation of one product to that document and to the lists', async () => {
    const calls = stubAdminFetch();
    // One active list, one inactive detail: the two shapes a real session has.
    const list = store.dispatch(
      apiSlice.endpoints.getAdminProducts.initiate({ page: 1, limit: 10 }),
    );
    await list;
    const detail = store.dispatch(apiSlice.endpoints.getAdminProduct.initiate('p1'));
    await detail;
    detail.unsubscribe();

    const listGets = () =>
      calls.filter((call) => call.pathname.endsWith('/admin/products') && call.method === 'GET');
    expect(listGets()).toHaveLength(1);

    const state = store.getState()[apiSlice.reducerPath];
    // Tag wiring is what the invalidation engine reads, so assert on it directly:
    // the inactive detail entry is findable by both of its tags.
    const invalidatedByProduct = apiSlice.util.selectInvalidatedBy(
      { [apiSlice.reducerPath]: state },
      [{ type: 'Product', id: 'p1' }],
    );
    const invalidatedByInventory = apiSlice.util.selectInvalidatedBy(
      { [apiSlice.reducerPath]: state },
      [{ type: 'Inventory', id: 'p1' }],
    );
    expect(invalidatedByProduct.length).toBeGreaterThanOrEqual(2); // detail + list
    expect(invalidatedByInventory.length).toBeGreaterThanOrEqual(2);

    // A mutation therefore revalidates the active list without any manual refetch…
    await store.dispatch(apiSlice.endpoints.updateStock.initiate({ id: 'p1', delta: 1 }));
    await waitFor(() => expect(listGets()).toHaveLength(2));

    // …and the invalidated detail, once something subscribes again, asks the server
    // instead of being served from the retained cache entry.
    const beforeResubscribe = calls.filter((call) => /\/admin\/products\/p1$/.test(call.pathname));
    const again = store.dispatch(apiSlice.endpoints.getAdminProduct.initiate('p1'));
    await again;
    expect(calls.filter((call) => /\/admin\/products\/p1$/.test(call.pathname)).length).toBe(
      beforeResubscribe.length + 1,
    );
    again.unsubscribe();
    list.unsubscribe();
  });
});

/** Admin-side stub: list, detail and stock endpoints, recording every call. */
function stubAdminFetch() {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const method = (typeof input === 'string' ? init.method : input.method) ?? 'GET';
      calls.push({
        url: url.toString(),
        pathname: url.pathname,
        method,
        params: Object.fromEntries(url.searchParams),
      });

      if (url.pathname.endsWith('/admin/products') && method === 'GET') {
        return jsonResponse({
          data: [product('p1'), product('p2')],
          meta: { page: 1, limit: 10, total: 2, totalPages: 1 },
        });
      }

      if (/\/admin\/products\/[^/]+\/stock$/.test(url.pathname)) {
        return jsonResponse({ data: { ...product('p1'), stock: 8, stockStatus: 'low_stock' } });
      }

      if (/\/admin\/products\/[^/]+$/.test(url.pathname) && method === 'GET') {
        const id = url.pathname.split('/').pop();
        return jsonResponse({ data: { ...product(id), stock: 99 } });
      }

      return jsonResponse({ error: { code: 'ROUTE_NOT_FOUND' } }, { status: 404 });
    }),
  );

  return calls;
}

/**
 * Brand/category tag contract.
 *
 * Taxonomies are embedded in every product payload (`brand: { id, name }`,
 * `category: { id, name }`), so a taxonomy write has two obligations:
 *  1. revalidate the taxonomy list/detail it belongs to (admin tables and the
 *     customer-facing filter facets read the same `getBrands`/`getCategories`
 *     cache entries);
 *  2. revalidate the products that may display that taxonomy.
 *
 * Broad `{ type: 'Product' }` invalidation (no id) is used for (2): the client
 * cannot know which product documents reference a taxonomy id, and an id-less tag
 * matches every `Product` tag — list *and* detail.
 *
 * As in the product block above, every assertion is behavioural: subscribe real
 * queries, dispatch the real mutation, count the refetches.
 */
describe('apiSlice tag contract (brands and categories)', () => {
  let store;

  beforeEach(() => {
    store = createAppStore();
    apiSlice.util.resetApiState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    apiSlice.util.resetApiState();
  });

  const entriesFor = (tag) =>
    apiSlice.util.selectInvalidatedBy(
      { [apiSlice.reducerPath]: store.getState()[apiSlice.reducerPath] },
      [tag],
    );

  const hasEntry = (endpointName, tag) =>
    entriesFor(tag).some((entry) => entry.endpointName === endpointName);

  it('publishes per-document and list tags from the brand list', async () => {
    stubTagContractFetch();
    const brands = store.dispatch(apiSlice.endpoints.getBrands.initiate({}));
    await brands;

    expect(hasEntry('getBrands', { type: 'Brand', id: 'brand-1' })).toBe(true);
    expect(hasEntry('getBrands', { type: 'Brand', id: 'brand-2' })).toBe(true);
    expect(hasEntry('getBrands', { type: 'Brand', id: 'LIST' })).toBe(true);

    // A brand that is not in the list is not covered by it, and brand tags never
    // bleed into the category type.
    expect(entriesFor({ type: 'Brand', id: 'brand-9' })).toHaveLength(0);
    expect(entriesFor({ type: 'Category', id: 'LIST' })).toHaveLength(0);

    brands.unsubscribe();
  });

  it('still publishes the brand list tag when the list is empty', async () => {
    stubTagContractFetch({ brands: [] });
    const brands = store.dispatch(apiSlice.endpoints.getBrands.initiate({}));
    await brands;

    // A failed/empty response still identifies the list it belongs to.
    expect(hasEntry('getBrands', { type: 'Brand', id: 'LIST' })).toBe(true);

    brands.unsubscribe();
  });

  it('publishes per-document and list tags from the category list', async () => {
    stubTagContractFetch();
    const categories = store.dispatch(apiSlice.endpoints.getCategories.initiate({}));
    await categories;

    expect(hasEntry('getCategories', { type: 'Category', id: 'cat-1' })).toBe(true);
    expect(hasEntry('getCategories', { type: 'Category', id: 'LIST' })).toBe(true);
    expect(entriesFor({ type: 'Category', id: 'cat-9' })).toHaveLength(0);

    categories.unsubscribe();
  });

  it.each([
    ['createBrand', { name: 'Aurora X' }],
    ['updateBrand', { id: 'brand-1', name: 'Aurora X' }],
    ['deleteBrand', 'brand-1'],
  ])('%s refreshes brand queries and the product displays', async (endpoint, arg) => {
    const calls = stubTagContractFetch();
    const brands = store.dispatch(apiSlice.endpoints.getBrands.initiate({}));
    await brands;
    const list = store.dispatch(
      apiSlice.endpoints.getStorefrontProducts.initiate({ limit: 2, sort: 'newest' }),
    );
    await list;
    const detail = store.dispatch(apiSlice.endpoints.getProduct.initiate('p1'));
    await detail;

    expect([
      getCount(calls, '/brands'),
      getCount(calls, '/products'),
      getCount(calls, '/products/p1'),
    ]).toEqual([1, 1, 1]);

    await store.dispatch(apiSlice.endpoints[endpoint].initiate(arg));

    await waitFor(() => expect(getCount(calls, '/brands')).toBe(2));
    // Brand names are embedded in product payloads, so both product views refresh.
    await waitFor(() => expect(getCount(calls, '/products')).toBe(2));
    await waitFor(() => expect(getCount(calls, '/products/p1')).toBe(2));

    brands.unsubscribe();
    list.unsubscribe();
    detail.unsubscribe();
  });

  it.each([
    ['createCategory', { name: 'Lamps' }],
    ['updateCategory', { id: 'cat-1', name: 'Lamps' }],
    ['deleteCategory', 'cat-1'],
  ])('%s refreshes category queries and the product displays', async (endpoint, arg) => {
    const calls = stubTagContractFetch();
    const categories = store.dispatch(apiSlice.endpoints.getCategories.initiate({}));
    await categories;
    const list = store.dispatch(
      apiSlice.endpoints.getStorefrontProducts.initiate({ limit: 2, sort: 'newest' }),
    );
    await list;
    const detail = store.dispatch(apiSlice.endpoints.getProduct.initiate('p1'));
    await detail;

    expect([
      getCount(calls, '/categories'),
      getCount(calls, '/products'),
      getCount(calls, '/products/p1'),
    ]).toEqual([1, 1, 1]);

    await store.dispatch(apiSlice.endpoints[endpoint].initiate(arg));

    await waitFor(() => expect(getCount(calls, '/categories')).toBe(2));
    await waitFor(() => expect(getCount(calls, '/products')).toBe(2));
    await waitFor(() => expect(getCount(calls, '/products/p1')).toBe(2));

    categories.unsubscribe();
    list.unsubscribe();
    detail.unsubscribe();
  });

  it('refetches a subscribed customer product list after a brand edit', async () => {
    const calls = stubBrandSyncFetch();
    const list = store.dispatch(
      apiSlice.endpoints.getStorefrontProducts.initiate({ limit: 2, sort: 'newest' }),
    );
    await list;
    const productListCalls = () =>
      calls.filter((call) => call.pathname.endsWith('/products') && call.method === 'GET');
    expect(productListCalls()).toHaveLength(1);

    // No manual refetch: the tag invalidation is the whole mechanism.
    await store.dispatch(
      apiSlice.endpoints.updateBrand.initiate({ id: 'brand-1', name: 'Aurora X' }),
    );

    await waitFor(() => expect(productListCalls()).toHaveLength(2));
    list.unsubscribe();
  });

  it('marks an inactive product detail invalid after a category edit', async () => {
    const calls = stubBrandSyncFetch();
    const detail = store.dispatch(apiSlice.endpoints.getProduct.initiate('p1'));
    await detail;
    detail.unsubscribe();

    await store.dispatch(
      apiSlice.endpoints.updateCategory.initiate({ id: 'cat-1', name: 'Lamps' }),
    );

    const detailCalls = () =>
      calls.filter((call) => /\/products\/p1$/.test(call.pathname) && call.method === 'GET');
    expect(detailCalls()).toHaveLength(1);

    // The invalidated entry is not served as fresh: subscribing again asks the server.
    const again = store.dispatch(apiSlice.endpoints.getProduct.initiate('p1'));
    await again;
    expect(detailCalls()).toHaveLength(2);
    again.unsubscribe();
  });
});

/**
 * Stub for every endpoint the tag-contract tests touch: admin list/detail and the
 * product writes, storefront list/detail, and the brand/category queries and
 * writes. Only `fetch` is faked — the store, the middleware and the tag graph are
 * the real ones — and every call is recorded so refetches can be counted.
 */
function stubTagContractFetch({
  brands = [
    { id: 'brand-1', name: 'Aurora' },
    { id: 'brand-2', name: 'Halo' },
  ],
  categories = [{ id: 'cat-1', name: 'Lighting' }],
} = {}) {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const method = (typeof input === 'string' ? init.method : input.method) ?? 'GET';
      const { pathname } = url;
      calls.push({ method, pathname });

      if (method === 'GET') {
        if (pathname.endsWith('/auth/csrf')) return jsonResponse({ data: { csrfToken: 'csrf' } });
        if (pathname.endsWith('/admin/products')) {
          return jsonResponse({
            data: [product('p1'), product('p2')],
            meta: { page: 1, limit: 10, total: 2, totalPages: 1 },
          });
        }
        if (/\/admin\/products\/[^/]+$/.test(pathname)) {
          const id = pathname.split('/').pop();
          return jsonResponse({ data: { ...product(id), stock: 99 } });
        }
        if (pathname.endsWith('/products')) {
          return jsonResponse({
            data: [product('p1'), product('p2')],
            meta: { nextCursor: null, hasNextPage: false, limit: 2, sort: 'newest', count: 2 },
          });
        }
        if (/\/products\/[^/]+$/.test(pathname)) {
          const id = pathname.split('/').pop();
          return jsonResponse({ data: product(id) });
        }
        if (pathname.endsWith('/brands')) return jsonResponse({ data: brands });
        if (pathname.endsWith('/categories')) return jsonResponse({ data: categories });
      }

      if (method === 'POST' && pathname.endsWith('/admin/products')) {
        return jsonResponse({ data: product('p9') }, { status: 201 });
      }
      if (method === 'PATCH' && /\/admin\/products\/[^/]+\/stock$/.test(pathname)) {
        return jsonResponse({ data: { ...product('p1'), stock: 8, stockStatus: 'low_stock' } });
      }
      if (/\/admin\/products\/[^/]+$/.test(pathname)) {
        // PUT / PATCH / DELETE of one product.
        return jsonResponse({ data: product('p1') });
      }
      if (pathname.endsWith('/brands')) {
        return jsonResponse({ data: { id: 'brand-9', name: 'Aurora X' } }, { status: 201 });
      }
      if (/\/brands\/[^/]+$/.test(pathname)) {
        return jsonResponse({ data: { id: pathname.split('/').pop(), name: 'Aurora X' } });
      }
      if (pathname.endsWith('/categories')) {
        return jsonResponse({ data: { id: 'cat-9', name: 'Lamps' } }, { status: 201 });
      }
      if (/\/categories\/[^/]+$/.test(pathname)) {
        return jsonResponse({ data: { id: pathname.split('/').pop(), name: 'Lamps' } });
      }

      return jsonResponse({ error: { code: 'ROUTE_NOT_FOUND' } }, { status: 404 });
    }),
  );

  return calls;
}

/** Storefront product endpoints plus the brand/category write endpoints. */
function stubBrandSyncFetch() {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const method = (typeof input === 'string' ? init.method : input.method) ?? 'GET';
      calls.push({ pathname: url.pathname, method, params: Object.fromEntries(url.searchParams) });

      if (url.pathname.endsWith('/products') && method === 'GET') {
        return jsonResponse({
          data: [product('p1'), product('p2')],
          meta: { nextCursor: null, hasNextPage: false, limit: 2, sort: 'newest', count: 2 },
        });
      }
      if (/\/products\/[^/]+$/.test(url.pathname) && method === 'GET') {
        const id = url.pathname.split('/').pop();
        return jsonResponse({ data: product(id) });
      }
      if (/\/brands\/[^/]+$/.test(url.pathname) && method === 'PUT') {
        return jsonResponse({ data: { id: 'brand-1', name: 'Aurora X', slug: 'aurora' } });
      }
      if (/\/categories\/[^/]+$/.test(url.pathname) && method === 'PUT') {
        return jsonResponse({ data: { id: 'cat-1', name: 'Lamps', slug: 'lighting' } });
      }
      return jsonResponse({ error: { code: 'ROUTE_NOT_FOUND' } }, { status: 404 });
    }),
  );
  return calls;
}
