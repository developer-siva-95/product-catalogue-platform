import { createApi } from '@reduxjs/toolkit/query/react';
import { apiBaseQuery, buildQueryString } from './baseQuery.js';

/*
 * Taxonomy writes revalidate products too: every product payload embeds its brand
 * and category (`{ id, name }`), so a brand/category edit changes what a product
 * list *and* a product detail render.
 *
 * The tag is the bare `Product` type instead of `{ type: 'Product', id: 'LIST' }`:
 *  - the client cannot know which product documents reference a taxonomy id without
 *    reading every cached page, which would be a second source of truth;
 *  - an id-less tag matches *all* `Product` tags, i.e. lists and details, and an
 *    inactive entry is marked invalid rather than reused as fresh;
 *  - the cost is one extra list/detail request after a rare admin taxonomy write.
 */
const BRAND_AFFECTS_PRODUCTS = { type: 'Product' };
const CATEGORY_AFFECTS_PRODUCTS = { type: 'Product' };

/**
 * The single RTK Query slice for every server interaction.
 *
 * Caching strategy:
 *  - tag types are coarse (`Product`, `Inventory`, `Brand`, `Category`, `Auth`) but
 *    carry ids, so a mutation can invalidate exactly the lists/details it affects;
 *  - storefront lists are cached per *filter set* (the cursor is excluded from the
 *    cache key) and accumulate pages via `merge`, which is what powers infinite
 *    "Load More" without refetching earlier pages;
 *  - `forceRefetch` is driven by the cursor so requesting the next page is a real
 *    request, while an unchanged cursor is served from cache (duplicate-request
 *    prevention at the cache layer);
 *  - every product/inventory query carries `Product` tags (one per document) plus
 *    an `Inventory` tag, so an administrative mutation invalidates exactly the
 *    detail, the lists and the stock views it actually changed — active entries
 *    refetch immediately, inactive ones are marked invalid and therefore can never
 *    be handed back as authoritative data on a later mount.
 *
 * Freshness policy (manual refresh + navigation):
 *  - the *pages* subscribe with `refetchOnMountOrArgChange: true`, so re-entering a
 *    product list or a detail route always asks the server again instead of
 *    rendering whatever the cache still holds;
 *  - each page also renders a `RefreshButton` that calls the hook's `refetch()`,
 *    which is the same request path, forced.
 */
