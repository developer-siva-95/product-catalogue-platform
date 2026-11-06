/**
 * Frontend regression audit in a real browser (Chromium via Playwright).
 *
 * Drives the production build served by `vite preview` against a freshly seeded
 * API, and records console errors, failed requests, guard behaviour, RTK Query
 * cache invalidation, keyboard accessibility and responsive layout.
 *
 * Run: node audit/browser-audit.mjs   (BASE_URL / API_URL can be overridden)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The audit owns the whole stack so it is reproducible: a freshly seeded API
 * (its own database) plus the production build served by `vite preview`.
 * Ports are deliberately different from the developer/E2E defaults.
 */
const API_PORT = Number(process.env.AUDIT_API_PORT ?? 5077);
const WEB_PORT = Number(process.env.AUDIT_WEB_PORT ?? 4177);
const BASE = `http://localhost:${WEB_PORT}`;

const children = [];
const serviceLog = path.join(repoRoot, '.cache', 'audit-browser');
fs.mkdirSync(serviceLog, { recursive: true });

function spawnService(name, command, args, { cwd, env }) {
  const out = fs.createWriteStream(path.join(serviceLog, `${name}.log`));
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on('exit', (code, signal) => {
    fs.appendFileSync(
      path.join(serviceLog, `${name}.log`),
      `\n[audit] ${name} exited code=${code} signal=${signal}\n`,
    );
  });
  children.push(child);
  return child;
}
function stopServices() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', stopServices);
process.on('SIGINT', () => {
  stopServices();
  process.exit(130);
});

