/**
 * API contract snapshot harness.
 *
 * Boots the real Express app against an ephemeral MongoDB, seeds a fully
 * deterministic fixture set (fixed 24-hex ids, fixed timestamps), then records for
 * every endpoint and error path: status, content-type, the response JSON **text**
 * (so key order is compared, not just values) and a recursive type map.
 *
 *   node audit/api-contract-snapshot.mjs --out /opt/snapshots/before.json
 *   node audit/api-contract-diff.mjs before.json after.json
 *
 * Only genuinely non-deterministic values are masked (request id, uptime, CSRF
 * token, the login instant, stack traces, ids minted during the run). Everything
 * else — including key order, numeric formatting and date formatting — must match
 * byte for byte between runs and between providers.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? null : process.argv[outIndex + 1];
if (!OUT) {
  console.error('usage: node audit/api-contract-snapshot.mjs --out <file.json>');
  process.exit(2);
}

// Same default as the application (src/config/env.js): MySQL. A missing variable must
// never silently snapshot MongoDB. CI passes the provider explicitly for both runs.
const PROVIDER = (process.env.DATABASE_PROVIDER ?? 'mysql').trim().toLowerCase();
if (!['mongodb', 'mysql'].includes(PROVIDER)) {
  console.error(
    `usage: DATABASE_PROVIDER=mongodb|mysql node audit/api-contract-snapshot.mjs --out <file>`,
  );
  process.exit(2);
}

process.env.NODE_ENV = 'test';
process.env.PORT = '5098';
process.env.DATABASE_PROVIDER = PROVIDER;
process.env.JWT_SECRET = 'contract-snapshot-secret-3f8a1c9d2b7e4f6a8c0d1e3f5a7b9c2d';
process.env.JWT_EXPIRES_IN = '1h';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.COOKIE_SECURE = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.RATE_LIMIT_MAX = '10000';
process.env.LOGIN_RATE_LIMIT_MAX = '10000';
process.env.UPLOAD_DIR = '/tmp/contract-snapshot-uploads';

/**
 * Both providers are driven through the *same* request recorder below; only the
 * bootstrap and the fixture inserts differ. That is what makes the diff between
 * the two snapshot files a statement about the API, not about the harness.
 */
let mongoose = null;
let memory = null;
let cleanupDatabase = async () => {};

if (PROVIDER === 'mongodb') {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  memory = await MongoMemoryServer.create({
    instance: { dbName: 'contract_snapshot' },
    binary: { version: process.env.MONGOMS_VERSION ?? '7.0.14' },
  });
  process.env.MONGO_URI = memory.getUri('contract_snapshot');

  ({ mongoose } = await import('mongoose'));
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: true });

  cleanupDatabase = async () => {
    await mongoose.disconnect();
    await memory.stop({ doCleanup: true, force: true });
  };
} else {
  // MySQL: credentials are never committed, so they arrive through MYSQL_TEST_*.
  const required = ['MYSQL_TEST_USER', 'MYSQL_TEST_DATABASE'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(
      `DATABASE_PROVIDER=mysql requires ${missing.join(', ')} ` +
        '(e.g. MYSQL_TEST_USER=storefront_migrator MYSQL_TEST_DATABASE=storefront_it_test).',
    );
    process.exit(2);
  }
  process.env.MYSQL_HOST = process.env.MYSQL_TEST_HOST ?? '127.0.0.1';
  process.env.MYSQL_PORT = process.env.MYSQL_TEST_PORT ?? '3306';
  process.env.MYSQL_USER = process.env.MYSQL_TEST_USER;
  process.env.MYSQL_PASSWORD = process.env.MYSQL_TEST_PASSWORD ?? '';
  process.env.MYSQL_DATABASE = process.env.MYSQL_TEST_DATABASE;
  process.env.ALLOW_DESTRUCTIVE_MIGRATIONS = 'true';

  const { resetMysqlSchema } = await import('../server/tests/helpers/mysql-db.js');
  const { connectDatabase, disconnectDatabase } = await import('../server/src/db/index.js');
  await resetMysqlSchema();
  await connectDatabase();

  cleanupDatabase = async () => {
    await disconnectDatabase();
  };
}

