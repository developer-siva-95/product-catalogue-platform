/**
 * Column mapping for the one-way MongoDB → MySQL data migration.
 *
 * This file is the *only* place that knows how a Mongo document becomes a MySQL
 * row. Keeping it declarative means the extractor, the validator, the writer and
 * the verifier cannot drift apart: they all transform through the same functions.
 *
 * Design rules (from the Phase 0 plan and the Section 10 criteria):
 *  - `_id` is preserved verbatim: a 24-character lowercase hex string becomes
 *    `CHAR(24) CHARACTER SET ascii COLLATE ascii_bin`, so ids, cursors and every
 *    API response that embeds an id stay valid after the switch;
 *  - absent/undefined optional fields become the column default rather than the
 *    string "undefined";
 *  - a missing or empty SKU becomes `NULL` — MySQL's UNIQUE treats NULLs as
 *    distinct, which is how the sparse unique index is reproduced;
 *  - dates are carried as `Date` objects (the pool runs `timezone: 'Z'`), so a
 *    DATETIME(3) round-trip is exact to the millisecond;
 *  - nothing is ever silently rounded: precision loss is a *finding* the caller
 *    must accept explicitly.
 */

/** Canonical id shape shared with `src/repositories/identifier.js`. */
export const CANONICAL_ID = /^[0-9a-f]{24}$/;

/** MySQL DATETIME bounds (the DATETIME type, not TIMESTAMP). */
export const DATETIME_MIN = Date.UTC(1000, 0, 1, 0, 0, 0, 0);
export const DATETIME_MAX = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** DECIMAL(12,2) bounds and scale. */
export const PRICE_SCALE = 2;
export const PRICE_MAX = 9_999_999_999.99;
export const PRICE_MIN = 0;

/** @param {unknown} value @returns {string} */
export function idOf(value) {
  if (value === null || value === undefined) return '';
  // Mongoose ObjectIds, plain 24-hex strings and `{ _id }` shapes all normalise.
  if (typeof value === 'object' && typeof value.toHexString === 'function') {
    return value.toHexString();
  }
  if (typeof value === 'object' && typeof value.toString === 'function') {
    return String(value.toString());
  }
  return String(value);
}

