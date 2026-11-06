import { Brand } from '../../modules/brands/model.js';
import { escapeRegex } from '../../utils/validators.js';
import { createUniqueSlug, withDuplicateKeyRetry } from '../../utils/slugify.js';
import { toObjectId } from './objectid.js';
import { Product } from '../../modules/products/model.js';
import { defineRepository } from '../repository.js';
import { BRANDS_REPOSITORY_METHODS } from '../brands.repository.js';
import { assertCanonicalId } from '../identifier.js';

/**
 * Brands repository — MongoDB.
 *
 * Product counts are computed here (`$group`) and by the MySQL implementation with
 * `GROUP BY`, from the same definition: `productCount` = all products referencing
 * the brand, `activeProductCount` = the subset with `isActive: true`.
 */

/**
 * Plain record for a lean brand document.
 *
 * Key order matches what the model's `toJSON` produced (schema order, with the
 * `id` virtual appended last) because response key order is part of the contract
 * the snapshot harness compares.
 */
function toRecord(document) {
  if (!document) return null;
  return {
    name: document.name,
    slug: document.slug,
    description: document.description,
    logo: document.logo,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    id: document._id.toString(),
  };
}

/** List rows use the flattened order the storefront/admin tables were built with. */
function toListRow(record, count) {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    description: record.description,
    logo: record.logo,
    productCount: count.total,
    activeProductCount: count.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Product counts for a set of brand ids. */
async function countProductsByBrand(ids) {
  if (ids.length === 0) return new Map();
  const rows = await Product.aggregate([
    { $match: { brand: { $in: ids.map((id) => toObjectId(String(id))) } } },
    {
      $group: {
        _id: '$brand',
        total: { $sum: 1 },
        active: { $sum: { $cond: ['$isActive', 1, 0] } },
      },
    },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), { total: row.total, active: row.active }]));
}

export const brandsRepository = defineRepository('brands', BRANDS_REPOSITORY_METHODS, {
  /** Lists brands (optionally name-filtered) with product counts. */
  async list({ search, sort = 'name' } = {}) {
    const filter = {};
    if (search) filter.nameNormalized = { $regex: escapeRegex(search.toLowerCase()) };

    const sortSpec = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const brands = await Brand.find(filter).sort(sortSpec).lean({ virtuals: false });

    const counts = await countProductsByBrand(brands.map((brand) => brand._id));
    return brands.map((brand) => {
      const count = counts.get(brand._id.toString()) ?? { total: 0, active: 0 };
      return toListRow(toRecord(brand), count);
    });
  },

  /** Finds a brand by 24-hex id or by slug. */
  async findByIdentifier(identifier) {
    const isId = /^[0-9a-fA-F]{24}$/.test(identifier);
    const brand = await Brand.findOne(isId ? { _id: identifier } : { slug: identifier }).lean();
    if (!brand) return null;

    const counts = await countProductsByBrand([brand._id]);
    const count = counts.get(brand._id.toString()) ?? { total: 0, active: 0 };
    return { ...toRecord(brand), productCount: count.total, activeProductCount: count.active };
  },

  /** Finds a brand by canonical id only. */
  async findById(id) {
    return toRecord(await Brand.findById(id).lean());
  },

  /**
   * Natural-key lookup used by the seeder and by the Mongo→MySQL migration.
   * Returns the same record shape as `findById` (so `record.id` is canonical).
   */
  async findByNameNormalized(nameNormalized) {
    return toRecord(await Brand.findOne({ nameNormalized: String(nameNormalized) }).lean());
  },

  /** Case-insensitive uniqueness pre-check (the unique index is the guarantee). */
  async existsByName(nameNormalized, { excludeId } = {}) {
    const filter = { nameNormalized };
    if (assertCanonicalId(excludeId)) filter._id = { $ne: excludeId };
    return Boolean(await Brand.exists(filter));
  },

  /** Creates a brand with a collision-free slug. */
  async create({ name, description = '' }) {
    const nameNormalized = name.trim().toLowerCase();
    return withDuplicateKeyRetry(async (attempt = 1) => {
      const slug = await createUniqueSlug(Brand, name, {
        fallback: 'brand',
        startIndex: 2 + (attempt - 1) * 4,
      });
      const brand = await Brand.create({ name, nameNormalized, slug, description });
      return toRecord(brand.toObject());
    });
  },

  /** Updates a brand; `null` when it does not exist. */
  async update(id, payload) {
    const brand = await Brand.findById(id);
    if (!brand) return null;

    if (payload.name !== undefined && payload.name.trim().toLowerCase() !== brand.nameNormalized) {
      brand.name = payload.name;
      brand.nameNormalized = payload.name.trim().toLowerCase();
      brand.slug = await createUniqueSlug(Brand, payload.name, {
        excludeId: brand._id,
        fallback: 'brand',
      });
    } else if (payload.name !== undefined) {
      brand.name = payload.name;
    }

    if (payload.description !== undefined) brand.description = payload.description;

    await withDuplicateKeyRetry(() => brand.save());
    return toRecord(brand.toObject());
  },

  /** Deletes a brand; returns `{ id, name }`, or `null` when absent. */
  async delete(id) {
    const brand = await Brand.findById(id).lean();
    if (!brand) return null;
    await Brand.deleteOne({ _id: brand._id });
    return { id: brand._id.toString(), name: brand.name };
  },

  /** Product references (active + inactive) for the delete guard. */
  async countProducts(id) {
    const [active, total] = await Promise.all([
      Product.countDocuments({ brand: id, isActive: true }),
      Product.countDocuments({ brand: id }),
    ]);
    return { activeReferences: active, inactiveReferences: total - active };
  },
});

export default brandsRepository;
