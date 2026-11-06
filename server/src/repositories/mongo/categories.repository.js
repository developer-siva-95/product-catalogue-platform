import { Category } from '../../modules/categories/model.js';
import { escapeRegex } from '../../utils/validators.js';
import { createUniqueSlug, withDuplicateKeyRetry } from '../../utils/slugify.js';
import { toObjectId } from './objectid.js';
import { Product } from '../../modules/products/model.js';
import { defineRepository } from '../repository.js';
import { CATEGORIES_REPOSITORY_METHODS } from '../categories.repository.js';
import { assertCanonicalId } from '../identifier.js';

/**
 * Categories repository — MongoDB.
 *
 * Product counts are computed here (`$group`) and by the MySQL implementation with
 * `GROUP BY`, from the same definition: `productCount` = all products referencing
 * the category, `activeProductCount` = the subset with `isActive: true`.
 */

/**
 * Plain record for a lean category document.
 *
 * `image` only appears when the stored document actually has the field — the
 * category schema does not declare it, and the create response never included it.
 * Key order mirrors the model's `toJSON` (schema order, `id` virtual last).
 */
function toRecord(document) {
  if (!document) return null;
  return {
    name: document.name,
    slug: document.slug,
    description: document.description,
    ...(document.image === undefined ? {} : { image: document.image }),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    id: document._id.toString(),
  };
}

/** List rows use the flattened order the admin table was built with. */
function toListRow(record, count) {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    description: record.description,
    productCount: count.total,
    activeProductCount: count.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Product counts for a set of category ids. */
async function countProductsByCategory(ids) {
  if (ids.length === 0) return new Map();
  const rows = await Product.aggregate([
    { $match: { category: { $in: ids.map((id) => toObjectId(String(id))) } } },
    {
      $group: {
        _id: '$category',
        total: { $sum: 1 },
        active: { $sum: { $cond: ['$isActive', 1, 0] } },
      },
    },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), { total: row.total, active: row.active }]));
}

export const categoriesRepository = defineRepository('categories', CATEGORIES_REPOSITORY_METHODS, {
  /** Lists categories (optionally name-filtered) with product counts. */
  async list({ search, sort = 'name' } = {}) {
    const filter = {};
    if (search) filter.nameNormalized = { $regex: escapeRegex(search.toLowerCase()) };

    const sortSpec = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const categories = await Category.find(filter).sort(sortSpec).lean({ virtuals: false });

    const counts = await countProductsByCategory(categories.map((category) => category._id));
    return categories.map((category) => {
      const count = counts.get(category._id.toString()) ?? { total: 0, active: 0 };
      return toListRow(toRecord(category), count);
    });
  },

  /** Finds a category by 24-hex id or by slug. */
  async findByIdentifier(identifier) {
    const isId = /^[0-9a-fA-F]{24}$/.test(identifier);
    const category = await Category.findOne(
      isId ? { _id: identifier } : { slug: identifier },
    ).lean();
    if (!category) return null;

    const counts = await countProductsByCategory([category._id]);
    const count = counts.get(category._id.toString()) ?? { total: 0, active: 0 };
    return { ...toRecord(category), productCount: count.total, activeProductCount: count.active };
  },

  /** Finds a category by canonical id only. */
  async findById(id) {
    return toRecord(await Category.findById(id).lean());
  },

  /** Case-insensitive uniqueness pre-check (the unique index is the guarantee). */
  /** Natural-key lookup used by the seeder and by the Mongo→MySQL migration. */
  async findByNameNormalized(nameNormalized) {
    return toRecord(await Category.findOne({ nameNormalized: String(nameNormalized) }).lean());
  },

  async existsByName(nameNormalized, { excludeId } = {}) {
    const filter = { nameNormalized };
    if (assertCanonicalId(excludeId)) filter._id = { $ne: excludeId };
    return Boolean(await Category.exists(filter));
  },

  /** Creates a category with a collision-free slug. */
  async create({ name, description = '' }) {
    const nameNormalized = name.trim().toLowerCase();
    return withDuplicateKeyRetry(async (attempt = 1) => {
      const slug = await createUniqueSlug(Category, name, {
        fallback: 'category',
        startIndex: 2 + (attempt - 1) * 4,
      });
      const category = await Category.create({ name, nameNormalized, slug, description });
      return toRecord(category.toObject());
    });
  },

  /** Updates a category; `null` when it does not exist. */
  async update(id, payload) {
    const category = await Category.findById(id);
    if (!category) return null;

    if (
      payload.name !== undefined &&
      payload.name.trim().toLowerCase() !== category.nameNormalized
    ) {
      category.name = payload.name;
      category.nameNormalized = payload.name.trim().toLowerCase();
      category.slug = await createUniqueSlug(Category, payload.name, {
        excludeId: category._id,
        fallback: 'category',
      });
    } else if (payload.name !== undefined) {
      category.name = payload.name;
    }

    if (payload.description !== undefined) category.description = payload.description;

    await withDuplicateKeyRetry(() => category.save());
    return toRecord(category.toObject());
  },

  /** Deletes a category; returns `{ id, name }`, or `null` when absent. */
  async delete(id) {
    const category = await Category.findById(id).lean();
    if (!category) return null;
    await Category.deleteOne({ _id: category._id });
    return { id: category._id.toString(), name: category.name };
  },

  /** Product references (active + inactive) for the delete guard. */
  async countProducts(id) {
    const [active, total] = await Promise.all([
      Product.countDocuments({ category: id, isActive: true }),
      Product.countDocuments({ category: id }),
    ]);
    return { activeReferences: active, inactiveReferences: total - active };
  },
});

export default categoriesRepository;
