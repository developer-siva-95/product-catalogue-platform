import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Guard for the approved `/health` change (Phase 7).
 *
 * `/health` now answers **503** when the database is not connected (it used to
 * answer 200 with a degraded body — the response helper overwrote the status set
 * by the route). That is safe only if nothing in the UI consumes the endpoint, so
 * this test makes the claim mechanical instead of a code-review opinion: no file
 * under `client/` or `e2e/` may reference it.
 *
 * The single legitimate consumer is Playwright's `webServer` readiness probe,
 * which requires a 2xx — exactly what a healthy start produces.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE_ROOTS = ['client/src', 'e2e'];

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.(js|jsx|ts|tsx|mjs|cjs|json|html)$/.test(entry.name)) files.push(full);
  }

  return files;
}

describe('/health consumers', () => {
  it('is never called by the SPA or by an E2E spec', async () => {
    const offenders = [];

    for (const root of SOURCE_ROOTS) {
      const files = await walk(path.join(repoRoot, root));
      for (const file of files) {
        const contents = await fs.readFile(file, 'utf8');
        if (/health/i.test(contents)) offenders.push(path.relative(repoRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('is used by the Playwright readiness probe, which requires a 2xx', async () => {
    const config = await fs.readFile(path.join(repoRoot, 'playwright.config.js'), 'utf8');

    expect(config).toMatch(/url:\s*`http:\/\/127\.0\.0\.1:\$\{API_PORT\}\/api\/v1\/health`/);
  });
});
