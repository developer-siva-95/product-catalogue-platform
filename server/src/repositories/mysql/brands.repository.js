import { createUniqueSlug, withDuplicateKeyRetry } from '../../utils/slugify.js';
import { defineRepository } from '../repository.js';
import { BRANDS_REPOSITORY_METHODS } from '../brands.repository.js';
import { query } from '../../db/mysql/pool.js';
import { containsPattern, orderByBinary, placeholders } from './sql.js';
import { newObjectIdHex } from './objectid.js';
import { isValidId } from '../../utils/id.js';
import { assertCanonicalId } from '../identifier.js';

/**
 * Brands repository — MySQL.
 *
 * Mirrors `mongo/brands.repository.js`, including the *key order* of the two wire
 * shapes (detail vs list row), because response key order is part of the API
 * contract the snapshot harness compares. Product counts come from the same
 * definition as the Mongo `$group`: `productCount` = all products referencing the
 * brand, `activeProductCount` = the `is_active = 1` subset.
 */

/** Detail record — schema order with the id last, as the model's `toJSON` produced. */
function toRecord(row) {
  if (!row) return null;
  return {
    name: row.name,
    slug: row.slug,
    description: row.description,
    logo: row.logo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    id: row.id,
  };
}

/** List row — flattened order the admin table was built with. */
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

/** Product counts per brand id, in one `GROUP BY` instead of N counts. */
async function countProductsByBrand(ids) {
  if (ids.length === 0) return new Map();
  const rows = await query(
    `SELECT brand_id AS taxonomy_id, COUNT(*) AS total, SUM(is_active = 1) AS active
       FROM products WHERE brand_id IN (${placeholders(ids.length)})
      GROUP BY brand_id`,
    ids,
  );
  return new Map(
    rows.map((row) => [row.taxonomy_id, { total: Number(row.total), active: Number(row.active) }]),
  );
}

/** Sort translation for the vault `name`/`createdAt` pair both taxonomies accept. */
function orderBy(sort = 'name') {
  const descending = sort.startsWith('-');
  const direction = descending ? 'DESC' : 'ASC';
  const column = sort.replace(/^-/, '') === 'createdAt' ? 'created_at' : 'name';
  // Binary collation reproduces Mongo's byte-order sort; the id tie-break makes
  // equal keys deterministic (the unique name index means it rarely matters).
  // `id` is CHAR(24) over **ascii**, so it must NOT be given a utf8mb4 collation —
  // ascii_bin is already exact byte order.
  return `${orderByBinary(column, direction)}, id ${direction}`;
}

const BRAND_SELECT = 'SELECT id, name, slug, description, logo, created_at, updated_at FROM brands';

async function isSlugTaken(candidate, { excludeId } = {}) {
  const rows = excludeId
    ? await query('SELECT 1 FROM brands WHERE slug = ? AND id <> ? LIMIT 1', [candidate, excludeId])
    : await query('SELECT 1 FROM brands WHERE slug = ? LIMIT 1', [candidate]);
  return rows.length > 0;
}

