import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * The API side honours `DATABASE_PROVIDER`, so the exact same suite runs against
 * a real MySQL test database (default) and against an in-memory MongoDB:
 *
 *   npm run test:e2e           # MySQL — the application default
 *   npm run test:e2e:mongodb   # MongoDB, selected explicitly
 *   npm run test:e2e:mysql     # MySQL, selected explicitly (needs MYSQL_*)
 *
 * Both servers are managed by Playwright:
 *  1. `server/scripts/e2e-server.mjs` — selected provider + seed + API (:5050);
 *  2. the **production** SPA build served by `vite preview` (:4173), proxying
 *     `/api` to the API so cookies stay first-party exactly as in production.
 *
 * The `setup` project signs in and completes the forced password rotation once,
 * then stores the session for every other project — that keeps the admin specs
 * fast while still asserting the real first-login flow.
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 5050);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  // The seeded database is shared, so specs run in a deterministic order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.js/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/admin.json' },
      dependencies: ['setup'],
      // The setup file is not a spec for this project.
      testIgnore: /auth\.setup\.js/,
    },
  ],
  webServer: [
    {
      command: 'node scripts/e2e-server.mjs',
      cwd: './server',
      url: `http://127.0.0.1:${API_PORT}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        E2E_API_PORT: String(API_PORT),
        E2E_WEB_ORIGIN: WEB_ORIGIN,
        // Forwarded explicitly. The fallback matches the application default (MySQL),
        // so a missing variable can never silently select MongoDB; the suffixed scripts
        // (`npm run test:e2e:mongodb` / `:mysql`) always pass it explicitly anyway.
        // The MYSQL_* keys are only forwarded when set: passing empty strings would
        // fail the server's own env validation on a MongoDB run.
        DATABASE_PROVIDER: process.env.DATABASE_PROVIDER ?? 'mysql',
        ...(process.env.MYSQL_HOST
          ? {
              MYSQL_HOST: process.env.MYSQL_HOST,
              MYSQL_PORT: process.env.MYSQL_PORT ?? '',
              MYSQL_USER: process.env.MYSQL_USER ?? '',
              MYSQL_PASSWORD: process.env.MYSQL_PASSWORD ?? '',
              MYSQL_DATABASE: process.env.MYSQL_DATABASE ?? '',
            }
          : {}),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `npm run build && npm run preview -- --port ${WEB_PORT} --strictPort`,
      cwd: './client',
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        VITE_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
        VITE_DEV_ORIGIN: WEB_ORIGIN,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
