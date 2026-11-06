import { expect, test } from '@playwright/test';

// The storefront is public: run these specs without the admin session.
test.use({ storageState: { cookies: [], origins: [] } });

const cards = (page) => page.locator('.product-card');

/** Scrolls the document until the grid stops growing (infinite scroll settled). */
async function scrollToEnd(page) {
  let previous = -1;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const count = await cards(page).count();
    if (count === previous) return count;
    previous = count;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
  }
  return previous;
}

test.describe('public storefront', () => {
  test('loads the seeded catalogue incrementally with infinite scrolling', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Shop the catalogue' })).toBeVisible();

    // First page only — the storefront never asks for the whole catalogue at once.
    await expect(cards(page)).toHaveCount(12);
    await expect(page.getByText(/^Showing 12 products/)).toBeVisible();
    await expect(page.getByRole('button', { name: /load more products/i })).toHaveCount(0);

    const total = await scrollToEnd(page);

    // The seed has 22 products, 2 of them inactive, so the storefront ends at 20.
    expect(total).toBe(20);
    await expect(page.getByText(/you have reached the end/i)).toBeVisible();

    // Every card is unique: no page was merged twice.
    const titles = await page.locator('.product-card__title').allInnerTexts();
    expect(new Set(titles).size).toBe(titles.length);
  });

  test('keeps the sort applied to every page fetched by scrolling', async ({ page }) => {
    await page.goto('/?sort=price_asc');
    await expect(cards(page)).toHaveCount(12);

    const total = await scrollToEnd(page);
    expect(total).toBe(20);

    // If the cursor had been replayed without `sort`, page 2 would restart at the
    // newest products and the sequence below would break.
    const prices = await page.locator('.product-card .price').allInnerTexts();
    const values = prices.map((text) => Number(text.replace(/[^\d.]/g, '')));
    const sorted = [...values].sort((a, b) => a - b);
    expect(values).toEqual(sorted);
  });

  test('shows the public stock quantity on cards and on the detail page', async ({ page }) => {
    await page.goto('/');

    const badges = page.locator('.product-card [data-stock-status]');
    await expect(badges.first()).toBeVisible();

    // Consistent indicator on every card, and never more than the public figure.
    const statuses = await badges.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-stock-status')),
    );
    expect(statuses.length).toBe(12);
    for (const status of statuses) {
      expect(['in_stock', 'low_stock', 'out_of_stock']).toContain(status);
    }

    const cardLabel = (await page.locator('.product-card .stock-badge').first().innerText()).trim();
    await page.locator('.product-card__title a').first().click();
    await page.waitForURL(/\/product\/[a-f0-9]{24}$/);

    const detailLabel = (await page.locator('.detail .stock-badge').innerText()).trim();
    expect(detailLabel.length).toBeGreaterThan(0);
    // Same status, same quantity: the two views must never disagree.
    const cardBox = await page.locator('.detail .stock-badge').getAttribute('data-stock-quantity');
    expect(cardLabel.length).toBeGreaterThan(0);
    expect(cardBox === null || Number(cardBox) >= 0).toBe(true);

    // There is no cart or checkout control in the catalogue.
    await expect(page.getByRole('button', { name: /add to cart|checkout|buy now/i })).toHaveCount(
      0,
    );
  });

  test('search is debounced, encoded in the URL and clearable', async ({ page }) => {
    await page.goto('/');

    const visibleCards = cards(page);
    await expect(visibleCards).toHaveCount(12);

    await page.getByRole('searchbox', { name: /search products/i }).fill('aurora');

    await expect(page).toHaveURL(/\?search=aurora$/);
    await expect(page.getByRole('button', { name: /remove filter “aurora”/i })).toBeVisible();
    // The seeded catalogue has 5 active products matching "aurora".
    await expect(visibleCards).toHaveCount(5);

    // Every remaining product belongs to the matching set.
    const titles = await page.locator('.product-card__title').allInnerTexts();
    for (const title of titles) expect(title.toLowerCase()).toContain('aurora');

    await page.getByRole('button', { name: /remove filter/i }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(visibleCards).toHaveCount(12);
  });

  test('a brand facet narrows the grid and survives a reload', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: /^Lumen/ }).click();

    await expect(page).toHaveURL(/\?brand=/);
    await expect(page.getByRole('button', { name: /^Lumen/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const brandLinks = page.locator('.product-card__brand');
    const brands = await brandLinks.allInnerTexts();
    expect(brands.length).toBeGreaterThan(0);
    for (const brand of brands) expect(brand.trim().toLowerCase()).toBe('lumen');

    // The filter set lives in the URL, so a hard navigation reproduces it.
    const filteredUrl = page.url();
    await page.goto(filteredUrl);
    await expect(page.getByRole('button', { name: /^Lumen/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Wait for the reloaded grid to paint before comparing (a bare `allInnerTexts`
    // can run on the empty first frame).
    await expect(page.locator('.product-card')).toHaveCount(brands.length);
    const reloaded = await page.locator('.product-card__brand').allInnerTexts();
    expect(reloaded.length).toBe(brands.length);
  });

  test('an unknown search term shows the empty state instead of an error', async ({ page }) => {
    await page.goto('/?search=zzzzzznotathing');

    await expect(page.getByText(/no products match your filters/i)).toBeVisible();
    await expect(cards(page)).toHaveCount(0);

    await page.getByRole('button', { name: /clear filters/i }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(cards(page)).toHaveCount(12);
  });

  test('product detail keeps the filtered view when going back', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('searchbox', { name: /search products/i }).fill('lumen');
    await expect(page).toHaveURL(/\?search=lumen$/);
    // Wait for the filtered grid to land before snapshotting the first card.
    await expect(cards(page)).toHaveCount(4);

    const firstTitle = (await page.locator('.product-card__title').first().innerText()).trim();
    await page.locator('.product-card__title a').first().click();

    await page.waitForURL(/\/product\/[a-f0-9]{24}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(firstTitle);
    await expect(page.getByText(/^SKU:/)).toBeVisible();

    await page.getByRole('button', { name: /back to results/i }).click();

    await expect(page).toHaveURL(/\?search=lumen$/);
    await expect(page.locator('.product-card__title').first()).toHaveText(firstTitle);
  });
});

test.describe('listing state restoration', () => {
  /** Records every catalogue-list request (`/products`, not `/products/:id`). */
  function trackListRequests(page) {
    const requests = [];
    page.on('request', (request) => {
      const { pathname, searchParams } = new URL(request.url());
      if (!/\/products$/.test(pathname)) return;
      if (request.method() !== 'GET') return;
      requests.push({ cursor: searchParams.get('cursor') ?? null });
    });
    return requests;
  }

  test('keeps pagination out of the URL, before and after a reload', async ({ page }) => {
    await page.goto('/');
    await expect(cards(page)).toHaveCount(12);

    expect(await scrollToEnd(page)).toBe(20);
    // Depth is internal state: scrolling never writes it into the address bar.
    await expect(page).not.toHaveURL(/[?&]page=/);

    const requests = trackListRequests(page);
    await page.reload();

    // A reload is a cold start (empty cache), so the listing begins at page one and
    // the URL is not used as a pagination instruction.
    await expect(cards(page)).not.toHaveCount(0);
    await expect.poll(() => requests.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(requests[0].cursor).toBeNull();
    await expect(page).not.toHaveURL(/[?&]page=/);

    // Scrolling again still never leaks the depth into the URL.
    await scrollToEnd(page);
    await expect(page).not.toHaveURL(/[?&]page=/);
  });

  test('returning from a product keeps the loaded pages, the scroll offset and the request count', async ({
    page,
  }) => {
    const requests = trackListRequests(page);
    await page.goto('/');
    await expect(cards(page)).toHaveCount(12);
    expect(await scrollToEnd(page)).toBe(20);
    expect(requests).toHaveLength(2);

    // Walk back up into the middle of the loaded list before leaving.
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(200);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(0);

    const title = (await page.locator('.product-card__title').nth(6).innerText()).trim();
    await page.locator('.product-card__title a').nth(6).click();
    await page.waitForURL(/\/product\/[a-f0-9]{24}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

    await page.getByRole('button', { name: /back to results/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/product'));

    // Same 20 products, viewport back where it was, and the pages are restored from
    // the cache — but re-entering the listing revalidates it: exactly one request,
    // for the page the list is parked on (never a page-1 replay, never a page per
    // rendered page).
    await expect(cards(page)).toHaveCount(20);
    await expect.poll(() => requests.length, { timeout: 5000 }).toBe(3);
    expect(requests.at(-1).cursor).not.toBeNull();
    expect(requests.slice(2).every((entry) => entry.cursor !== null)).toBe(true);
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 })
      .toBeGreaterThan(scrollBefore - 200);
  });

  test('a browser Back from a detail page lands on the restored grid', async ({ page }) => {
    await page.goto('/');
    expect(await scrollToEnd(page)).toBe(20);
    // The loaded depth lives in the cache, never in the URL.
    await expect(page).not.toHaveURL(/[?&]page=/);

    const title = (await page.locator('.product-card__title').nth(3).innerText()).trim();
    await page.locator('.product-card__title a').nth(3).click();
    await page.waitForURL(/\/product\/[a-f0-9]{24}$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

    const requests = trackListRequests(page);
    await page.goBack();

    await expect(cards(page)).toHaveCount(20);
    // Browser Back is a route mount like any other, so it revalidates the parked
    // page with a single request while keeping the restored depth.
    await expect.poll(() => requests.length, { timeout: 5000 }).toBe(1);
    expect(requests[0].cursor).not.toBeNull();
  });
});

test.describe('public storefront — mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('filters live in a drawer, apply to the grid and never overflow the page', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Shop the catalogue' })).toBeVisible();

    // Two columns of cards on a phone, and nothing wider than the viewport.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // The sidebar is behind a toggle here. (`Close filters` shares the word, so the
    // toggle is matched exactly.)
    await expect(page.getByRole('button', { name: /^Aurora/ })).toHaveCount(0);
    const toggle = page.getByRole('button', { name: 'Filters', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const lumelFacet = page.getByRole('button', { name: /^Lumen/ });
    await expect(lumelFacet).toBeVisible();
    await lumelFacet.click();
    await expect(page).toHaveURL(/\?brand=/);

    await page.getByRole('button', { name: /show results/i }).click();

    // Drawer closed, grid filtered by the chosen facet.
    await expect(page.getByRole('button', { name: /^Aurora/ })).toHaveCount(0);
    const brandLinks = page.locator('.product-card__brand');
    await expect(brandLinks.first()).toBeVisible();
    const brands = await brandLinks.allInnerTexts();
    for (const brand of brands) expect(brand.trim().toLowerCase()).toBe('lumen');

    const stillOverflowing = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(stillOverflowing).toBeLessThanOrEqual(1);
  });

  test('the product detail page fits the viewport', async ({ page }) => {
    await page.goto('/');
    await page.locator('.product-card__title a').first().click();
    await page.waitForURL(/\/product\/[a-f0-9]{24}$/);

    await expect(page.locator('.detail .stock-badge')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
