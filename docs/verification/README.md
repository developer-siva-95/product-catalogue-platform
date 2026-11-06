# Verification: what has been proven, what has not

> **The single rule of this page:** a number here belongs to the run that produced it. Nothing
> on this page was executed on 2026-11-06 — **this workspace has no `node_modules`, no database
> server and no Playwright browsers installed**, so the entire test surface is **NOT VERIFIED
> today**. What follows is a map of the evidence that exists, with its limits stated.

---

## 1. Status legend

| Label                     | Meaning                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **EXECUTED (historical)** | The command was run and the result recorded in the linked report, at the time that report was written. Reproducible; not reproduced here.    |
| **SKIPPED (by design)**   | The suite exists but skips when its prerequisites are absent. `MYSQL_REQUIRE=1` converts those skips into failures, which is the CI posture. |
| **DEFINED, NEVER RUN**    | Configuration exists (e.g. the CI workflow) but there is no evidence of a single execution anywhere.                                         |
| **NOT VERIFIED**          | No evidence exists in this workspace. Treat as unknown.                                                                                      |

## 2. Evidence map

| Area                                                                                                                                           | Last recorded result                                                                                                                                               | Where the record is                                                                                                                                                                                                      | Status today                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Server unit + integration (MongoDB, in-memory `mongodb-memory-server`)                                                                         | Suite recorded as passing at the time of the dual-database programme; per-phase numbers are in each phase report                                                   | [`../implementation/FINAL-IMPLEMENTATION-REPORT.md`](../implementation/FINAL-IMPLEMENTATION-REPORT.md) §6, phase reports                                                                                                 | **NOT VERIFIED** — not re-run                                               |
| MySQL suites (foundation, repositories, contracts, capabilities, concurrency, seed, ops)                                                       | Recorded as passing against a real MySQL 8.0 during the programme                                                                                                  | [`../implementation/phases/PHASE-3-REPORT.md`](../implementation/phases/PHASE-3-REPORT.md) … [`PHASE-7-REPORT.md`](../implementation/phases/PHASE-7-REPORT.md)                                                           | **NOT VERIFIED** + requires a MySQL 8.0 server                              |
| Migration suite (dry run, confirmations, idempotency, rollback)                                                                                | Recorded as passing                                                                                                                                                | [`../database/PHASE-6-REPORT.md`](../database/PHASE-6-REPORT.md) §6                                                                                                                                                      | **NOT VERIFIED**                                                            |
| Cross-provider contract parity                                                                                                                 | Recorded as byte-identical snapshots between providers                                                                                                             | [`../database/provider-default/PROVIDER-DEFAULT-HANDOVER.md`](../database/provider-default/PROVIDER-DEFAULT-HANDOVER.md) §10, [`../implementation/phases/PHASE-4-REPORT.md`](../implementation/phases/PHASE-4-REPORT.md) | **NOT VERIFIED** — the golden baseline is `audit/api-contract-snapshot.mjs` |
| Client suites (Vitest + React Testing Library)                                                                                                 | Recorded as passing                                                                                                                                                | [`VERIFICATION-REPORT.md`](./VERIFICATION-REPORT.md), storefront reports                                                                                                                                                 | **NOT VERIFIED**                                                            |
| Playwright E2E (both providers, run separately)                                                                                                | Recorded as passing per provider                                                                                                                                   | [`../implementation/phases/PHASE-7-REPORT.md`](../implementation/phases/PHASE-7-REPORT.md) §3                                                                                                                            | **NOT VERIFIED** — browsers not installed here                              |
| Audit harnesses (`audit/api-audit.mjs` 56 checks · `browser-audit.mjs` 15 · `runtime-audit.mjs` 9 · responsive · DOM budget · lifecycle probe) | Recorded as passing in that audit session                                                                                                                          | [`VERIFICATION-REPORT.md`](./VERIFICATION-REPORT.md) §3–§6                                                                                                                                                               | **NOT VERIFIED**; their output JSON is git-ignored and regenerated per run  |
| Production build (`npm run build`)                                                                                                             | Recorded as succeeding                                                                                                                                             | [`../verification/storefront/VIRTUALIZATION-COMPLETION-REPORT.md`](./storefront/VIRTUALIZATION-COMPLETION-REPORT.md) §5 and the other storefront reports                                                                 | **NOT VERIFIED**                                                            |
| Lint + format (`npm run lint`, `npm run format:check`)                                                                                         | Recorded as clean in the reports that ran them                                                                                                                     | phase reports (gate sections)                                                                                                                                                                                            | **NOT VERIFIED**                                                            |
| **CI (`.github/workflows/ci.yml`, 5 jobs)**                                                                                                    | **No run has ever been recorded.** The workflow is committed and reviewed; its jobs (mongodb, mysql, contract-parity, windows-scripts, macos-scripts) are untested | [`../implementation/HANDOVER-REPORT.md`](../implementation/HANDOVER-REPORT.md) §3 marks it **NOT VERIFIED**                                                                                                              | **DEFINED, NEVER RUN**                                                      |
| **Windows / macOS execution**                                                                                                                  | The scripts were written to be runner-agnostic and a Windows/macOS CI job exists, but **no evidence of a real Windows or macOS run exists**                        | as above                                                                                                                                                                                                                 | **DEFINED, NEVER RUN**                                                      |
| Storefront URL-state round (`?page=` removal)                                                                                                  | Code + tests updated; **no report and no run recorded**                                                                                                            | root README, `client/src/pages/StorefrontUrlState.test.jsx`                                                                                                                                                              | **NOT VERIFIED**                                                            |
| Admin taxonomy refresh (tags/invalidation)                                                                                                     | Code updated; **no report and no run recorded**                                                                                                                    | `client/src/api/apiSlice.js`                                                                                                                                                                                             | **NOT VERIFIED**                                                            |

