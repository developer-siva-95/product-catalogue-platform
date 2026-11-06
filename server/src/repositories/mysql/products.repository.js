import { HTTP_STATUS } from '../../constants/httpStatusCodes.js';
import { PRODUCT_SORT } from '../../constants/appConstants.js';
import { ApiError } from '../../utils/ApiError.js';
import { isValidId } from '../../utils/id.js';
import { createUniqueSlug, withDuplicateKeyRetry } from '../../utils/slugify.js';
import { createUniqueSku } from '../../utils/skuGenerator.js';
import { decodeCursor } from '../../utils/cursor.js';
import { storefrontFilterHash } from '../storefront-query.js';
import { defineRepository } from '../repository.js';
import { PRODUCTS_REPOSITORY_METHODS } from '../products.repository.js';
import { query, withTransaction } from '../../db/mysql/pool.js';
import { newObjectIdHex } from './objectid.js';
import { containsPattern, orderByBinary, placeholders, toBoolean, toNumber } from './sql.js';
import { assertCanonicalId } from '../identifier.js';

/**
 * Products repository — MySQL.
 *
 * The MySQL twin of `mongo/products.repository.js`: same method names, same
 * arguments, same return shapes, same error codes. The mapping table that keeps
 * the two byte-identical lives in the header of `db/mysql/migrations/001_init.sql`;
 * the essentials repeated here:
 *
 *  - ids are 24-hex strings comparable as bytes, so `ORDER BY id DESC` reproduces
 *    Mongo's `sort({ _id: -1 })` and cursor tokens stay valid across providers;
 *  - `price` is DECIMAL and is converted to a number at this boundary only;
 *  - `version` is Mongo's `__v`: `UPDATE … WHERE id = ? AND version = ?` with
 *    `affectedRows = 0` meaning "someone else won" → `STALE_RESOURCE` (409);
 *  - stock moves through one guarded `UPDATE … WHERE stock >= ?`, so concurrent
 *    decrements cannot oversell without any read-modify-write;
 *  - duplicate keys surface as `ApiError DUPLICATE_KEY` via `mapMysqlError`.
 */

/** Columns + joins that produce a record identical to the Mongo `toRecord`. */
const PRODUCT_SELECT = `
  SELECT p.id, p.title, p.slug, p.sku, p.price, p.stock, p.description,
         p.image, p.thumbnail, p.is_active, p.version, p.created_at, p.updated_at,
         p.brand_id, b.name AS brand_name, b.slug AS brand_slug,
         p.category_id, c.name AS category_name, c.slug AS category_slug
    FROM products p
    JOIN brands b ON b.id = p.brand_id
    JOIN categories c ON c.id = p.category_id`;

/** Storefront/admin sort → exact ORDER BY clause (binary collation like Mongo). */
const STOREFRONT_ORDER = {
  [PRODUCT_SORT.NEWEST]: 'p.id DESC',
  [PRODUCT_SORT.PRICE_ASC]: 'p.price ASC, p.id ASC',
  [PRODUCT_SORT.PRICE_DESC]: 'p.price DESC, p.id DESC',
};

/** Admin sort whitelist (mirrors the validation schema, never user SQL). */
const ADMIN_SORT_COLUMNS = {
  createdAt: 'p.created_at',
  price: 'p.price',
  title: 'p.title',
};

/** Normalises one joined row into the provider-neutral record shape. */
function toRecord(row) {
  if (!row) return null;
  return {
    _id: row.id,
    title: row.title,
    slug: row.slug,
    sku: row.sku ?? null,
    price: toNumber(row.price),
    stock: Number(row.stock),
    description: row.description,
    image: row.image,
    thumbnail: row.thumbnail,
    brand: row.brand_id ? { _id: row.brand_id, name: row.brand_name, slug: row.brand_slug } : null,
    category: row.category_id
      ? { _id: row.category_id, name: row.category_name, slug: row.category_slug }
      : null,
    isActive: toBoolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    __v: Number(row.version ?? 0),
  };
}

/** Stale-write error, identical in status/message/code to the Mongo provider. */
function staleResource(details) {
  return new ApiError(
    HTTP_STATUS.CONFLICT,
    'This product was modified by someone else. Reload the latest version and re-apply your changes.',
    { code: 'STALE_RESOURCE', details },
  );
}

