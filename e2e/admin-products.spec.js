import { expect, test } from '@playwright/test';

const PRODUCT_TITLE = 'E2E Smoke Widget';
const PRODUCT_DESCRIPTION =
  'Created by the Playwright suite to prove the multipart write path works end to end.';

test.describe('admin product management', () => {
  test('the dashboard reports exact counts from the API', async ({ page }) => {
    await page.goto('/admin');

    const stats = page.locator('.stat-card__value');
    await expect(stats).toHaveCount(5);
    await expect(
      page.locator('.stat-card', { hasText: 'Products' }).locator('.stat-card__value'),
    ).toHaveText('22');
    await expect(
      page.locator('.stat-card', { hasText: 'Brands' }).locator('.stat-card__value'),
    ).toHaveText('6');
    await expect(
      page.locator('.stat-card', { hasText: 'Categories' }).locator('.stat-card__value'),
    ).toHaveText('6');
    await expect(page.getByRole('heading', { name: /recently added/i })).toBeVisible();
    await expect(page.locator('.table tbody tr')).toHaveCount(5);
  });

  test('the table paginates with the offset contract', async ({ page }) => {
    await page.goto('/admin/products');

    await expect(page.getByText('Page 1 of 3 · 22 result(s)')).toBeVisible();
    await expect(page.locator('.table tbody tr')).toHaveCount(10);

    await page.getByRole('button', { name: 'Next page' }).click();

    await expect(page.getByText('Page 2 of 3 · 22 result(s)')).toBeVisible();
    await expect(page.locator('.table tbody tr')).toHaveCount(10);

    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(page.getByText('Page 1 of 3 · 22 result(s)')).toBeVisible();
  });

  test('search narrows the table and resets to page one', async ({ page }) => {
    await page.goto('/admin/products');
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText('Page 2 of 3 · 22 result(s)')).toBeVisible();

    await page.getByLabel('Search products').fill('lumen');

    // Single page of results: the control collapses to a plain count.
    await expect(page.getByText(/^\d+ result\(s\)$/)).toBeVisible();
    await expect(page.getByText(/Page 2 of/)).toHaveCount(0);

    const rows = await page.locator('.table tbody tr').allInnerTexts();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(10);
    for (const row of rows) expect(row.toLowerCase()).toContain('lumen');
  });

  test('a product can be created with an image and then edited', async ({ page }) => {
    await page.goto('/admin/products/new');

    // Submitting empty surfaces per-field validation and sends nothing.
    await page.getByRole('button', { name: /create product/i }).click();
    await expect(page.getByText('Title is required')).toBeVisible();
    await expect(page.getByText(/fix the highlighted fields/i)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/admin/products/new');

    await page.getByLabel('Title').fill(PRODUCT_TITLE);
    await page.getByLabel('Description').fill(PRODUCT_DESCRIPTION);
    await page.getByLabel('Price (INR)').fill('1499');
    await page.getByLabel('Stock').fill('3');
    await page.getByLabel('Brand').selectOption({ label: 'Aurora' });
    await page.getByLabel('Category').selectOption({ label: 'Accessories' });

    await page.setInputFiles('#image-upload-input', 'e2e/fixtures/product.png');
    await expect(page.getByAltText('Selected product')).toBeVisible();

    await page.getByRole('button', { name: /create product/i }).click();

    await page.waitForURL('**/admin/products');
    await expect(page.getByText(/created/i).first()).toBeVisible();

    // Newest-first ordering puts it at the top, with a real uploaded thumbnail.
    const firstRow = page.locator('.table tbody tr').first();
    await expect(firstRow).toContainText(PRODUCT_TITLE);
    const thumb = firstRow.locator('img.table__thumb');
    await expect(thumb).toBeVisible();
    await expect.poll(() => thumb.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);

    // Edit it: the form must arrive pre-filled from the server.
    await firstRow.getByRole('link', { name: 'Edit' }).click();
    await page.waitForURL(/\/admin\/products\/[a-f0-9]{24}$/);
    await expect(page.getByLabel('Title')).toHaveValue(PRODUCT_TITLE);
    await expect(page.getByText(/editing version/i)).toBeVisible();

    await page.getByLabel('Price (INR)').fill('1999');
    await page.getByRole('button', { name: /save changes/i }).click();

    await page.waitForURL('**/admin/products');
    await expect(page.locator('.table tbody tr').first()).toContainText('₹1,999');
  });

  test('stock can be adjusted by a relative delta', async ({ page }) => {
    await page.goto('/admin/products');
    await page.getByLabel('Search products').fill(PRODUCT_TITLE);
    const row = page.locator('.table tbody tr').filter({ hasText: PRODUCT_TITLE }).first();
    await expect(row).toBeVisible();

    await row
      .getByRole('button', { name: new RegExp(`increase stock for ${PRODUCT_TITLE}`, 'i') })
      .click();

    await expect(page.getByText(/stock for .* is now 4/i)).toBeVisible();
    await expect(row.locator('.badge').first()).toHaveText('4');

    await row
      .getByRole('button', { name: new RegExp(`decrease stock for ${PRODUCT_TITLE}`, 'i') })
      .click();
    await expect(page.getByText(/stock for .* is now 3/i)).toBeVisible();
  });

  test('a product is deleted only after confirmation', async ({ page }) => {
    await page.goto('/admin/products');
    await page.getByLabel('Search products').fill(PRODUCT_TITLE);
    const row = page.locator('.table tbody tr').filter({ hasText: PRODUCT_TITLE }).first();
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: /delete/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(/cannot be undone/i);

    // Cancelling keeps the product.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText(PRODUCT_TITLE)).toBeVisible();

    await row.getByRole('button', { name: /delete/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /delete product/i })
      .click();

    await expect(page.getByText(/deleted/i).first()).toBeVisible();
    await expect(page.getByText(/no products found/i)).toBeVisible();
  });
});
