import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, E2E_PASSWORD, SEED_PASSWORD, signIn } from './support/auth.js';

// These specs deliberately start from a clean browser.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('authentication', () => {
  test('an anonymous visitor is sent to the login screen', async ({ page }) => {
    await page.goto('/admin/products');

    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText(/administrator access/i)).toBeVisible();
  });

  test('rejects bad credentials with the server message', async ({ page }) => {
    await signIn(page, { password: 'definitely-wrong' });

    await expect(page.getByRole('alert')).toContainText(/invalid email or password/i);
    expect(new URL(page.url()).pathname).toBe('/login');
  });

  test('the rotated password signs the administrator in', async ({ page }) => {
    await signIn(page, { password: E2E_PASSWORD });

    await page.waitForURL('**/admin');
    await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();
    await expect(page.locator('.stat-card')).toHaveCount(5);
  });

  test('the pre-rotation seed password no longer works', async ({ page }) => {
    await signIn(page, { password: SEED_PASSWORD });

    await expect(page.getByRole('alert')).toContainText(/invalid email or password/i);
    expect(new URL(page.url()).pathname).toBe('/login');
  });

  test('signing out clears the session and re-locks the admin routes', async ({ page }) => {
    await signIn(page, { password: E2E_PASSWORD });
    await page.waitForURL('**/admin');

    await page.getByRole('button', { name: /sign out/i }).click();

    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/admin');
    await page.waitForURL('**/login');
  });
});
