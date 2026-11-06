import { jsonResponse } from './utils.jsx';

/**
 * Builds a deterministic `fetch` stub for the storefront endpoints.
 *
 * It mimics the real cursor contract: each page advertises the `nextCursor` that
 * leads to the page after it, and the last page advertises `null`. Every request
 * URL is recorded so tests can assert what the client actually asked the server
 * for. A page may be told to fail (`fail`, or `failOnce` for the retry path), and
 * `delayMs` keeps a request in flight long enough to prove that a second scroll
 * event cannot start a duplicate one.
 */
/** Facet ids deliberately differ from the ids used inside products, so a test that
 *  confuses the two fails loudly. */
const BRAND_IDS = { Aurora: 'brand-1', Nimbus: 'brand-2' };
const CATEGORY_IDS = { Lighting: 'cat-1' };

const DEFAULT_PAGES = [
  {
    products: [
      { id: 'p1', title: 'Aurora Desk Lamp', price: 2499, brand: 'Aurora', category: 'Lighting' },
      {
        id: 'p2',
        title: 'Nimbus Office Chair',
        price: 18999,
        brand: 'Nimbus',
        category: 'Seating',
      },
    ],
    nextCursor: 'cursor-page-2',
  },
  {
    products: [
      { id: 'p3', title: 'Vertex Standing Desk', price: 32999, brand: 'Vertex', category: 'Desks' },
    ],
    nextCursor: null,
  },
];

export function createStorefrontFetch({
  pages = DEFAULT_PAGES,
  brands = [
    { id: 'brand-1', name: 'Aurora', slug: 'aurora', productCount: 4, activeProductCount: 4 },
    { id: 'brand-2', name: 'Nimbus', slug: 'nimbus', productCount: 2, activeProductCount: 2 },
  ],
  categories = [
    { id: 'cat-1', name: 'Lighting', slug: 'lighting', productCount: 3, activeProductCount: 3 },
  ],
  delayMs = 0,
} = {}) {
  const calls = [];
  /** cursor → page, so any number of pages can be chained. */
  const pageByCursor = new Map();
  pages.forEach((page, index) => {
    const previous = pages[index - 1];
    if (previous?.nextCursor) pageByCursor.set(previous.nextCursor, page);
  });
  const attempts = new Map();

  const toProduct = (product) => ({
    id: product.id,
    title: product.title,
    description: `${product.title} description`,
    price: product.price,
    stock: product.stock ?? 5,
    stockStatus: product.stockStatus ?? 'in_stock',
    sku: `SKU-${product.id.toUpperCase()}`,
    thumbnail: null,
    image: null,
    isActive: true,
    brand: {
      id: BRAND_IDS[product.brand] ?? `brand-${product.brand.toLowerCase()}`,
      name: product.brand,
    },
    category: {
      id: CATEGORY_IDS[product.category] ?? `cat-${product.category.toLowerCase()}`,
      name: product.category,
    },
    createdAt: '2026-01-05T10:00:00.000Z',
    updatedAt: '2026-01-05T10:00:00.000Z',
  });

  const fetchMock = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    const { pathname, searchParams } = new URL(url);
    calls.push({ url, pathname, params: Object.fromEntries(searchParams) });

    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

    if (pathname.endsWith('/products')) {
      const cursor = searchParams.get('cursor');
      const pageIndex = cursor ? pages.indexOf(pageByCursor.get(cursor)) : 0;
      const page = cursor ? pageByCursor.get(cursor) : pages[0];

      if (!page) {
        return jsonResponse(
          { error: { code: 'CURSOR_INVALID', message: 'Invalid cursor' } },
          { status: 400 },
        );
      }

      const key = String(pageIndex);
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      const shouldFail = page.fail || (page.failOnce && attempt === 1);

      if (shouldFail) {
        return jsonResponse(
          { error: { code: 'INTERNAL_ERROR', message: 'Products unavailable' } },
          { status: 500 },
        );
      }

      return jsonResponse({
        data: page.products.map(toProduct),
        meta: {
          nextCursor: page.nextCursor,
          hasNextPage: Boolean(page.nextCursor),
          limit: Number(searchParams.get('limit') ?? 12),
          sort: searchParams.get('sort') ?? 'newest',
          count: page.products.length,
        },
      });
    }

    if (pathname.endsWith('/brands')) {
      return jsonResponse({ data: brands, meta: { count: brands.length } });
    }

    if (pathname.endsWith('/categories')) {
      return jsonResponse({ data: categories, meta: { count: categories.length } });
    }

    return jsonResponse({ error: { code: 'ROUTE_NOT_FOUND' } }, { status: 404 });
  };

  return { fetchMock, calls };
}
