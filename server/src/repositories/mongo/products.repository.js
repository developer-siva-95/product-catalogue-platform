import { Product } from '../../modules/products/model.js';
import { HTTP_STATUS } from '../../constants/httpStatusCodes.js';
import { PRODUCT_SORT, PRODUCT_SORT_SPECS } from '../../constants/appConstants.js';
import { ApiError } from '../../utils/ApiError.js';
import { escapeRegex } from '../../utils/validators.js';
import { createUniqueSlug, withDuplicateKeyRetry } from '../../utils/slugify.js';
import { createUniqueSku } from '../../utils/skuGenerator.js';
import { decodeCursor } from '../../utils/cursor.js';
import { storefrontFilterHash } from '../storefront-query.js';
import { toObjectId } from './objectid.js';
import { isVersionError } from './errors.js';
import { defineRepository } from '../repository.js';
import { PRODUCTS_REPOSITORY_METHODS } from '../products.repository.js';
import { assertCanonicalId } from '../identifier.js';

/**
 * Products repository — MongoDB (reference implementation).
 *
 * Everything Mongoose-specific about products lives here: query operators, index
 * hints, `.lean()` + `populate`, atomic `$inc` guards, optimistic concurrency and
 * duplicate-key retries. The service above it only deals in plain records, which
 * is what makes the MySQL implementation a drop-in replacement.
 *
 * A "record" is a plain object shaped exactly like the mapper input in
 * `repositories/product.mapper.js`:
 *   `{ _id: <24-hex string>, ..., brand: { _id, name, slug } | null, __v: number }`
 * Ids are canonical strings (never ObjectIds) and dates stay `Date` objects.
 */

const BRAND_POPULATE = { path: 'brand', select: 'name slug' };
const CATEGORY_POPULATE = { path: 'category', select: 'name slug' };

/**
 * Combines filter conditions without ever colliding on the same key.
 * (Two independent `$or` clauses — search and a compound cursor — cannot coexist
 * as sibling keys in one object, so they are joined with `$and`.)
 * @param {Array<object|undefined>} conditions
 * @returns {object}
 */
export function combineConditions(conditions) {
  const active = conditions.filter((condition) => condition && Object.keys(condition).length > 0);
  if (active.length === 0) return {};
  if (active.length === 1) return active[0];
  return { $and: active };
}

/**
 * Builds the search condition.
 * - `regex` (default): substring match on title/SKU — matches what a shopper
 *   types mid-word, which is what debounced storefront search needs;
 * - `text`: MongoDB text index (weighted title/description) — relevance-capable,
 *   used by the admin table when `searchMode=text`.
 *
 * @param {string} term
 * @param {'regex'|'text'} mode
 */
export function buildSearchCondition(term, mode = 'regex') {
  if (!term) return undefined;
  if (mode === 'text') {
    // $text cannot be nested inside $or/$and, so it is returned as its own
    // top-level condition and combineConditions() keeps it separate.
    return { $text: { $search: term } };
  }
  const pattern = new RegExp(escapeRegex(term), 'i');
  return { $or: [{ title: pattern }, { sku: pattern }] };
}

/** Price/brand/category facet conditions shared by both list endpoints. */
export function buildFacetConditions({ minPrice, maxPrice, brand, category }) {
  const conditions = [];

  if (minPrice !== undefined || maxPrice !== undefined) {
    const price = {};
    if (minPrice !== undefined) price.$gte = minPrice;
    if (maxPrice !== undefined) price.$lte = maxPrice;
    conditions.push({ price });
  }
  if (brand) conditions.push({ brand: toObjectId(brand) });
  if (category) conditions.push({ category: toObjectId(category) });

  return conditions;
}

/**
 * Builds the cursor comparison for the requested sort.
 *
 * The operators MUST mirror the sort direction, otherwise rows are skipped or
 * repeated at page boundaries:
 *   newest     : _id desc  -> { _id: { $lt: cursorId } }
 *   price_asc  : price asc -> { $or: [ {price: {$gt: p}}, {price: p, _id: {$gt: id}} ] }
 *   price_desc : price desc-> { $or: [ {price: {$lt: p}}, {price: p, _id: {$lt: id}} ] }
 *
 * @param {{ sort: string, id: string, price?: number }} cursor
 */
