import { Product } from '../../src/modules/products/model.js';
import { createBrandRecord, createCategoryRecord, createProductRecord } from './factories.js';

/**
 * Seeds a deterministic storefront dataset:
 * - 4 price tiers with deliberate ties (compound-cursor tie-breaking);
 * - a couple of inactive products that must never surface;
 * - a zero-stock and a low-stock product for badge assertions;
 * - two brands and two categories for facet filters.
 */
export async function seedStorefront() {
  const brandA = await createBrandRecord({ name: 'Aurora' });
  const brandB = await createBrandRecord({ name: 'NovaTech' });
  const categoryA = await createCategoryRecord({ name: 'Audio' });
  const categoryB = await createCategoryRecord({ name: 'Computing' });

  const prices = [100, 100, 100, 250, 250, 500, 500, 500, 500, 1000, 1500, 1500, 2000];
  const products = [];

  for (let index = 0; index < 30; index += 1) {
    const price = prices[index % prices.length];

    const product = await createProductRecord({
      title: `Storefront Product ${String(index + 1).padStart(2, '0')}`,
      price,
      stock: index === 0 ? 0 : index === 1 ? 3 : 25,
      brand: index % 2 === 0 ? brandA._id : brandB._id,
      category: index % 3 === 0 ? categoryB._id : categoryA._id,
      isActive: index % 10 !== 9,
      description: `Description for storefront product number ${index + 1} including searchable words.`,
    });
    products.push(product);
  }

  return { products, brandA, brandB, categoryA, categoryB, prices };
}

/** Walks cursor pages and returns { ids, pages, meta }. */
export async function traverseCursor(client, baseUrl, { limit = 7, maxPages = 50 } = {}) {
  const ids = [];
  const pages = [];
  let cursor = null;
  let guard = 0;

  do {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const url = cursor
      ? `${baseUrl}${separator}limit=${limit}&cursor=${encodeURIComponent(cursor)}`
      : `${baseUrl}${separator}limit=${limit}`;

    const response = await client.get(url);
    if (response.status !== 200) {
      throw new Error(`Traversal failed (${response.status}): ${JSON.stringify(response.body)}`);
    }
    pages.push(response.body);
    ids.push(...response.body.data.map((product) => product.id));
    cursor = response.body.meta.nextCursor;
    guard += 1;
    if (guard > maxPages) throw new Error('Cursor traversal did not terminate');
  } while (cursor);

  return { ids, pages };
}

/** Convenience: all products in one page (limit is capped at 48). */
export async function fetchAll(client, baseUrl) {
  const separator = baseUrl.includes('?') ? '&' : '?';
  const response = await client.get(`${baseUrl}${separator}limit=48`);
  return response.body;
}

export { Product };
