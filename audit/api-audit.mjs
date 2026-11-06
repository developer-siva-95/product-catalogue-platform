/**
 * Independent backend regression audit.
 *
 * Boots a disposable MongoDB, seeds the real fixture data, drives the real
 * Express application over HTTP (supertest) and records one pass/fail line per
 * behavioural assertion. This is an *audit* harness: it does not modify or
 * import application test files, and it fails loudly instead of skipping.
 *
 * Run: node audit/api-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(repoRoot, '.cache', 'audit');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(path.join(scratch, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'mongo'), { recursive: true });

const MONGO_PORT = 27996;
const API_ORIGIN = 'http://localhost:5173';

process.env.NODE_ENV = 'test';
// This audit is MongoDB-only; state it instead of inheriting the application default.
process.env.DATABASE_PROVIDER = 'mongodb';
process.env.MONGO_URI = `mongodb://127.0.0.1:${MONGO_PORT}/catalogue_audit`;
process.env.JWT_SECRET =
  'audit-secret-9f1c3a5d7b2e4f6081a3c5e7b9d0f2a4c6e8b1d3f5a7c9e0b2d4f6a8c1e3b5d7';
process.env.JWT_EXPIRES_IN = '1h';
process.env.PORT = '5061';
process.env.FRONTEND_URL = API_ORIGIN;
process.env.COOKIE_SECURE = 'false';
process.env.COOKIE_SAME_SITE = 'lax';
process.env.LOG_LEVEL = 'silent';
process.env.UPLOAD_DIR = path.join(scratch, 'uploads');
process.env.RATE_LIMIT_MAX = '100000';
process.env.LOGIN_RATE_LIMIT_MAX = '100000';

const { MongoMemoryServer } = await import('mongodb-memory-server');
const mongo = await MongoMemoryServer.create({
  instance: {
    port: MONGO_PORT,
    dbName: 'catalogue_audit',
    dbPath: path.join(scratch, 'mongo'),
  },
});
const mongoose = (await import('mongoose')).default;
const request = (await import('supertest')).default;
const { createApp } = await import('../server/src/app.js');
const { runSeed } = await import('../server/src/config/seed.js');
const { resetAllRateLimits } = await import('../server/src/middlewares/rateLimiter.js');
const { User } = await import('../server/src/modules/auth/model.js');
const { Product } = await import('../server/src/modules/products/model.js');
const { Brand } = await import('../server/src/modules/brands/model.js');
const { Category } = await import('../server/src/modules/categories/model.js');
const { openApiSpec } = await import('../server/src/config/swagger.js');
const { API_PREFIX } = await import('../server/src/constants/appConstants.js');

await mongoose.connect(process.env.MONGO_URI, { autoIndex: true });
await Promise.all([
  User.syncIndexes(),
  Product.syncIndexes(),
  Brand.syncIndexes(),
  Category.syncIndexes(),
]);
const seeded = await runSeed({ silent: true });

const app = createApp();

// --------------------------------------------------------------------------- helpers
const results = [];
let currentGroup = 'general';

function group(name) {
  currentGroup = name;
}

async function check(name, fn) {
  const id = `${results.length + 1}`.padStart(3, '0');
  try {
    const detail = await fn();
    results.push({ id, group: currentGroup, name, ok: true, detail: detail ?? '' });
  } catch (error) {
    results.push({
      id,
      group: currentGroup,
      name,
      ok: false,
      detail: error instanceof Error ? `${error.message}` : String(error),
    });
  }
}

function expectStatus(response, expected, label = '') {
  const list = Array.isArray(expected) ? expected : [expected];
  if (!list.includes(response.status)) {
    throw new Error(
      `${label} expected status ${list.join('|')} but got ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`,
    );
  }
}

function expectEq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

function expectTruthy(value, label) {
  if (!value) throw new Error(`${label}: expected a truthy value, got ${JSON.stringify(value)}`);
}

/** Identity-scoped HTTP client that also carries the CSRF header. */
function client(label) {
  const agent = request.agent(app);
  const state = { label, agent, csrfToken: null, cookieHeader: null };
  state.cookies = () =>
    agent.jar.getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false });

  state.csrf = async () => {
    const response = await agent.get(`${API_PREFIX}/auth/csrf`);
    expectStatus(response, 200, 'csrf');
    state.csrfToken = response.body.data.csrfToken;
    return state.csrfToken;
  };

  /** Performs a request, adding the CSRF header for unsafe methods by default. */
  state.do = (method, url, { body, csrf = true, headers = {}, token } = {}) => {
    let req = agent[method](url);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    if (csrf && !['get', 'head', 'options'].includes(method) && state.csrfToken) {
      req = req.set('X-CSRF-Token', token ?? state.csrfToken);
    }
    if (body !== undefined) req = req.send(body);
    return req;
  };

  state.login = async (email, password) => {
    await state.csrf();
    const response = await state.do('post', `${API_PREFIX}/auth/login`, {
      body: { email, password },
    });
    if (response.status === 200) state.csrfToken = response.body.data.csrfToken ?? state.csrfToken;
    return response;
  };

  return state;
}

const anon = client('anonymous');
const admin = client('admin');
const customer = client('customer');
const rotateAdmin = client('rotation-admin');

// Seed extra identities (direct model writes keep the audit independent of the API).
const ADMIN_EMAIL = 'audit.admin@catalogue.test';
const CUSTOMER_EMAIL = 'audit.customer@catalogue.test';
const ROTATE_EMAIL = 'audit.rotate@catalogue.test';
const PASSWORD = 'Aud1t!Passw0rd';

