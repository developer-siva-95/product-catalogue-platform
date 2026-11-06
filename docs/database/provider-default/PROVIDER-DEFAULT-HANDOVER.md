# Handover — Database provider default is now MySQL 8.0 (MongoDB explicit)

**Date:** 2026-11-06 · **Round:** targeted architecture correction · **Status:** implemented +
verified in this sandbox, **awaiting review. Nothing committed** (there is no `.git` in this
workspace, so no commit was possible or attempted).

**The change in one line:** an unset `DATABASE_PROVIDER` now means **Oracle MySQL 8.0** (source
`default`); MongoDB is fully supported but must be selected explicitly; an unsupported value
is fatal instead of falling back.

---

## 1. Purpose and scope

Reverse the previous "never default to a provider" rule as an explicitly approved exception:
MySQL becomes the default, MongoDB becomes explicit. Everything else stays exactly as it was —
dual-provider architecture, repositories, services, controllers, routes, DTOs, migrations,
frontend, auth, dependencies, launchers, `.gitattributes`. No schema, API, ID or cursor
contract change, and therefore no frontend-visible change.

## 2. Provider resolution contract (single source of truth: `server/src/config/env.js`)

| Input                               | Resolved            | Source        |
| ----------------------------------- | ------------------- | ------------- |
| unset                               | `mysql`             | `default`     |
| `''` / `'   '`                      | `mysql`             | `default`     |
| `mysql`, `MySQL`, `' mysql\n'`      | `mysql`             | `environment` |
| `mongodb`, `MONGODB`, `' MONGOdb '` | `mongodb`           | `environment` |
| anything else (`postgres`, `maria`) | — **startup fails** | —             |

Exports: `DEFAULT_DATABASE_PROVIDER = 'mysql'`, `SUPPORTED_DATABASE_PROVIDERS =
['mongodb','mysql']`, `PROVIDER_SOURCES`, `resolveProvider(raw) → { provider, source, invalid }`.
The frozen env object carries `DATABASE_PROVIDER` (normalised) and `DATABASE_PROVIDER_SOURCE`.
Fatal message (observed):

```
Error [EnvValidationError]: Invalid environment configuration:
  - DATABASE_PROVIDER: unsupported value "postgres". Supported values: mongodb, mysql
    (case-insensitive; surrounding whitespace is ignored). An invalid value is fatal — the
    application never falls back to another provider. Leave it unset to use "mysql".
```

Observability — provider **and** source, never credentials or connection strings:

```json
{"msg":"database provider resolved","provider":"mysql","source":"default"}
{"msg":"server listening","provider":"mysql","providerSource":"default","supportedProviders":["mongodb","mysql"],"transactions":true,"port":5099,...}
{"msg":"database capabilities","provider":"mysql","transactions":true,"version":"8.0.44","storageEngine":"InnoDB","isolation":"REPEATABLE-READ"}
```

## 3. Default selection (runtime evidence)

Unsuffixed entry points now select MySQL, verified by running them:

| Command                                | Observed                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `node src/server.js` (env unset)       | `provider resolved mysql / source default`, caps `8.0.44 InnoDB`, listening `providerSource: default` |
| `npm run setup` (`--check`)            | `=== Provider — mysql`                                                                                |
| `npm run dev` (unset)                  | `dev: DATABASE_PROVIDER=(from server/.env, default mysql)`                                            |
| `node audit/api-contract-snapshot.mjs` | `wrote 84 contract snapshots … (provider: mysql)`                                                     |
| `npm run test:e2e` (unset)             | 34/34 passed against MySQL                                                                            |

## 4. Explicit selection and the suffixed commands

Preserved and independently confirmed: `npm run setup:mongodb` → `=== Provider — mongodb
(ok: MONGO_URI=mongodb://127.0.0.1:27017/catalogue)`; `npm run dev:mongodb` → `DATABASE_PROVIDER=mongodb` +
`provider resolved mongodb / source environment`; `npm run dev:mysql`, `start:mysql`,
`start:mongodb`, `seed:mongodb|mysql`, `test:e2e:mongodb|:mysql`, `test:mysql` all still set the
provider through the Node launcher (`server/scripts/with-env.mjs`), unchanged.

`.env.example` now ships `DATABASE_PROVIDER=mysql` with the case/whitespace rules, the
fatal-on-typo rule, the "tests pin their own provider" note and the log-line example.

## 5. Behaviour when the database is unavailable (both providers)