const { createApp } = await import('../server/src/app.js');
const { resetAllRateLimits } = await import('../server/src/middlewares/rateLimiter.js');
const { createClient } = await import('../server/tests/helpers/auth.js');

// ---------------------------------------------------------------- fixtures
const BRAND_A = '650000000000000000000001';
const BRAND_B = '650000000000000000000002';
const CAT_A = '651000000000000000000001';
const CAT_B = '651000000000000000000002';
const productId = (n) => `65a00000000000000000000${n}`;
const FIXED_IDS = new Set([
  BRAND_A,
  BRAND_B,
  CAT_A,
  CAT_B,
  ...[1, 2, 3, 4, 5, 6].map(productId),
  '652000000000000000000001',
  '652000000000000000000002',
]);

const ts = (day, hour = 12) => new Date(Date.UTC(2026, 0, day, hour, 0, 0, 0));

function productDoc({ n, title, price, stock, sku, brand, category, isActive = true, day }) {
  return {
    _id: new mongoose.Types.ObjectId(productId(n)),
    title,
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    ...(sku ? { sku } : {}),
    price,
    stock,
    description: `${title} description`,
    image: '/uploads/placeholder.svg',
    thumbnail: '/uploads/placeholder-thumb.svg',
    brand: new mongoose.Types.ObjectId(brand),
    category: new mongoose.Types.ObjectId(category),
    isActive,
    createdAt: ts(day),
    updatedAt: ts(day),
    __v: 0,
  };
}

const password = 'Adm1n!Passw0rd';

/** MongoDB fixtures. */
async function seedMongoFixtures() {
  const { User } = await import('../server/src/modules/auth/model.js');
  const { Product } = await import('../server/src/modules/products/model.js');
  const { Brand } = await import('../server/src/modules/brands/model.js');
  const { Category } = await import('../server/src/modules/categories/model.js');
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }

  await Brand.collection.insertMany([
    {
      _id: new mongoose.Types.ObjectId(BRAND_A),
      name: 'Acme',
      nameNormalized: 'acme',
      slug: 'acme',
      description: 'Acme brand',
      logo: '',
      createdAt: ts(1),
      updatedAt: ts(1),
    },
    {
      _id: new mongoose.Types.ObjectId(BRAND_B),
      name: 'Bravo',
      nameNormalized: 'bravo',
      slug: 'bravo',
      description: '',
      logo: '',
      createdAt: ts(2),
      updatedAt: ts(2),
    },
  ]);

  await Category.collection.insertMany([
    {
      _id: new mongoose.Types.ObjectId(CAT_A),
      name: 'Footwear',
      nameNormalized: 'footwear',
      slug: 'footwear',
      description: 'Shoes',
      image: '',
      createdAt: ts(1),
      updatedAt: ts(1),
    },
    {
      _id: new mongoose.Types.ObjectId(CAT_B),
      name: 'Accessories',
      nameNormalized: 'accessories',
      slug: 'accessories',
      description: '',
      image: '',
      createdAt: ts(2),
      updatedAt: ts(2),
    },
  ]);

  await Product.collection.insertMany([
    productDoc({
      n: 1,
      title: 'Alpha Sneaker',
      price: 19.99,
      stock: 10,
      sku: 'ACM-001',
      brand: BRAND_A,
      category: CAT_A,
      day: 1,
    }),
    productDoc({
      n: 2,
      title: 'alpha runner',
      price: 100,
      stock: 3,
      sku: 'ACM-002',
      brand: BRAND_A,
      category: CAT_A,
      day: 2,
    }),
    productDoc({
      n: 3,
      title: 'Beta Boot',
      price: 250.5,
      stock: 0,
      sku: 'BRV-001',
      brand: BRAND_B,
      category: CAT_A,
      day: 3,
    }),
    productDoc({
      n: 4,
      title: 'Gamma Sandal',
      price: 1000,
      stock: 5,
      sku: 'BRV-002',
      brand: BRAND_B,
      category: CAT_B,
      day: 4,
    }),
    productDoc({
      n: 5,
      title: 'Delta Cap',
      price: 5.25,
      stock: 25,
      brand: BRAND_A,
      category: CAT_B,
      day: 5,
    }),
    productDoc({
      n: 6,
      title: 'Epsilon Belt',
      price: 300,
      stock: 0,
      sku: 'BRV-003',
      brand: BRAND_B,
      category: CAT_B,
      isActive: false,
      day: 6,
    }),
  ]);

  const password = 'Adm1n!Passw0rd';
  const userDocs = [
    {
      id: '652000000000000000000001',
      name: 'Snapshot Admin',
      email: 'admin@test.local',
      role: 'admin',
    },
    {
      id: '652000000000000000000002',
      name: 'Snapshot Customer',
      email: 'customer@test.local',
      role: 'customer',
    },
  ];
  for (const user of userDocs) {
    await User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(user.id),
      name: user.name,
      email: user.email,
      passwordHash: await User.hashPassword(password),
      role: user.role,
      isActive: true,
      mustChangePassword: false,
      tokenVersion: 0,
      failedLoginAttempts: 0,
      lockedUntil: null,
      createdAt: ts(1),
      updatedAt: ts(1),
      __v: 0,
    });
  }
}

