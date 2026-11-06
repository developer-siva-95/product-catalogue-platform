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
 */
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

  const tagList = (tags) =>
    tags
      .map((tag) => (typeof tag === 'string' ? tag : `${tag.type}:${tag.id}`))
      .sort();

  it('provides per-document product and inventory tags on the admin list', () => {
    const tags = apiSlice.endpoints.getAdminProducts.providesTags({
      data: [product('p1'), product('p2')],
    });

    expect(tagList(tags)).toEqual(
      tagList([
        { type: 'Product', id: 'LIST' },
        { type: 'Inventory', id: 'LIST' },
        { type: 'Product', id: 'p1' },
        { type: 'Product', id: 'p2' },
        { type: 'Inventory', id: 'p1' },
        { type: 'Inventory', id: 'p2' },
      ]),
    );
  });

  it('provides an inventory tag for the admin detail of a product', () => {
    expect(tagList(apiSlice.endpoints.getAdminProduct.providesTags(undefined, undefined, 'p1'))).toEqual(
      tagList([
        { type: 'Product', id: 'p1' },
        { type: 'Inventory', id: 'p1' },
      ]),
    );
  });

  it.each([
    ['updateProduct', { id: 'p1', title: 'Renamed' }],
    ['updateStock', { id: 'p1', delta: 1 }],
    ['deleteProduct', 'p1'],
  ])('%s invalidates the document, its list and its inventory views', (endpoint, arg) => {
    const tags = apiSlice.endpoints[endpoint].invalidatesTags(undefined, undefined, arg);

    expect(tagList(tags)).toEqual(
      tagList([
        { type: 'Product', id: 'p1' },
        { type: 'Product', id: 'LIST' },
        { type: 'Inventory', id: 'p1' },
        { type: 'Inventory', id: 'LIST' },
      ]),
    );
  });

  it('createProduct invalidates the lists, inventory and the taxonomy', () => {
    const tags = apiSlice.endpoints.createProduct.invalidatesTags(undefined, undefined, {});
    expect(tagList(tags)).toEqual(
      tagList([
        { type: 'Product', id: 'LIST' },
        { type: 'Inventory', id: 'LIST' },
        'Brand',
        'Category',
      ]),
    );
  });

  it('resolves a mutation of one product to that document and to the lists', async () => {
    const calls = stubAdminFetch();
    // One active list, one inactive detail: the two shapes a real session has.
    const list = store.dispatch(apiSlice.endpoints.getAdminProducts.initiate({ page: 1, limit: 10 }));
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
    expect(
      calls.filter((call) => /\/admin\/products\/p1$/.test(call.pathname)).length,
    ).toBe(beforeResubscribe.length + 1);
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

  const tagList = (tags) =>
    tags
      .map((tag) => (typeof tag === 'string' ? tag : `${tag.type}:${tag.id ?? '*'}`))
      .sort();

  it('provides per-document and list tags for brands', () => {
    const tags = apiSlice.endpoints.getBrands.providesTags({
      data: [{ id: 'brand-1' }, { id: 'brand-2' }],
    });
    expect(tagList(tags)).toEqual(
      tagList([{ type: 'Brand', id: 'brand-1' }, { type: 'Brand', id: 'brand-2' }, { type: 'Brand', id: 'LIST' }]),
    );
    // A failed/empty response still identifies the list it belongs to.
    expect(tagList(apiSlice.endpoints.getBrands.providesTags({ data: [] }))).toEqual(
      tagList([{ type: 'Brand', id: 'LIST' }]),
    );
  });

  it('provides per-document and list tags for categories', () => {
    const tags = apiSlice.endpoints.getCategories.providesTags({
      data: [{ id: 'cat-1' }],
    });
    expect(tagList(tags)).toEqual(
      tagList([{ type: 'Category', id: 'cat-1' }, { type: 'Category', id: 'LIST' }]),
    );
  });

  it.each([
    ['createBrand', {}, ['Brand:LIST', 'Product:*']],
    ['updateBrand', { id: 'brand-1', name: 'Aurora X' }, ['Brand:brand-1', 'Brand:LIST', 'Product:*']],
    ['deleteBrand', 'brand-1', ['Brand:LIST', 'Product:*']],
  ])('%s invalidates its brand tags and the product displays', (endpoint, arg, expected) => {
    const tags = apiSlice.endpoints[endpoint].invalidatesTags(undefined, undefined, arg);
    expect(tagList(tags)).toEqual(tagList(expected.map(parseTag)));
  });

  it.each([
    ['createCategory', {}, ['Category:LIST', 'Product:*']],
    ['updateCategory', { id: 'cat-1', name: 'Lamps' }, ['Category:cat-1', 'Category:LIST', 'Product:*']],
    ['deleteCategory', 'cat-1', ['Category:LIST', 'Product:*']],
  ])('%s invalidates its category tags and the product displays', (endpoint, arg, expected) => {
    const tags = apiSlice.endpoints[endpoint].invalidatesTags(undefined, undefined, arg);
    expect(tagList(tags)).toEqual(tagList(expected.map(parseTag)));
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

/** Parses a `Type:id` shorthand used by the table above into a tag object. */
function parseTag(shorthand) {
  const [type, id] = shorthand.split(':');
  return id === '*' ? { type } : { type, id };
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