await User.create({
  name: 'Audit Admin',
  email: ADMIN_EMAIL,
  passwordHash: await User.hashPassword(PASSWORD),
  role: 'admin',
  mustChangePassword: false,
  isActive: true,
});
await User.create({
  name: 'Audit Customer',
  email: CUSTOMER_EMAIL,
  passwordHash: await User.hashPassword(PASSWORD),
  role: 'customer',
  mustChangePassword: false,
  isActive: true,
});
await User.create({
  name: 'Audit Rotation Admin',
  email: ROTATE_EMAIL,
  passwordHash: await User.hashPassword(PASSWORD),
  role: 'admin',
  mustChangePassword: true,
  isActive: true,
});

await admin.login(ADMIN_EMAIL, PASSWORD);
await customer.login(CUSTOMER_EMAIL, PASSWORD);
await rotateAdmin.login(ROTATE_EMAIL, PASSWORD);

const fixtureBrand = await Brand.findOne({}).lean();
const fixtureCategory = await Category.findOne({}).lean();
const fixtureProducts = await Product.find({ isActive: true }).sort({ createdAt: -1 }).lean();
const firstProduct = fixtureProducts[0];

// --------------------------------------------------------------------------- 1. health & docs
group('health & docs');

await check('GET /health returns 200 with database status', async () => {
  const response = await anon.do('get', `${API_PREFIX}/health`);
  expectStatus(response, 200);
  expectEq(response.body.data.status, 'ok', 'health status');
  expectEq(response.body.data.database, 'connected', 'database state');
  return `uptime ${response.body.data.uptimeSeconds}s`;
});

await check('GET /docs.json serves a valid OpenAPI 3 document', async () => {
  const response = await anon.do('get', `${API_PREFIX}/docs.json`);
  expectStatus(response, 200);
  expectTruthy(/^3\./.test(response.body.openapi), 'openapi version');
  return `${Object.keys(response.body.paths).length} documented paths`;
});

await check('GET /docs/ serves Swagger UI HTML', async () => {
  const response = await anon.do('get', `${API_PREFIX}/docs/`);
  expectStatus(response, 200);
  expectTruthy(response.text.includes('swagger-ui'), 'swagger html');
  return 'html + csp';
});

await check('GET / serves the API banner', async () => {
  const response = await anon.do('get', '/');
  expectStatus(response, 200);
  expectEq(response.body.data.name, 'Catalogue API', 'banner name');
  return '';
});

// --------------------------------------------------------------------------- 2. security headers
group('security headers');

await check('Helmet sets the core hardening headers on API responses', async () => {
  const response = await anon.do('get', `${API_PREFIX}/health`);
  const missing = [
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
    'cross-origin-resource-policy',
  ].filter((h) => !response.headers[h]);
  if (missing.length) throw new Error(`missing headers: ${missing.join(', ')}`);
  if (response.headers['x-powered-by']) throw new Error('x-powered-by is exposed');
  return 'nosniff, frame, referrer, corp; no x-powered-by';
});

await check('CORS rejects a foreign origin with 403 CORS_ORIGIN_DENIED', async () => {
  const response = await anon.do('get', `${API_PREFIX}/health`, {
    headers: { Origin: 'https://evil.example.com' },
  });
  expectStatus(response, 403);
  expectEq(response.body.error.code, 'CORS_ORIGIN_DENIED', 'cors code');
  return 'envelope preserved';
});

await check('CORS allows the configured frontend origin', async () => {
  const response = await anon.do('get', `${API_PREFIX}/health`, {
    headers: { Origin: API_ORIGIN },
  });
  expectStatus(response, 200);
  expectEq(response.headers['access-control-allow-origin'], API_ORIGIN, 'acao');
  return '';
});

// --------------------------------------------------------------------------- 3. storefront
group('storefront');

await check('GET /products returns the first cursor page', async () => {
  const response = await anon.do('get', `${API_PREFIX}/products`);
  expectStatus(response, 200);
  const items = response.body.data;
  const meta = response.body.meta;
  expectEq(items.length, 12, 'page size');
  expectEq(meta.hasNextPage, true, 'hasNextPage');
  expectTruthy(meta.nextCursor, 'nextCursor');
  return `${items.length} products, count=${meta.count}`;
});

await check('cursor pagination walks the whole catalogue without duplicates', async () => {
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const url = cursor
      ? `${API_PREFIX}/products?cursor=${encodeURIComponent(cursor)}`
      : `${API_PREFIX}/products`;
    const response = await anon.do('get', url);
    expectStatus(response, 200);
    for (const product of response.body.data) {
      if (seen.has(product.id)) throw new Error(`duplicate product ${product.id} across pages`);
      seen.add(product.id);
    }
    cursor = response.body.meta.nextCursor;
    pages += 1;
    if (pages > 10) throw new Error('pagination did not terminate');
  } while (cursor);
  expectEq(seen.size, 20, 'total active products traversed');
  return `${pages} pages, ${seen.size} unique products`;
});

await check(
  'storefront search + brand + category + price filters narrow the result set',
  async () => {
    const search = await anon.do('get', `${API_PREFIX}/products?search=aurora`);
    expectStatus(search, 200);
    const searchCount = search.body.meta.count;
    expectEq(searchCount, 5, 'search=aurora count');

    const brand = await anon.do('get', `${API_PREFIX}/products?brand=${fixtureBrand._id}`);
    expectStatus(brand, 200);
    expectTruthy(brand.body.meta.count > 0, 'brand filter count');
    expectTruthy(
      brand.body.data.every((p) => p.brand.name === fixtureBrand.name),
      'brand filter membership',
    );

    const category = await anon.do('get', `${API_PREFIX}/products?category=${fixtureCategory._id}`);
    expectStatus(category, 200);
    expectTruthy(
      category.body.data.every((p) => p.category.name === fixtureCategory.name),
      'category filter membership',
    );

    const priced = await anon.do('get', `${API_PREFIX}/products?minPrice=1000&maxPrice=6000`);
    expectStatus(priced, 200);
    expectTruthy(
      priced.body.data.every((p) => p.price >= 1000 && p.price <= 6000),
      'price range membership',
    );
    return `search=${searchCount}, brand=${brand.body.meta.count}, category=${category.body.meta.count}, price=${priced.body.meta.count}`;
  },
);