/** @param {unknown} value @param {string} fallback */
function text(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

/** @param {unknown} value @returns {number|null} */
function nullableText(value) {
  if (value === null || value === undefined) return null;
  const asText = String(value);
  return asText === '' ? null : asText;
}

/** @param {unknown} value @returns {0|1} */
function bit(value, fallback = true) {
  if (value === null || value === undefined) return fallback ? 1 : 0;
  return value ? 1 : 0;
}

/** @param {unknown} value @returns {Date|null} */
function nullableDate(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(/** @type {string} */ (value));
}

/**
 * Table specifications, in insert order (parents before children so foreign keys
 * never dangle mid-run).
 *
 * `columns` is the target column list; `row(doc)` produces the matching values in
 * the same order. `compare` normalises a stored value (from either driver) so the
 * verifier can compare source and target without caring which driver produced it.
 */
export const TABLES = [
  {
    collection: 'brands',
    table: 'brands',
    label: 'brands',
    requiredSource: ['name', 'slug'],
    references: [],
    uniques: [['name_normalized'], ['slug']],
    stringLimits: {
      name: 60,
      name_normalized: 60,
      slug: 80,
      description: 500,
      logo: 500,
    },
    columns: [
      'id',
      'name',
      'name_normalized',
      'slug',
      'description',
      'logo',
      'created_at',
      'updated_at',
    ],
    row: (doc) => ({
      id: idOf(doc._id),
      name: text(doc.name).trim(),
      name_normalized: text(doc.nameNormalized || doc.name)
        .trim()
        .toLowerCase(),
      slug: text(doc.slug).trim().toLowerCase(),
      description: text(doc.description),
      logo: text(doc.logo),
      created_at: nullableDate(doc.createdAt),
      updated_at: nullableDate(doc.updatedAt ?? doc.createdAt),
    }),
    dates: ['created_at', 'updated_at'],
    decimals: [],
    booleans: [],
  },
  {
    collection: 'categories',
    table: 'categories',
    label: 'categories',
    requiredSource: ['name', 'slug'],
    references: [],
    uniques: [['name_normalized'], ['slug']],
    stringLimits: {
      name: 60,
      name_normalized: 60,
      slug: 80,
      description: 500,
      image: 500,
    },
    columns: [
      'id',
      'name',
      'name_normalized',
      'slug',
      'description',
      'image',
      'created_at',
      'updated_at',
    ],
    // `image` is the one nullable text column (migration 002): Mongo's "key
    // absent" must stay distinguishable from the empty string.
    row: (doc) => ({
      id: idOf(doc._id),
      name: text(doc.name).trim(),
      name_normalized: text(doc.nameNormalized || doc.name)
        .trim()
        .toLowerCase(),
      slug: text(doc.slug).trim().toLowerCase(),
      description: text(doc.description),
      image: nullableText(doc.image),
      created_at: nullableDate(doc.createdAt),
      updated_at: nullableDate(doc.updatedAt ?? doc.createdAt),
    }),
    dates: ['created_at', 'updated_at'],
    decimals: [],
    booleans: [],
  },
  {
    collection: 'products',
    table: 'products',
    label: 'products',
    requiredSource: ['title', 'slug', 'price', 'stock', 'description', 'brand', 'category'],
    references: [
      { column: 'brand_id', table: 'brands' },
      { column: 'category_id', table: 'categories' },
    ],
    uniques: [['slug'], ['sku']],
    stringLimits: {
      title: 160,
      slug: 200,
      sku: 64,
      description: 5000,
      image: 500,
      thumbnail: 500,
    },
    columns: [
      'id',
      'title',
      'slug',
      'sku',
      'price',
      'stock',
      'description',
      'image',
      'thumbnail',
      'brand_id',
      'category_id',
      'is_active',
      'version',
      'created_at',
      'updated_at',
    ],
    row: (doc) => ({
      id: idOf(doc._id),
      title: text(doc.title).trim(),
      slug: text(doc.slug).trim().toLowerCase(),
      // Empty/missing SKU → NULL (sparse unique).
      sku: nullableText(doc.sku) === null ? null : text(doc.sku).trim().toUpperCase(),
      price: doc.price,
      stock: doc.stock,
      description: text(doc.description),
      image: text(doc.image),
      thumbnail: text(doc.thumbnail),
      brand_id: idOf(doc.brand),
      category_id: idOf(doc.category),
      is_active: bit(doc.isActive),
      version: Number.isFinite(doc.__v) ? doc.__v : 0,
      created_at: nullableDate(doc.createdAt),
      updated_at: nullableDate(doc.updatedAt ?? doc.createdAt),
    }),
    dates: ['created_at', 'updated_at'],
    decimals: ['price'],
    booleans: ['is_active'],
  },
  {
    collection: 'users',
    table: 'users',
    label: 'users',
    requiredSource: ['name', 'email', 'passwordHash'],
    references: [],
    uniques: [['email']],
    stringLimits: { name: 80, email: 254, password_hash: 100, role: 20 },
    columns: [
      'id',
      'name',
      'email',
      'password_hash',
      'role',
      'is_active',
      'must_change_password',
      'password_changed_at',
      'token_version',
      'login_attempts',
      'lock_until',
      'last_login_at',
      'created_at',
      'updated_at',
    ],
    row: (doc) => ({
      id: idOf(doc._id),
      name: text(doc.name).trim(),
      email: text(doc.email).trim().toLowerCase(),
      password_hash: text(doc.passwordHash),
      role: text(doc.role, 'customer'),
      is_active: bit(doc.isActive),
      must_change_password: bit(doc.mustChangePassword, false),
      password_changed_at: nullableDate(doc.passwordChangedAt),
      token_version: Number.isFinite(doc.tokenVersion) ? doc.tokenVersion : 0,
      login_attempts: Number.isFinite(doc.loginAttempts) ? doc.loginAttempts : 0,
      lock_until: nullableDate(doc.lockUntil),
      last_login_at: nullableDate(doc.lastLoginAt),
      created_at: nullableDate(doc.createdAt),
      updated_at: nullableDate(doc.updatedAt ?? doc.createdAt),
    }),
    dates: ['created_at', 'updated_at', 'password_changed_at', 'lock_until', 'last_login_at'],
    decimals: [],
    booleans: ['is_active', 'must_change_password'],
  },
];

/** @param {string} collection @returns {object|undefined} */
export function tableFor(collection) {
  return TABLES.find((spec) => spec.collection === collection);
}

/**
 * Normalises one value for comparison, so the verifier can compare a Mongo
 * document against a MySQL row without caring which driver produced it.
 *
 * @param {unknown} value
 * @param {'date'|'decimal'|'boolean'|'text'|'int'} kind
 * @returns {string|number|boolean|null}
 */
export function normaliseForComparison(value, kind) {
  if (value === null || value === undefined) return null;
  if (kind === 'date') {
    const date = value instanceof Date ? value : new Date(/** @type {string} */ (value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (kind === 'decimal') return Math.round(Number(value) * 100) / 100;
  if (kind === 'boolean') return Boolean(Number(value));
  if (kind === 'int') return Number(value);
  return String(value);
}
