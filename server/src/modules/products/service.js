import { HTTP_STATUS } from '../../constants/httpStatusCodes.js';
import { ApiError } from '../../utils/ApiError.js';
import { encodeCursor } from '../../utils/cursor.js';
import { storefrontFilterHash } from '../../repositories/storefront-query.js';
import { getRepositories } from '../../repositories/index.js';
import { toAdminProduct, toPublicProduct } from '../../repositories/product.mapper.js';
import {
  processAndStoreProductImage,
  removeImagesByUrl,
  removeFiles,
} from '../../utils/imageProcessor.js';
import logger from '../../utils/logger.js';

/**
 * Product domain service.
 *
 * Storage-agnostic: every database operation goes through the products repository,
 * so this file contains only business rules — reference validation, the image
 * lifecycle, cursor assembly and the error contracts the API publishes.
 *
 * The query builders below are re-exported from the MongoDB implementation for
 * backward compatibility (the query-plan tests assert which index each sort uses).
 * They are `-mongo` specific and will move to the Mongo test suite in P5.
 */
export {
  buildCursorCondition,
  buildFacetConditions,
  buildSearchCondition,
  buildStorefrontQueryParts,
  combineConditions,
} from '../../repositories/mongo/products.repository.js';

/**
 * Re-exported for call sites that imported them from here.
 * The implementations live in `repositories/product.mapper.js` so both database
 * providers share one definition.
 */
export { toAdminProduct, toPublicProduct };

/**
 * STOREFRONT list — cursor pagination.
 *
 * The repository fetches `limit + 1` rows so `hasNextPage` is exact without a
 * second count query (cursor pagination must stay O(limit), not O(total)).
 */
export async function listStorefrontProducts(query) {
  const { products } = getRepositories();
  const filterHash = storefrontFilterHash(query);

  const { records, fetched } = await products.listStorefront({ query, limit: query.limit });

  const hasNextPage = fetched > query.limit;
  const page = hasNextPage ? records.slice(0, query.limit) : records;
  const last = page.at(-1);

  const nextCursor =
    hasNextPage && last
      ? encodeCursor({ sort: query.sort, id: last._id, price: last.price, filterHash })
      : null;

  return {
    items: page.map(toPublicProduct),
    meta: {
      limit: query.limit,
      count: page.length,
      sort: query.sort,
      hasNextPage,
      nextCursor,
    },
  };
}

/**
 * ADMIN list — offset/page pagination with an exact total.
 * The total is exact (not an estimate), which is what a numbered table needs.
 */
export async function listAdminProducts(query) {
  const { products } = getRepositories();
  const { records, total } = await products.listAdmin(query);
  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    items: records.map(toAdminProduct),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPrevPage: query.page > 1,
      sort: query.sort,
      searchMode: query.searchMode,
    },
  };
}

/** Public detail: inactive products are invisible to shoppers. */
export async function getPublicProduct(identifier) {
  const { products } = getRepositories();
  const record = await products.findById(identifier);
  if (!record) throw ApiError.notFound('Product not found', { code: 'PRODUCT_NOT_FOUND' });
  return toPublicProduct(record);
}

/** Admin detail: includes inactive products and the OCC version. */
export async function getAdminProduct(identifier) {
  const { products } = getRepositories();
  const record = await products.findAdminById(identifier);
  if (!record) throw ApiError.notFound('Product not found', { code: 'PRODUCT_NOT_FOUND' });
  return toAdminProduct(record);
}

/** Ensures a brand/category reference exists. */
async function resolveReferences({ brand, category }) {
  const { brands, categories } = getRepositories();
  const [brandRecord, categoryRecord] = await Promise.all([
    brand ? brands.findById(brand) : null,
    category ? categories.findById(category) : null,
  ]);

  if (brand && !brandRecord) {
    throw ApiError.badRequest('Selected brand does not exist', {
      code: 'BRAND_NOT_FOUND',
      details: { field: 'brand', value: brand },
    });
  }
  if (category && !categoryRecord) {
    throw ApiError.badRequest('Selected category does not exist', {
      code: 'CATEGORY_NOT_FOUND',
      details: { field: 'category', value: category },
    });
  }
  return { brandRecord, categoryRecord };
}

/**
 * Creates a product, optionally with an uploaded image.
 *
 * Failure atomicity without transactions: the image is written first, and the
 * files are removed if the database insert fails — so a failed request never
 * leaves orphaned assets behind.
 */