- **Unavailable at boot:** startup fails fast, exit `1`. MySQL message (observed):

  ```
  DatabaseConnectionError: MySQL is the selected database provider (DATABASE_PROVIDER=mysql,
  source: default) but the connection to 127.0.0.1:3398/storefront failed: connect
  ECONNREFUSED 127.0.0.1:3398. Start an Oracle MySQL 8.0 server and check MYSQL_HOST /
  MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE, or select MongoDB explicitly with
  DATABASE_PROVIDER=mongodb. The application will not fall back to another database.
  ```

  MongoDB's equivalent (`MongooseServerSelectionError`) is unchanged. No silent switch.

- **Lost after a successful boot:** process stays up, `GET /api/v1/health` → **503** with
  `database: "disconnected"` (approved; unchanged). Path is `/api/v1/health`, never `/health`.

## 6. Provider isolation — runtime evidence, both directions

Instrumented run counting driver-level initialisation (`mongoose.connect`, `mysql2.createPool`)
through the same facade the API uses:

| Selected  | `getProviderName()` | `mongoose.connect` calls | `mongoose.connection.readyState` | `mysql2.createPool` calls | `isPoolCreated()` | Capabilities                              |
| --------- | ------------------- | ------------------------ | -------------------------------- | ------------------------- | ----------------- | ----------------------------------------- |
| `mysql`   | `mysql`             | **0**                    | **0 (disconnected)**             | 1                         | true              | `{provider: mysql, transactions: true}`   |
| `mongodb` | `mongodb`           | 1                        | 1 (connected)                    | **0**                     | **false**         | `{provider: mongodb, transactions: true}` |

(The single MySQL connection reported in the MongoDB row's process list is the _measuring_
connection the evidence script opens to count threads — the application created no pool.)

This is also asserted permanently in the suite (§8).

## 7. CI changes — additive env values only

`.github/workflows/ci.yml`, three touches, nothing else:

1. `windows-scripts` job `env:` → `DATABASE_PROVIDER: mongodb` (+ explanatory comment). Those
   runners provision no MySQL.
2. `macos-scripts` job `env:` → `DATABASE_PROVIDER: mongodb` (same reason).
3. `contract-parity` → step "Snapshot the API contract on MongoDB" → `env: DATABASE_PROVIDER:
mongodb` (the MySQL step already had `mysql`).

No job, step, assertion, timeout, cache, matrix, launcher or dependency version changed. The
`mongodb` and `mysql` Ubuntu jobs already carried correct values and are untouched.

## 8. Test matrix (every required case)

| Requirement                                   | Where it is asserted                                                                          | Result              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------- |
| unset → MySQL (source `default`)              | `env.test.js` "selects MySQL when DATABASE_PROVIDER is unset"                                 | pass                |
| `mysql` → MySQL (source `environment`)        | `env.test.js`                                                                                 | pass                |
| `MySQL` / `' mysql\n'` / `MONGODB` normalised | `env.test.js` "normalises case and surrounding whitespace"                                    | pass                |
| `mongodb` → MongoDB                           | `env.test.js`                                                                                 | pass                |
| `invalid` → fatal, message lists values       | `env.test.js` "fails startup on an unsupported value"                                         | pass                |
| empty value = unset, not invalid              | `env.test.js` + `resolveProvider('')`                                                         | pass                |
| default drives MySQL-only validation          | `env.test.js` "treats the unset default as MySQL…"                                            | pass                |
| MySQL selected → no Mongoose connection       | `mysql-foundation.test.js` "connecting the application to MySQL leaves Mongoose disconnected" | pass (`test:mysql`) |
| MongoDB selected → no MySQL pool              | `db-capabilities.test.js` "never opens a MySQL pool while MongoDB is the selected provider"   | pass                |
| facade reports the chosen provider            | `db-provider.test.js` (replaces the old MongoDB-default assertion)                            | pass                |
| MySQL-failure message names MySQL             | §5, observed output                                                                           | pass                |
| suffix commands work / unsuffixed = MySQL     | §3, §4, observed output                                                                       | pass                |
| existing MongoDB tests still pass             | full default suite, `test:contracts`, `test:migration`                                        | pass                |

## 9. Regression gate — measured results

