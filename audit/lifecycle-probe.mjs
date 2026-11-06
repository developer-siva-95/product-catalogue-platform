/**
 * Lifecycle probe: what *actually* happens when you navigate away from the
 * storefront and come back?
 *
 * Records every /api/v1/products request, the card count, whether the grid
 * component remounted, and the scroll offset, at each step:
 *   1. load storefront, scroll to accumulate pages
 *   2. click a product (detail route)
 *   3. browser Back
 *   4. detail → Back after the cache retention window (keepUnusedDataFor)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 5081;
const WEB_PORT = 4181;
const BASE = `http://localhost:${WEB_PORT}`;
const scratch = path.join(repoRoot, '.cache', 'lifecycle-probe');
fs.mkdirSync(scratch, { recursive: true });

const children = [];
const start = (name, args, options) => {
  const log = fs.createWriteStream(path.join(scratch, `${name}.log`));
  const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push(child);
};
const stop = () => children.forEach((child) => child.kill('SIGTERM'));
process.on('exit', stop);

start('api', ['server/scripts/e2e-server.mjs'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    // MongoDB-only audit: never inherit the application default (now MySQL).
    DATABASE_PROVIDER: 'mongodb',
    E2E_API_PORT: String(API_PORT),
    E2E_MONGO_PORT: '27990',
    E2E_SCRATCH_DIR: path.join(scratch, 'db'),
    E2E_WEB_ORIGIN: BASE,
    RATE_LIMIT_MAX: '100000',
    LOG_LEVEL: 'error',
  },
});
start(
  'preview',
  [
    path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview',
    '--port',
    String(WEB_PORT),
    '--strictPort',
  ],
  {
    cwd: path.join(repoRoot, 'client'),
    env: {
      ...process.env,
      VITE_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
      VITE_DEV_ORIGIN: BASE,
    },
  },
);

async function waitFor(url, label, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`${label} not ready`);
}
await waitFor(`http://127.0.0.1:${API_PORT}/api/v1/health`, 'api');
await waitFor(`${BASE}/`, 'preview');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const requests = [];
page.on('request', (request) => {
  const url = new URL(request.url());
  if (url.pathname.endsWith('/products')) {
    requests.push({
      at: Date.now(),
      cursor: url.searchParams.get('cursor'),
      limit: url.searchParams.get('limit'),
    });
  }
});
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('401'))
    consoleErrors.push(message.text());
});

const snapshot = async (label) => {
  const state = await page.evaluate(() => ({
    url: `${location.pathname}${location.search}`,
    cards: document.querySelectorAll('.product-card').length,
    scrollY: Math.round(window.scrollY),
    hasGrid: Boolean(document.querySelector('.product-grid')),
    subtitle: document.querySelector('.page-heading__subtitle')?.textContent ?? null,
    savedScroll: window.sessionStorage.getItem('catalogue:scroll:/?'),
  }));
  return { label, ...state, requests: requests.length };
};

const report = [];

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.locator('.product-card').first().waitFor();
report.push(await snapshot('initial load'));

// Scroll until the second page has been appended.
for (let attempt = 0; attempt < 8; attempt += 1) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  if ((await page.locator('.product-card').count()) >= 20) break;
}
await page.waitForTimeout(300);
report.push(await snapshot('after scrolling (2 pages loaded)'));

const before = requests.length;
const scrollBefore = await page.evaluate(() => Math.round(window.scrollY));

// Navigate into a detail page (this is the "navigate to ProductDetail" step).
await page.locator('.product-card__title a').last().click();
await page.waitForURL(/\/product\/[a-f0-9]{24}$/);
await page.waitForTimeout(400);
report.push(await snapshot('on product detail'));

// Browser back.
await page.goBack();
await page.waitForTimeout(900);
const afterBack = await snapshot('after browser Back');
afterBack.requestsSinceBack = requests.length - before;
afterBack.scrollBefore = scrollBefore;
report.push(afterBack);

// Soft-navigation back via the in-app control, from a fresh detail visit.
await page.locator('.product-card__title a').last().click();
await page.waitForURL(/\/product\/[a-f0-9]{24}$/);
await page.getByRole('button', { name: /back to results/i }).click();
await page.waitForURL((url) => url.pathname === '/');
await page.waitForTimeout(900);
const afterSoft = await snapshot('after in-app "Back to results"');
afterSoft.requestsSinceDetail = requests.length - before - afterBack.requestsSinceBack;
report.push(afterSoft);

// Wait out the cache retention window (keepUnusedDataFor) and return again.
await page.locator('.product-card__title a').last().click();
await page.waitForURL(/\/product\/[a-f0-9]{24}$/);
const retentionMs = Number(process.argv[2] ?? 125_000);
console.log(`waiting ${Math.round(retentionMs / 1000)}s on the detail page for the cache window…`);
await page.waitForTimeout(retentionMs);
const beforeLate = requests.length;
await page.goBack();
await page.waitForTimeout(1200);
const afterLate = await snapshot('after Back past the cache window');
afterLate.requestsSinceBack = requests.length - beforeLate;
afterLate.scrollBefore = scrollBefore;
report.push(afterLate);

// Cold cache: a brand-new document that only knows the depth from `?page=`. This is
// the path that used to come back with a partial list (8 mid-catalogue products).
const beforeCold = requests.length;
await page.goto(`${BASE}/?page=2`, { waitUntil: 'domcontentloaded' });
await page.locator('.product-card').first().waitFor();
await page.waitForTimeout(1500);
const cold = await snapshot('cold reload of /?page=2 (no cache at all)');
cold.requestsSinceLoad = requests.length - beforeCold;
cold.cursorsRequested = requests.slice(beforeCold).map((request) => request.cursor);
report.push(cold);

console.log(JSON.stringify({ report, consoleErrors }, null, 2));
fs.writeFileSync(
  path.join(repoRoot, 'audit', 'lifecycle-probe.json'),
  JSON.stringify({ report, consoleErrors }, null, 2),
);

await browser.close();
stop();