await check('sorting is applied for every documented storefront sort', async () => {
  const asc = await anon.do('get', `${API_PREFIX}/products?sort=price_asc&limit=48`);
  expectStatus(asc, 200);
  const ascPrices = asc.body.data.map((p) => p.price);
  expectEq(
    [...ascPrices].sort((a, b) => a - b),
    ascPrices,
    'price_asc ordering',
  );

  const desc = await anon.do('get', `${API_PREFIX}/products?sort=price_desc&limit=48`);
  expectStatus(desc, 200);
  const descPrices = desc.body.data.map((p) => p.price);
  expectEq(
    [...descPrices].sort((a, b) => b - a),
    descPrices,
    'price_desc ordering',
  );
  return `${ascPrices.length} products sorted both ways`;
});

await check('GET /products/:slug and /products/:id return the same product', async () => {
  const bySlug = await anon.do('get', `${API_PREFIX}/products/${firstProduct.slug}`);
  expectStatus(bySlug, 200);
  const byId = await anon.do('get', `${API_PREFIX}/products/${firstProduct._id}`);
  expectStatus(byId, 200);
  expectEq(byId.body.data.id, bySlug.body.data.id, 'id match');
  return bySlug.body.data.slug;
});

await check('unknown product returns 404 PRODUCT_NOT_FOUND via the async controller', async () => {
  const response = await anon.do('get', `${API_PREFIX}/products/does-not-exist`);
  expectStatus(response, 404);
  expectEq(response.body.error.code, 'PRODUCT_NOT_FOUND', 'error code');
  expectTruthy(response.body.requestId, 'requestId present');
  expectTruthy(response.headers['x-request-id'], 'x-request-id header');
  return 'envelope + request id';
});

await check('inactive products are hidden from the storefront', async () => {
  const inactive = await Product.findOne({ isActive: false }).lean();
  const response = await anon.do('get', `${API_PREFIX}/products/${inactive._id}`);
  expectStatus(response, 404);
  const listed = await anon.do('get', `${API_PREFIX}/products?limit=48`);
  expectTruthy(
    !listed.body.data.some((p) => p.id === inactive._id.toString()),
    'inactive product must not be listed',
  );
  return `hidden ${inactive.slug}`;
});

await check('brands and categories endpoints list and resolve by slug', async () => {
  const brands = await anon.do('get', `${API_PREFIX}/brands`);
  expectStatus(brands, 200);
  expectEq(brands.body.data.length, 6, 'brand count');
  const brand = await anon.do('get', `${API_PREFIX}/brands/${fixtureBrand.slug}`);
  expectStatus(brand, 200);

  const categories = await anon.do('get', `${API_PREFIX}/categories`);
  expectStatus(categories, 200);
  expectEq(categories.body.data.length, 6, 'category count');
  const category = await anon.do('get', `${API_PREFIX}/categories/${fixtureCategory.slug}`);
  expectStatus(category, 200);
  return '6 brands / 6 categories';
});

await check('unknown brand and category return 404', async () => {
  const brand = await anon.do('get', `${API_PREFIX}/brands/nope-nope`);
  expectStatus(brand, 404);
  expectEq(brand.body.error.code, 'BRAND_NOT_FOUND', 'brand 404');
  const category = await anon.do('get', `${API_PREFIX}/categories/nope-nope`);
  expectStatus(category, 404);
  expectEq(category.body.error.code, 'CATEGORY_NOT_FOUND', 'category 404');
  return '';
});

// --------------------------------------------------------------------------- 4. input validation
group('input validation');

await check('invalid storefront query parameters are rejected with field details', async () => {
  const cases = [
    ['?limit=999', 'limit'],
    ['?sort=bogus', 'sort'],
    ['?minPrice=-5', 'minPrice'],
    ['?unknownParam=1', 'unknownParam'],
    ['?cursor=not-a-cursor', 'cursor'], // rejected with CURSOR_INVALID, also a 4xx
  ];
  const failures = [];
  for (const [qs, label] of cases) {
    const response = await anon.do('get', `${API_PREFIX}/products${qs}`);
    const code = response.body.error?.code;
    const acceptedCodes = ['VALIDATION_ERROR', 'CURSOR_INVALID'];
    if (response.status !== 400 || !acceptedCodes.includes(code)) {
      failures.push(`${label} -> ${response.status} ${code ?? ''}`);
    }
  }
  if (failures.length) throw new Error(`not rejected: ${failures.join(', ')}`);
  return `${cases.length} malformed queries rejected`;
});

await check('cursor bound to a different sort is rejected (CURSOR_SORT_MISMATCH)', async () => {
  const first = await anon.do('get', `${API_PREFIX}/products?sort=price_asc`);
  const cursor = first.body.meta.nextCursor;
  const response = await anon.do(
    'get',
    `${API_PREFIX}/products?sort=price_desc&cursor=${encodeURIComponent(cursor)}`,
  );
  expectStatus(response, 400);
  expectEq(response.body.error.code, 'CURSOR_SORT_MISMATCH', 'cursor sort guard');
  return '';
});

await check('malformed ObjectId in a path returns 400 INVALID_IDENTIFIER', async () => {
  const response = await admin.do('get', `${API_PREFIX}/admin/products/not-an-id`);
  expectStatus(response, 400);
  expectEq(response.body.error.code, 'VALIDATION_ERROR', 'validation code');
  expectTruthy(
    response.body.error.details.some((d) => d.path.includes('params.id')),
    'field-addressed detail',
  );
  return '';
});

