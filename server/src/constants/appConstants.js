/**
 * Application-wide tunables and domain constants.
 * Anything a reviewer might want to change without touching business logic
 * lives here so that limits are discoverable and testable.
 */

export const ROLES = Object.freeze({
  ADMIN: 'admin',
  CUSTOMER: 'customer',
});

export const ALL_ROLES = Object.freeze([ROLES.ADMIN, ROLES.CUSTOMER]);

/** API surface */
export const API_PREFIX = '/api/v1';

/** Auth */
export const COOKIE_NAMES = Object.freeze({
  ACCESS_TOKEN: 'access_token',
  CSRF_TOKEN: 'csrf_token',
});

/** Centrally defined password policy, reused by Zod and the seed script. */
export const PASSWORD_POLICY = Object.freeze({
  MIN_LENGTH: 10,
  MAX_LENGTH: 128,
  // At least one lower, one upper, one digit and one symbol.
  PATTERN: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/,
  DESCRIPTION:
    'Password must be 10-128 characters and include an uppercase letter, a lowercase letter, a number and a symbol.',
});

/** Pagination: offset (admin) */
export const PAGINATION = Object.freeze({
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
});

/** Pagination: cursor (storefront) */
export const CURSOR_PAGINATION = Object.freeze({
  DEFAULT_LIMIT: 12,
  MAX_LIMIT: 48,
});

/** Storefront sort strategies — the single source of truth for sort + cursor shape. */
export const PRODUCT_SORT = Object.freeze({
  NEWEST: 'newest',
  PRICE_ASC: 'price_asc',
  PRICE_DESC: 'price_desc',
});

export const PRODUCT_SORTS = Object.freeze(Object.values(PRODUCT_SORT));

/**
 * Sort contract per strategy.
 * `direction` is used both for the Mongo sort spec and for choosing the correct
 * cursor comparison operators, which is what keeps cursor pages gap-free.
 */
export const PRODUCT_SORT_SPECS = Object.freeze({
  [PRODUCT_SORT.NEWEST]: Object.freeze({
    keys: ['_id'],
    direction: { _id: -1 },
    cursorFields: ['_id'],
    compound: false,
  }),
  [PRODUCT_SORT.PRICE_ASC]: Object.freeze({
    keys: ['price', '_id'],
    direction: { price: 1, _id: 1 },
    cursorFields: ['price', '_id'],
    compound: true,
  }),
  [PRODUCT_SORT.PRICE_DESC]: Object.freeze({
    keys: ['price', '_id'],
    direction: { price: -1, _id: -1 },
    cursorFields: ['price', '_id'],
    compound: true,
  }),
});

/** Product domain limits */
export const PRODUCT_LIMITS = Object.freeze({
  TITLE_MAX: 160,
  DESCRIPTION_MAX: 5000,
  PRICE_MIN: 0,
  PRICE_MAX: 1_000_000_000,
  STOCK_MAX: 1_000_000,
});

/** Brand / Category limits */
export const TAXONOMY_LIMITS = Object.freeze({
  NAME_MIN: 2,
  NAME_MAX: 60,
  DESCRIPTION_MAX: 500,
});

/** Uploads */
export const UPLOAD = Object.freeze({
  FIELD_NAME: 'image',
  DIRECTORY: 'products',
  MAX_BYTES: 5 * 1024 * 1024,
  // Decoding bombs: refuse pixel counts beyond this before/while processing.
  MAX_INPUT_PIXELS: 40_000_000,
  MIN_WIDTH: 100,
  MIN_HEIGHT: 100,
  MAIN_MAX_WIDTH: 1200,
  MAIN_MAX_HEIGHT: 1200,
  THUMB_WIDTH: 300,
  THUMB_HEIGHT: 300,
  ALLOWED_MIME_TYPES: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
  ALLOWED_OUTPUT_FORMATS: Object.freeze(['image/webp', 'image/jpeg']),
  QUALITY: 82,
  THUMB_QUALITY: 75,
  THUMB_SUFFIX: '-thumb',
});

/** Rate limiting */
export const RATE_LIMITS = Object.freeze({
  WINDOW_MS: 15 * 60 * 1000,
  MAX: 300,
  LOGIN_WINDOW_MS: 15 * 60 * 1000,
  LOGIN_MAX: 10,
});

/** Misc */
export const BODY_SIZE_LIMIT = '1mb';
export const JSON_BODY_SIZE_LIMIT = '100kb';
export const BCRYPT_SALT_ROUNDS = 12;
export const DEFAULT_ADMIN = Object.freeze({
  email: 'admin@catalogue.com',
  password: 'Admin123!',
  name: 'Catalogue Administrator',
});

/** Seeds are only ever allowed to run against local/dev databases. */
export const PROTECTED_ENVIRONMENTS = Object.freeze(['production']);
