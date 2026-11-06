import { createUniqueSlug, withDuplicateKeyRetry } from '../../utils/slugify.js';
import { defineRepository } from '../repository.js';
import { CATEGORIES_REPOSITORY_METHODS } from '../categories.repository.js';
import { query } from '../../db/mysql/pool.js';
import { containsPattern, orderByBinary, placeholders } from './sql.js';
import { newObjectIdHex } from './objectid.js';
import { isValidId } from '../../utils/id.js';
import { assertCanonicalId } from '../identifier.js';

/**
 * Categories repository — MySQL.
 *
 * Mirrors `mongo/categories.repository.js` exactly, including the conditional
 * `image` key: the Mongo category schema never declared `image`, so that key is
 * only present when a record actually carries one. The column defaults to `''`,
 * which is treated as "absent" so the JSON stays identical.
 */

/** Detail record — schema order with the id last; `image` only when present. */
function toRecord(row) {
  if (!row) return null;
  return {
    name: row.name,
    slug: row.slug,
    description: row.description,
    // NULL means the field is absent (Mongo never declared it); '' means it exists
    // and is empty. Both cases must serialise exactly like the reference provider.
    ...(row.image === null || row.image === undefined ? {} : { image: row.image }),
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
    productCount: count.total,
    activeProductCount: count.active,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Product counts per category id, in one `GROUP BY`. */
async function countProductsByCategory(ids) {
  if (ids.length === 0) return new Map();
  const rows = await query(
    `SELECT category_id AS taxonomy_id, COUNT(*) AS total, SUM(is_active = 1) AS active
       FROM products WHERE category_id IN (${placeholders(ids.length)})
      GROUP BY category_id`,
    ids,
  );
  return new Map(
    rows.map((row) => [row.taxonomy_id, { total: Number(row.total), active: Number(row.active) }]),
  );
}

/** Sort translation for `name`/`createdAt`, binary-collated like Mongo. */
function orderBy(sort = 'name') {
  const descending = sort.startsWith('-');
  const direction = descending ? 'DESC' : 'ASC';
  const column = sort.replace(/^-/, '') === 'createdAt' ? 'created_at' : 'name';
  // `id` is CHAR(24) over **ascii**: it must not be given a utf8mb4 collation
  // (MySQL rejects it), and ascii_bin is already exact byte order.
  return `${orderByBinary(column, direction)}, id ${direction}`;
}

const CATEGORY_SELECT =
  'SELECT id, name, slug, description, image, created_at, updated_at FROM categories';

async function isSlugTaken(candidate, { excludeId } = {}) {
  const rows = excludeId
    ? await query('SELECT 1 FROM categories WHERE slug = ? AND id <> ? LIMIT 1', [
        candidate,
        excludeId,
      ])
    : await query('SELECT 1 FROM categories WHERE slug = ? LIMIT 1', [candidate]);
  return rows.length > 0;
}

export const categoriesRepository = defineRepository('categories', CATEGORIES_REPOSITORY_METHODS, {
  async list({ search, sort = 'name' } = {}) {
    const rows = search
      ? await query(`${CATEGORY_SELECT} WHERE name_normalized LIKE ? ORDER BY ${orderBy(sort)}`, [
          containsPattern(String(search).trim().toLowerCase()),
        ])
      : await query(`${CATEGORY_SELECT} ORDER BY ${orderBy(sort)}`);

    const counts = await countProductsByCategory(rows.map((row) => row.id));
    return rows.map((row) =>
      toListRow(toRecord(row), counts.get(row.id) ?? { total: 0, active: 0 }),
    );
  },

  async findByIdentifier(identifier) {
    const rows = isValidId(identifier)
      ? await query(`${CATEGORY_SELECT} WHERE id = ? LIMIT 1`, [identifier])
      : await query(`${CATEGORY_SELECT} WHERE slug = ? LIMIT 1`, [identifier]);
    if (rows.length === 0) return null;

    const counts = await countProductsByCategory([rows[0].id]);
    const count = counts.get(rows[0].id) ?? { total: 0, active: 0 };
    return { ...toRecord(rows[0]), productCount: count.total, activeProductCount: count.active };
  },

  async findById(id) {
    const rows = await query(`${CATEGORY_SELECT} WHERE id = ? LIMIT 1`, [id]);
    return toRecord(rows[0]);
  },

  /** Natural-key lookup used by the seeder and by the Mongo→MySQL migration. */
  async findByNameNormalized(nameNormalized) {
    const rows = await query(`${CATEGORY_SELECT} WHERE name_normalized = ? LIMIT 1`, [
      String(nameNormalized),
    ]);
    return rows.length ? toRecord(rows[0]) : null;
  },

  async existsByName(nameNormalized, { excludeId } = {}) {
    assertCanonicalId(excludeId);
    const rows = excludeId
      ? await query('SELECT 1 FROM categories WHERE name_normalized = ? AND id <> ? LIMIT 1', [
          nameNormalized,
          excludeId,
        ])
      : await query('SELECT 1 FROM categories WHERE name_normalized = ? LIMIT 1', [nameNormalized]);
    return rows.length > 0;
  },

  async create({ name, description = '' }) {
    const trimmedName = String(name).trim();
    const nameNormalized = trimmedName.toLowerCase();

    return withDuplicateKeyRetry(async (attempt = 1) => {
      const slug = await createUniqueSlug(isSlugTaken, name, {
        fallback: 'category',
        startIndex: 2 + (attempt - 1) * 4,
      });
      const id = newObjectIdHex();
      const now = new Date();

      await query(
        `INSERT INTO categories
             (id, name, name_normalized, slug, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, trimmedName, nameNormalized, slug, String(description ?? '').trim(), now, now],
      );

      const rows = await query(`${CATEGORY_SELECT} WHERE id = ? LIMIT 1`, [id]);
      return toRecord(rows[0]);
    });
  },

  async update(id, payload) {
    const rows = await query(`${CATEGORY_SELECT} WHERE id = ? LIMIT 1`, [id]);
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
        next.name = trimmedName;
        next.name_normalized = trimmedName.toLowerCase();
        next.slug = await createUniqueSlug(isSlugTaken, payload.name, {
          excludeId: id,
          fallback: 'category',
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
        `UPDATE categories SET name = ?, name_normalized = ?, slug = ?, description = ?, updated_at = ?
            WHERE id = ?`,
        [next.name, next.name_normalized, next.slug, next.description, new Date(), id],
      ),
    );

    const updated = await query(`${CATEGORY_SELECT} WHERE id = ? LIMIT 1`, [id]);
    return toRecord(updated[0]);
  },

  async delete(id) {
    const rows = await query(`${CATEGORY_SELECT} WHERE id = ? LIMIT 1`, [id]);
    if (rows.length === 0) return null;

    await query('DELETE FROM categories WHERE id = ?', [id]);
    return { id: rows[0].id, name: rows[0].name };
  },

  async countProducts(id) {
    const rows = await query(
      'SELECT COUNT(*) AS total, SUM(is_active = 1) AS active FROM products WHERE category_id = ?',
      [id],
    );
    const total = Number(rows[0]?.total ?? 0);
    const active = Number(rows[0]?.active ?? 0);
    return { activeReferences: active, inactiveReferences: total - active };
  },
});

export default categoriesRepository;