| Gate                                   | Result                                                                                         | Before → after |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------- |
| `npm run lint`                         | **0 errors**, 5 warnings (all pre-existing, in untouched client form code)                     | unchanged      |
| `npx prettier --check .`               | **All matched files use Prettier code style**                                                  | clean          |
| `npm run test:server` (MongoDB pinned) | **658 passed / 5 skipped / 0 failed**, 44 files                                                | 649/4 → 658/5  |
| `npm run test:mysql`                   | **85 passed / 0 failed**, 7 files                                                              | 84 → 85        |
| `npm run test:contracts`               | **72 passed / 0 failed**, 4 files                                                              | 71 → 72        |
| `npm run test:migration`               | **15 passed / 0 failed**                                                                       | 15 → 15        |
| `npm run test:client`                  | **284 passed / 0 failed**, 24 files                                                            | unchanged      |
| `npm run build`                        | ✓ 161 modules transformed                                                                      | unchanged      |
| `npm run verify`                       | **All 4 step(s) passed: lint, format:check, test, build**                                      | pass           |
| `npm run launcher:check`               | **EXIT 0**                                                                                     | pass           |
| E2E MongoDB (`test:e2e:mongodb`)       | **34/34 passed (1.3 m)** — re-run after the `playwright.config.js` change                      | 34 → 34        |
| E2E MySQL (`test:e2e:mysql`)           | **34/34 passed (1.3 m)**                                                                       | 34 → 34        |
| E2E unset → MySQL (`npm run test:e2e`) | **34/34 passed (1.3 m)**                                                                       | new case       |
| `audit/api-audit.mjs`                  | **56 passed, 0 failed** (fixtures: 22 products / 6 brands / 6 categories)                      | 56 → 56        |
| `audit/runtime-audit.mjs`              | **9 passed, 0 failed**                                                                         | 9 → 9          |
| `audit/browser-audit.mjs`              | **15 passed, 0 failed**                                                                        | 15 → 15        |
| `audit/dom-budget-audit.mjs`           | **PASS (11 checks)**, console errors 0, `virtualized=true`, `mounted<=28`                      | 11 → 11        |
| `audit/responsive-audit.mjs`           | 4 viewports clean — columns 4/…/2 as expected, `overflow=0px`, `smallTaps=0`, no a11y findings | unchanged      |
| `audit/lifecycle-probe.mjs`            | exit 0, `consoleErrors: []`                                                                    | unchanged      |

**Test-count deltas only go up. No test was deleted, renamed or skipped.** 8 new
provider-resolution cases in `env.test.js` (14 → 22), 1 new isolation case each in
`db-capabilities.test.js` (7 → 8) and `mysql-foundation.test.js`; the old "defaults to the
MongoDB reference provider" assertion was _replaced in place_ by a stronger one ("binds the
provider selected for this process"), so `db-provider.test.js` neither grew nor shrank.
The 5 skips in the default suite are 4 × `ops.mysql.test.js` (MySQL-only, by design) plus the
new MySQL isolation case; all five execute and pass under `npm run test:mysql`.

## 10. API contract snapshots — byte-identical on both providers

Three snapshots, 84 entries each (`audit/api-contract-snapshot.mjs`,
`audit/api-contract-diff.mjs`):

| Snapshot                               | Entries | Diff verdict                                                                        |
| -------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `DATABASE_PROVIDER=mongodb` (explicit) | 84      | —                                                                                   |
| `DATABASE_PROVIDER=mysql` (explicit)   | 84      | `CONTRACT STABLE: every entry is byte-identical (status, key order, types, values)` |
| unset (resolves to MySQL)              | 84      | `CONTRACT STABLE` vs the MongoDB snapshot                                           |

Entries hash identical across all three runs:
`sha256(canonical entries) = c082869d0fbfa084a2fa4803239524a64f232be62f16d337be40a89ecc1a589a`.
Only `generatedAt` / `provider` / `node` metadata differ between files, as before. No entry
changed, no assertion weakened.

## 11. Documentation

- `README.md` — new **"Choosing a database"** section: MySQL default, the resolution table,
  case/whitespace rules, fatal-on-typo, provider+source logging, isolation, boot-failure vs
  runtime-loss behaviour, and the note that tests/CI never rely on the default. Quick start
  rewritten MySQL-first with MongoDB as the explicit alternative; script table updated.
- `.env.example` — `DATABASE_PROVIDER=mysql`, rules and examples.
- `PHASE-7-OPS-RUNBOOK.md` — "mysql (default) | mongodb", provider+source log lines, unsuffixed
  startup assumes a reachable Oracle MySQL 8.0, new incident rows (unsupported value,
  `MONGO_URI` missing while MongoDB is selected), corrected health wording.