/**
 * MySQL fixtures — semantically identical to the MongoDB ones above: same fixed
 * ids, same timestamps, same slugs/SKUs, same "no SKU" product, same inactive
 * product, and the two categories intentionally carry `image = ''` because the
 * MongoDB fixtures insert that key explicitly.
 *
 * There is deliberately no orphan product here: MySQL enforces
 * `product_brand_fk`, so a product pointing at a non-existent brand cannot exist.
 * (The sweep endpoint only reports orphaned *image files*, so its response is
 * unaffected — see the P4 report.)
 */
async function seedMysqlFixtures() {
  const bcrypt = (await import('bcrypt')).default;
  const { BCRYPT_SALT_ROUNDS } = await import('../server/src/constants/appConstants.js');
  const { query } = await import('../server/src/db/mysql/pool.js');

  const passwordHash = await bcrypt.hash('Adm1n!Passw0rd', BCRYPT_SALT_ROUNDS);

  for (const brand of [
    { id: BRAND_A, name: 'Acme', description: 'Acme brand', day: 1 },
    { id: BRAND_B, name: 'Bravo', description: '', day: 2 },
  ]) {
    await query(
      `INSERT INTO brands (id, name, name_normalized, slug, description, logo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
      [
        brand.id,
        brand.name,
        brand.name.toLowerCase(),
        brand.name.toLowerCase(),
        brand.description,
        ts(brand.day),
        ts(brand.day),
      ],
    );
  }

  for (const category of [
    { id: CAT_A, name: 'Footwear', description: 'Shoes', image: '', day: 1 },
    { id: CAT_B, name: 'Accessories', description: '', image: '', day: 2 },
  ]) {
    await query(
      `INSERT INTO categories
         (id, name, name_normalized, slug, description, image, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        category.id,
        category.name,
        category.name.toLowerCase(),
        category.name.toLowerCase(),
        category.description,
        category.image,
        ts(category.day),
        ts(category.day),
      ],
    );
  }

  const products = [
    {
      n: 1,
      title: 'Alpha Sneaker',
      price: 19.99,
      stock: 10,
      sku: 'ACM-001',
      brand: BRAND_A,
      category: CAT_A,
      day: 1,
    },
    {
      n: 2,
      title: 'alpha runner',
      price: 100,
      stock: 3,
      sku: 'ACM-002',
      brand: BRAND_A,
      category: CAT_A,
      day: 2,
    },
    {
      n: 3,
      title: 'Beta Boot',
      price: 250.5,
      stock: 0,
      sku: 'BRV-001',
      brand: BRAND_B,
      category: CAT_A,
      day: 3,
    },
    {
      n: 4,
      title: 'Gamma Sandal',
      price: 1000,
      stock: 5,
      sku: 'BRV-002',
      brand: BRAND_B,
      category: CAT_B,
      day: 4,
    },
    { n: 5, title: 'Delta Cap', price: 5.25, stock: 25, brand: BRAND_A, category: CAT_B, day: 5 },
    {
      n: 6,
      title: 'Epsilon Belt',
      price: 300,
      stock: 0,
      sku: 'BRV-003',
      brand: BRAND_B,
      category: CAT_B,
      isActive: false,
      day: 6,
    },
  ];

  for (const product of products) {
    await query(
      `INSERT INTO products
         (id, title, slug, sku, price, stock, description, image, thumbnail,
          brand_id, category_id, is_active, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '/uploads/placeholder.svg', '/uploads/placeholder-thumb.svg',
               ?, ?, ?, 0, ?, ?)`,
      [
        productId(product.n),
        product.title,
        product.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        product.sku ?? null,
        product.price,
        product.stock,
        `${product.title} description`,
        product.brand,
        product.category,
        product.isActive === false ? 0 : 1,
        ts(product.day),
        ts(product.day),
      ],
    );
  }

  for (const user of [
    {
      id: '652000000000000000000001',
      name: 'Snapshot Admin',
      email: 'admin@test.local',
      role: 'admin',
    },
    {
      id: '652000000000000000000002',
      name: 'Snapshot Customer',
      email: 'customer@test.local',
      role: 'customer',
    },
  ]) {
    await query(
      `INSERT INTO users
         (id, name, email, password_hash, role, is_active, must_change_password,
          password_changed_at, token_version, login_attempts, lock_until, last_login_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, NULL, 0, 0, NULL, NULL, ?, ?)`,
      [user.id, user.name, user.email, passwordHash, user.role, ts(1), ts(1)],
    );
  }
}

