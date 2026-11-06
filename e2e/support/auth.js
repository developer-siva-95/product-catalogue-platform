/** Shared credentials and auth flows used by the Playwright specs. */
export const ADMIN_EMAIL = 'admin@catalogue.com';
/** Public development seed value; the account is flagged `mustChangePassword`. */
export const SEED_PASSWORD = 'Admin123!';
/** Password the `setup` project rotates the seeded admin to. */
export const E2E_PASSWORD = 'E2eRotated!2026';

/**
 * Signs in through the UI.
 * @param {import('@playwright/test').Page} page
 * @param {{ email?: string, password: string }} credentials
 */
/**
 * Resolves a labelled input by its accessible name.
 *
 * `getByLabel` matches label *text*, and every label ends with a decorative
 * mandatory marker ("Password *") while "Confirm new password" contains
 * "password" — so role + exact accessible name is the unambiguous selector.
 */
export function field(page, name) {
  return page.getByRole('textbox', { name, exact: true });
}

export async function signIn(page, { email = ADMIN_EMAIL, password }) {
  await page.goto('/login');
  await field(page, 'Email').fill(email);
  await field(page, 'Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/**
 * Completes the forced first-login rotation.
 * @param {import('@playwright/test').Page} page
 */
export async function completePasswordRotation(
  page,
  { currentPassword = SEED_PASSWORD, newPassword = E2E_PASSWORD } = {},
) {
  await field(page, 'Current password').fill(currentPassword);
  await field(page, 'New password').fill(newPassword);
  await field(page, 'Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Update password' }).click();
  await page.waitForURL('**/admin');
}
