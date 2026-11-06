/**
 * Visual + measured responsive audit of the storefront.
 *
 * Boots the seeded API and the production build (same as the browser audit), then
 * at each viewport records: horizontal overflow, rendered grid columns, touch
 * target sizes and the drawer behaviour, plus screenshots for eyeballing.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 5079;
const WEB_PORT = 4179;
const BASE = `http://localhost:${WEB_PORT}`;
const OUT = path.join(repoRoot, 'audit', 'responsive');

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(repoRoot, '.cache', 'responsive-audit'), { recursive: true });

const children = [];
function start(name, args, options) {
  const log = fs.createWriteStream(
    path.join(repoRoot, '.cache', 'responsive-audit', `${name}.log`),
  );
  const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push(child);
  return child;
}
const stop = () => children.forEach((child) => child.kill('SIGTERM'));
process.on('exit', stop);

start('api', ['server/scripts/e2e-server.mjs'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    // MongoDB-only audit: never inherit the application default (now MySQL).
    DATABASE_PROVIDER: 'mongodb',
    E2E_API_PORT: String(API_PORT),
    E2E_MONGO_PORT: '27992',
    E2E_SCRATCH_DIR: path.join(repoRoot, '.cache', 'responsive-audit', 'db'),
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
      // The API allow-lists one exact origin; the preview proxy rewrites to it.
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
      /* not ready */
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`${label} not ready: ${url}`);
}

await waitFor(`http://127.0.0.1:${API_PORT}/api/v1/health`, 'api');
await waitFor(`${BASE}/`, 'preview');

const viewports = [
  { name: 'mobile-390', width: 390, height: 844, columns: 2 },
  { name: 'tablet-768', width: 768, height: 1024, columns: 3 },
  { name: 'laptop-1280', width: 1280, height: 800, columns: 4 },
  // The container is capped at 1280px, so a 1680px screen still renders 4 columns.
  { name: 'desktop-1680', width: 1680, height: 950, columns: 4 },
];

const browser = await chromium.launch();
const results = [];