/** Reads one product by id or slug. */
async function findRecord(identifier, { includeInactive }, executor = query) {
  const where = isValidId(identifier) ? 'p.id = ?' : 'p.slug = ?';
  const clauses = [where];
  const params = [identifier];
  if (!includeInactive) clauses.push('p.is_active = 1');

  const rows = await executor(`${PRODUCT_SELECT} WHERE ${clauses.join(' AND ')} LIMIT 1`, params);
  return toRecord(rows[0]);
}

/** Facet conditions shared by the storefront and admin lists. */
function facetConditions({ minPrice, maxPrice, brand, category }) {
  const clauses = [];
  const params = [];

  if (minPrice !== undefined) {
    clauses.push('p.price >= ?');
    params.push(minPrice);
  }
  if (maxPrice !== undefined) {
    clauses.push('p.price <= ?');
    params.push(maxPrice);
  }
  if (brand) {
    clauses.push('p.brand_id = ?');
    params.push(brand);
  }
  if (category) {
    clauses.push('p.category_id = ?');
    params.push(category);
  }

  return { clauses, params };
}

/**
 * Search condition.
 *
 * `regex` (default) is a literal, case-insensitive substring over title/SKU — the
 * MySQL equivalent of Mongo's `{ $regex: escapeRegex(term), $options: 'i' }` on
 * those same two fields, expressed as an escaped `LIKE` against the
 * accent/case-insensitive column collation.
 *
 * `text` uses the InnoDB FULLTEXT index. See `docs` in the P4 report: InnoDB's
 * parser has its own stopword list and minimum token length, so this mode is
 * matched against the reference on a fixture corpus in the dual-provider suite
 * rather than assumed equivalent.
 *
 * @param {string|undefined} term
 * @param {'regex'|'text'} mode
 */
function searchCondition(term, mode = 'regex') {
  if (!term) return { clauses: [], params: [] };
  if (mode === 'text') {
    return {
      clauses: ['MATCH (p.title, p.description) AGAINST (? IN BOOLEAN MODE)'],
      params: [term],
    };
  }
  const pattern = containsPattern(term);
  // The collation is forced on the *expression*, not inherited from the column:
  // `sku` is utf8mb4_bin (exact uniqueness), so an inherited comparison would be
  // case-sensitive and `search=b` would stop matching `BRV-002`, which the
  // reference provider matches via `/b/i`.
  return {
    clauses: [
      '(p.title COLLATE utf8mb4_0900_as_ci LIKE ? OR p.sku COLLATE utf8mb4_0900_as_ci LIKE ?)',
    ],
    params: [pattern, pattern],
  };
}

/**
 * Cursor comparison. The operators mirror the sort direction exactly (the same
 * four cases the Mongo provider implements), otherwise rows are skipped or
 * repeated at page boundaries.
 */
function cursorCondition(cursor) {
  if (cursor.sort === PRODUCT_SORT.NEWEST) {
    return { clause: 'p.id < ?', params: [cursor.id] };
  }
  if (cursor.sort === PRODUCT_SORT.PRICE_ASC) {
    return {
      clause: '(p.price > ? OR (p.price = ? AND p.id > ?))',
      params: [cursor.price, cursor.price, cursor.id],
    };
  }
  if (cursor.sort === PRODUCT_SORT.PRICE_DESC) {
    return {
      clause: '(p.price < ? OR (p.price = ? AND p.id < ?))',
      params: [cursor.price, cursor.price, cursor.id],
    };
  }
  throw ApiError.badRequest(`Unsupported sort: ${cursor.sort}`, { code: 'UNSUPPORTED_SORT' });
}