export const brandsRepository = defineRepository('brands', BRANDS_REPOSITORY_METHODS, {
  async list({ search, sort = 'name' } = {}) {
    const rows = search
      ? await query(`${BRAND_SELECT} WHERE name_normalized LIKE ? ORDER BY ${orderBy(sort)}`, [
          containsPattern(String(search).trim().toLowerCase()),
        ])
      : await query(`${BRAND_SELECT} ORDER BY ${orderBy(sort)}`);

    const counts = await countProductsByBrand(rows.map((row) => row.id));
    return rows.map((row) =>
      toListRow(toRecord(row), counts.get(row.id) ?? { total: 0, active: 0 }),
    );
  },

  async findByIdentifier(identifier) {
    const rows = isValidId(identifier)
      ? await query(`${BRAND_SELECT} WHERE id = ? LIMIT 1`, [identifier])
      : await query(`${BRAND_SELECT} WHERE slug = ? LIMIT 1`, [identifier]);
    if (rows.length === 0) return null;

    const counts = await countProductsByBrand([rows[0].id]);
    const count = counts.get(rows[0].id) ?? { total: 0, active: 0 };
    return { ...toRecord(rows[0]), productCount: count.total, activeProductCount: count.active };
  },

  async findById(id) {
    const rows = await query(`${BRAND_SELECT} WHERE id = ? LIMIT 1`, [id]);
    return toRecord(rows[0]);
  },

  /** Natural-key lookup used by the seeder and by the Mongo→MySQL migration. */
  async findByNameNormalized(nameNormalized) {
    const rows = await query(`${BRAND_SELECT} WHERE name_normalized = ? LIMIT 1`, [
      String(nameNormalized),
    ]);
    return rows.length ? toRecord(rows[0]) : null;
  },

  async existsByName(nameNormalized, { excludeId } = {}) {
    assertCanonicalId(excludeId);
    const rows = excludeId
      ? await query('SELECT 1 FROM brands WHERE name_normalized = ? AND id <> ? LIMIT 1', [
          nameNormalized,
          excludeId,
        ])
      : await query('SELECT 1 FROM brands WHERE name_normalized = ? LIMIT 1', [nameNormalized]);
    return rows.length > 0;
  },

  async create({ name, description = '' }) {
    const trimmedName = String(name).trim();
    const nameNormalized = trimmedName.toLowerCase();

    return withDuplicateKeyRetry(async (attempt = 1) => {
      const slug = await createUniqueSlug(isSlugTaken, name, {
        fallback: 'brand',
        startIndex: 2 + (attempt - 1) * 4,
      });
      const id = newObjectIdHex();
      const now = new Date();

      await query(
        `INSERT INTO brands (id, name, name_normalized, slug, description, logo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
        [id, trimmedName, nameNormalized, slug, String(description ?? '').trim(), now, now],
      );

      const rows = await query(`${BRAND_SELECT} WHERE id = ? LIMIT 1`, [id]);
      return toRecord(rows[0]);
    });
  },

  async update(id, payload) {
    const rows = await query(`${BRAND_SELECT} WHERE id = ? LIMIT 1`, [id]);
    const current = rows[0];
    if (!current) return null;

    const next = {
      name: current.name,
      name_normalized: current.name.toLowerCase(),
      slug: current.slug,
      description: current.description,
    };

    if (payload.name !== undefined) {
      const trimmedName = String(payload.name).trim();
      if (trimmedName.toLowerCase() !== current.name.toLowerCase()) {
        // Renaming changes the public slug, exactly like the Mongo provider.
        next.name = trimmedName;
        next.name_normalized = trimmedName.toLowerCase();
        next.slug = await createUniqueSlug(isSlugTaken, payload.name, {
          excludeId: id,
          fallback: 'brand',
        });
      } else {
        next.name = trimmedName;
      }
    }
    if (payload.description !== undefined) {
      next.description = String(payload.description ?? '').trim();
    }

    await withDuplicateKeyRetry(() =>
      query(
        `UPDATE brands SET name = ?, name_normalized = ?, slug = ?, description = ?, updated_at = ?
          WHERE id = ?`,
        [next.name, next.name_normalized, next.slug, next.description, new Date(), id],
      ),
    );

    const updated = await query(`${BRAND_SELECT} WHERE id = ? LIMIT 1`, [id]);
    return toRecord(updated[0]);
  },

  async delete(id) {
    const rows = await query(`${BRAND_SELECT} WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return null;

    // The FK (product_brand_fk) is the final guard: deleting a referenced brand
    // raises ER_ROW_IS_REFERENCED_2, which the service's count check normally
    // prevents and the error mapper turns into a 409 if it ever races.
    await query('DELETE FROM brands WHERE id = ?', [id]);
    return { id: rows[0].id, name: rows[0].name };
  },

  async countProducts(id) {
    const rows = await query(
      'SELECT COUNT(*) AS total, SUM(is_active = 1) AS active FROM products WHERE brand_id = ?',
      [id],
    );
    const total = Number(rows[0]?.total ?? 0);
    const active = Number(rows[0]?.active ?? 0);
    return { activeReferences: active, inactiveReferences: total - active };
  },
});

export default brandsRepository;