for (const viewport of viewports) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.width < 900,
    isMobile: viewport.width < 900,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('401')) {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('.product-card').first().waitFor({ timeout: 30_000 });

  const measured = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.product-card')];
    const boxes = cards.map((card) => card.getBoundingClientRect());
    const firstTop = Math.min(...boxes.map((box) => box.top));
    const taps = [...document.querySelectorAll('.btn, .filter-option, .input, .select, .chip')].map(
      (element) => {
        const rect = element.getBoundingClientRect();
        return {
          cls: element.className,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0,
        };
      },
    );
    const images = cards
      .map((card) => card.querySelector('img'))
      .filter(Boolean)
      .map((img) => ({
        natural: [img.naturalWidth, img.naturalHeight],
        box: [img.clientWidth, img.clientHeight],
      }));

    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      firstRowCount: boxes.filter((box) => Math.abs(box.top - firstTop) < 4).length,
      cardWidths: [...new Set(boxes.map((box) => Math.round(box.width)))],
      cardHeights: [...new Set(boxes.map((box) => Math.round(box.height)))],
      stockBadges: document.querySelectorAll('.product-card [data-stock-status]').length,
      minTapHeight: Math.min(...taps.filter((tap) => tap.visible).map((tap) => tap.h)),
      smallTaps: taps
        .filter((tap) => tap.visible && tap.h < 40)
        .map((tap) => `${tap.cls.split(' ').slice(0, 2).join('.')}@${tap.h}px`),
      images,
      drawerToggleVisible: Boolean(document.querySelector('.filters-toggle')),
      sidebarVisible: Boolean(document.querySelector('.filters:not(.filters--drawer)')),
    };
  });

  // Cheap accessibility sanity checks (no extra dependency): every control needs a
  // name, every image an alt attribute, exactly one h1, and a skip link.
  const a11y = await page.evaluate(() => {
    const nameOf = (element) =>
      (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().length;

    return {
      unnamedControls: [...document.querySelectorAll('button, a[href]')].filter(
        (element) => nameOf(element) === 0 && !element.getAttribute('title'),
      ).length,
      imagesWithoutAlt: [...document.querySelectorAll('img')].filter(
        (image) => !image.hasAttribute('alt'),
      ).length,
      unlabelledInputs: [...document.querySelectorAll('input, select, textarea')].filter(
        (input) =>
          !input.getAttribute('aria-label') &&
          !input.closest('label') &&
          !document.querySelector(`label[for="${input.id}"]`),
      ).length,
      h1Count: document.querySelectorAll('h1').length,
      skipLink: Boolean(document.querySelector('.skip-link')),
      liveRegions: document.querySelectorAll('[role="status"]').length,
    };
  });

  await page.screenshot({
    path: path.join(OUT, `storefront-${viewport.name}.png`),
    fullPage: false,
  });
  await page.screenshot({
    path: path.join(OUT, `storefront-${viewport.name}-full.png`),
    fullPage: true,
  });

  let drawer = null;
  if (measured.drawerToggleVisible) {
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.locator('.filters--drawer').waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, `filters-drawer-${viewport.name}.png`) });
    drawer = await page.evaluate(() => ({
      width: Math.round(document.querySelector('.filters--drawer').getBoundingClientRect().width),
      backdrop: Boolean(document.querySelector('.drawer-backdrop')),
      bodyLocked: document.body.style.overflow === 'hidden',
      footerVisible: Boolean(document.querySelector('.filters__footer')),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }));
    await page.keyboard.press('Escape');
    await page.locator('.filters--drawer').waitFor({ state: 'detached' });
  }

  // Detail page at the same viewport — pick a product that really has an upload,
  // otherwise the image rules are never exercised.
  const withImage = await page.evaluate(async () => {
    const response = await fetch('/api/v1/products?limit=12');
    const body = await response.json();
    return body.data.find((product) => product.image)?.id ?? body.data[0]?.id ?? null;
  });
  await page.goto(`${BASE}/product/${withImage}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.detail .stock-badge').waitFor({ timeout: 20_000 });
  await page.locator('.detail .stock-badge').waitFor();
  const detail = await page.evaluate(() => {
    const badge = document.querySelector('.detail .stock-badge');
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      stockLabel: badge?.textContent?.trim(),
      stockStatus: badge?.getAttribute('data-stock-status'),
      hasCartControl: Boolean(
        [...document.querySelectorAll('button, a')].find((element) =>
          /add to cart|checkout|buy now/i.test(element.textContent ?? ''),
        ),
      ),
      imageBox: (() => {
        const img = document.querySelector('.detail__image');
        if (!img) return null;
        return {
          w: img.clientWidth,
          h: img.clientHeight,
          natural: [img.naturalWidth, img.naturalHeight],
        };
      })(),
    };
  });
  await page.screenshot({ path: path.join(OUT, `detail-${viewport.name}.png`) });

  results.push({
    viewport: viewport.name,
    expectColumns: viewport.columns,
    ...measured,
    a11y,
    drawer,
    detail,
    consoleErrors,
  });
  await context.close();
}

await browser.close();
stop();

fs.writeFileSync(
  path.join(repoRoot, 'audit', 'responsive-audit.json'),
  JSON.stringify(results, null, 2),
);
for (const row of results) {
  console.log(`\n== ${row.viewport}`);
  console.log(
    `   columns=${row.firstRowCount} (expected ${row.expectColumns}) cardW=${row.cardWidths.join('/')} cardH=${row.cardHeights.join('/')}`,
  );
  console.log(
    `   overflow=${row.overflow}px stockBadges=${row.stockBadges} minTap=${row.minTapHeight}px smallTaps=${row.smallTaps.length}`,
  );
  console.log(`   a11y=${JSON.stringify(row.a11y)}`);
  if (row.drawer) console.log(`   drawer=${JSON.stringify(row.drawer)}`);
  console.log(`   detail=${JSON.stringify(row.detail)}`);
  if (row.consoleErrors.length)
    console.log(`   consoleErrors=${JSON.stringify(row.consoleErrors)}`);
}
