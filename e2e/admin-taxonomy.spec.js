import { expect, test } from '@playwright/test';

const BRAND_NAME = 'Zephyr';

test.describe('admin taxonomy', () => {
  test('brands can be created, renamed and deleted', async ({ page }) => {
    await page.goto('/admin/brands');

    await expect(page.getByRole('heading', { name: 'Brands' })).toBeVisible();
    await expect(page.locator('.taxonomy-list li')).toHaveCount(6);

    await page.getByRole('button', { name: /new brand/i }).click();
    const createDialog = page.getByRole('dialog');
    await createDialog.getByLabel('Name').fill(BRAND_NAME);
    await createDialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText(/created/i).first()).toBeVisible();
    await expect(page.locator('.taxonomy-list li')).toHaveCount(7);
    const row = page.locator('.taxonomy-list li', { hasText: BRAND_NAME });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Edit' }).click();
    const editDialog = page.getByRole('dialog');
    await expect(editDialog.getByLabel('Name')).toHaveValue(BRAND_NAME);
    await editDialog.getByLabel('Name').fill(`${BRAND_NAME} Labs`);
    await editDialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText(/updated/i).first()).toBeVisible();
    await expect(
      page.locator('.taxonomy-list li', { hasText: `${BRAND_NAME} Labs` }),
    ).toBeVisible();

    await page
      .locator('.taxonomy-list li', { hasText: `${BRAND_NAME} Labs` })
      .getByRole('button', { name: 'Delete' })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /delete brand/i })
      .click();

    await expect(page.locator('.taxonomy-list li')).toHaveCount(6);
  });

  test('a brand that products still reference cannot be deleted', async ({ page }) => {
    await page.goto('/admin/brands');

    const aurora = page.locator('.taxonomy-list li', { hasText: 'Aurora' }).first();
    await aurora.getByRole('button', { name: 'Delete' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /delete brand/i })
      .click();

    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText(/is used by .* product/i)).toBeVisible();
    await expect(page.locator('.taxonomy-list li', { hasText: 'Aurora' }).first()).toBeVisible();
  });

  test('categories are listed with their product counts', async ({ page }) => {
    await page.goto('/admin/categories');

    await expect(page.getByRole('heading', { name: 'Categories' })).toBeVisible();
    await expect(page.locator('.taxonomy-list li')).toHaveCount(6);
    await expect(page.locator('.taxonomy-list__meta').first()).toContainText(/product\(s\)/);
  });
});