export function buildCursorCondition(cursor) {
  const objectId = toObjectId(cursor.id);

  if (cursor.sort === PRODUCT_SORT.NEWEST) {
    return { _id: { $lt: objectId } };
  }

  if (cursor.sort === PRODUCT_SORT.PRICE_ASC) {
    return {
      $or: [{ price: { $gt: cursor.price } }, { price: cursor.price, _id: { $gt: objectId } }],
    };
  }

  if (cursor.sort === PRODUCT_SORT.PRICE_DESC) {
    return {
      $or: [{ price: { $lt: cursor.price } }, { price: cursor.price, _id: { $lt: objectId } }],
    };
  }

  throw ApiError.badRequest(`Unsupported sort: ${cursor.sort}`, { code: 'UNSUPPORTED_SORT' });
}

/**
 * The exact filter + sort used by the storefront. Exported because the query-plan
 * tests assert which index each sort uses.
 *
 * The filter fingerprint is computed here (not by the service) so a cursor token
 * is validated against the same filter set that produced it.
 */
export function buildStorefrontQueryParts(query) {
  // Shared with the MySQL provider so a cursor minted by one is accepted by the
  // other (see repositories/storefront-query.js).
  const filterHash = storefrontFilterHash(query);

  const conditions = [{ isActive: true }, ...buildFacetConditions(query)];
  const searchCondition = buildSearchCondition(query.search, 'regex');
  if (searchCondition) conditions.push(searchCondition);

  let cursor = null;
  if (query.cursor) {
    cursor = decodeCursor(query.cursor, { sort: query.sort, filterHash });
    conditions.push(buildCursorCondition(cursor));
  }

  return {
    filter: combineConditions(conditions),
    sort: PRODUCT_SORT_SPECS[query.sort].direction,
    filterHash,
    cursor,
  };
}

/** Normalises a lean Mongoose document into a plain, driver-free record. */
function toRecord(document) {
  if (!document) return null;
  return {
    ...document,
    _id: document._id.toString(),
    brand: document.brand
      ? {
          _id: document.brand._id.toString(),
          name: document.brand.name,
          slug: document.brand.slug,
        }
      : null,
    category: document.category
      ? {
          _id: document.category._id.toString(),
          name: document.category.name,
          slug: document.category.slug,
        }
      : null,
    __v: document.__v ?? 0,
  };
}

/** Reads one product by id or slug. */
async function findRecord(identifier, { includeInactive }) {
  const query = /^[0-9a-fA-F]{24}$/.test(identifier) ? { _id: identifier } : { slug: identifier };
  if (!includeInactive) query.isActive = true;

  const document = await Product.findOne(query)
    .populate(BRAND_POPULATE)
    .populate(CATEGORY_POPULATE)
    .lean();
  return toRecord(document);
}

/** Shared admin sort translation (`price` / `-price` / `title` / ...). */
function adminSortSpec(sort) {
  return sort.startsWith('-') ? { [sort.slice(1)]: -1, _id: -1 } : { [sort]: 1, _id: 1 };
}