if (PROVIDER === 'mongodb') {
  await seedMongoFixtures();
} else {
  await seedMysqlFixtures();
}

// ---------------------------------------------------------------- recorder
const app = createApp();
resetAllRateLimits();
const guest = createClient(app);
const admin = createClient(app);
const customer = createClient(app);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX24_RE = /\b[0-9a-f]{24}\b/gi;
const ISO_RE = /"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g;

const entries = [];

/**
 * @param {string} label
 * @param {object} response supertest response
 * @param {{ generatedIds?: boolean, timestamps?: boolean, cursors?: boolean }} [masks]
 */
function record(label, response, masks = {}) {
  let text = response.text ?? JSON.stringify(response.body ?? {});
  text = text
    .replace(UUID_RE, '<uuid>')
    .replace(/"csrfToken":\s*"[^"]*"/g, '"csrfToken":"<csrf-token>"')
    .replace(/"stack":\s*"(?:[^"\\]|\\.)*"/g, '"stack":"<stack>"')
    .replace(/"(uptimeSeconds|uptime|timestamp)":\s*("?[^",}]*"?)/g, '"$1":<volatile>');

  if (masks.generatedIds) {
    text = text.replace(HEX24_RE, (match) =>
      FIXED_IDS.has(match.toLowerCase()) ? match : '<generated-id>',
    );
  }
  if (masks.timestamps) text = text.replace(ISO_RE, '"<iso>"');
  if (masks.cursors || masks.generatedIds)
    text = text.replace(/"nextCursor":\s*"[^"]*"/g, '"nextCursor":"<cursor>"');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  entries.push({
    label,
    status: response.status,
    contentType: response.headers['content-type'] ?? null,
    wire: text,
    shape: parsed === null ? null : shapeOf(parsed),
  });
}