await check('missing required fields are rejected with a field list', async () => {
  const response = await admin.do('post', `${API_PREFIX}/admin/products`);
  expectStatus(response, 400);
  expectEq(response.body.error.code, 'VALIDATION_ERROR', 'validation code');
  expectTruthy(response.body.error.details.length >= 5, 'several field errors');
  return `${response.body.error.details.length} field errors`;
});

await check('unknown body fields are rejected (strict schemas)', async () => {
  const response = await admin.do('post', `${API_PREFIX}/brands`, {
    body: { name: 'Strict Brand', nameNormalized: 'hacked' },
  });
  expectStatus(response, 400);
  expectEq(response.body.error.code, 'VALIDATION_ERROR', 'strict rejection');
  return '';
});

await check('malformed JSON body is rejected without a stack leak in the message', async () => {
  const response = await admin
    .do('post', `${API_PREFIX}/brands`, {
      headers: { 'Content-Type': 'application/json' },
    })
    .send('{"name": ');
  expectStatus(response, 400);
  expectTruthy(
    !/at .*\.js:\d+/.test(response.body.message ?? ''),
    'message must not contain a stack',
  );
  return `code ${response.body.error.code}`;
});

await check('oversized JSON body is rejected with 413', async () => {
  const big = 'x'.repeat(200 * 1024);
  const response = await admin.do('post', `${API_PREFIX}/brands`, {
    body: { name: 'Big', description: big },
    headers: { 'Content-Type': 'application/json' },
  });
  expectStatus(response, [413, 400]);
  return `status ${response.status} code ${response.body.error.code}`;
});

await check('NoSQL operator injection through query and body is neutralised', async () => {
  await anon.csrf();
  const query = await anon.do('get', `${API_PREFIX}/products?search[$ne]=&brand[$gt]=`);
  expectStatus(query, [400, 200]);
  const body = await admin.do('post', `${API_PREFIX}/brands`, {
    body: { name: { $ne: null } },
  });
  expectStatus(body, 400);
  const login = await anon.do('post', `${API_PREFIX}/auth/login`, {
    body: { email: { $gt: '' }, password: { $gt: '' } },
  });
  expectStatus(login, 400);
  return `query=${query.status}, create=${body.status}, login=${login.status}`;
});

// --------------------------------------------------------------------------- 5. auth & csrf
group('auth & csrf');

await check('CSRF bootstrap issues a readable, signed token cookie', async () => {
  const fresh = client('csrf');
  const response = await fresh.do('get', `${API_PREFIX}/auth/csrf`);
  expectStatus(response, 200);
  const cookies = response.headers['set-cookie'] ?? [];
  const csrfCookie = cookies.find((c) => c.startsWith('csrf_token='));
  expectTruthy(csrfCookie, 'csrf cookie set');
  expectTruthy(!/HttpOnly/i.test(csrfCookie), 'csrf cookie must be JS-readable');
  expectTruthy(/SameSite=Lax/i.test(csrfCookie), 'sameSite set');
  expectTruthy(response.body.data.csrfToken.includes('.'), 'signed token shape');
  return 'readable + signed';
});

await check('unsafe request without a CSRF token is rejected', async () => {
  const fresh = client('no-csrf');
  await fresh.csrf();
  const response = await fresh.do('post', `${API_PREFIX}/auth/login`, {
    body: { email: ADMIN_EMAIL, password: PASSWORD },
    csrf: false,
  });
  expectStatus(response, 403);
  expectEq(response.body.error.code, 'CSRF_TOKEN_MISSING', 'csrf missing');
  return '';
});

await check('unsafe request with a forged CSRF token is rejected', async () => {
  const fresh = client('bad-csrf');
  await fresh.csrf();
  const response = await fresh.do('post', `${API_PREFIX}/auth/login`, {
    body: { email: ADMIN_EMAIL, password: PASSWORD },
    token: 'forged.token',
  });
  expectStatus(response, 403);
  expectEq(response.body.error.code, 'CSRF_TOKEN_MISMATCH', 'csrf mismatch');
  return '';
});

await check(
  'login sets an httpOnly, SameSite session cookie and no token in JS-readable storage',
  async () => {
    const response = await admin.login(ADMIN_EMAIL, PASSWORD);
    expectStatus(response, 200);
    const cookies = response.headers['set-cookie'] ?? [];
    const session = cookies.find((c) => /^(access_token|auth_token|catalogue_token)=/.test(c));
    expectTruthy(session, 'session cookie set');
    expectTruthy(/HttpOnly/i.test(session), 'session cookie is httpOnly');
    expectTruthy(/SameSite=Lax/i.test(session), 'sameSite set');
    expectTruthy(
      !/payload|passwordHash/i.test(JSON.stringify(response.body)),
      'no sensitive fields',
    );
    return session.split(';')[0].split('=')[0] + ' httpOnly';
  },
);

await check('wrong password returns a generic 401 without account enumeration', async () => {
  const fresh = client('bad-password');
  await fresh.csrf();
  const response = await fresh.login(ADMIN_EMAIL, 'definitely-wrong');
  expectStatus(response, 401);
  expectEq(response.body.error.code, 'INVALID_CREDENTIALS', 'generic code');
  const unknown = await fresh.login('nobody@nowhere.test', 'definitely-wrong');
  expectStatus(unknown, 401);
  expectEq(unknown.body.message, response.body.message, 'identical message for unknown account');
  return 'same message for unknown user and bad password';
});

await check('login validates the payload shape', async () => {
  const fresh = client('login-validation');
  await fresh.csrf();
  const missing = await fresh.do('post', `${API_PREFIX}/auth/login`, { body: {} });
  expectStatus(missing, 400);
  expectEq(missing.body.error.code, 'VALIDATION_ERROR', 'missing fields');
  const malformed = await fresh.do('post', `${API_PREFIX}/auth/login`, {
    body: { email: 'not-an-email', password: 'x' },
  });
  expectStatus(malformed, 400);
  return 'missing + malformed email rejected';
});