- `PHASE-7-REPORT.md`, `FINAL-IMPLEMENTATION-REPORT.md`, `HANDOVER-REPORT.md` — stale
  "mongodb (default)" wording corrected; the Phase 7 report keeps its historical numbers and
  carries a one-line note that the harness default has since been superseded.
- `PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md` — the Phase 0 discovery report.

No contradictory "MongoDB is default" text remains (grep-verified).

## 12. Every file changed

**Application (4):** `server/src/config/env.js`, `server/src/db/index.js`,
`server/src/db/mysql/provider.js`, `server/src/server.js`.

**Scripts / harness / config (9):** `.env.example`, `server/scripts/e2e-server.mjs`,
`server/scripts/setup.mjs`, `server/scripts/dev.mjs`, `server/tests/setup.js`,
`server/package.json` (**scripts `test` and `test:coverage` only**), `playwright.config.js`,
`audit/api-contract-snapshot.mjs`, `.github/workflows/ci.yml`.

**Audit harnesses (6):** `audit/api-audit.mjs`, `audit/runtime-audit.mjs`,
`audit/browser-audit.mjs`, `audit/dom-budget-audit.mjs`, `audit/responsive-audit.mjs`,
`audit/lifecycle-probe.mjs`.

**Tests (4):** `server/tests/unit/env.test.js`, `server/tests/unit/db-provider.test.js`,
`server/tests/integration/db-capabilities.test.js`,
`server/tests/integration/mysql-foundation.test.js`.

**Docs (5 edited + 2 new):** `README.md`, `PHASE-7-OPS-RUNBOOK.md`, `PHASE-7-REPORT.md`,
`HANDOVER-REPORT.md`, `FINAL-IMPLEMENTATION-REPORT.md`; new
`PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md`, `PROVIDER-DEFAULT-HANDOVER.md` (this file).

**Regenerated as a side effect of running the gates (not edited by hand):**
`audit/api-audit-results.json`, `audit/runtime-audit-results.json`,
`audit/browser-audit-results.json`, `audit/dom-budget.json`, `audit/responsive-audit.json`,
`audit/lifecycle-probe.json`, `client/dist/**`.

**Not touched:** any repository/service/controller/route/DTO/middleware, `client/src/**`
(except the rebuilt `dist`), migrations, seeds, `eslint.config.js`, `.gitattributes`,
`server/scripts/with-env.mjs`, `server/scripts/steps.mjs`, the `launcher:*` scripts, root
`package.json` (left exactly as the previous round approved it), lockfiles.

## 13. No dependency changes — confirmed

`dependencies` / `devDependencies` blocks in all three `package.json` files are untouched; no
package was added, removed, upgraded or pinned; `package-lock.json` was not regenerated and
`npm install`/`npm ci` was not run as part of this change set. The only `package.json`
edit is the _body_ of two existing scripts (`server` `test`, `test:coverage`), which now route
through the already-existing `server/scripts/with-env.mjs` launcher. No Docker, no Compose, no
containers, no WSL — native Oracle MySQL 8.0 and native MongoDB remain the only requirements.

## 14. Verification status — honest labelling

| Item                                                                   | Status                                                                                                                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| MySQL-default resolution, invalid-value failure, isolation (both ways) | **Verified** in this sandbox                                                                                                                    |
| Full regression gate (§9)                                              | **Verified** in this sandbox                                                                                                                    |
| Snapshots byte-identical, both providers                               | **Verified**                                                                                                                                    |
| MySQL version                                                          | **Verified in a sandbox-provisioned Oracle MySQL 8.0.44; pending a rerun on the owner's machine or in CI.** Not a claim about any other install |
| `.github/workflows/ci.yml` (all five jobs)                             | **NOT VERIFIED** — no CI run was triggered from here; the file is YAML-validated locally only                                                   |
| Windows and macOS execution                                            | **NOT VERIFIED** — no such host, no Docker allowed. Their jobs now pin `DATABASE_PROVIDER=mongodb` but have never run                           |
| Native Windows/macOS MySQL 8.0, MongoDB, or Playwright installs        | **NOT VERIFIED** — documented only                                                                                                              |
| `launcher:check`                                                       | **Verified locally (exit 0)**; the Windows/macOS job claim remains unverified until a run exists                                                |
| `MONGOMS_VERSION=7.0.14` + mongod-cache mitigation                     | **Applied, not verified**                                                                                                                       |

