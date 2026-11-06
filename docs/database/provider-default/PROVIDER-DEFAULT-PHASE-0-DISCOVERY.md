# Phase 0 — Discovery: MySQL becomes the default provider

**Date:** 2026-11-06 · **Type:** read-only discovery (no writes) · **Scope:** where the
database provider default is decided, and everything that relied on MongoDB being it.

**Approved change under inspection:** an unset/empty `DATABASE_PROVIDER` must resolve to
**`mysql`** (source `default`). `mongodb` stays fully supported but must be selected
explicitly. Any other value is fatal — no fallback. Values are trimmed and case-normalised.
The resolved provider **and its source** are logged; credentials and connection strings are
never logged.

---

## 1. Where the default is decided today

| #   | File:line                            | Expression                                                      | Kind                                 |
| --- | ------------------------------------ | --------------------------------------------------------------- | ------------------------------------ |
| 1   | `server/src/config/env.js:98`        | `z.enum([...]).default('mongodb')`                              | **application default** (authority)  |
| 2   | `server/src/config/env.js` `loadEnv` | `rawEnv.DATABASE_PROVIDER ?? 'mongodb'` (provider-aware checks) | **application default**              |
| 3   | `server/scripts/e2e-server.mjs:20`   | `process.env.DATABASE_PROVIDER ?? 'mongodb'`                    | E2E harness default                  |
| 4   | `server/scripts/setup.mjs:140`       | `requestedProvider ?? env.DATABASE_PROVIDER ?? 'mongodb'`       | setup default                        |
| 5   | `server/scripts/dev.mjs:28` (+ l.12) | `requested ?? process.env.DATABASE_PROVIDER ?? null`            | _no_ default; comment says "mongodb" |
| 6   | `audit/api-contract-snapshot.mjs:27` | `process.env.DATABASE_PROVIDER ?? 'mongodb'`                    | snapshot tool default                |
| 7   | `playwright.config.js` (webServer)   | `DATABASE_PROVIDER: process.env.DATABASE_PROVIDER ?? 'mongodb'` | E2E web-server env                   |

Everything else (`server/src/db/index.js`, `server/src/repositories/index.js`) takes the
provider **from the validated env** or from an explicit argument and never invents a default
— nothing to change there.

## 2. Every site that runs without `DATABASE_PROVIDER`

These inherit whichever default the application has, so each one silently changes provider
when the default flips. Classified by which provider it actually _means_:

**Means MongoDB — must be pinned `mongodb` (preserve existing behaviour):**

| Site                                                                                                               | Why MongoDB                        |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `server/tests/setup.js` (vitest setup, whole default suite)                                                        | in-memory replica set, 27999       |
| `server/package.json` → `test`, `test:coverage`                                                                    | run the whole default suite        |
| root `package.json` → `test` (→ `steps.mjs test:server test:client`)                                               | same suite                         |
| root `package.json` → `verify` (→ `lint format:check test build`)                                                  | same suite                         |
| `server/tests/unit/db-provider.test.js`                                                                            | asserts the resolved provider      |
| `server/tests/unit/env.test.js` (`validRawEnv()`)                                                                  | fixtures assume MongoDB            |
| `audit/api-audit.mjs`                                                                                              | boots a disposable MongoDB         |
| `audit/runtime-audit.mjs` (2 spawns)                                                                               | asserts MongoDB boot/degraded path |
| `audit/browser-audit.mjs`, `audit/dom-budget-audit.mjs`, `audit/responsive-audit.mjs`, `audit/lifecycle-probe.mjs` | spawn `e2e-server.mjs`             |
| `playwright.config.js` (webServer)                                                                                 | E2E harness                        |
| CI jobs `windows-scripts`, `macos-scripts`                                                                         | provision **no** MySQL             |
| CI job `mongodb` (test step)                                                                                       | MongoDB replica set by definition  |
| CI job `contract-parity` → "Snapshot … on MongoDB" (no env today)                                                  | the MongoDB half of the pair       |

