import { expect, test as setup } from '@playwright/test';
import { ADMIN_EMAIL, SEED_PASSWORD, E2E_PASSWORD, field, signIn } from './support/auth.js';

const AUTH_FILE = 'e2e/.auth/admin.json';

/**
 * Authenticates once for the whole run.
 *
 * This doubles as the end-to-end assertion of the first-login experience: a freshly
 * seeded administrator must be redirected to the password screen, cannot skip it,
 * and lands on the dashboard only after rotating the password.
 */
setup(
  'seeded admin is forced to rotate the password, then reaches the dashboard',
  async ({ page }) => {
    await signIn(page, { password: SEED_PASSWORD });

    // The flag must win over the requested destination.
    await page.waitForURL('**/change-password');
    await expect(page.getByRole('heading', { name: /set a new password/i })).toBeVisible();

    // Weak / mismatched input is refused before any request is sent.
    await field(page, 'Current password').fill(SEED_PASSWORD);
    await field(page, 'New password').fill('short');
    await field(page, 'Confirm new password').fill('different');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: /password must be at least 10 characters/i }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/change-password');

    await field(page, 'New password').fill(E2E_PASSWORD);
    await field(page, 'Confirm new password').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Update password' }).click();

    await page.waitForURL('**/admin');
    await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();
    await expect(page.locator('.stat-card')).toHaveCount(5);

    await page.context().storageState({ path: AUTH_FILE });
  },
);