/** Admin ORDER BY from the same sort strings the Mongo provider accepts. */
function adminOrderBy(sort) {
  const descending = sort.startsWith('-');
  const field = descending ? sort.slice(1) : sort;
  const column = ADMIN_SORT_COLUMNS[field];
  if (!column) {
    throw ApiError.badRequest(`Unsupported sort: ${sort}`, { code: 'UNSUPPORTED_SORT' });
  }
  const direction = descending ? 'DESC' : 'ASC';
  // Only text columns take a collation; applying one to `p.price` would make MySQL
  // compare the DECIMAL as a string ('100' < '1000' < '250.50' < '5.25').
  const orderTerm = field === 'title' ? orderByBinary(column, direction) : `${column} ${direction}`;
  // Tie-break on id in the same direction, exactly like `{ [field]: dir, _id: dir }`.
  return `${orderTerm}, p.id ${direction}`;
}

/**
 * Column-level normalisation that the Mongo schema performed implicitly
 * (`trim: true`, `uppercase: true`, `lowercase: true`, and the price setter's
 * 2-decimal rounding). Reproducing it here keeps the stored values — and therefore
 * every response body — identical between the two providers.
 */
function normalizeSku(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim().toUpperCase();
  return trimmed === '' ? null : trimmed;
}

function roundPrice(value) {
  return typeof value === 'number' ? Math.round(value * 100) / 100 : value;
}

/** Probe used by the shared slug allocator. */
async function isSlugTaken(candidate, { excludeId } = {}) {
  const rows = excludeId
    ? await query('SELECT 1 FROM products WHERE slug = ? AND id <> ? LIMIT 1', [
        candidate,
        excludeId,
      ])
    : await query('SELECT 1 FROM products WHERE slug = ? LIMIT 1', [candidate]);
  return rows.length > 0;
}

/** Probe used by the shared SKU allocator. */
async function isSkuTaken(candidate, { excludeId } = {}) {
  const rows = excludeId
    ? await query('SELECT 1 FROM products WHERE sku = ? AND id <> ? LIMIT 1', [
        candidate,
        excludeId,
      ])
    : await query('SELECT 1 FROM products WHERE sku = ? LIMIT 1', [candidate]);
  return rows.length > 0;
}