export const apiSlice = createApi({
  reducerPath: 'api',
  baseQuery: apiBaseQuery,
  tagTypes: ['Product', 'Inventory', 'Brand', 'Category', 'Auth'],
  keepUnusedDataFor: 120,
  // Left off at the api level on purpose: only the product/inventory pages opt in,
  // per subscription. A global `true` would also force token/taxonomy reads to
  // re-fetch on every mount, which is not what this feature is about.
  refetchOnMountOrArgChange: false,
  endpoints: (builder) => ({
    // ------------------------------------------------------------ auth
    csrfToken: builder.query({
      query: () => '/auth/csrf',
      keepUnusedDataFor: 3600,
    }),
    login: builder.mutation({
      query: (credentials) => ({ url: '/auth/login', method: 'POST', body: credentials }),
      invalidatesTags: ['Auth'],
    }),
    register: builder.mutation({
      query: (payload) => ({ url: '/auth/register', method: 'POST', body: payload }),
      invalidatesTags: ['Auth'],
    }),
    logout: builder.mutation({
      query: () => ({ url: '/auth/logout', method: 'POST' }),
      invalidatesTags: ['Auth'],
      // A different user must never see the previous session's cached data.
      async onQueryStarted(_arg, { dispatch }) {
        dispatch(apiSlice.util.resetApiState());
      },
    }),
    me: builder.query({
      query: () => '/auth/me',
      providesTags: ['Auth'],
    }),
    changePassword: builder.mutation({
      query: (payload) => ({ url: '/auth/change-password', method: 'POST', body: payload }),
      invalidatesTags: ['Auth'],
    }),

    // ------------------------------------------------------------ taxonomy
    getBrands: builder.query({
      query: (params = {}) => `/brands${buildQueryString(params)}`,
      providesTags: (result) =>
        result?.data
          ? [
              ...result.data.map((brand) => ({ type: 'Brand', id: brand.id })),
              { type: 'Brand', id: 'LIST' },
            ]
          : [{ type: 'Brand', id: 'LIST' }],
    }),
    createBrand: builder.mutation({
      query: (body) => ({ url: '/brands', method: 'POST', body }),
      invalidatesTags: [{ type: 'Brand', id: 'LIST' }, BRAND_AFFECTS_PRODUCTS],
    }),
    updateBrand: builder.mutation({
      query: ({ id, ...body }) => ({ url: `/brands/${id}`, method: 'PUT', body }),
      invalidatesTags: (_result, _error, arg) => [
        { type: 'Brand', id: arg.id },
        { type: 'Brand', id: 'LIST' },
        BRAND_AFFECTS_PRODUCTS,
      ],
    }),
    deleteBrand: builder.mutation({
      query: (id) => ({ url: `/brands/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'Brand', id: 'LIST' }, BRAND_AFFECTS_PRODUCTS],
    }),

    getCategories: builder.query({
      query: (params = {}) => `/categories${buildQueryString(params)}`,
      providesTags: (result) =>
        result?.data
          ? [
              ...result.data.map((category) => ({ type: 'Category', id: category.id })),
              { type: 'Category', id: 'LIST' },
            ]
          : [{ type: 'Category', id: 'LIST' }],
    }),
    createCategory: builder.mutation({
      query: (body) => ({ url: '/categories', method: 'POST', body }),
      invalidatesTags: [{ type: 'Category', id: 'LIST' }, CATEGORY_AFFECTS_PRODUCTS],
    }),
    updateCategory: builder.mutation({
      query: ({ id, ...body }) => ({ url: `/categories/${id}`, method: 'PUT', body }),
      invalidatesTags: (_result, _error, arg) => [
        { type: 'Category', id: arg.id },
        { type: 'Category', id: 'LIST' },
        CATEGORY_AFFECTS_PRODUCTS,
      ],
    }),
    deleteCategory: builder.mutation({
      query: (id) => ({ url: `/categories/${id}`, method: 'DELETE' }),
      invalidatesTags: [{ type: 'Category', id: 'LIST' }, CATEGORY_AFFECTS_PRODUCTS],
    }),

    // ------------------------------------------------------------ storefront
    getStorefrontProducts: builder.query({
      query: (args = {}) =>
        `/products${buildQueryString({
          cursor: args.cursor ?? undefined,
          limit: args.limit,
          search: args.search || undefined,
          minPrice: args.minPrice !== '' ? args.minPrice : undefined,
          maxPrice: args.maxPrice !== '' ? args.maxPrice : undefined,
          brand: args.brand || undefined,
          category: args.category || undefined,
          sort: args.sort,
        })}`,
      // One cache entry per filter set: the cursor is a paging control, not part
      // of the identity of the result list.
      serializeQueryArgs: ({ queryArgs, endpointName }) => {
        const { cursor: _cursor, ...filters } = queryArgs ?? {};
        return `${endpointName}-${JSON.stringify(filters)}`;
      },
      merge: (currentCache, newPage, { arg }) => {
        const incoming = newPage?.data ?? [];
        const cursor = arg?.cursor ?? null;

        if (!cursor) {
          currentCache.data = incoming;
          currentCache.cursors = [];
        } else {
          const seen = new Set((currentCache.data ?? []).map((product) => product.id));
          const unique = incoming.filter((product) => !seen.has(product.id));
          currentCache.data = [...(currentCache.data ?? []), ...unique];
          // A retry of the *same* cursor must not count as a new page.
          const cursors = currentCache.cursors ?? [];
          if (!cursors.includes(cursor)) currentCache.cursors = [...cursors, cursor];
          else currentCache.cursors = cursors;
        }

        // Depth of the accumulated list: 1 (first page) + one per distinct cursor.
        // This is what lets a remount restore pagination depth **without** asking
        // the server for anything it already delivered.
        currentCache.pageCount = 1 + (currentCache.cursors?.length ?? 0);
        currentCache.meta = newPage?.meta ?? currentCache.meta;
      },
      /**
       * Keep the accumulated list while the shopper is away. The storefront list is
       * the only entry that can be expensive to rebuild (N cursor pages), so it is
       * retained far longer than the global default: leaving a detail page open for
       * a couple of minutes must not throw the loaded pages away.
       */
      keepUnusedDataFor: 900,
      forceRefetch: ({ currentArg, previousArg }) => currentArg?.cursor !== previousArg?.cursor,
      providesTags: (result) => [
        { type: 'Product', id: 'LIST' },
        ...(result?.data ?? []).map((product) => ({ type: 'Product', id: product.id })),
      ],
    }),
    getProduct: builder.query({
      query: (id) => `/products/${id}`,
      providesTags: (_result, _error, id) => [{ type: 'Product', id }],
      /**
       * The detail page subscribes with `refetchOnMountOrArgChange: true`, so the
       * document is re-read on every entry (one small request for one document —
       * never a list refetch). RTK Query only honours `refetchOnMountOrArgChange` as
       * an **api-level** or **per-subscription** option — a per-endpoint value is
       * silently ignored — so the flag is applied at the call site, not here.
       */
      /**
       * Data freshness without extra requests: the detail response is the freshest
       * copy of that product the client will ever hold, so it is written back into
       * every cached listing that contains it (storefront and admin). Coming back to
       * the grid then shows the new stock/price with **zero** additional requests.
       */
      async onQueryStarted(_id, { dispatch, getState, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          const product = data?.data;
          if (product?.id) patchCachedProductLists(dispatch, getState(), product);
        } catch {
          // A failed detail request simply leaves the cached copies untouched.
        }
      },
    }),

    // ------------------------------------------------------------ admin
    getAdminProducts: builder.query({
      query: (args = {}) =>
        `/admin/products${buildQueryString({
          page: args.page,
          limit: args.limit,
          search: args.search || undefined,
          brand: args.brand || undefined,
          category: args.category || undefined,
          isActive: args.isActive === '' || args.isActive === undefined ? undefined : args.isActive,
          sort: args.sort,
        })}`,
      providesTags: (result) => [
        { type: 'Product', id: 'LIST' },
        { type: 'Inventory', id: 'LIST' },
        ...(result?.data ?? []).flatMap((product) => [
          { type: 'Product', id: product.id },
          { type: 'Inventory', id: product.id },
        ]),
      ],
    }),
    getAdminProduct: builder.query({
      query: (id) => `/admin/products/${id}`,
      // The admin detail is also the stock view of that product.
      providesTags: (_result, _error, id) => [
        { type: 'Product', id },
        { type: 'Inventory', id },
      ],
    }),
    createProduct: builder.mutation({
      // FormData is passed through untouched so the browser sets the multipart
      // boundary (fetchBaseQuery must not add a Content-Type for it).
      query: (body) => ({ url: '/admin/products', method: 'POST', body }),
      invalidatesTags: [
        { type: 'Product', id: 'LIST' },
        { type: 'Inventory', id: 'LIST' },
        'Brand',
        'Category',
      ],
    }),
    updateProduct: builder.mutation({
      query: ({ id, body, method = 'PATCH' }) => ({
        url: `/admin/products/${id}`,
        method,
        body,
      }),
      invalidatesTags: (_result, _error, arg) => [
        { type: 'Product', id: arg.id },
        { type: 'Product', id: 'LIST' },
        { type: 'Inventory', id: arg.id },
        { type: 'Inventory', id: 'LIST' },
      ],
    }),
    updateStock: builder.mutation({
      query: ({ id, ...body }) => ({ url: `/admin/products/${id}/stock`, method: 'PATCH', body }),
      invalidatesTags: (_result, _error, arg) => [
        { type: 'Product', id: arg.id },
        { type: 'Product', id: 'LIST' },
        { type: 'Inventory', id: arg.id },
        { type: 'Inventory', id: 'LIST' },
      ],
    }),
    deleteProduct: builder.mutation({
      query: (id) => ({ url: `/admin/products/${id}`, method: 'DELETE' }),
      // Deleting one product must invalidate *that* document as well as the lists
      // and inventory views that were rendering it.
      invalidatesTags: (_result, _error, id) => [
        { type: 'Product', id },
        { type: 'Product', id: 'LIST' },
        { type: 'Inventory', id },
        { type: 'Inventory', id: 'LIST' },
      ],
    }),
  }),
});

/**
 * The cursor the cached storefront list is parked on (the deepest page it holds).
 *
 * Read straight from the RTK Query cache **before** the query hook runs, so a
 * remount can resume at the right page on its very first render. Without this the
 * component would mount with `cursor: undefined`, `forceRefetch` would see an
 * argument change and refetch page one — either a redundant request or, worse, a
 * `merge` that replaces the accumulated pages.
 *
 * `endpoint.select(arg)` applies the endpoint's own `serializeQueryArgs`, which is
 * why the same filters (cursor excluded) resolve to the same cache entry.
 *
 * @returns {string|null}
 */
export function selectCachedListCursor(state, arg) {
  const entry = apiSlice.endpoints.getStorefrontProducts.select(arg)(state);
  return entry?.data?.cursors?.at(-1) ?? null;
}

const LIST_ENDPOINTS = ['getStorefrontProducts', 'getAdminProducts'];

/**
 * Writes a freshly fetched product into every cached list that already contains it.
 *
 * `selectInvalidatedBy` resolves each cache entry that provides the product's tag to
 * its endpoint + original arguments, which is exactly what `updateQueryData` needs.
 * Only entries that already hold the product are touched, so no new request and no
 * cache entry is created as a side effect.
 *
 * @param {Function} dispatch RTK dispatch
 * @param {object} state the api slice state (`getState()[apiSlice.reducerPath]`)
 * @param {object} product the public product payload from `GET /products/:id`
 */
export function patchCachedProductLists(dispatch, state, product) {
  const entries = apiSlice.util.selectInvalidatedBy(state, [{ type: 'Product', id: product.id }]);

  for (const entry of entries) {
    if (!LIST_ENDPOINTS.includes(entry.endpointName)) continue;

    dispatch(
      apiSlice.util.updateQueryData(entry.endpointName, entry.originalArgs, (draft) => {
        const items = draft?.data;
        if (!Array.isArray(items)) return;
        const index = items.findIndex((item) => item.id === product.id);
        if (index === -1) return;
        items[index] = { ...items[index], ...product };
      }),
    );
  }
}

export const {
  useCsrfTokenQuery,
  useLoginMutation,
  useRegisterMutation,
  useLogoutMutation,
  useMeQuery,
  useChangePasswordMutation,
  useGetBrandsQuery,
  useCreateBrandMutation,
  useUpdateBrandMutation,
  useDeleteBrandMutation,
  useGetCategoriesQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useDeleteCategoryMutation,
  useGetStorefrontProductsQuery,
  useGetProductQuery,
  useGetAdminProductsQuery,
  useGetAdminProductQuery,
  useCreateProductMutation,
  useUpdateProductMutation,
  useUpdateStockMutation,
  useDeleteProductMutation,
} = apiSlice;

export default apiSlice;