**Review checklist before anything is committed:** confirm the Windows/macOS CI jobs are run
at least once; confirm the owner's own MySQL 8.0 install (native, not this sandbox's 8.0.44)
boots the unsuffixed `npm run dev`; confirm the `.env` files on real machines either carry an
explicit `DATABASE_PROVIDER` or intentionally rely on the new MySQL default.

## 15. Approved architecture decision — tool-level MySQL defaults

**Status: approved by the owner (2026-11-06) as an explicit scope extension. This is a
deliberate decision, not an accidental deviation.**

During the final review the two tool-level fallbacks below were flagged as going slightly
beyond "add explicit `DATABASE_PROVIDER=mongodb` where MongoDB is intended". The owner has
ratified them as they stand. They are recorded here so the intent survives future readers.

### 15.1 The two tool defaults stay as changed

| File                                     | Tool-level default                                                | Why it stays                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playwright.config.js` (webServer `env`) | `DATABASE_PROVIDER: process.env.DATABASE_PROVIDER ?? 'mysql'`     | The E2E harness must follow the application's MySQL default. Left at `'mongodb'`, a bare `npx playwright test` would silently override the application default — the exact "accidental provider selection caused by a missing environment variable" this round removes. |
| `audit/api-contract-snapshot.mjs`        | `(process.env.DATABASE_PROVIDER ?? 'mysql').trim().toLowerCase()` | Same reasoning: a missing variable must never silently produce a MongoDB snapshot. Unset now means MySQL, and an invalid value exits `2` with a usage message.                                                                                                          |

Both files are **not** to be modified further; the architecture decision is that the tool
defaults mirror `DEFAULT_DATABASE_PROVIDER` in `server/src/config/env.js`.

### 15.2 MongoDB is still always selected explicitly

Every context that _means_ MongoDB names it, so the tool defaults never decide this:

- **Tests:** `server/tests/setup.js` (`??= 'mongodb'`), `server/package.json` `test` and
  `test:coverage` (via `server/scripts/with-env.mjs`), and therefore root `npm run test` and
  `npm run verify`.
- **Scripts:** `dev:mongodb`, `start:mongodb`, `seed:mongodb`, `setup:mongodb`,
  `test:e2e:mongodb` — all through the existing `with-env.mjs` launcher.
- **Audit harnesses:** `api-audit.mjs`, `runtime-audit.mjs` (both spawns), `browser-audit.mjs`,
  `dom-budget-audit.mjs`, `responsive-audit.mjs`, `lifecycle-probe.mjs` — hard-coded
  `DATABASE_PROVIDER: 'mongodb'`.
- **CI:** the `mongodb` job's test step, the Windows and macOS jobs, and the
  "Snapshot the API contract on MongoDB" step in `contract-parity`.

### 15.3 What this means in practice

- An unset variable means MySQL everywhere: application, E2E harness, snapshot tool.
- MongoDB requires `DATABASE_PROVIDER=mongodb` (or a `:mongodb` script).
- No fallback in either direction; an unsupported value is fatal at startup.

## 16. Existing `.env` files — compatibility note

This change alters the meaning of a **missing** variable, which is the one thing an existing
`.env` file cannot protect itself against. Read this before upgrading a working checkout.

- **An existing `.env` without `DATABASE_PROVIDER` now resolves to MySQL** (`source: default`,
  logged at boot as `{"msg":"database provider resolved","provider":"mysql","source":"default"}`).
- **Developers whose local setup uses MongoDB must set `DATABASE_PROVIDER=mongodb`** in
  `server/.env`, or use the explicit commands: `npm run dev:mongodb`, `npm run start:mongodb`,
  `npm run seed:mongodb`, `npm run setup:mongodb`, `npm run test:e2e:mongodb`.
- **The application does not fall back to MongoDB automatically.** If MySQL is selected and
  unreachable, startup fails with exit `1` and a message naming MySQL — it never tries the
  other provider.
- **Existing `.env` files are not modified automatically.** Nothing rewrites them:
  `npm run setup` reports `ok: server/.env already exists (left untouched)`, `.env.example` is
  only a template, and no migration or upgrade step edits an existing file. Adding the line is
  a deliberate, one-time, manual edit.

Shortest remedy for a MongoDB-based local setup:

```dotenv
# server/.env
DATABASE_PROVIDER=mongodb
MONGO_URI=mongodb://127.0.0.1:27017/catalogue
```

Nothing else in an existing `.env` needs to change, and no `MYSQL_*` values are required while
MongoDB is selected (they stay inert).

**Nothing is committed. No further change will be made without review.**