**Already explicit (no change needed):** `server/package.json` `test:mysql`,
`test:contracts`, `test:migration`, `start:mongodb|mysql`, `dev:mongodb|mysql`,
`seed:mongodb|mysql`; root `test:mysql`, `test:e2e:mongodb`, `test:e2e:mysql`,
`seed:mongodb`, `dev:mongodb|mysql`, `start:mongodb|mysql`, `setup:mongodb|mysql`;
CI job `mysql` and the "Snapshot … on MySQL" step; `test:e2e:mongodb|mysql`.

**MySQL suites are unaffected either way:** `repositories.mysql`, `contracts.mysql`,
`concurrency.mysql`, `seed.mysql`, `db-capabilities.mysql` bind repositories with
`configureRepositories('mysql')` and use the pool directly; only `ops.mysql.test.js` reads
`DATABASE_PROVIDER` (it skips when it is not `mysql`) — that is the source of the 4 skips in
the default suite.

## 3. What breaks if nothing else changes

1. `env.test.js` fixtures set `MONGO_URI` but no `DATABASE_PROVIDER` → under a MySQL default
   they fail on `MYSQL_USER`/`MYSQL_DATABASE`.
2. `db-provider.test.js` asserts `getProviderName() === 'mongodb'` ("defaults to the MongoDB
   reference provider") → fails.
3. The whole default vitest suite would try MySQL (no Mongoose), and the in-memory MongoDB
   at 27999 would go unused → mass failures.
4. `e2e-server.mjs`, `setup.mjs`, `dev.mjs`, `playwright.config.js` would start MySQL without
   `MYSQL_*` → startup validation errors instead of a MongoDB run.
5. Every audit would spawn an API that wants MySQL → audits fail.
6. The two non-Ubuntu CI jobs (no MySQL provisioning) would fail at startup.
7. Docs claim "mongodb (default)" in `README.md`, `PHASE-7-OPS-RUNBOOK.md`,
   `HANDOVER-REPORT.md`, `FINAL-IMPLEMENTATION-REPORT.md`, `PHASE-7-REPORT.md`.

## 4. Minimal file set

**Application (1 semantic change + 3 log/error enrichments):**
`server/src/config/env.js`, `server/src/db/index.js`, `server/src/db/mysql/provider.js`,
`server/src/server.js`.

**Harness / scripts (explicit pinning, no logic change):** `.env.example`,
`server/scripts/{e2e-server.mjs, setup.mjs, dev.mjs}`, `server/tests/setup.js`,
`server/package.json` (`test`, `test:coverage` only), `playwright.config.js`,
`audit/{api-audit, runtime-audit, browser-audit, dom-budget-audit, responsive-audit,
lifecycle-probe, api-contract-snapshot}.mjs`.

**Tests:** `server/tests/unit/{env, db-provider}.test.js`,
`server/tests/integration/{db-capabilities, mysql-foundation}.test.js`.

**CI (approved: adding `DATABASE_PROVIDER` env values only):** `.github/workflows/ci.yml`.

**Docs:** `README.md`, `PHASE-7-OPS-RUNBOOK.md`, `PHASE-7-REPORT.md`, `HANDOVER-REPORT.md`,
`FINAL-IMPLEMENTATION-REPORT.md`.

## 5. Risks and conflicts

- **Silent inversion.** Any file that sets `MONGO_URI` but not `DATABASE_PROVIDER` now means
  MySQL. Every such site above is pinned, so the inversion is contained — but a _new_ script
  written without a provider variable would inherit MySQL.
- **`playwright.config.js` and `api-contract-snapshot.mjs`** each carried their own MongoDB
  default. Left as-is, a missing variable would keep silently selecting MongoDB — the exact
  failure mode being removed. Both now follow the application default (`mysql`) and the CI
  jobs / suffixed scripts / `test:e2e:mongodb` pass the provider explicitly.
- **`dev.mjs` has no default of its own** (it forwards `null`), so it follows the app — no
  code change beyond its comment and banner text.
- **Health/degradation wording.** Boot-time DB unavailability is fatal for _both_ providers
  (exit 1); `503 degraded` applies to a database lost _after_ boot. Docs were written to that
  distinction, not the reverse.
- **No Docker / no new dependencies / no MariaDB** — untouched. Nothing in this change set
  needs a container or a package.
- **CI may not change beyond env values** — no job, step, timeout, cache, launcher or
  assertion was modified; only `DATABASE_PROVIDER` was added where MongoDB is intended.