function shapeOf(value) {
  if (Array.isArray(value)) return { type: 'array', items: value.map(shapeOf) };
  if (value === null) return { type: 'null' };
  if (typeof value !== 'object') return { type: typeof value };
  return {
    type: 'object',
    keys: Object.keys(value),
    fields: Object.fromEntries(Object.entries(value).map(([key, val]) => [key, shapeOf(val)])),
  };
}

// ---------------------------------------------------------------- requests
// -- public catalogue
record('health', await guest.get('/api/v1/health'));
record('products.default', await guest.get('/api/v1/products'));
record('products.limit_1', await guest.get('/api/v1/products?limit=1'));
record('products.limit_max', await guest.get('/api/v1/products?limit=48'));
record('products.limit_zero', await guest.get('/api/v1/products?limit=0'));
record('products.limit_over_max', await guest.get('/api/v1/products?limit=999'));
record('products.sort_price_asc', await guest.get('/api/v1/products?limit=4&sort=price_asc'));
record('products.sort_price_desc', await guest.get('/api/v1/products?limit=4&sort=price_desc'));
record('products.sort_invalid', await guest.get('/api/v1/products?sort=bogus'));
record('products.search', await guest.get('/api/v1/products?limit=5&search=alpha'));
record('products.search_regex_chars', await guest.get('/api/v1/products?search=.*'));
record('products.price_range', await guest.get('/api/v1/products?minPrice=100&maxPrice=300'));
record('products.brand_filter', await guest.get(`/api/v1/products?brand=${BRAND_A}`));
record('products.category_filter', await guest.get(`/api/v1/products?category=${CAT_B}`));
record(
  'products.combined_filters',
  await guest.get(
    `/api/v1/products?brand=${BRAND_B}&category=${CAT_B}&minPrice=1&maxPrice=2000&search=b`,
  ),
);

const firstPage = await guest.get('/api/v1/products?limit=2');
record('products.page1', firstPage);
const nextCursor = firstPage.body.meta.nextCursor;
record('products.page2', await guest.get(`/api/v1/products?limit=2&cursor=${nextCursor}`));
record('products.cursor_garbage', await guest.get('/api/v1/products?cursor=garbage'));
record(
  'products.cursor_sort_mismatch',
  await guest.get(`/api/v1/products?sort=price_asc&cursor=${nextCursor}`),
);
record(
  'products.cursor_filter_mismatch',
  await guest.get(`/api/v1/products?search=alpha&cursor=${nextCursor}`),
);

record('product.detail_id', await guest.get(`/api/v1/products/${productId(1)}`));
record('product.detail_slug', await guest.get('/api/v1/products/alpha-sneaker'));
record('product.detail_no_sku', await guest.get(`/api/v1/products/${productId(5)}`));
record('product.detail_inactive', await guest.get(`/api/v1/products/${productId(6)}`));
record('product.detail_missing', await guest.get('/api/v1/products/000000000000000000000000'));
record('product.detail_malformed', await guest.get('/api/v1/products/not-an-id'));

record('brands.list', await guest.get('/api/v1/brands'));
record('brands.search', await guest.get('/api/v1/brands?search=acm'));
record('brands.sort_desc', await guest.get('/api/v1/brands?sort=-name'));
record('brand.detail_id', await guest.get(`/api/v1/brands/${BRAND_A}`));
record('brand.detail_slug', await guest.get('/api/v1/brands/acme'));
record('brand.detail_missing', await guest.get('/api/v1/brands/000000000000000000000000'));

record('categories.list', await guest.get('/api/v1/categories'));
record('category.detail_id', await guest.get(`/api/v1/categories/${CAT_A}`));
record('category.detail_missing', await guest.get('/api/v1/categories/000000000000000000000000'));
record('route_not_found', await guest.get('/api/v1/does-not-exist'));