export const productsRepository = defineRepository('products', PRODUCTS_REPOSITORY_METHODS, {
  /**
   * Storefront list: cursor pagination over active products.
   * Fetches `limit + 1` rows so `hasNextPage` needs no count query.
   */
  async listStorefront({ query, limit }) {
    const { filter, sort } = buildStorefrontQueryParts(query);
    const documents = await Product.find(filter)
      .sort(sort)
      .limit(limit + 1)
      .populate(BRAND_POPULATE)
      .populate(CATEGORY_POPULATE)
      .lean();

    return { records: documents.map(toRecord), fetched: documents.length };
  },

  /** Admin list: offset pagination with an exact total. */
  async listAdmin(query) {
    const conditions = [];
    const searchCondition = buildSearchCondition(query.search, query.searchMode);
    if (searchCondition) conditions.push(searchCondition);
    if (query.isActive !== undefined) conditions.push({ isActive: query.isActive });
    conditions.push(...buildFacetConditions(query));

    const filter = combineConditions(conditions);
    const skip = (query.page - 1) * query.limit;

    const [documents, total] = await Promise.all([
      Product.find(filter)
        .sort(adminSortSpec(query.sort))
        .skip(skip)
        .limit(query.limit)
        .populate(BRAND_POPULATE)
        .populate(CATEGORY_POPULATE)
        .lean(),
      Product.countDocuments(filter),
    ]);

    return { records: documents.map(toRecord), total };
  },

  /** Public detail: inactive products are invisible; id or slug accepted. */
  async findById(identifier) {
    return findRecord(identifier, { includeInactive: false });
  },

  /** Admin detail: includes inactive products. */
  async findAdminById(identifier) {
    return findRecord(identifier, { includeInactive: true });
  },

  /** Whether another product already uses this slug. */
  async existsBySlug(slug, { excludeId } = {}) {
    const filter = { slug };
    if (assertCanonicalId(excludeId)) filter._id = { $ne: excludeId };
    return Boolean(await Product.exists(filter));
  },

  /** Whether another product already uses this SKU. */
  async existsBySku(sku, { excludeId } = {}) {
    const filter = { sku };
    if (assertCanonicalId(excludeId)) filter._id = { $ne: excludeId };
    return Boolean(await Product.exists(filter));
  },

  /** Allocates a SKU that no product uses. */
  async allocateSku({ prefix, excludeId } = {}) {
    return createUniqueSku(Product, { prefix, excludeId: assertCanonicalId(excludeId) });
  },

  /** Allocates a slug that no product uses. */
  async allocateSlug(text, options = {}) {
    return createUniqueSlug(Product, text, {
      fallback: 'product',
      ...options,
      excludeId: assertCanonicalId(options.excludeId),
    });
  },

  /** Inserts a product; duplicate slug/SKU retries with fresh candidates. */
  async create({ payload, slugSource, skuPrefix, image, thumbnail }) {
    const product = await withDuplicateKeyRetry(async (attempt = 1) => {
      const slug = await createUniqueSlug(Product, slugSource, {
        fallback: 'product',
        startIndex: 2 + (attempt - 1) * 4,
        randomizeAfter: 2,
      });
      const sku =
        payload.sku ?? (await createUniqueSku(Product, { prefix: skuPrefix ?? 'product' }));

      return Product.create({
        title: payload.title,
        description: payload.description,
        price: payload.price,
        stock: payload.stock,
        brand: payload.brand,
        category: payload.category,
        isActive: payload.isActive ?? true,
        sku,
        slug,
        image: image ?? '',
        thumbnail: thumbnail ?? '',
      });
    });

    await product.populate([BRAND_POPULATE, CATEGORY_POPULATE]);
    return toRecord(product.toObject({ virtuals: true }));
  },

  /**
   * Replaces/patch-updates editable fields with optimistic concurrency.
   *
   * Returns `null` when the product does not exist, throws `STALE_RESOURCE` when
   * `version` no longer matches, and returns the previous image URLs so the
   * service can delete superseded files only after the write is durable.
   */
  async replaceFields(id, payload, { partial = false, slugSource, image, thumbnail } = {}) {
    const product = await Product.findById(id);
    if (!product) return null;

    if (payload.version !== product.__v) {
      throw new ApiError(
        HTTP_STATUS.CONFLICT,
        'This product was modified by someone else. Reload the latest version and re-apply your changes.',
        {
          code: 'STALE_RESOURCE',
          details: { providedVersion: payload.version, currentVersion: product.__v },
        },
      );
    }

    const previous = { image: product.image, thumbnail: product.thumbnail };

    if (partial) {
      if (payload.title !== undefined && payload.title !== product.title) {
        product.title = payload.title;
        product.slug = await createUniqueSlug(Product, slugSource ?? payload.title, {
          excludeId: product._id,
          fallback: 'product',
        });
      }
      for (const field of [
        'description',
        'price',
        'stock',
        'brand',
        'category',
        'isActive',
        'sku',
      ]) {
        if (payload[field] !== undefined) product[field] = payload[field];
      }
    } else {
      if (payload.title !== product.title) {
        product.slug = await createUniqueSlug(Product, slugSource ?? payload.title, {
          excludeId: product._id,
          fallback: 'product',
        });
      }
      product.title = payload.title;
      product.description = payload.description;
      product.price = payload.price;
      product.stock = payload.stock;
      product.brand = payload.brand;
      product.category = payload.category;
      product.isActive = payload.isActive ?? true;
      if (payload.sku !== undefined) product.sku = payload.sku;
    }

    if (image !== undefined) {
      product.image = image;
      product.thumbnail = thumbnail ?? image;
    }

    try {
      await withDuplicateKeyRetry(() => product.save());
    } catch (error) {
      if (isVersionError(error)) {
        throw new ApiError(
          HTTP_STATUS.CONFLICT,
          'This product was modified by someone else. Reload the latest version and re-apply your changes.',
          { code: 'STALE_RESOURCE', details: { providedVersion: payload.version } },
        );
      }
      throw error;
    }

    await product.populate([BRAND_POPULATE, CATEGORY_POPULATE]);
    return { record: toRecord(product.toObject({ virtuals: true })), previous };
  },

  /**
   * Atomic stock adjustment: one guarded `$inc`, so N concurrent decrements can
   * never oversell and no update is lost without needing a transaction.
   */
  async updateStock(id, payload) {
    if (payload.delta !== undefined) {
      const updated = await Product.findOneAndUpdate(
        { _id: id, stock: { $gte: -payload.delta } },
        { $inc: { stock: payload.delta, __v: 1 } },
        { returnDocument: 'after', runValidators: true },
      )
        .populate(BRAND_POPULATE)
        .populate(CATEGORY_POPULATE)
        .lean();

      if (updated) return { record: toRecord(updated), insufficient: false };

      const existing = await Product.findById(id).select('stock').lean();
      if (!existing) return null;
      return {
        record: null,
        insufficient: true,
        available: existing.stock,
        requested: Math.abs(payload.delta),
      };
    }

    const updated = await Product.findOneAndUpdate(
      { _id: id },
      { $set: { stock: payload.stock }, $inc: { __v: 1 } },
      { returnDocument: 'after', runValidators: true },
    )
      .populate(BRAND_POPULATE)
      .populate(CATEGORY_POPULATE)
      .lean();

    if (!updated) return null;
    return { record: toRecord(updated), insufficient: false };
  },

  /** Deletes a product; returns what was removed so the service can audit it. */
  async deleteById(id) {
    const product = await Product.findById(id).select('image thumbnail title').lean();
    if (!product) return null;

    await Product.deleteOne({ _id: product._id });
    return {
      id: product._id.toString(),
      title: product.title,
      image: product.image,
      thumbnail: product.thumbnail,
    };
  },

  /** Product counts per brand/category id, for the taxonomy endpoints. */
  async countByTaxonomy(field, ids) {
    if (ids.length === 0) return new Map();
    const key = field === 'category' ? 'category' : 'brand';
    const rows = await Product.aggregate([
      { $match: { [key]: { $in: ids.map((id) => toObjectId(String(id))) } } },
      {
        $group: {
          _id: `$${key}`,
          total: { $sum: 1 },
          active: { $sum: { $cond: ['$isActive', 1, 0] } },
        },
      },
    ]);
    return new Map(
      rows.map((row) => [row._id.toString(), { total: row.total, active: row.active }]),
    );
  },

  /** File names still referenced by any product, for the orphan sweeper. */
  async collectReferencedImageFiles() {
    const documents = await Product.find({
      $or: [{ image: { $ne: '' } }, { thumbnail: { $ne: '' } }],
    })
      .select('image thumbnail')
      .lean();

    const names = new Set();
    for (const document of documents) {
      for (const url of [document.image, document.thumbnail]) {
        if (url) names.add(url.split('/').pop());
      }
    }
    return names;
  },
});

export default productsRepository;
