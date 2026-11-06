import { expect, test } from '@playwright/test';

/**
 * Virtualization of the product grid.
 *
 * The seeded catalogue is 20 products, which is deliberately *below* the
 * virtualization threshold (60) — small result sets keep every card mounted so
 * find-in-page and printing cover the whole list. To exercise the windowed path
 * this spec intercepts the catalogue endpoint and serves a 240-product catalogue
 * that behaves exactly like the real one (cursor pagination, 12 per page, the same
 * response shape). Only the test double is synthetic — the application code has no
 * mock path.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TOTAL = 240;
const PAGE_SIZE = 12;

function productAt(index) {
  return {
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
  };
}

/** Serves the catalogue in the backend's own pagination contract. */
async function serveLargeCatalogue(page) {
  await page.route('**/api/v1/products**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname.replace(/\/$/, '');

    // Single product: the same synthetic rows, so a detail round trip works.
    const detail = pathname.match(/\/products\/(\d+)$/);
    if (detail) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: productAt(Number(detail[1])) }),
      });
      return;
    }

    if (pathname !== '/api/v1/products' || route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }

    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? PAGE_SIZE);
    const items = Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, index) =>
      productAt(offset + index),
    );
    const nextOffset = offset + items.length;

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: items,
        meta: {
          nextCursor: nextOffset < TOTAL ? String(nextOffset) : null,
          hasNextPage: nextOffset < TOTAL,
          limit,
          sort: url.searchParams.get('sort') ?? 'newest',
          count: items.length,
        },
      }),
    });
  });
}

const mountedCards = (page) => page.locator('.product-card');

/** Keeps scrolling until the grid stops growing (infinite scroll settled). */
async function scrollToEnd(page, { maxAttempts = 40 } = {}) {
  let previous = -1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const loaded = Number(
      (await page.locator('.page-heading__subtitle').innerText()).match(/Showing (\d+)/)?.[1] ?? 0,
    );
    if (loaded === previous) return loaded;
    previous = loaded;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(320);
  }
  return previous;
}