// -- auth
record('auth.csrf', await guest.get('/api/v1/auth/csrf'));
record('auth.login_wrong_password', await guest.login('admin@test.local', 'WrongPassword1!'));
record('auth.login_validation', await guest.post('/api/v1/auth/login', { email: 'nope' }));
record('auth.login_unknown_user', await guest.login('ghost@test.local', 'Adm1n!Passw0rd'));
record('auth.me_unauthorised', await guest.get('/api/v1/auth/me'));
record('admin.list_unauthorised', await guest.get('/api/v1/admin/products'));

record('auth.login_admin', await admin.login('admin@test.local', password), { timestamps: true });
record('auth.me_admin', await admin.get('/api/v1/auth/me'), { timestamps: true });
record('auth.login_customer', await customer.login('customer@test.local', password), {
  timestamps: true,
});
record('admin.list_forbidden_customer', await customer.get('/api/v1/admin/products'));

// -- admin reads
record('admin.list', await admin.get('/api/v1/admin/products?page=1&limit=3'));
record('admin.list_page2', await admin.get('/api/v1/admin/products?page=2&limit=3'));
record('admin.list_beyond_end', await admin.get('/api/v1/admin/products?page=50&limit=3'));
record('admin.list_search_regex', await admin.get('/api/v1/admin/products?search=alpha'));
record(
  'admin.list_search_text',
  await admin.get('/api/v1/admin/products?search=sneaker&searchMode=text'),
);
record('admin.list_inactive_only', await admin.get('/api/v1/admin/products?isActive=false'));
record('admin.list_brand_filter', await admin.get(`/api/v1/admin/products?brand=${BRAND_A}`));
record('admin.list_sort_price', await admin.get('/api/v1/admin/products?sort=price&limit=3'));
record('admin.list_sort_price_desc', await admin.get('/api/v1/admin/products?sort=-price&limit=3'));
record('admin.list_page_zero', await admin.get('/api/v1/admin/products?page=0'));
record('admin.detail', await admin.get(`/api/v1/admin/products/${productId(1)}`));
record('admin.detail_inactive', await admin.get(`/api/v1/admin/products/${productId(6)}`));
record('admin.detail_missing', await admin.get('/api/v1/admin/products/000000000000000000000000'));
record('admin.detail_malformed', await admin.get('/api/v1/admin/products/not-an-id'));

// -- admin writes: products
const createPayload = {
  title: 'Snapshot Created Product',
  description: 'Created by the contract snapshot harness',
  price: 42.5,
  stock: 7,
  brand: BRAND_A,
  category: CAT_A,
  sku: 'SNAP-001',
};
record('admin.create', await admin.post('/api/v1/admin/products', createPayload), {
  generatedIds: true,
  timestamps: true,
});
record('admin.create_duplicate_sku', await admin.post('/api/v1/admin/products', createPayload), {
  generatedIds: true,
});
record(
  'admin.create_validation',
  await admin.post('/api/v1/admin/products', {
    title: 'x',
    price: -5,
    stock: 1.5,
    description: '',
    brand: 'nope',
    category: CAT_A,
  }),
);
record(
  'admin.create_unknown_brand',
  await admin.post('/api/v1/admin/products', {
    title: 'Unknown Brand Product',
    description: 'Reference validation',
    price: 5,
    stock: 1,
    brand: '6500000000000000000000ff',
    category: CAT_A,
  }),
);
record(
  'admin.create_unknown_category',
  await admin.post('/api/v1/admin/products', {
    title: 'Unknown Category Product',
    description: 'Reference validation',
    price: 5,
    stock: 1,
    brand: BRAND_A,
    category: '6510000000000000000000ff',
  }),
);