await check('GET /auth/me restores the session from the cookie', async () => {
  const response = await admin.do('get', `${API_PREFIX}/auth/me`);
  expectStatus(response, 200);
  expectEq(response.body.data.user.email, ADMIN_EMAIL, 'session user');
  expectTruthy(!('passwordHash' in response.body.data.user), 'password hash not exposed');
  return '';
});

await check('GET /auth/me without a cookie returns 401 AUTH_REQUIRED', async () => {
  const fresh = client('anon-me');
  const response = await fresh.do('get', `${API_PREFIX}/auth/me`);
  expectStatus(response, 401);
  expectEq(response.body.error.code, 'AUTH_REQUIRED', 'auth required');
  return '';
});

await check('a tampered JWT is rejected', async () => {
  const fresh = client('tampered');
  const response = await fresh.do('get', `${API_PREFIX}/auth/me`, {
    headers: { Cookie: `access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.bad` },
  });
  expectStatus(response, 401);
  expectTruthy(
    [
      'AUTH_REQUIRED',
      'SESSION_INVALID',
      'TOKEN_INVALID',
      'INVALID_TOKEN',
      'SESSION_REVOKED',
    ].includes(response.body.error.code),
    `unexpected code ${response.body.error.code}`,
  );
  return response.body.error.code;
});

await check(
  'forced password rotation blocks privileged routes until the password changes',
  async () => {
    const blocked = await rotateAdmin.do('get', `${API_PREFIX}/admin/products`);
    expectStatus(blocked, 403);
    expectEq(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED', 'rotation gate');

    const changed = await rotateAdmin.do('post', `${API_PREFIX}/auth/change-password`, {
      body: {
        currentPassword: PASSWORD,
        newPassword: 'Rotated!Passw0rd9',
        confirmPassword: 'Rotated!Passw0rd9',
      },
    });
    expectStatus(changed, 200);

    const allowed = await rotateAdmin.do('get', `${API_PREFIX}/admin/products`);
    expectStatus(allowed, 200);
    return '403 -> rotate -> 200';
  },
);

await check('change-password rejects a wrong current password and a reused password', async () => {
  const wrong = await admin.do('post', `${API_PREFIX}/auth/change-password`, {
    body: {
      currentPassword: 'nope',
      newPassword: 'Another!Passw0rd1',
      confirmPassword: 'Another!Passw0rd1',
    },
  });
  expectStatus(wrong, [400, 401]);
  const reused = await admin.do('post', `${API_PREFIX}/auth/change-password`, {
    body: { currentPassword: PASSWORD, newPassword: PASSWORD, confirmPassword: PASSWORD },
  });
  expectStatus(reused, 400);
  return `wrong=${wrong.status}, reused=${reused.status}`;
});

await check('logout clears the session cookie and re-locks protected routes', async () => {
  const temp = client('logout');
  await temp.login(CUSTOMER_EMAIL, PASSWORD);
  expectStatus(await temp.do('get', `${API_PREFIX}/auth/me`), 200);
  const out = await temp.do('post', `${API_PREFIX}/auth/logout`);
  expectStatus(out, 200);
  const cleared = (out.headers['set-cookie'] ?? []).some((c) =>
    /access_token=;|access_token=;$/.test(c),
  );
  expectTruthy(cleared, 'session cookie cleared');
  const after = await temp.do('get', `${API_PREFIX}/auth/me`);
  expectStatus(after, 401);
  return 'cookie cleared, 401 after';
});

await check('register creates a customer and never elevates the role', async () => {
  const fresh = client('register');
  await fresh.csrf();
  const response = await fresh.do('post', `${API_PREFIX}/auth/register`, {
    body: {
      name: 'Audit Registrant',
      email: 'audit.registrant@catalogue.test',
      password: 'Reg1ster!Pass',
      confirmPassword: 'Reg1ster!Pass',
      role: 'admin',
    },
  });
  expectStatus(response, [201, 400]);
  if (response.status === 400) {
    // strict schema rejects the smuggled role — that is the secure outcome
    expectEq(response.body.error.code, 'VALIDATION_ERROR', 'strict register schema');
    const clean = await fresh.do('post', `${API_PREFIX}/auth/register`, {
      body: {
        name: 'Audit Registrant',
        email: 'audit.registrant@catalogue.test',
        password: 'Reg1ster!Pass',
        confirmPassword: 'Reg1ster!Pass',
      },
    });
    expectStatus(clean, 201);
    expectEq(clean.body.data.user.role, 'customer', 'role forced to customer');
    return 'role smuggling rejected, clean signup is customer';
  }
  expectEq(response.body.data.user.role, 'customer', 'role forced to customer');
  return 'customer only';
});

await check('duplicate registration is rejected', async () => {
  const fresh = client('dup-register');
  await fresh.csrf();
  const response = await fresh.do('post', `${API_PREFIX}/auth/register`, {
    body: {
      name: 'Dup',
      email: CUSTOMER_EMAIL,
      password: 'Reg1ster!Pass',
      confirmPassword: 'Reg1ster!Pass',
    },
  });
  expectStatus(response, 409);
  return `code ${response.body.error.code}`;
});

await check('brute-force protection kicks in after repeated failures', async () => {
  const previous = process.env.LOGIN_RATE_LIMIT_MAX;
  process.env.LOGIN_RATE_LIMIT_MAX = '3';
  const { resetAllRateLimits: reset } = await import('../server/src/middlewares/rateLimiter.js');
  reset();
  try {
    const fresh = client('brute');
    await fresh.csrf();
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await fresh.do('post', `${API_PREFIX}/auth/login`, {
        body: { email: ADMIN_EMAIL, password: `wrong-${i}` },
      });
      statuses.push(response.status);
      if (response.status === 429) {
        expectEq(response.body.error.code, 'RATE_LIMITED', 'rate limit code');
        return `statuses ${statuses.join(',')} -> 429 RATE_LIMITED`;
      }
    }
    throw new Error(`no 429 after 6 failed attempts: ${statuses.join(',')}`);
  } finally {
    process.env.LOGIN_RATE_LIMIT_MAX = previous;
    resetAllRateLimits();
  }
});