test.describe('virtualized product grid', () => {
  test('bounds the DOM while the catalogue keeps loading', async ({ page }) => {
    await serveLargeCatalogue(page);
    await page.goto('/');

    const grid = page.locator('[data-testid="product-grid"]');
    await expect(mountedCards(page)).toHaveCount(12);
    // Only 12 products are loaded, which is below the threshold: every card is
    // mounted and find-in-page still covers the whole result set.
    await expect(grid).toHaveAttribute('data-virtualized', 'false');

    // Load pages until the threshold is crossed.
    await scrollToEnd(page, { maxAttempts: 8 });
    await expect(grid).toHaveAttribute('data-virtualized', 'true');
    const crossed = {
      loaded: Number(
        (await page.locator('.page-heading__subtitle').innerText()).match(/Showing (\d+)/)?.[1],
      ),
      mounted: await mountedCards(page).count(),
      nodes: await page.evaluate(() => document.getElementsByTagName('*').length),
    };
    expect(crossed.loaded).toBeGreaterThan(60);

    // Keep loading much further: the list grows, the mounted DOM does not.
    const loaded = await scrollToEnd(page, { maxAttempts: 25 });
    expect(loaded).toBeGreaterThan(crossed.loaded + 60);

    const late = {
      mounted: await mountedCards(page).count(),
      nodes: await page.evaluate(() => document.getElementsByTagName('*').length),
    };
    expect(late.mounted).toBeLessThanOrEqual(crossed.mounted + 8);
    expect(late.nodes).toBeLessThan(crossed.nodes + 120);
    // Every mounted card still reports the true catalogue size.
    await expect(mountedCards(page).first()).toHaveAttribute('aria-setsize', String(loaded));
  });

  test('keeps every product reachable while only a window is mounted', async ({ page }) => {
    await serveLargeCatalogue(page);
    await page.goto('/');
    await expect(mountedCards(page)).toHaveCount(12);

    const loaded = await scrollToEnd(page, { maxAttempts: 40 });
    expect(loaded).toBe(TOTAL);

    // The last product of the catalogue is rendered and visible at the end.
    const last = page.locator('.product-card__title', { hasText: 'Catalogue Item 239' });
    await expect(last).toBeVisible();

    // …and an early product is no longer mounted (memory was released).
    await expect(
      page.locator('.product-card__title', { hasText: 'Catalogue Item 000' }),
    ).toHaveCount(0);

    // Scrolling back up re-mounts it.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(
      page.locator('.product-card__title', { hasText: 'Catalogue Item 000' }),
    ).toBeVisible();
  });

  test('keyboard focus survives window boundaries and resizing', async ({ page }) => {
    await serveLargeCatalogue(page);
    await page.goto('/');
    await expect(mountedCards(page)).toHaveCount(12);

    // Cross the virtualization threshold first (12 products per page) and load
    // enough products that 60 Tab presses stay inside the list.
    const loaded = await scrollToEnd(page, { maxAttempts: 12 });
    expect(loaded).toBeGreaterThan(60);
    await expect(page.locator('[data-testid="product-grid"]')).toHaveAttribute(
      'data-virtualized',
      'true',
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const initiallyMounted = await mountedCards(page).count();
    expect(initiallyMounted).toBeLessThan(60);

    // Start on the first card's title link and tab through the grid.
    const firstTitle = mountedCards(page).first().locator('.product-card__title a');
    await firstTitle.focus();
    await expect(firstTitle).toBeFocused();

    const indices = new Set();
    for (let step = 0; step < 60; step += 1) {
      await page.keyboard.press('Tab');
      const state = await page.evaluate(() => {
        const active = document.activeElement;
        const card = active?.closest?.('.product-card');
        if (!card) return { inGrid: false, index: null };
        return { inGrid: true, index: Number(card.dataset.index) };
      });
      // Focus must never fall back to <body> mid-list: that is the failure mode
      // virtualization introduces when the focused row unmounts.
      expect(state.inGrid).toBe(true);
      if (Number.isInteger(state.index)) indices.add(state.index);
    }

    // Traversal went *past* the window that was mounted on first paint, which is
    // only possible if the window follows focus.
    expect(Math.max(...indices)).toBeGreaterThanOrEqual(initiallyMounted);
    expect(indices.size).toBeGreaterThan(10);

    // Resize with focus inside the grid: focus is retained and still usable.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const afterResize = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        inGrid: Boolean(active?.closest?.('.product-card')),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(afterResize.inGrid).toBe(true);
    expect(afterResize.overflow).toBeLessThanOrEqual(1);

    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest?.('.product-card'))),
    ).toBe(true);
  });

  test('re-renders with the phone column count after a viewport change', async ({ page }) => {
    await serveLargeCatalogue(page);
    await page.goto('/');
    await expect(mountedCards(page)).toHaveCount(12);

    await scrollToEnd(page, { maxAttempts: 6 });
    const desktopColumns = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.product-grid')).gridTemplateColumns.split(' ')
          .length,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const phoneColumns = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.product-grid')).gridTemplateColumns.split(' ')
          .length,
    );
    expect(desktopColumns).toBe(4);
    expect(phoneColumns).toBe(2);
    // Still bounded after the layout change (columns doubling the row count).
    expect(await mountedCards(page).count()).toBeLessThanOrEqual(24);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  });

  test('restores scroll and depth after a detail round trip, revalidating once', async ({
    page,
  }) => {
    const listRequests = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.replace(/\/$/, '') === '/api/v1/products' && request.method() === 'GET') {
        listRequests.push(url.searchParams.get('cursor') ?? 'page-1');
      }
    });

    await serveLargeCatalogue(page);
    await page.goto('/');
    await expect(mountedCards(page)).toHaveCount(12);

    // Load enough pages that the grid is virtualized, then park mid-list.
    const loaded = await scrollToEnd(page, { maxAttempts: 9 });
    expect(loaded).toBeGreaterThan(60);
    await page.evaluate(() => window.scrollTo(0, 2200));
    await page.waitForTimeout(400);
    /** The subtitle is the only place the *loaded* product count is exposed. */
    const showing = async () =>
      Number(
        (await page.locator('.page-heading__subtitle').innerText()).match(/Showing (\d+)/)?.[1] ??
          0,
      );

    const before = {
      scrollY: await page.evaluate(() => Math.round(window.scrollY)),
      showing: await showing(),
      mounted: await mountedCards(page).count(),
    };
    expect(before.showing).toBeGreaterThan(60);
    expect(before.scrollY).toBeGreaterThan(1000);

    // Open a product that is on screen, then come back through the in-app control.
    const visibleCard = page
      .locator('.product-card')
      .filter({ has: page.locator('a:visible') })
      .nth(2);
    const title = (await visibleCard.locator('.product-card__title').innerText()).trim();
    await visibleCard.locator('.product-card__title a').click();
    await page.waitForURL(/\/product\/\d+$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

    const requestsBeforeBack = listRequests.length;
    await page.getByRole('button', { name: /back to results/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/product'));

    // Same depth, same position, same bounded DOM. Coming back re-enters the route,
    // so the parked page is revalidated: exactly one request, for the deepest page
    // already loaded — not a replay of every page and not a page-1 reset.
    await expect
      .poll(() => page.evaluate(() => Math.round(window.scrollY)), { timeout: 5000 })
      .toBeGreaterThan(before.scrollY - 200);
    // Same depth (the cache still holds every page) and no pagination in the URL.
    expect(await showing()).toBe(before.showing);
    await expect(page).not.toHaveURL(/[?&]page=/);
    expect(await mountedCards(page).count()).toBeLessThanOrEqual(40);
    await expect.poll(() => listRequests.length, { timeout: 5000 }).toBe(requestsBeforeBack + 1);
    expect(listRequests.at(-1)).not.toBe('page-1');
    await expect(page.locator('[data-testid="product-grid"]')).toHaveAttribute(
      'data-virtualized',
      'true',
    );
  });

  test('keeps the grid virtualized and the URL free of pagination', async ({ page }) => {
    await serveLargeCatalogue(page);
    await page.goto('/');
    await expect(mountedCards(page)).toHaveCount(12);

    // Load ~9 pages (108 products) so the grid is virtualized.
    const loaded = await scrollToEnd(page, { maxAttempts: 9 });
    expect(loaded).toBeGreaterThan(60);

    await expect(page.locator('[data-testid="product-grid"]')).toHaveAttribute(
      'data-virtualized',
      'true',
    );
    expect(await mountedCards(page).count()).toBeLessThanOrEqual(32);
    // Depth is cache state: the address bar never carries it.
    await expect(page).not.toHaveURL(/[?&]page=/);

    await page.reload();

    // A reload is a cache-less start, so the listing begins at page one; the grid
    // stays bounded while it grows again, and the URL still carries no pagination.
    await expect
      .poll(async () => mountedCards(page).count(), { timeout: 20_000 })
      .toBeLessThanOrEqual(32);
    await expect(page).not.toHaveURL(/[?&]page=/);

    await scrollToEnd(page, { maxAttempts: 9 });
    await expect(page).not.toHaveURL(/[?&]page=/);
    await expect(page.locator('[data-testid="product-grid"]')).toHaveAttribute(
      'data-virtualized',
      'true',
    );
  });
});

test.describe('catalogue below the threshold', () => {
  test('keeps the seeded 20-product grid fully mounted and virtualizes nothing', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(mountedCards(page)).toHaveCount(12);

    const loaded = await scrollToEnd(page, { maxAttempts: 12 });
    expect(loaded).toBe(20);
    await expect(page.locator('[data-testid="product-grid"]')).toHaveAttribute(
      'data-virtualized',
      'false',
    );
    await expect(mountedCards(page)).toHaveCount(20);
    await expect(mountedCards(page).first()).not.toHaveAttribute('aria-setsize');
  });
});