### 2.1 Why some suites skip instead of failing

- The MySQL suites **skip** when `MYSQL_TEST_*` is not configured — by design, so
  `npm run verify` needs no MySQL server. `MYSQL_REQUIRE=1` turns that into a failure and is the
  posture used by CI.
- MongoDB is supplied by the test process itself (`mongodb-memory-server` downloads a `mongod`
  binary on first use, cached at `~/.cache/mongodb-binaries`).
- Playwright needs browsers (`npx playwright install`), plus a running API and SPA.

## 3. Reproducing each claim

```bash
npm install                 # nothing is installed in this workspace
npm run setup               # creates server/.env + generates JWT_SECRET

npm run lint && npm run format:check
npm run test:server         # MongoDB in-memory
npm run test:client         # Vitest + RTL
npm run build               # production SPA build

# MySQL-backed suites (need a real MySQL 8.0 and MYSQL_TEST_*)
npm run db:migrate && npm run test:mysql && npm run test:migration

# Browser-level evidence
npm run test:e2e            # Playwright; add :mysql / :mongodb to pin the provider
node audit/api-audit.mjs && node audit/browser-audit.mjs && node audit/runtime-audit.mjs
node audit/api-contract-snapshot.mjs --out /tmp/mongo.json   # with each provider
node audit/api-contract-diff.mjs /tmp/mongo.json /tmp/mysql.json
```

`npm run verify` chains lint + format check + both test suites + build. It does **not** run
MySQL, Playwright or the audit harnesses.

## 4. Screenshots

Screenshots are evidence of **rendering at a point in time**, not of behaviour. They were
captured by the browser audit harness during the rounds that produced the linked reports.

| File                                                                                                                   | Shows                                                                         | Notes                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [`../assets/screenshots/storefront-desktop.png`](../assets/screenshots/storefront-desktop.png)                         | Storefront listing, desktop (1440×950): filters, sort, grid, stock badges     | current era                                                                                                                  |
| [`../assets/screenshots/storefront-mobile.png`](../assets/screenshots/storefront-mobile.png)                           | Storefront listing, mobile (390×844)                                          | current era                                                                                                                  |
| [`../assets/screenshots/product-detail.png`](../assets/screenshots/product-detail.png)                                 | Product detail page (1440×950)                                                | current era                                                                                                                  |
| [`../assets/screenshots/admin-dashboard.png`](../assets/screenshots/admin-dashboard.png)                               | Admin dashboard with counts (1440×950)                                        | current era                                                                                                                  |
| [`../assets/screenshots/admin-products.png`](../assets/screenshots/admin-products.png)                                 | Admin product table with offset pagination (1440×950)                         | current era                                                                                                                  |
| [`../assets/screenshots/admin-brands.png`](../assets/screenshots/admin-brands.png)                                     | Admin brands screen (1440×950)                                                | current era                                                                                                                  |
| [`../assets/screenshots/admin-product-form.png`](../assets/screenshots/admin-product-form.png)                         | Admin product form incl. image upload (1440×900)                              | current era                                                                                                                  |
| [`../assets/screenshots/admin-password-rotation.png`](../assets/screenshots/admin-password-rotation.png)               | **Administrative** forced password rotation on first admin sign-in (1440×950) | administrative auth — **not** a customer feature                                                                             |
| [`../assets/screenshots/legacy/admin-signin.png`](../assets/screenshots/legacy/admin-signin.png)                       | **Administrative** sign-in screen `/login` (1280×900)                         | **legacy** era; shows the development-seed hint banner. Administrative auth only — the storefront has no customer sign-in UI |
| [`../assets/screenshots/legacy/storefront-pre-redesign.png`](../assets/screenshots/legacy/storefront-pre-redesign.png) | Storefront before the later responsive/virtualization rounds (1280×900)       | **legacy**, superseded by `storefront-desktop.png`; kept for provenance                                                      |

No screenshot depicts a customer login, because no such screen exists. Captions say
"administrative" wherever the admin auth stack is visible, so the images cannot be read as a
user-facing login feature.

Harness-produced screenshots (`audit/screenshots/`, `audit/responsive/`) are **not** part of
this documentation: they are git-ignored build artifacts rewritten on every audit run.

## 5. Security findings and follow-ups

- The severity-sorted findings from the regression audit are in
  [`VERIFICATION-REPORT.md`](./VERIFICATION-REPORT.md) §7–§8, with §9 listing the harness
  assumptions that were wrong first and had to be corrected (useful when you re-run them).
- **Open follow-up, deliberately not fixed during the documentation cleanup:**
  `client/src/pages/LoginPage.jsx` renders the _"Local development seed:
  admin@catalogue.com / Admin123!"_ banner **unconditionally** — it is not gated behind
  `import.meta.env.DEV`, so it is also rendered by a production build. Fixing it changes
  application behaviour and therefore needs its own approved change; it is recorded here so it
  is not lost. Until it is fixed, do not describe that banner as a development-only affordance.
- Credentials that must never be committed: `server/.env`, `e2e/.auth/admin.json`
  (a live Playwright session), and any `audit/*.json` output (the lifecycle probe output
  contains a signed token). All are git-ignored; see the cleanup change record for the
  verification limits of that claim.