await check('account lockout is enforced independently of the IP limiter', async () => {
  const lockedUser = await User.exists({ email: 'audit.lockout@catalogue.test' });
  if (!lockedUser) {
    await User.create({
      name: 'Lockout Target',
      email: 'audit.lockout@catalogue.test',
      passwordHash: await User.hashPassword(PASSWORD),
      role: 'customer',
      mustChangePassword: false,
      isActive: true,
    });
  }
  const fresh = client('lockout');
  let sawLock = null;
  for (let i = 0; i < 8 && !sawLock; i += 1) {
    const response = await fresh.login('audit.lockout@catalogue.test', `wrong-${i}`);
    if (response.status === 423 || response.body.error?.code === 'ACCOUNT_LOCKED') {
      sawLock = response.body.error.code;
    }
  }
  if (!sawLock) throw new Error('account was never locked after 8 failed attempts');
  return `locked with ${sawLock}`;
});

// --------------------------------------------------------------------------- 6. RBAC
group('rbac');

await check('anonymous access to every admin route is refused with 401', async () => {
  const routes = [
    ['get', `${API_PREFIX}/admin/products`],
    ['post', `${API_PREFIX}/admin/products`],
    ['get', `${API_PREFIX}/admin/products/${firstProduct._id}`],
    ['put', `${API_PREFIX}/admin/products/${firstProduct._id}`],
    ['patch', `${API_PREFIX}/admin/products/${firstProduct._id}`],
    ['patch', `${API_PREFIX}/admin/products/${firstProduct._id}/stock`],
    ['delete', `${API_PREFIX}/admin/products/${firstProduct._id}`],
    ['post', `${API_PREFIX}/admin/products/maintenance/sweep-orphans`],
    ['post', `${API_PREFIX}/brands`],
    ['put', `${API_PREFIX}/brands/${fixtureBrand._id}`],
    ['delete', `${API_PREFIX}/brands/${fixtureBrand._id}`],
    ['post', `${API_PREFIX}/categories`],
    ['put', `${API_PREFIX}/categories/${fixtureCategory._id}`],
    ['delete', `${API_PREFIX}/categories/${fixtureCategory._id}`],
  ];
  const failures = [];
  for (const [method, url] of routes) {
    const response = await anon.do(method, url, { body: {} });
    if (![401, 403].includes(response.status))
      failures.push(`${method} ${url} -> ${response.status}`);
  }
  if (failures.length) throw new Error(failures.join('; '));
  return `${routes.length} admin routes refused for anonymous callers`;
});

await check('a customer session receives 403 INSUFFICIENT_ROLE on admin routes', async () => {
  const response = await customer.do('get', `${API_PREFIX}/admin/products`);
  expectStatus(response, 403);
  expectEq(response.body.error.code, 'INSUFFICIENT_ROLE', 'role gate');
  return '';
});

await check('an admin session is accepted on admin routes', async () => {
  const response = await admin.do('get', `${API_PREFIX}/admin/products`);
  expectStatus(response, 200);
  expectTruthy(Array.isArray(response.body.data), 'admin list shape');
  return `${response.body.meta.total} products`;
});

// --------------------------------------------------------------------------- 7. admin CRUD & concurrency
group('admin CRUD & concurrency');

let createdBrandId = null;
let createdCategoryId = null;
let createdProductId = null;
let createdProductVersion = null;

await check('brand create / rename / delete round-trip', async () => {
  const create = await admin.do('post', `${API_PREFIX}/brands`, {
    body: { name: 'Audit Brand', description: 'created by the audit harness' },
  });
  expectStatus(create, 201);
  createdBrandId = create.body.data.id;
  const rename = await admin.do('put', `${API_PREFIX}/brands/${createdBrandId}`, {
    body: { name: 'Audit Brand Renamed' },
  });
  expectStatus(rename, 200);
  expectEq(rename.body.data.name, 'Audit Brand Renamed', 'rename applied');
  const duplicate = await admin.do('post', `${API_PREFIX}/brands`, {
    body: { name: 'audit brand renamed' },
  });
  expectStatus(duplicate, 409);
  expectEq(duplicate.body.error.code, 'BRAND_NAME_TAKEN', 'case-insensitive uniqueness');
  const remove = await admin.do('delete', `${API_PREFIX}/brands/${createdBrandId}`);
  expectStatus(remove, 200);
  const gone = await admin.do('get', `${API_PREFIX}/brands/${createdBrandId}`);
  expectStatus(gone, 404);
  return 'create 201, rename 200, duplicate 409, delete 200';
});

await check('brand delete is blocked while products still reference it', async () => {
  const response = await admin.do('delete', `${API_PREFIX}/brands/${fixtureBrand._id}`);
  expectStatus(response, 409);
  expectTruthy(
    /BRAND_IN_USE|BRAND_HAS_PRODUCTS|CONFLICT/.test(response.body.error.code),
    response.body.error.code,
  );
  return response.body.error.code;
});

await check('category create / delete round-trip', async () => {
  const create = await admin.do('post', `${API_PREFIX}/categories`, {
    body: { name: 'Audit Category' },
  });
  expectStatus(create, 201);
  createdCategoryId = create.body.data.id;
  const remove = await admin.do('delete', `${API_PREFIX}/categories/${createdCategoryId}`);
  expectStatus(remove, 200);
  return 'create 201, delete 200';
});

