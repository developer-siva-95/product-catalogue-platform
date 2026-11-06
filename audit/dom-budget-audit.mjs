/**
 * DOM-budget audit for the storefront grid.
 *
 * Answers one question with measurements: does the number of mounted product cards
 * (and DOM nodes) stay bounded while the catalogue keeps loading, or does it grow
 * with how far the shopper has scrolled?
 *
 * The seeded catalogue is 20 products, which is deliberately below the
 * virtualization threshold, so this audit serves a large catalogue through request
 * interception (same cursor contract as the backend: 12 per page, `nextCursor`).
 * Only the catalogue payload is synthetic; the application itself has no mock path.
 *
 * Measurements are taken at three viewports and at increasing scroll depth, and the
 * same figures are reported for a catalogue below the threshold so the two
 * behaviours can be compared.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 5084;
const WEB_PORT = 4184;
const BASE = `http://localhost:${WEB_PORT}`;
const scratch = path.join(repoRoot, '.cache', 'dom-budget');
fs.mkdirSync(scratch, { recursive: true });

const BIG_TOTAL = 480;

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
    E2E_MONGO_PORT: '27994',
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

const product = (index) => ({
  id: `0000000000000000000${String(index).padStart(3, '0')}`,
  title: `Catalogue Item ${String(index).padStart(3, '0')}`,
  description: 'Generated catalogue row',
  price: 1000 + index,
  stock: (index % 9) + 1,
  stockStatus: index % 9 === 0 ? 'low_stock' : 'in_stock',
  sku: `SKU-${index}`,
  image: null,
  thumbnail: null,
  isActive: true,
  brand: { id: 'brand-1', name: 'Aurora' },
  category: { id: 'cat-1', name: 'Lighting' },
  createdAt: '2026-01-05T10:00:00.000Z',
  updatedAt: '2026-01-05T10:00:00.000Z',
});

async function serveCatalogue(page, total) {
  if (total === 0) return;
  await page.route('**/api/v1/products**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.replace(/\/$/, '') !== '/api/v1/products') {
      await route.fallback();
      return;
    }
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 12);
    const items = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) =>
      product(offset + index),
    );
    const next = offset + items.length;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: items,
        meta: {
          nextCursor: next < total ? String(next) : null,
          hasNextPage: next < total,
          limit,
          sort: url.searchParams.get('sort') ?? 'newest',
          count: items.length,
        },
      }),
    });
  });
}

const snapshot = (page) =>
  page.evaluate(() => {
    const cards = document.querySelectorAll('.product-card');
    const grid = document.querySelector('[data-testid="product-grid"]');
    const subtitle = document.querySelector('.page-heading__subtitle')?.textContent ?? '';
    return {
      loaded: Number(subtitle.match(/Showing (\d+)/)?.[1] ?? 0),
      mountedCards: cards.length,
      gridNodes: document.querySelector('.product-grid')?.querySelectorAll('*').length ?? 0,
      documentNodes: document.getElementsByTagName('*').length,
      virtualized: grid?.getAttribute('data-virtualized') ?? null,
      documentHeight: document.documentElement.scrollHeight,
      scrollY: Math.round(window.scrollY),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

async function loadMore(page, steps) {
  for (let step = 0; step < steps; step += 1) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(320);
  }
}

const browser = await chromium.launch();
const report = [];
const consoleErrors = [];

for (const [label, viewport] of [
  ['mobile-390', { width: 390, height: 844 }],
  ['tablet-768', { width: 768, height: 1024 }],
  ['laptop-1280', { width: 1280, height: 800 }],
]) {
  const page = await browser.newPage({ viewport });
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('401')) {
      consoleErrors.push(`${label}: ${message.text()}`);
    }
  });

  await serveCatalogue(page, BIG_TOTAL);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.product-card').first().waitFor();
  await page.waitForTimeout(500);

  const stages = [];
  stages.push({ stage: 'first page', ...(await snapshot(page)) });

  await loadMore(page, 6);
  stages.push({ stage: 'after ~7 pages', ...(await snapshot(page)) });

  await loadMore(page, 10);
  stages.push({ stage: 'after ~17 pages', ...(await snapshot(page)) });

  await loadMore(page, 14);
  stages.push({ stage: 'after ~31 pages', ...(await snapshot(page)) });

  // Deep scroll, then back to the top: the DOM must not have accumulated.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  stages.push({ stage: 'back at the top', ...(await snapshot(page)) });

  report.push({ viewport: label, catalogue: BIG_TOTAL, stages });
  await page.close();
}

// Control: the real 20-product seed, which must not virtualize.
const controlPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
controlPage.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('401')) {
    consoleErrors.push(`control: ${message.text()}`);
  }
});
await controlPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await controlPage.locator('.product-card').first().waitFor();
await loadMore(controlPage, 4);
const control = await snapshot(controlPage);
await controlPage.close();

const bounds = report.map(({ viewport, stages }) => {
  const finalStage = stages.at(-1);
  const maxMounted = Math.max(...stages.map((stage) => stage.mountedCards));
  const maxDocNodes = Math.max(...stages.map((stage) => stage.documentNodes));
  return {
    viewport,
    maxMountedCards: maxMounted,
    maxDocumentNodes: maxDocNodes,
    loadedProducts: finalStage.loaded,
    virtualized: finalStage.virtualized,
    maxOverflow: Math.max(...stages.map((stage) => stage.overflow)),
  };
});

const output = { bounds, report, control, consoleErrors };
fs.writeFileSync(path.join(repoRoot, 'audit', 'dom-budget.json'), JSON.stringify(output, null, 2));

for (const line of bounds) {
  console.log(
    `== ${line.viewport}  loaded=${line.loadedProducts}  mounted<=${line.maxMountedCards}  docNodes<=${line.maxDocumentNodes}  virtualized=${line.virtualized}  overflow=${line.maxOverflow}px`,
  );
}
console.log(
  `== control (20-product seed)  loaded=${control.loaded} mounted=${control.mountedCards} virtualized=${control.virtualized}`,
);
console.log(`console errors: ${consoleErrors.length}`);
for (const error of consoleErrors) console.log(`  ${error}`);

const failures = [];
for (const line of bounds) {
  if (line.virtualized !== 'true') failures.push(`${line.viewport}: not virtualized`);
  if (line.maxMountedCards > 40)
    failures.push(`${line.viewport}: ${line.maxMountedCards} cards mounted`);
  if (line.maxOverflow > 1) failures.push(`${line.viewport}: ${line.maxOverflow}px overflow`);
}
if (control.virtualized !== 'false') failures.push('control: 20-product seed was virtualized');
if (consoleErrors.length > 0) failures.push(`${consoleErrors.length} console errors`);

console.log(
  `\nDOM BUDGET AUDIT: ${failures.length === 0 ? 'PASS' : 'FAIL'} (${bounds.length * 3 + 2} checks)`,
);
for (const failure of failures) console.log(`  - ${failure}`);

await browser.close();
stop();
process.exitCode = failures.length === 0 ? 0 : 1;
