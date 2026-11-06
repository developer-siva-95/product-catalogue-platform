/**
 * Shared product mappers.
 *
 * These two functions define the *only* shapes the API ever exposes for a
 * product. Both providers must funnel through them so that MongoDB and MySQL
 * produce byte-identical JSON: same keys in the same order, same types
 * (`price` a number, `sku` `null` rather than absent, `createdAt`/`updatedAt`
 * `Date` objects that serialise to ISO-8601 UTC), and the same derived fields.
 *
 * Field order is part of the contract: JSON key order changes show up in client
 * snapshots and in the Phase 1 evidence comparison, so keys are never reordered
 * here without an explicit contract change.
 *
 * The functions accept either a Mongoose document (which is converted with
 * `toObject({ virtuals: true })`) or a plain object. Repositories are expected to
 * hand over plain objects, which is what makes the MySQL implementation possible
 * without touching this file.
 */

/**
 * Stock badge thresholds surfaced to the storefront.
 *
 * Mirrors `LOW_STOCK_THRESHOLD` in `modules/products/model.js`. It is duplicated
 * here rather than imported so this shared module stays free of Mongoose; P2
 * unifies the two into `constants/appConstants.js` when the Mongo model stops
 * being imported by services.
 */
export const LOW_STOCK_THRESHOLD = 5;

/** Storefront badge for a stock quantity. */
export const STOCK_STATUS = {
  OUT_OF_STOCK: 'out_of_stock',
  LOW_STOCK: 'low_stock',
  IN_STOCK: 'in_stock',
};

/**
 * @param {number} stock
 * @returns {'out_of_stock' | 'low_stock' | 'in_stock'}
 */
export function stockStatusFor(stock) {
  if (stock === 0) return STOCK_STATUS.OUT_OF_STOCK;
  if (stock <= LOW_STOCK_THRESHOLD) return STOCK_STATUS.LOW_STOCK;
  return STOCK_STATUS.IN_STOCK;
}

/** Normalises a document or plain object to a plain object with virtuals. */
function toPlainProduct(doc) {
  return typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : doc;
}

/**
 * Maps a (possibly lean) product document to the public shape.
 * @param {object} doc
 */
export function toPublicProduct(doc) {
  const product = toPlainProduct(doc);
  return {
    id: product._id.toString(),
    title: product.title,
    slug: product.slug,
    sku: product.sku ?? null,
    price: product.price,
    stock: product.stock,
    inStock: product.stock > 0,
    stockStatus: stockStatusFor(product.stock),
    description: product.description,
    image: product.image,
    thumbnail: product.thumbnail || product.image,
    brand: product.brand
      ? { id: product.brand._id.toString(), name: product.brand.name, slug: product.brand.slug }
      : null,
    category: product.category
      ? {
          id: product.category._id.toString(),
          name: product.category.name,
          slug: product.category.slug,
        }
      : null,
    isActive: product.isActive,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

/**
 * Admin shape = public shape plus the optimistic-concurrency version (`__v`).
 * @param {object} doc
 */
export function toAdminProduct(doc) {
  const product = toPlainProduct(doc);
  return {
    ...toPublicProduct(doc),
    version: product.__v ?? 0,
  };
}

export default {
  LOW_STOCK_THRESHOLD,
  STOCK_STATUS,
  stockStatusFor,
  toPublicProduct,
  toAdminProduct,
};