record(
  'admin.patch',
  await admin.patch(`/api/v1/admin/products/${productId(2)}`, { price: 111.11, version: 0 }),
  {
    timestamps: true,
  },
);
record(
  'admin.patch_stale_version',
  await admin.patch(`/api/v1/admin/products/${productId(2)}`, { price: 222.22, version: 99 }),
);
record(
  'admin.put',
  await admin.put(`/api/v1/admin/products/${productId(3)}`, {
    title: 'Beta Boot Revised',
    description: 'Full replacement',
    price: 260,
    stock: 4,
    brand: BRAND_B,
    category: CAT_A,
    sku: 'BRV-001',
    isActive: true,
    version: 0,
  }),
  { timestamps: true },
);
record(
  'admin.put_missing',
  await admin.put('/api/v1/admin/products/000000000000000000000000', {
    title: 'Missing Product',
    description: 'Full replacement',
    price: 1,
    stock: 1,
    brand: BRAND_A,
    category: CAT_A,
    version: 0,
  }),
);
record(
  'admin.stock_delta',
  await admin.patch(`/api/v1/admin/products/${productId(5)}/stock`, { delta: -3 }),
  {
    timestamps: true,
  },
);
record(
  'admin.stock_absolute',
  await admin.patch(`/api/v1/admin/products/${productId(5)}/stock`, { stock: 12 }),
  {
    timestamps: true,
  },
);
record(
  'admin.stock_overdraw',
  await admin.patch(`/api/v1/admin/products/${productId(1)}/stock`, { delta: -999 }),
);
record(
  'admin.stock_both_fields',
  await admin.patch(`/api/v1/admin/products/${productId(1)}/stock`, { delta: 1, stock: 2 }),
);
record(
  'admin.stock_missing_product',
  await admin.patch('/api/v1/admin/products/000000000000000000000000/stock', { delta: 1 }),
);

// -- admin writes: taxonomy
record('admin.brand_create', await admin.post('/api/v1/brands', { name: 'Snapshot Brand' }), {
  generatedIds: true,
  timestamps: true,
});
record('admin.brand_create_duplicate', await admin.post('/api/v1/brands', { name: 'Acme' }));
record(
  'admin.brand_update_missing',
  await admin.put('/api/v1/brands/000000000000000000000000', { name: 'Ghost' }),
);
record('admin.brand_delete_in_use', await admin.del(`/api/v1/brands/${BRAND_A}`));
record(
  'admin.category_create',
  await admin.post('/api/v1/categories', { name: 'Snapshot Category' }),
  {
    generatedIds: true,
    timestamps: true,
  },
);
record(
  'admin.category_create_duplicate',
  await admin.post('/api/v1/categories', { name: 'Footwear' }),
);
record('admin.category_delete_in_use', await admin.del(`/api/v1/categories/${CAT_A}`));

// -- orphan sweep (an orphan can only exist where there are no foreign keys)
if (PROVIDER === 'mongodb') {
  const { Product } = await import('../server/src/modules/products/model.js');
  await Product.collection.insertOne({
    _id: new mongoose.Types.ObjectId('65a0000000000000000000ff'),
    title: 'Orphan Product',
    slug: 'orphan-product',
    sku: 'ORP-001',
    price: 1,
    stock: 1,
    description: 'No brand or category document exists for this product',
    image: '',
    thumbnail: '',
    brand: new mongoose.Types.ObjectId('6500000000000000000000aa'),
    category: new mongoose.Types.ObjectId('6510000000000000000000aa'),
    isActive: true,
    createdAt: ts(7),
    updatedAt: ts(7),
    __v: 0,
  });
}
record('admin.sweep_orphans', await admin.post('/api/v1/admin/products/maintenance/sweep-orphans'));

// -- deletes last, so they cannot disturb the reads above
record('admin.delete', await admin.del(`/api/v1/admin/products/${productId(6)}`));
record('admin.delete_missing', await admin.del('/api/v1/admin/products/000000000000000000000000'));

// ---------------------------------------------------------------- output
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      provider: process.env.DATABASE_PROVIDER,
      node: process.version,
      entries,
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${entries.length} contract snapshots to ${OUT} (provider: ${PROVIDER})`);
await cleanupDatabase();