spawnService('api', process.execPath, ['server/scripts/e2e-server.mjs'], {
  cwd: repoRoot,
  env: {
    DATABASE_PROVIDER: 'mongodb',
    E2E_API_PORT: String(API_PORT),
    E2E_MONGO_PORT: '27993',
    E2E_SCRATCH_DIR: path.join(repoRoot, '.cache', 'audit-browser'),
    E2E_WEB_ORIGIN: BASE,
    RATE_LIMIT_MAX: '100000',
    LOGIN_RATE_LIMIT_MAX: '1000',
    LOG_LEVEL: 'error',
  },
});
spawnService(
  'preview',
  process.execPath,
  [
    path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview',
    '--port',
    String(WEB_PORT),
    '--strictPort',
  ],
  {
    cwd: path.join(repoRoot, 'client'),
    env: { VITE_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`, VITE_DEV_ORIGIN: BASE },
  },
);

const waitFor = async (url, label, timeoutMs = 90_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const logPath = path.join(serviceLog, `${label.split(' ').pop()}.log`);
  const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-1500) : '(no log)';
  throw new Error(`${label} did not become ready (${url})\n--- service log ---\n${tail}`);
};
await waitFor(`http://127.0.0.1:${API_PORT}/api/v1/health`, 'audit API', 180_000);
await waitFor(`${BASE}/`, 'client preview');
const SHOTS = path.join(repoRoot, 'audit', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const ADMIN = { email: 'admin@catalogue.com', password: 'Admin123!' };
const ROTATED = 'E2eRotated!2026';

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (error) {
    results.push({
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const consoleErrors = [];
const failedRequests = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()}`));
page.on('response', (response) => {
  if (response.status() >= 500) failedRequests.push(`${response.status()} ${response.url()}`);
});

const resetLogs = () => {
  consoleErrors.length = 0;
  failedRequests.length = 0;
};
/** The SPA probes /auth/me for every anonymous visitor; a 401 there is expected. */
const realConsoleErrors = () => consoleErrors.filter((e) => !/401|Unauthorized/.test(e));

/** Public routes that must render without console errors or 5xx. */
const brands = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/brands`)
  .then((r) => r.json())
  .then((body) => body.data);
const brandId = brands[0].id;

await check('public routes render with no console errors or failed requests', async () => {
  const routes = ['/', '/?search=aurora', `/?brand=${brandId}`, '/?sort=price_asc'];
  const problems = [];
  for (const route of routes) {
    resetLogs();
    const response = await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    assert(response.status() === 200, `${route} returned HTTP ${response.status()}`);
    await page.locator('article').first().waitFor({ timeout: 15_000 });
    const cards = await page.locator('article').count();
    if (cards === 0) problems.push(`${route} rendered no products`);
    const realErrors = realConsoleErrors();
    if (realErrors.length) problems.push(`${route}: ${realErrors[0]}`);
    if (failedRequests.length) problems.push(`${route}: ${failedRequests[0]}`);
  }
  assert(problems.length === 0, problems.join(' | '));
  return `${routes.length} storefront routes clean`;
});

await check('product detail route renders and back-navigation keeps the filter state', async () => {
  await page.goto(`${BASE}/?search=aurora`, { waitUntil: 'domcontentloaded' });
  await page.locator('article').first().waitFor({ timeout: 15_000 });
  await page.locator('article a').first().click();
  await page.waitForURL(/\/product\//, { timeout: 20_000 });
  const title = await page.locator('h1').first().textContent();
  assert(title && title.trim().length > 0, 'detail page has no heading');
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.locator('article').first().waitFor();
  const url = page.url();
  assert(url.includes('search='), `filter state lost after back navigation: ${url}`);
  const restored = await page.getByRole('searchbox').first().inputValue();
  assert(restored === 'aurora', `search box not restored (${restored})`);
  return `detail "${title.trim().slice(0, 40)}", back to ${new URL(url).search}`;
});

await check('unknown route renders the in-app 404 page', async () => {
  resetLogs();
  await page.goto(`${BASE}/this/route/does/not/exist`, { waitUntil: 'domcontentloaded' });
  const text = await page.locator('body').innerText();
  assert(/not found|404/i.test(text), 'no not-found messaging rendered');
  assert(realConsoleErrors().length === 0, `console errors on 404: ${realConsoleErrors()[0]}`);
  return 'not-found UI without console errors';
});

await check('unauthenticated /admin is redirected to the login screen', async () => {
  await page.goto(`${BASE}/admin/products`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /sign in/i }).waitFor({ timeout: 15_000 });
  assert(!page.url().includes('/admin/products'), 'admin route was not guarded');
  return `redirected to ${new URL(page.url()).pathname}`;
});

let passwordToUse = ADMIN.password;
await check('admin login with the seeded password forces a password rotation', async () => {
  await page.getByRole('textbox', { name: /email/i }).fill(ADMIN.email);
  await page.getByLabel(/^Password/).fill(ADMIN.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(1200);
  const alertBox = page.locator('[role="alert"]').first();
  if (await alertBox.isVisible().catch(() => false)) {
    const message = await alertBox.innerText();
    if (/invalid email or password/i.test(message)) {
      // the seeded password was rotated by an earlier audit run
      await page.getByLabel(/^Password/).fill(ROTATED);
      await page.getByRole('button', { name: /sign in/i }).click();
      passwordToUse = ROTATED;
      await page.waitForURL(/\/admin$/, { timeout: 20_000 });
      return 'database was already rotated; signed in with the rotated password';
    }
  }
  const outcome = await Promise.race([
    page.waitForURL(/change-password/, { timeout: 20_000 }).then(() => 'rotate'),
    page.waitForURL(/\/admin$/, { timeout: 20_000 }).then(() => 'dashboard'),
    page.waitForSelector('[role="alert"]', { timeout: 20_000 }).then(() => 'error'),
  ]);
  if (outcome === 'rotate') return 'routed to /change-password';
  if (outcome === 'dashboard') {
    // a previous audit run already rotated this database's admin password
    await page
      .getByRole('button', { name: /sign out|log out|logout/i })
      .first()
      .click();
    await page.waitForURL((url) => !url.pathname.startsWith('/admin'), { timeout: 20_000 });
    await page.getByRole('textbox', { name: /email/i }).fill(ADMIN.email);
    await page.getByLabel(/^Password/).fill(ROTATED);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/admin$/, { timeout: 20_000 });
    passwordToUse = ROTATED;
    return 'seeded password was already rotated; signed in with the rotated one';
  }
  const alert = await page.locator('[role="alert"]').first().innerText();
  throw new Error(`login failed: ${alert}`);
});

await check('password rotation succeeds and unlocks the dashboard', async () => {
  await page.getByLabel(/^Current password/).fill(passwordToUse);
  await page.getByLabel(/^New password/).fill(ROTATED);
  await page.getByLabel(/^Confirm/).fill(ROTATED);
  await page.getByRole('button', { name: /update password|change password|save/i }).click();
  await page.waitForURL(/\/admin$/, { timeout: 20_000 });
  await page.waitForSelector('.admin-main', { timeout: 20_000 });
  assert(
    /catalogue management/i.test(await page.locator('.admin-main').innerText()),
    'admin shell did not render',
  );
  // RTK Query fills the stat cards after the first fetch resolves.
  await page.locator('.admin-main', { hasText: /PRODUCTS\s*\d+/i }).waitFor({ timeout: 20_000 });
  const body = await page.locator('.admin-main').innerText();
  assert(/products/i.test(body) && /\d/.test(body), 'dashboard stats did not load');
  return 'dashboard reached';
});

await check('session is restored after a full page reload', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.admin-main');
  assert(!page.url().includes('/login'), 'session was not restored');
  assert(new URL(page.url()).pathname.startsWith('/admin'), `unexpected path ${page.url()}`);
  const body = await page.locator('.admin-main').innerText();
  assert(/catalogue management/i.test(body), 'admin shell missing after reload');
  assert(/admin@catalogue\.com/i.test(body), 'session user not shown after reload');
  return 'cookie session restored';
});

await check('admin product table loads, paginates and searches', async () => {
  resetLogs();
  await page.goto(`${BASE}/admin/products`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table tbody tr');
  const rows = await page.locator('table tbody tr').count();
  assert(rows > 0, 'no product rows rendered');

  const next = page.getByRole('button', { name: /next/i });
  if (await next.isEnabled().catch(() => false)) {
    const firstBefore = await page.locator('table tbody tr td').nth(1).innerText();
    await next.click();
    await page.waitForTimeout(800);
    const firstAfter = await page.locator('table tbody tr td').nth(1).innerText();
    assert(firstBefore !== firstAfter, 'pagination did not change the rows');
  }

  await page.getByRole('searchbox').first().fill('aurora');
  await page.waitForFunction(
    (expected) => document.querySelectorAll('table tbody tr').length < expected,
    rows,
    { timeout: 20_000 },
  );
  const filtered = await page.locator('table tbody tr').count();
  assert(filtered > 0 && filtered < rows, `search returned ${filtered} of ${rows} rows`);
  assert(realConsoleErrors().length === 0, `console errors: ${realConsoleErrors()[0]}`);
  return `${rows} rows, search -> ${filtered}`;
});

await check('RTK Query cache invalidation refreshes the brand list after a create', async () => {
  await page.goto(`${BASE}/admin/brands`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('ul.taxonomy-list li');
  const before = await page.locator('ul.taxonomy-list li').count();
  const brandName = `Audit Brand ${Date.now()}`;

  await page.getByRole('button', { name: /\+ New brand/i }).click();
  await page.getByLabel(/^Name/).last().fill(brandName);
  await page.getByRole('button', { name: /^Save$/ }).click();
  await page.waitForTimeout(1800);

  const rows = await page.locator('ul.taxonomy-list li').count();
  const text = await page.locator('ul.taxonomy-list').innerText();
  assert(rows === before + 1, `list went from ${before} to ${rows} items`);
  assert(
    text.toLowerCase().includes(brandName.toLowerCase()),
    'new brand not visible without a reload',
  );

  // cleanup through the UI (delete is guarded by a confirmation dialog)
  const row = page.locator('ul.taxonomy-list li', { hasText: brandName });
  await row.getByRole('button', { name: /^Delete$/ }).click();
  await page.getByRole('button', { name: /^Delete brand$/ }).click();
  await page
    .locator('ul.taxonomy-list li', { hasText: brandName })
    .waitFor({ state: 'detached', timeout: 15_000 });
  const after = await page.locator('ul.taxonomy-list li').count();
  assert(after === before, `cleanup delete left ${after} items (expected ${before})`);
  return `create + invalidate + delete over ${before} brands`;
});

await check('admin categories and dashboard render their data', async () => {
  resetLogs();
  await page.goto(`${BASE}/admin/categories`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('ul.taxonomy-list li');
  const categories = await page.locator('ul.taxonomy-list li').count();

  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.admin-main');
  await page.locator('.admin-main', { hasText: /PRODUCTS\s*\d+/i }).waitFor({ timeout: 20_000 });
  const text = await page.locator('.admin-main').innerText();
  assert(/catalogue management/i.test(text), 'dashboard shell missing');
  assert(/\d/.test(text), 'dashboard shows no numbers');
  assert(realConsoleErrors().length === 0, `console errors: ${realConsoleErrors()[0]}`);
  return `${categories} categories, dashboard rendered`;
});

await check('logout clears the session and re-locks the admin area', async () => {
  await page
    .getByRole('button', { name: /sign out|log out|logout/i })
    .first()
    .click();
  await page.waitForURL((url) => !url.pathname.startsWith('/admin'), { timeout: 20_000 });
  await page.goto(`${BASE}/admin/products`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /sign in/i }).waitFor({ timeout: 15_000 });
  return 'session cleared, guard restored';
});

await check('form validation surfaces inline errors instead of submitting', async () => {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(400);
  const body = await page.locator('form').innerText();
  assert(/required/i.test(body), 'no inline validation message');
  assert(page.url().includes('/login'), 'navigated away despite invalid form');
  return 'required-field errors shown';
});

await check('keyboard navigation reaches the primary controls', async () => {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const reached = new Set();
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return {
        tag: el.tagName,
        type: el.getAttribute('type'),
        name: el.getAttribute('name') ?? el.textContent?.trim().slice(0, 20),
      };
    });
    if (info) reached.add(`${info.tag}:${info.type ?? info.name}`);
  }
  const labels = [...reached];
  assert(
    labels.some((l) => l.startsWith('INPUT')),
    `focus never reached an input (${labels.join(', ')})`,
  );
  assert(
    labels.some((l) => l.startsWith('BUTTON') || l.startsWith('A')),
    'focus never reached a button/link',
  );
  return `${reached.size} focus stops: ${labels.slice(0, 5).join(', ')}`;
});

await check('responsive layouts have no horizontal overflow (390px / 768px)', async () => {
  const measurements = [];
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('article').first().waitFor();
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    assert(
      overflow.scrollWidth <= overflow.clientWidth + 1,
      `${width}px: scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}`,
    );
    measurements.push(`${width}px ok`);
    await page.screenshot({ path: path.join(SHOTS, `storefront-${width}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  return measurements.join(', ');
});

await check('storefront screenshots captured for the record', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('article').first().waitFor();
  await page.screenshot({ path: path.join(SHOTS, 'storefront-1280.png') });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: path.join(SHOTS, 'login.png') });
  return 'audit/screenshots/*.png';
});

await browser.close();
stopServices();
await new Promise((resolve) => setTimeout(resolve, 500));

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(
  path.join(repoRoot, 'audit', 'browser-audit-results.json'),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), passed, failed: failed.length, results },
    null,
    2,
  ),
);
console.log(
  `\nBROWSER AUDIT: ${passed} passed, ${failed.length} failed (${results.length} checks)`,
);
for (const failure of failed) console.log(`  FAIL ${failure.name}\n        ${failure.detail}`);
process.exit(failed.length === 0 ? 0 : 1);