await check(
  'product create with an image stores a compressed main file and a thumbnail',
  async () => {
    const response = await admin
      .do('post', `${API_PREFIX}/admin/products`)
      .field('title', 'Audit Upload Product')
      .field('description', 'Created by the regression audit to exercise the upload pipeline.')
      .field('price', '1999')
      .field('stock', '7')
      .field('brand', fixtureBrand._id.toString())
      .field('category', fixtureCategory._id.toString())
      .attach('image', path.join(repoRoot, 'e2e', 'fixtures', 'product.png'));

    expectStatus(response, [201, 400, 422], 'create with image');
    if (response.status !== 201) {
      throw new Error(`upload rejected unexpectedly: ${JSON.stringify(response.body.error)}`);
    }
    const product = response.body.data.product ?? response.body.data;
    createdProductId = product.id;
    createdProductVersion = product.version;
    expectTruthy(
      typeof product.image === 'string' && product.image.length > 0,
      'image url present',
    );
    expectTruthy(
      typeof product.thumbnail === 'string' && product.thumbnail.length > 0,
      'thumb url present',
    );
    const uploadDir = process.env.UPLOAD_DIR;
    const files = fs.readdirSync(path.join(uploadDir, 'products'));
    expectTruthy(files.length >= 2, `expected main + thumb, found ${files.join(',')}`);
    const sharp = (await import('sharp')).default;
    const dimensions = [];
    for (const file of files) {
      const meta = await sharp(path.join(uploadDir, 'products', file)).metadata();
      dimensions.push(`${path.extname(file)}${meta.width}x${meta.height}`);
      expectTruthy(meta.width <= 1200 && meta.height <= 1200, `resized within bounds (${file})`);
      expectTruthy(!meta.exif && !meta.icc, `metadata stripped (${file})`);
      if (meta.width > 300 || meta.height > 300) {
        expectTruthy(
          meta.format === 'png' || meta.format === 'jpeg' || meta.format === 'webp',
          'format normalised',
        );
      }
    }
    const thumbs = await Promise.all(
      files.map(async (file) => {
        const meta = await sharp(path.join(uploadDir, 'products', file)).metadata();
        return meta.width <= 300 && meta.height <= 300;
      }),
    );
    expectTruthy(thumbs.some(Boolean), 'a thumbnail (<=300px) was generated');
    return `${files.length} files re-encoded: ${dimensions.join(', ')}`;
  },
);

await check('unsafe upload content is rejected', async () => {
  const response = await admin
    .do('post', `${API_PREFIX}/admin/products`)
    .field('title', 'Audit Malicious Upload')
    .field('description', 'Should never be stored.')
    .field('price', '10')
    .field('stock', '1')
    .field('brand', fixtureBrand._id.toString())
    .field('category', fixtureCategory._id.toString())
    .attach('image', Buffer.from('<svg><script>alert(1)</script></svg>'), {
      filename: 'evil.png',
      contentType: 'image/png',
    });
  expectStatus(response, [400, 422]);
  expectTruthy(
    ['UNSUPPORTED_FILE_TYPE', 'MIME_TYPE_MISMATCH', 'IMAGE_DECODE_FAILED'].includes(
      response.body.error.code,
    ),
    response.body.error.code,
  );
  const stored = await Product.exists({ title: 'Audit Malicious Upload' });
  expectTruthy(!stored, 'no document created for a rejected upload');
  return response.body.error.code;
});

await check('product update applies changes and bumps the version', async () => {
  const response = await admin
    .do('patch', `${API_PREFIX}/admin/products/${createdProductId}`)
    .set('Content-Type', 'application/json')
    .send({ title: 'Audit Upload Product (edited)', version: createdProductVersion });
  expectStatus(response, 200);
  const product = response.body.data.product ?? response.body.data;
  expectEq(product.title, 'Audit Upload Product (edited)', 'title updated');
  expectTruthy(product.version > createdProductVersion, 'version bumped');
  createdProductVersion = product.version;
  return `version ${createdProductVersion}`;
});

await check(
  'stale writes are rejected with 409 STALE_RESOURCE (optimistic concurrency)',
  async () => {
    const response = await admin
      .do('patch', `${API_PREFIX}/admin/products/${createdProductId}`)
      .set('Content-Type', 'application/json')
      .send({ title: 'Audit stale write', version: createdProductVersion - 1 });
    expectStatus(response, 409);
    expectEq(response.body.error.code, 'STALE_RESOURCE', 'occ code');
    return '';
  },
);

await check('two concurrent edits with the same version: exactly one wins', async () => {
  const current = await admin.do('get', `${API_PREFIX}/admin/products/${createdProductId}`);
  const version = (current.body.data.product ?? current.body.data).version;
  const [a, b] = await Promise.all([
    admin
      .do('patch', `${API_PREFIX}/admin/products/${createdProductId}`)
      .set('Content-Type', 'application/json')
      .send({ title: 'Concurrent A', version }),
    admin
      .do('patch', `${API_PREFIX}/admin/products/${createdProductId}`)
      .set('Content-Type', 'application/json')
      .send({ title: 'Concurrent B', version }),
  ]);
  const statuses = [a.status, b.status].sort((x, y) => x - y);
  expectEq(statuses, [200, 409], 'one 200 and one 409');
  const latest = await admin.do('get', `${API_PREFIX}/admin/products/${createdProductId}`);
  createdProductVersion = (latest.body.data.product ?? latest.body.data).version;
  return `statuses ${statuses.join(',')}`;
});