export async function createProduct(payload, file) {
  const { products } = getRepositories();
  const { categoryRecord } = await resolveReferences(payload);

  let storedImage = null;
  if (file) storedImage = await processAndStoreProductImage(file.buffer);

  try {
    const record = await products.create({
      payload,
      slugSource: payload.title,
      skuPrefix: categoryRecord?.name ?? 'product',
      image: storedImage?.image ?? '',
      thumbnail: storedImage?.thumbnail ?? '',
    });

    logger.info('product created', { productId: record._id, sku: record.sku });
    return toAdminProduct(record);
  } catch (error) {
    if (storedImage) await removeFiles([storedImage.imagePath, storedImage.thumbnailPath]);
    throw error;
  }
}

/**
 * Updates a product (PUT = full replace, PATCH = partial). Both require the
 * caller's `version` (the `__v` it last read).
 *
 * Concurrency: an explicit pre-check produces a friendly 409 for a stale form, and
 * the repository's optimistic concurrency raises the same error if another writer
 * commits between the read and the save.
 */
export async function updateProduct(id, payload, { partial = false, file } = {}) {
  const { products } = getRepositories();

  const current = await products.findAdminById(id);
  if (!current) throw ApiError.notFound('Product not found', { code: 'PRODUCT_NOT_FOUND' });

  if (payload.version !== current.__v) {
    throw new ApiError(
      HTTP_STATUS.CONFLICT,
      'This product was modified by someone else. Reload the latest version and re-apply your changes.',
      {
        code: 'STALE_RESOURCE',
        details: { providedVersion: payload.version, currentVersion: current.__v },
      },
    );
  }

  await resolveReferences({
    brand: payload.brand ?? current.brand?._id,
    category: payload.category ?? current.category?._id,
  });

  let storedImage = null;
  if (file) storedImage = await processAndStoreProductImage(file.buffer);

  try {
    const result = await products.replaceFields(id, payload, {
      partial,
      slugSource: payload.title,
      image: storedImage?.image,
      thumbnail: storedImage?.thumbnail,
    });
    if (!result) throw ApiError.notFound('Product not found', { code: 'PRODUCT_NOT_FOUND' });

    // Only after the write is durable do we delete the superseded files.
    if (storedImage && result.previous.image) {
      await removeImagesByUrl([result.previous.image, result.previous.thumbnail]);
    }

    logger.info('product updated', { productId: result.record._id, version: result.record.__v });
    return toAdminProduct(result.record);
  } catch (error) {
    if (storedImage) await removeFiles([storedImage.imagePath, storedImage.thumbnailPath]);
    throw error;
  }
}

/**
 * Atomic stock adjustment.
 *
 * One guarded atomic operation on both providers (`$inc` with `$gte` on MongoDB, a
 * single guarded `UPDATE` on MySQL): 50 simultaneous decrements can never drive
 * stock below zero or lose an update, without multi-document transactions.
 *
 * @param {string} id
 * @param {{ delta?: number, stock?: number }} payload
 */
export async function updateStock(id, payload) {
  const { products } = getRepositories();
  const result = await products.updateStock(id, payload);

  if (result === null) throw ApiError.notFound('Product not found', { code: 'PRODUCT_NOT_FOUND' });

  if (result.insufficient) {
    throw new ApiError(
      HTTP_STATUS.CONFLICT,
      `Insufficient stock: only ${result.available} unit(s) available`,
      {
        code: 'INSUFFICIENT_STOCK',
        details: { available: result.available, requested: result.requested },
      },
    );
  }

  return toAdminProduct(result.record);
}

/** Deletes a product and cleans up its image files afterwards. */
export async function deleteProduct(id) {
  const { products } = getRepositories();
  const deleted = await products.deleteById(id);
  if (!deleted) throw ApiError.notFound('Product not found', { code: 'PRODUCT_NOT_FOUND' });

  await removeImagesByUrl([deleted.image, deleted.thumbnail]);
  logger.info('product deleted', { productId: id });
  return { id: deleted.id, title: deleted.title };
}

/** Files still referenced by any product — input for the orphan sweeper. */
export async function collectReferencedImageFiles() {
  const { products } = getRepositories();
  return products.collectReferencedImageFiles();
}

export default {
  listStorefrontProducts,
  listAdminProducts,
  getPublicProduct,
  getAdminProduct,
  createProduct,
  updateProduct,
  updateStock,
  deleteProduct,
  collectReferencedImageFiles,
  toPublicProduct,
  toAdminProduct,
};