export const productsRepository = defineRepository('products', PRODUCTS_REPOSITORY_METHODS, {
  async listStorefront({ query: storefrontQuery, limit }) {
    const filterHash = storefrontFilterHash(storefrontQuery);
    const { clauses, params } = facetConditions(storefrontQuery);
    const where = ['p.is_active = 1', ...clauses];
    const values = [...params];

    const search = searchCondition(storefrontQuery.search, 'regex');
    where.push(...search.clauses);
    values.push(...search.params);

    if (storefrontQuery.cursor) {
      const cursor = decodeCursor(storefrontQuery.cursor, {
        sort: storefrontQuery.sort,
        filterHash,
      });
      const condition = cursorCondition(cursor);
      where.push(condition.clause);
      values.push(...condition.params);
    }

    const rows = await query(
      `${PRODUCT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${
        STOREFRONT_ORDER[storefrontQuery.sort]
      } LIMIT ?`,
      [...values, limit + 1],
    );

    return { records: rows.map(toRecord), fetched: rows.length };
  },

  async listAdmin(adminQuery) {
    const clauses = [];
    const params = [];

    const search = searchCondition(adminQuery.search, adminQuery.searchMode);
    clauses.push(...search.clauses);
    params.push(...search.params);

    if (adminQuery.isActive !== undefined) {
      clauses.push('p.is_active = ?');
      params.push(adminQuery.isActive ? 1 : 0);
    }

    const facets = facetConditions(adminQuery);
    clauses.push(...facets.clauses);
    params.push(...facets.params);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const offset = (adminQuery.page - 1) * adminQuery.limit;

    const [rows, countRows] = await Promise.all([
      query(
        `${PRODUCT_SELECT} ${where} ORDER BY ${adminOrderBy(adminQuery.sort)} LIMIT ? OFFSET ?`,
        [...params, adminQuery.limit, offset],
      ),
      query(`SELECT COUNT(*) AS total FROM products p ${where}`, params),
    ]);

    return { records: rows.map(toRecord), total: Number(countRows[0]?.total ?? 0) };
  },

  async findById(identifier) {
    return findRecord(identifier, { includeInactive: false });
  },

  async findAdminById(identifier) {
    return findRecord(identifier, { includeInactive: true });
  },

  async existsBySlug(slug, { excludeId } = {}) {
    return isSlugTaken(slug, { excludeId: assertCanonicalId(excludeId) });
  },

  async existsBySku(sku, { excludeId } = {}) {
    return isSkuTaken(sku, { excludeId: assertCanonicalId(excludeId) });
  },

  async allocateSku({ prefix, excludeId } = {}) {
    return createUniqueSku(isSkuTaken, { prefix, excludeId: assertCanonicalId(excludeId) });
  },

  async allocateSlug(text, options = {}) {
    return createUniqueSlug(isSlugTaken, text, {
      fallback: 'product',
      ...options,
      excludeId: assertCanonicalId(options.excludeId),
    });
  },

  async create({ payload, slugSource, skuPrefix, image, thumbnail }) {
    const record = await withDuplicateKeyRetry(async (attempt = 1) => {
      const slug = await createUniqueSlug(isSlugTaken, slugSource, {
        fallback: 'product',
        startIndex: 2 + (attempt - 1) * 4,
        randomizeAfter: 2,
      });
      const sku =
        payload.sku ?? (await createUniqueSku(isSkuTaken, { prefix: skuPrefix ?? 'product' }));
      const id = newObjectIdHex();
      const now = new Date();

      await query(
        `INSERT INTO products
           (id, title, slug, sku, price, stock, description, image, thumbnail,
            brand_id, category_id, is_active, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [
          id,
          String(payload.title).trim(),
          slug,
          normalizeSku(sku),
          roundPrice(payload.price),
          payload.stock,
          String(payload.description ?? '').trim(),
          image ?? '',
          thumbnail ?? '',
          payload.brand,
          payload.category,
          payload.isActive === false ? 0 : 1,
          now,
          now,
        ],
      );

      return findRecord(id, { includeInactive: true });
    });

    return record;
  },

  async replaceFields(id, payload, { partial = false, slugSource, image, thumbnail } = {}) {
    return withTransaction(async (connection) => {
      const [rows] = await connection.query(
        `SELECT id, title, slug, sku, price, stock, description, brand_id, category_id,
                image, thumbnail, is_active, version
           FROM products WHERE id = ? FOR UPDATE`,
        [id],
      );
      const current = rows[0];
      if (!current) return null;

      const currentVersion = Number(current.version ?? 0);
      if (payload.version !== currentVersion) {
        throw staleResource({
          providedVersion: payload.version,
          currentVersion,
        });
      }

      const previous = { image: current.image, thumbnail: current.thumbnail };
      const next = {
        title: current.title,
        slug: current.slug,
        sku: current.sku,
        price: current.price,
        stock: current.stock,
        description: current.description,
        brand_id: current.brand_id,
        category_id: current.category_id,
        is_active: current.is_active,
        // image/thumbnail are only replaced when a new upload was processed; the
        // stored values must still be written back (mysql2 turns `undefined` into
        // NULL, and the columns are NOT NULL).
        image: current.image,
        thumbnail: current.thumbnail,
      };

      if (partial) {
        if (payload.title !== undefined && payload.title !== current.title) {
          next.title = payload.title;
          next.slug = await createUniqueSlug(isSlugTaken, slugSource ?? payload.title, {
            excludeId: id,
            fallback: 'product',
          });
        }
        for (const [field, column] of [
          ['description', 'description'],
          ['price', 'price'],
          ['stock', 'stock'],
          ['brand', 'brand_id'],
          ['category', 'category_id'],
          ['sku', 'sku'],
        ]) {
          if (payload[field] !== undefined) next[column] = payload[field];
        }
        if (payload.isActive !== undefined) next.is_active = payload.isActive ? 1 : 0;
      } else {
        if (payload.title !== current.title) {
          next.slug = await createUniqueSlug(isSlugTaken, slugSource ?? payload.title, {
            excludeId: id,
            fallback: 'product',
          });
        }
        next.title = payload.title;
        next.description = payload.description;
        next.price = payload.price;
        next.stock = payload.stock;
        next.brand_id = payload.brand;
        next.category_id = payload.category;
        next.is_active = payload.isActive === false ? 0 : 1;
        if (payload.sku !== undefined) next.sku = payload.sku;
      }

      if (image !== undefined) {
        next.image = image;
        next.thumbnail = thumbnail ?? image;
      }

      // Guarded by version: a concurrent writer that committed between the SELECT
      // and this UPDATE makes affectedRows 0 → exactly the Mongoose VersionError.
      const [result] = await connection.query(
        `UPDATE products
            SET title = ?, slug = ?, sku = ?, price = ?, stock = ?, description = ?,
                image = ?, thumbnail = ?, brand_id = ?, category_id = ?, is_active = ?,
                version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?`,
        [
          String(next.title).trim(),
          next.slug,
          normalizeSku(next.sku),
          roundPrice(next.price),
          next.stock,
          String(next.description ?? '').trim(),
          next.image,
          next.thumbnail,
          next.brand_id,
          next.category_id,
          next.is_active,
          new Date(),
          id,
          currentVersion,
        ],
      );

      if (result.affectedRows === 0) {
        throw staleResource({ providedVersion: payload.version });
      }

      const record = await findRecord(id, { includeInactive: true }, async (sql, params) => {
        const [innerRows] = await connection.query(sql, params);
        return innerRows;
      });

      return { record, previous };
    });
  },

  /**
   * Atomic stock adjustment — one guarded UPDATE, so N concurrent decrements can
   * never oversell and no update is lost without multi-document transactions.
   */
  async updateStock(id, payload) {
    return withTransaction(async (connection) => {
      const now = new Date();

      if (payload.delta !== undefined) {
        const decrement = payload.delta < 0;
        const [result] = decrement
          ? await connection.query(
              `UPDATE products
                  SET stock = stock + ?, version = version + 1, updated_at = ?
                WHERE id = ? AND stock >= ?`,
              [payload.delta, now, id, Math.abs(payload.delta)],
            )
          : await connection.query(
              `UPDATE products
                  SET stock = stock + ?, version = version + 1, updated_at = ?
                WHERE id = ?`,
              [payload.delta, now, id],
            );

        if (result.affectedRows === 0) {
          const [existing] = await connection.query('SELECT stock FROM products WHERE id = ?', [
            id,
          ]);
          if (existing.length === 0) return null;
          return {
            record: null,
            insufficient: true,
            available: Number(existing[0].stock),
            requested: Math.abs(payload.delta),
          };
        }
      } else {
        const [result] = await connection.query(
          `UPDATE products
              SET stock = ?, version = version + 1, updated_at = ?
            WHERE id = ?`,
          [payload.stock, now, id],
        );
        if (result.affectedRows === 0) return null;
      }

      const record = await findRecord(id, { includeInactive: true }, async (sql, params) => {
        const [innerRows] = await connection.query(sql, params);
        return innerRows;
      });
      return { record, insufficient: false };
    });
  },

  async deleteById(id) {
    return withTransaction(async (connection) => {
      const [rows] = await connection.query(
        'SELECT id, title, image, thumbnail FROM products WHERE id = ? FOR UPDATE',
        [id],
      );
      const product = rows[0];
      if (!product) return null;

      await connection.query('DELETE FROM products WHERE id = ?', [id]);
      return {
        id: product.id,
        title: product.title,
        image: product.image,
        thumbnail: product.thumbnail,
      };
    });
  },

  async countByTaxonomy(field, ids) {
    if (ids.length === 0) return new Map();
    const column = field === 'category' ? 'category_id' : 'brand_id';
    const rows = await query(
      `SELECT ${column} AS taxonomy_id, COUNT(*) AS total, SUM(is_active = 1) AS active
         FROM products WHERE ${column} IN (${placeholders(ids.length)})
        GROUP BY ${column}`,
      ids.map(String),
    );
    return new Map(
      rows.map((row) => [
        row.taxonomy_id,
        { total: Number(row.total), active: Number(row.active) },
      ]),
    );
  },

  async collectReferencedImageFiles() {
    const rows = await query(
      "SELECT image, thumbnail FROM products WHERE image <> '' OR thumbnail <> ''",
    );
    const names = new Set();
    for (const row of rows) {
      for (const url of [row.image, row.thumbnail]) {
        if (url) names.add(url.split('/').pop());
      }
    }
    return names;
  },
});

export default productsRepository;