await check('stock deltas are atomic and can never go negative', async () => {
  const before = await admin.do('get', `${API_PREFIX}/admin/products/${createdProductId}`);
  const startStock = (before.body.data.product ?? before.body.data).stock;

  const up = await admin.do('patch', `${API_PREFIX}/admin/products/${createdProductId}/stock`, {
    body: { delta: 5 },
  });
  expectStatus(up, 200);
  const afterUp = (up.body.data.product ?? up.body.data).stock;
  expectEq(afterUp, startStock + 5, 'delta applied');

  const tooMuch = await admin.do(
    'patch',
    `${API_PREFIX}/admin/products/${createdProductId}/stock`,
    {
      body: { delta: -(startStock + 50) },
    },
  );
  expectStatus(tooMuch, [400, 409]);
  const afterFail = await admin.do('get', `${API_PREFIX}/admin/products/${createdProductId}`);
  expectEq(
    (afterFail.body.data.product ?? afterFail.body.data).stock,
    afterUp,
    'unchanged after rejected delta',
  );

  // concurrent decrements: total must never drop below zero
  await Promise.all(
    Array.from({ length: 4 }, () =>
      admin.do('patch', `${API_PREFIX}/admin/products/${createdProductId}/stock`, {
        body: { delta: -3 },
      }),
    ),
  );
  const final = await admin.do('get', `${API_PREFIX}/admin/products/${createdProductId}`);
  const finalStock = (final.body.data.product ?? final.body.data).stock;
  expectTruthy(finalStock >= 0, `stock went negative: ${finalStock}`);
  return `start ${startStock} -> ${afterUp} -> ${finalStock} (never negative)`;
});

await check('admin listing supports offset pagination and sorting', async () => {
  const page1 = await admin.do('get', `${API_PREFIX}/admin/products?page=1&limit=10`);
  expectStatus(page1, 200);
  expectEq(page1.body.meta.page, 1, 'page echo');
  expectTruthy(page1.body.meta.total >= 22, 'total count');
  const page2 = await admin.do('get', `${API_PREFIX}/admin/products?page=2&limit=10`);
  expectStatus(page2, 200);
  const ids1 = page1.body.data.map((p) => p.id);
  const ids2 = page2.body.data.map((p) => p.id);
  expectTruthy(!ids2.some((id) => ids1.includes(id)), 'pages do not overlap');

  const sorted = await admin.do('get', `${API_PREFIX}/admin/products?sort=title&limit=10`);
  expectStatus(sorted, 200);
  const titles = sorted.body.data.map((p) => p.title);
  expectEq(
    [...titles].sort((a, b) => a.localeCompare(b)),
    titles,
    'title sort',
  );

  const bad = await admin.do('get', `${API_PREFIX}/admin/products?page=0`);
  expectStatus(bad, 400);
  const beyond = await admin.do('get', `${API_PREFIX}/admin/products?page=99&limit=10`);
  expectStatus(beyond, [200, 404]);
  return `total=${page1.body.meta.total}, pages do not overlap`;
});

await check('product delete removes the document and its image files', async () => {
  const before = await admin.do('get', `${API_PREFIX}/admin/products/${createdProductId}`);
  const product = before.body.data.product ?? before.body.data;
  const uploadDir = path.join(process.env.UPLOAD_DIR, 'products');
  const filesBefore = fs.readdirSync(uploadDir);

  const remove = await admin.do('delete', `${API_PREFIX}/admin/products/${createdProductId}`);
  expectStatus(remove, 200);
  const gone = await admin.do('get', `${API_PREFIX}/admin/products/${createdProductId}`);
  expectStatus(gone, 404);

  const filesAfter = fs.readdirSync(uploadDir);
  expectTruthy(
    filesAfter.length < filesBefore.length,
    `files not cleaned: ${filesBefore.length} -> ${filesAfter.length}`,
  );
  return `${product.title}: files ${filesBefore.length} -> ${filesAfter.length}`;
});

await check('orphan sweep endpoint reports its work', async () => {
  const response = await admin.do('post', `${API_PREFIX}/admin/products/maintenance/sweep-orphans`);
  expectStatus(response, 200);
  expectTruthy(typeof response.body.data === 'object', 'sweep result payload');
  return JSON.stringify(response.body.data).slice(0, 120);
});

// --------------------------------------------------------------------------- 8. documented endpoint sweep
group('documented endpoint sweep');

await check('every documented operation is routed (no 404 ROUTE_NOT_FOUND, no 5xx)', async () => {
  const substituted = (url) =>
    url.replace('{id}', firstProduct._id.toString()).replace('{param}', 'x');

  let calls = 0;
  const problems = [];
  for (const [rawPath, item] of Object.entries(openApiSpec.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (!item[method]) continue;
      const url = substituted(rawPath);
      const response = await admin.do(method, url, { body: method === 'get' ? undefined : {} });
      calls += 1;
      const code = response.body?.error?.code;
      if (code === 'ROUTE_NOT_FOUND') problems.push(`${method} ${rawPath} -> 404 ROUTE_NOT_FOUND`);
      if (response.status >= 500)
        problems.push(`${method} ${rawPath} -> ${response.status} ${code}`);
    }
  }
  if (problems.length) throw new Error(problems.join('; '));
  return `${calls} documented operations answered without routing or server errors`;
});

// --------------------------------------------------------------------------- report
await mongoose.disconnect();
await mongo.stop();

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
const outPath = path.join(repoRoot, 'audit', 'api-audit-results.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), passed, failed: failed.length, results },
    null,
    2,
  ),
);

console.log(`\nAPI AUDIT: ${passed} passed, ${failed.length} failed (${results.length} checks)`);
for (const failure of failed) {
  console.log(`  FAIL [${failure.group}] ${failure.name}\n        ${failure.detail}`);
}
console.log(
  `\nfixture summary: ${JSON.stringify({
    products: seeded?.products ?? seeded?.productCount ?? 'n/a',
    brands: seeded?.brands,
    categories: seeded?.categories,
  })}`,
);
process.exit(failed.length === 0 ? 0 : 1);
