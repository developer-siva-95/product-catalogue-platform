# Storefront — MongoDB → MySQL migration: final handover

**Date:** 2026-11-06 · **Scope:** Phases 0–7 accepted · **Providers:** MongoDB (reference) and MySQL 8.0
**Posture:** the local workflow is documented for **native Windows (PowerShell) and Linux**, with no Docker, containers, WSL or bash required to develop or run this application. _Windows and macOS execution is **NOT VERIFIED** until the corresponding CI job or your own run passes (§3)._

| Label                                   | Applies to                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VERIFIED (Linux)**                    | every npm script, the full gate set, both providers' E2E, snapshots, audits — executed in this session (§2.6)                                                  |
| **NOT VERIFIED (Windows)**              | the same scripts under Windows PowerShell; no Windows machine was available to this build. §1 is the script that turns it into VERIFIED.                       |
| **NOT VERIFIED**                        | `.github/workflows/ci.yml` — never executed; no runner in this environment. Includes the new `scripts (windows-latest)` and `scripts (macos-latest)` jobs (§3) |
| **NOT VERIFIED (win/mac DB + browser)** | native MySQL, MongoDB and Playwright on Windows or macOS — no CI job covers them (§3.2)                                                                        |
| **MySQL: sandbox-qualified**            | verified in a sandbox-provisioned **8.0.44**; pending a rerun on your machine or in CI                                                                         |
| **OUTSTANDING OPS WORK**                | production-scale performance, backup/restore drill, replication/failover (§5) — not completed work                                                             |
| Overall completion claim                | **none** — per-requirement status is §4                                                                                                                        |

Companions: `FINAL-IMPLEMENTATION-REPORT.md` (narrative report, §7 per-provider status, §8 limitations), `PHASE-7-REPORT.md` (review-round evidence), `PHASE-6-MIGRATION-RUNBOOK.md`, `PHASE-7-OPS-RUNBOOK.md` (operator procedures).

---

## 1. Owner verification checklist (Windows PowerShell)

Copy-paste, top to bottom. Every command below is PowerShell — no `VAR=value cmd`, no `export`, no `&&`, no `rm -rf`, no Docker. Run from the repository root unless a step says otherwise.

> **These exact steps are NOT VERIFIED on Windows.** They are the Windows equivalent of what _was_ verified on Linux (§2.6). If a command fails, the failure is as likely to be the doc as the code — send me the output before improvising.

### 1.1 Prerequisites

```powershell
node -v          # must be >= 22.22.0 (package.json "engines")
npm -v
git --version
```

If Node is missing: `winget install OpenJS.NodeJS.LTS` (reopen the terminal afterwards).
Then, once, from the repo root:

```powershell
npm ci
npx playwright install chromium
```

`npx playwright install --with-deps` is the Linux form; on Windows the browser ships with its own dependencies and the plain `install` is enough.

### 1.2 MySQL 8.0, natively on Windows

**Install (either path):**

- _Installer (recommended):_ download **MySQL Installer for Windows** from <https://dev.mysql.com/downloads/installer/>, choose **Server only → MySQL Server 8.0**, and in the configuration step keep authentication as `caching_sha2_password` (the `mysql2` driver supports it) and set a root password you control.
- _Package manager:_ `winget install Oracle.MySQL` — on some machines this installs the _Installer_, not the server; verify with `Get-Service MySQL80` afterwards.

**Put the client on PATH** (adjust the version if different) and start the service:

```powershell
$mysqlBin = 'C:\Program Files\MySQL\MySQL Server 8.0\bin'
$env:Path = "$mysqlBin;$env:Path"                       # this terminal
[Environment]::SetEnvironmentVariable('Path', "$mysqlBin;" + [Environment]::GetEnvironmentVariable('Path','Machine'), 'Machine')  # permanent

Get-Service MySQL80 | Start-Service
Get-Service MySQL80 | Select-Object Status, Name
```

**utf8mb4, server-wide.** Add or confirm these under `[mysqld]` in `C:\ProgramData\MySQL\MySQL Server 8.0\my.ini`, then restart the service:

```ini
[mysqld]
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
```

```powershell
Restart-Service MySQL80
mysql -u root -p -e "SELECT @@version AS version, @@character_set_server AS charset, @@collation_server AS collation, @@transaction_isolation AS isolation;"
```

Expect `8.0.x`, `utf8mb4`, `utf8mb4_0900_ai_ci`, `REPEATABLE-READ`.

**Databases and least-privilege users.** Paste the whole block; it prompts once for the root password:

```powershell
@"
CREATE DATABASE IF NOT EXISTS storefront          CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS storefront_it_test  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS storefront_e2e_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- schema changes + the data migration
CREATE USER IF NOT EXISTS 'storefront_migrator'@'localhost' IDENTIFIED BY '<migrator-password>';
GRANT ALL PRIVILEGES ON ``storefront``.*          TO 'storefront_migrator'@'localhost';
GRANT ALL PRIVILEGES ON ``storefront_it_test``.*  TO 'storefront_migrator'@'localhost';
GRANT ALL PRIVILEGES ON ``storefront_e2e_test``.* TO 'storefront_migrator'@'localhost';

-- the running API: DML only, no DDL
CREATE USER IF NOT EXISTS 'storefront_app'@'localhost' IDENTIFIED BY '<app-password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON ``storefront``.* TO 'storefront_app'@'localhost';

FLUSH PRIVILEGES;
SELECT user, host FROM mysql.user WHERE user LIKE 'storefront%';
"@ | mysql -u root -p
```

Replace `<migrator-password>` and `<app-password>` with your own values (they go into `server/.env`, which is gitignored). The runtime user is deliberately least-privilege: if the API needs DDL at runtime, that is a bug, not a permission problem.

### 1.3 MongoDB as a single-node replica set (transactions need it)

A standalone `mongod` cannot run multi-document transactions, and the capability probe will correctly report `transactions: false`. Install **MongoDB Community Server 7.x** from <https://www.mongodb.com/try/download/community> (MSI) or `winget install MongoDB.Server`; if you want `mongodump`/`mongorestore` you also need **MongoDB Command Line Database Tools** (a separate download).

Start it as a replica set in its own terminal (keep this window open), or install it as a service:

```powershell
New-Item -ItemType Directory -Force C:\data\db, C:\data\log | Out-Null

# foreground: one terminal, leave it running
mongod --dbpath C:\data\db --logpath C:\data\log\mongod.log --port 27017 --bind_ip 127.0.0.1 --replSet rs0
```

In a **second** terminal, initialise the set — once only — and confirm it:

```powershell
mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"
mongosh --eval "db.hello().isWritablePrimary"     # expect true
mongosh --eval "rs.status().ok"                   # expect 1
```

**Prove transactions really work** (this is what the app's probe checks):

```powershell
mongosh "mongodb://127.0.0.1:27017/catalogue?replicaSet=rs0" --eval "const s=db.getMongo().startSession(); s.startTransaction(); s.getDatabase('catalogue').probe.insertOne({_id:'probe'}); s.abortTransaction(); print('transactions OK — aborted cleanly')"
```

And through the application's own capability probe — the seed run prints it:

```powershell
npm run seed      # look for: "database capabilities" ... "transactions": true
```

If that says `false`, the URI is missing `?replicaSet=rs0` or `rs.initiate()` has not run.

### 1.4 `server/.env` for each provider (placeholders only)

```powershell
Copy-Item .env.example server\.env        # or: npm run setup  (creates it and generates JWT_SECRET)
notepad server\.env
```

**MongoDB provider** — the values that matter:

```ini
DATABASE_PROVIDER=mongodb
MONGO_URI=mongodb://127.0.0.1:27017/catalogue?replicaSet=rs0
JWT_SECRET=<64-byte random hex>          # node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
PORT=5000
FRONTEND_URL=http://localhost:5173
```

**MySQL provider** — the values that matter:

```ini
DATABASE_PROVIDER=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=storefront_app
MYSQL_PASSWORD=<app-password>
MYSQL_DATABASE=storefront
MYSQL_CONNECTION_LIMIT=10
JWT_SECRET=<64-byte random hex>
PORT=5000
FRONTEND_URL=http://localhost:5173
```

Do not put real production credentials in this file; it is for local development only.

### 1.5 Switching providers (no code, no branch, no Docker)

```powershell
npm run dev          # both processes, provider from server/.env (default mysql)
npm run dev:mongodb  # force MongoDB for API + SPA
npm run dev:mysql    # force MySQL for API + SPA
npm run start:mongodb
npm run start:mysql
```

These four `:*` scripts go through `server/scripts/with-env.mjs`, a Node launcher, so they set `DATABASE_PROVIDER` the same way in PowerShell, cmd.exe and bash. One terminal, both processes, `Ctrl+C` stops both.

### 1.6 Setup, migrations and seeding — per provider

```powershell
# one command: create server/.env (if missing), migrate if MySQL, then seed
npm run setup:mongodb
npm run setup:mysql
# or, provider from server/.env / an explicit argument:
npm run setup
node server/scripts/setup.mjs --check      # report only, change nothing
```

Explicit steps, when you want them:

```powershell
# ---- MongoDB: schemaless, nothing to migrate
npm run seed                 # 6 categories / 6 brands / 22 products / 1 admin

# ---- MySQL: schema first, then data
npm run db:status            # migration ledger
npm run db:migrate:dry-run   # what would be applied, writes nothing
npm run db:migrate           # apply 001_init + 002_categories_image_nullable
npm run seed:mysql           # same 6 / 6 / 22 / 1 fixture set
```

Both seeders are idempotent — run them twice and the counts stay at 6 brands, 6 categories, 22 products, 1 admin (pinned by tests).

### 1.7 Tests — each command, then the full gate set

The MySQL suites are a **failure**, not a skip, when no server is reachable: `MYSQL_REQUIRE=1` is baked into the script. Only the test credentials need to come from your shell:

```powershell
$env:MYSQL_TEST_HOST='127.0.0.1'
$env:MYSQL_TEST_PORT='3306'
$env:MYSQL_TEST_USER='storefront_migrator'
$env:MYSQL_TEST_PASSWORD='<migrator-password>'
$env:MYSQL_TEST_DATABASE='storefront_it_test'

npm run test:mysql        # → 7 files, 84 passed, 0 skipped
npm run test:contracts    # → 4 files, 71 passed (both providers)
npm run test:migration    # → 15 passed (messy fixture, dry run, confirmations, idempotency, rollback)
```

Full gate set (each command, in the order the build runs them):

```powershell
npm run lint          # 0 errors, 5 pre-existing warnings
npm run format:check  # Prettier clean
npm run test          # server suite + client suite
npm run build         # client production build
npm run verify        # all four, in sequence, stopping at the first failure
```

Audits (each needs a seeded database and free ports; they open their own browser session):

```powershell
node audit/dom-budget-audit.mjs
node audit/responsive-audit.mjs
node audit/api-audit.mjs
node audit/runtime-audit.mjs
node audit/browser-audit.mjs
node audit/lifecycle-probe.mjs
```

Contract snapshots, one per provider, then the diff:

```powershell
node audit/api-contract-snapshot.mjs --out C:\temp\mongo.json
$env:DATABASE_PROVIDER='mysql'
node audit/api-contract-snapshot.mjs --out C:\temp\mysql.json
node audit/api-contract-diff.mjs C:\temp\mongo.json C:\temp\mysql.json   # expect CONTRACT STABLE
Remove-Item Env:\DATABASE_PROVIDER
```

### 1.8 Playwright E2E, once per provider

```powershell
# (a) MongoDB
npm run test:e2e:mongodb
#     expect 34 passed; the harness prints: provider: mongodb … transactions: false
#     (standalone in-memory mongod; transaction proof lives in the integration suites)

# (b) MySQL — needs the runtime MySQL variables and storefront_e2e_test to exist
$env:MYSQL_HOST='127.0.0.1'; $env:MYSQL_PORT='3306'
$env:MYSQL_USER='storefront_migrator'; $env:MYSQL_PASSWORD='<migrator-password>'
$env:MYSQL_DATABASE='storefront_e2e_test'
npm run test:e2e:mysql
#     expect 34 passed; the harness prints: provider: mysql … transactions: true
```

The harness refuses a MySQL database whose name does not end in `_test`, and rebuilds it from the migration files before the run. Add `-- --reporter=list` for per-spec output.

### 1.9 Migration dry run against a **copy** of your data

Reads a copy; writes nothing — not to production, not to the target.

```powershell
$work = 'C:\temp\storefront-migration'
New-Item -ItemType Directory -Force $work | Out-Null

# 1. copy production MongoDB (read-only against production)
#    requires MongoDB Database Tools (mongodump/mongorestore)
$env:PROD_MONGO_URI = 'mongodb://prod-host:27017/storefront?replicaSet=rs0'
mongodump  --uri="$env:PROD_MONGO_URI" --db=storefront --out="$work\dump" --gzip
mongorestore --uri="mongodb://127.0.0.1:27017" --gzip --nsFrom="storefront.*" --nsTo="storefront_prodcopy.*" "$work\dump"

# 2. empty MySQL target schema (no rows written)
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS storefront_prodcopy CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
$env:MYSQL_USER='storefront_migrator'; $env:MYSQL_PASSWORD='<migrator-password>'
$env:MYSQL_DATABASE='storefront_prodcopy'
node server\src\db\mysql\migrate.js up

# 3. the dry run — writes nothing anywhere
$env:MONGO_URI='mongodb://127.0.0.1:27017/storefront_prodcopy?replicaSet=rs0'
npm run migrate:data | Tee-Object -FilePath "$work\dry-run.json"
"exit code: $LASTEXITCODE"

# 4. prove nothing was written
mysql -u root -p -N -e "SELECT (SELECT COUNT(*) FROM storefront_prodcopy.products) + (SELECT COUNT(*) FROM storefront_prodcopy.brands) + (SELECT COUNT(*) FROM storefront_prodcopy.categories) + (SELECT COUNT(*) FROM storefront_prodcopy.users);"
# expect 0
```

**Read the orphan report before you even think about `--apply`** (PowerShell-native, no `jq`):

```powershell
$r = Get-Content "$work\dry-run.json" -Raw | ConvertFrom-Json
$r.ok, $r.mode, $r.database, $r.stage
$r.plan | Format-Table table, inserted, updated, unchanged, orphaned -AutoSize
$r.totals
$r.findings        | Format-List      # blocking problems (empty when ok = true)
$r.quarantined     | Format-List      # rows a --quarantine run would skip
```

| Field             | Meaning                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`              | `true` → the source is migratable. `false` → it is not; `stage` and `findings` say why.                                                                                                                         |
| `stage`           | `"validation"` when validation blocked before any diff was computed.                                                                                                                                            |
| `findings[]`      | **Blocking**: missing required fields, unique collisions, non-canonical ids, values that do not fit the MySQL column. Nothing was written.                                                                      |
| `quarantined[]`   | Rows that _would_ be skipped with `--quarantine=<file>`. **Quarantine is explicit row loss** — decide on each one.                                                                                              |
| `tolerated[]`     | Accepted-but-reported findings (e.g. DECIMAL rounding, only with `--round-decimals`).                                                                                                                           |
| `plan[].orphaned` | Rows already in the target that the source knows nothing about. **This is the pre-insert orphan audit.** The tool never deletes; `--apply` refuses while any orphan exists unless you pass `--allow-non-empty`. |
| `totals.orphaned` | The number to chase down first.                                                                                                                                                                                 |
| `sourceCounts`    | Documents read per source collection before mapping.                                                                                                                                                            |

Exit codes: `0` = `ok:true`; `1` = `ok:false` or verification failed. Only after the dry run is clean **and** the orphan question is answered:

```powershell
npm run migrate:data:apply -- --confirm=storefront_prodcopy --manifest="$work\manifest.json"
npm run migrate:data:verify
npm run migrate:data:rollback -- --confirm=storefront_prodcopy --manifest="$work\manifest.json"
```

Keep the manifest **and** any quarantine file with it — the migration is one-way and rollback is manifest-bound. Full operator procedure: `PHASE-6-MIGRATION-RUNBOOK.md`.

---

## 2. What changed in this round (script portability)

### 2.1 Why

Every provider-specific script used POSIX-shell syntax. In Windows PowerShell `DATABASE_PROVIDER=mysql npm run dev` sets nothing and tries to run a command called `DATABASE_PROVIDER=mysql`; `&` is the call operator rather than a background operator; `&&` does not exist before PowerShell 7 and behaves differently afterwards. So `npm run dev:mysql`, `npm run test:mysql`, `npm run test:migration`, `npm run test:e2e:*`, `npm run verify` and `npm test` were all Linux/macOS-only.

### 2.2 What replaced it — three Node launchers, no new dependency

| File                          | Replaces                                    | What it does                                                                                                                         |
| ----------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `server/scripts/with-env.mjs` | `VAR=value command`, `export`               | `node server/scripts/with-env.mjs KEY=VALUE … -- <command>`; sets the variables for that one child process, propagates its exit code |
| `server/scripts/steps.mjs`    | `npm run a && npm run b`                    | `node server/scripts/steps.mjs lint format:check test build`; runs them in order, stops at the first failure, exits with its code    |
| `server/scripts/dev.mjs`      | `npm run dev --workspace server & … client` | starts both workspaces, prefixes `[server]` / `[client]`, `Ctrl+C` stops the whole tree                                              |
| `server/scripts/setup.mjs`    | (new `npm run setup`)                       | creates `server/.env` from `.env.example` with a generated `JWT_SECRET`, then migrates (MySQL) and seeds — provider-aware            |

Design rules, all of which you can check in the files: plain Node ESM with only `node:` built-ins (**no dependency was added — `cross-env` was not needed**); commands are spawned with `shell: true` and every argument shell-quoted, because on Windows `npm`, `vitest` and `playwright` are `.cmd` shims that Node cannot spawn directly; no `rm -rf`, no `cp`, no `.sh`, no `export`.

### 2.3 Script inventory after the change

| Script                                                     | Cross-platform | Note                                                 |
| ---------------------------------------------------------- | -------------- | ---------------------------------------------------- |
| `dev`, `dev:mongodb`, `dev:mysql`                          | ✅             | `scripts/dev.mjs`                                    |
| `start`, `start:mongodb`, `start:mysql`                    | ✅             | `start:*` delegate to the server workspace           |
| `setup`, `setup:mongodb`, `setup:mysql`                    | ✅             | new; `--check`, `--no-seed`, `--no-migrate` flags    |
| `seed`, `seed:mongodb`, `seed:mysql`                       | ✅             | `seed:mongodb` uses the env launcher                 |
| `db:migrate`, `db:migrate:dry-run`, `db:status`, `db:down` | ✅             | added `db:migrate:dry-run` and `db:down`             |
| `migrate:data`, `:apply`, `:verify`, `:rollback`           | ✅             | pass flags after `--`                                |
| `test`, `test:server`, `test:client`                       | ✅             | `test` = `scripts/steps.mjs test:server test:client` |
| `test:mysql`, `test:contracts`, `test:migration`           | ✅             | MySQL env is supplied by the launcher, not the shell |
| `test:e2e`, `test:e2e:mongodb`, `test:e2e:mysql`           | ✅             | provider forwarded by the env launcher               |
| `lint`, `lint:fix`, `format`, `format:check`, `build`      | ✅             | unchanged                                            |
| `verify`                                                   | ✅             | `scripts/steps.mjs lint format:check test build`     |

`client/package.json` needed no change (it never had shell syntax).

### 2.4 What stayed the same on purpose

Application, repository, service, controller, API and frontend code: **not touched**. `eslint.config.js` needed no change because the launchers live under `server/scripts/**/*.mjs`, which already has Node globals. `playwright.config.js` is unchanged — it still forwards `DATABASE_PROVIDER` and only forwards `MYSQL_*` when `MYSQL_HOST` is set. `.github/workflows/ci.yml` changed **only** by the cross-platform work described in §3 — the two new jobs, a `launcher:check` step in the Ubuntu MongoDB job, timeouts on the Ubuntu jobs, and the approved `MONGOMS_VERSION` + mongod-cache additions — and remains **NOT VERIFIED**.

### 2.5 Windows-specific risk I could not test

- `taskkill /T /F` is the Windows branch of the dev launcher's shutdown path; on Linux the same code path uses process groups. The Linux branch is verified; the Windows branch is **NOT VERIFIED**.
- PowerShell 5.1 vs 7: nothing in the scripts depends on either, but only PowerShell on a real machine can prove it.
- Native Windows MySQL/MongoDB service management (`Get-Service`, `my.ini` paths) is documentation, **NOT VERIFIED**.

### 2.6 Linux re-verification of this round (executed, this session)

| Command                                     | Result                                                                                                                                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`                            | **exit 0** — 4 steps passed (lint → format → test → build); client 284/284; build ✓ 507 ms                                                                                                                                   |
| `npm run test:server` (JSON reporter)       | **649 passed / 4 skipped / 0 failed** (44 files) with `MYSQL_TEST_*` exported; the 4 skips are `ops.mysql`'s `DATABASE_PROVIDER=mysql`-only cases, which pass under `test:mysql`                                             |
| `npm run test:contracts`                    | **71 / 71** (4 files)                                                                                                                                                                                                        |
| `npm run test:mysql`                        | **84 / 84, 0 skipped** (7 files)                                                                                                                                                                                             |
| `npm run test:migration`                    | **15 / 15**                                                                                                                                                                                                                  |
| `npm run test:e2e:mongodb`                  | **34 passed (1.4 m)** — `provider: mongodb … transactions: false`                                                                                                                                                            |
| `npm run test:e2e:mysql`                    | **34 passed (1.3 m)** — `provider: mysql … transactions: true`                                                                                                                                                               |
| `api-contract-snapshot` on both providers   | **84 entries each**, `entries` arrays byte-identical; `api-contract-diff` → **CONTRACT STABLE**                                                                                                                              |
| `dom-budget-audit`                          | **PASS (11 checks)**, 0 console errors                                                                                                                                                                                       |
| `responsive-audit`                          | **exit 0** — 4 viewports, 0 px overflow, 0 small taps, a11y checks clean                                                                                                                                                     |
| `api-audit`                                 | **56 / 56**                                                                                                                                                                                                                  |
| `runtime-audit`                             | **9 / 9**                                                                                                                                                                                                                    |
| `browser-audit`                             | **15 / 15**                                                                                                                                                                                                                  |
| `lifecycle-probe`                           | **exit 0**                                                                                                                                                                                                                   |
| `npm run setup` (MongoDB)                   | exit 0 — created/validated `server/.env`, seeded 6 / 6 / 22 + admin                                                                                                                                                          |
| `npm run setup:mysql`                       | exit 0 — applied `001_init, 002_categories_image_nullable`, seeded 6 / 6 / 22                                                                                                                                                |
| `npm run dev:mysql`                         | both processes started, `[server]`/`[client]` prefixes, `GET /api/v1/health` → **200**, SPA → 200; `Ctrl+C` stopped both (ports 5000/5173 freed, no stray processes)                                                         |
| `with-env` / `steps` edge cases             | exit codes propagate (7 → 7); args with spaces, quotes, parentheses and empty values survive intact                                                                                                                          |
| `npm run launcher:check` (handover round 3) | **exit 0** through npm → `steps.mjs` → npm → `with-env.mjs` → child; the same check with the wrong value → **exit 7**; `steps.mjs` propagation of a failing npm script → **exit 1**; no `mongod`/`vitest`/Playwright spawned |

MySQL was **8.0.44** (`SELECT VERSION()`), InnoDB, `REPEATABLE-READ`, `utf8mb4_0900_ai_ci`. _Verified in a sandbox-provisioned 8.0.44; pending a rerun on your machine or in CI._

One honest note about snapshots: the `entries` payload is compared (84/84 identical across providers, `CONTRACT STABLE`). The Phase-0/2 **baseline file itself** lived outside the workspace and did not survive into this session, so the "identical to the old baseline" check could not be repeated here — the provider-vs-provider comparison is the one that ran.

---

## 3. CI readiness — `.github/workflows/ci.yml` (NOT VERIFIED)

The workflow has never executed; no runner exists in this environment. **Everything below is a claim
about what the file says, not evidence that it works.**

| Job                        | Runner         | Services              | Runs                                                                                                             |
| -------------------------- | -------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `tests (mongodb provider)` | ubuntu-latest  | none                  | `npm ci` → lint + format → `npm run test` → `npm run build` → **with-env launcher check**                        |
| `tests (mysql provider)`   | ubuntu-latest  | `mysql:8.0` container | `npm ci` → create users → `SELECT VERSION()` → `npm run test:mysql` → `npm run test:migration`                   |
| `API contract parity`      | ubuntu-latest  | `mysql:8.0` container | snapshot the API on MongoDB → snapshot on MySQL → byte-level diff                                                |
| `scripts (windows-latest)` | windows-latest | none                  | `npm ci` → `npm run lint` → `npm run test:server` → **with-env launcher check** → **`npm run test` (steps.mjs)** |
| `scripts (macos-latest)`   | macos-latest   | none                  | the same five steps, on the default macOS shell (bash)                                                           |

### 3.1 Launcher coverage — `npm run launcher:check` (approved scope change)

`with-env.mjs` and `steps.mjs` are exercised in three jobs (Ubuntu MongoDB, Windows, macOS) through
**one npm command**, `npm run launcher:check`:

```
npm run launcher:check                      # npm script
  -> node server/scripts/steps.mjs launcher:env
    -> npm run launcher:env                 # npm script again
      -> node server/scripts/with-env.mjs LAUNCHER_CHECK=ok -- node -e "…"
        -> child exits 0 only if LAUNCHER_CHECK really reached it (else 7)
```

So the **npm script path is now covered for both launchers**: npm → `steps.mjs` → npm → `with-env.mjs`
→ child, with **no database and no Playwright**.

**This is an approved scope change** (owner decision, handover round 3): two scripts were added to the
root `package.json` and nothing else in it changed. No dependency was added; no file was created.

| Script           | Definition                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `launcher:env`   | `node server/scripts/with-env.mjs LAUNCHER_CHECK=ok -- node -e "process.exit(process.env.LAUNCHER_CHECK === 'ok' ? 0 : 7)"` |
| `launcher:check` | `node server/scripts/steps.mjs launcher:env`                                                                                |

Verified on **Linux (bash)** in this round: `npm run launcher:check` → **exit 0**; the identical check
with the wrong value → **exit 7**; `steps.mjs` propagation of a failing npm script → **exit 1**; no
`mongod`, `vitest` or Playwright process was spawned. **Not verified on Windows PowerShell or cmd.exe** —
npm runs scripts through `cmd.exe` on Windows regardless of the calling shell, and the quoting was
reasoned about but not executed. That is exactly what the `scripts (windows-latest)` job is for.

The inline `node -e` survived review as non-fragile: no `%`, `&`, `^` or embedded double quotes; the
only inner quotes are single quotes, which `cmd.exe` passes through verbatim. If the Windows job fails on
this step, the fallback (a small `launcher check` file) needs approval before it is added.

### 3.2 What these jobs do and do not prove

| Claim                                                                         | Status                                                                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Ubuntu: install, lint, both provider suites, migration, parity, build         | **VERIFIED locally** (this build, Ubuntu-equivalent Linux); **NOT VERIFIED in CI** until a run passes |
| Ubuntu: npm script path for both launchers                                    | same — **VERIFIED locally**, **NOT VERIFIED in CI**                                                   |
| Windows: `npm ci`, lint, server suite, **npm script path for both launchers** | **NOT VERIFIED** — proven only if the job passes on a real run                                        |
| macOS: `npm ci`, lint, server suite, **npm script path for both launchers**   | **NOT VERIFIED** — proven only if the job passes on a real run                                        |
| Native MySQL on Windows or macOS                                              | **NOT VERIFIED** — no job touches it                                                                  |
| Native MongoDB (replica set) on Windows or macOS                              | **NOT VERIFIED** — no job touches it                                                                  |
| Playwright on Windows or macOS                                                | **NOT VERIFIED** — deliberately excluded from both jobs                                               |

The server suite needs no runner-installed database: `mongodb-memory-server` **downloads** a `mongod`
binary at test time (a network download, not a preinstalled tool), and the MySQL suites skip whenever
`MYSQL_TEST_*` is absent — a skip, never a false green, because `MYSQL_REQUIRE=1` lives inside
`npm run test:mysql`, which these jobs do not call.

**Approved `ci.yml` hardening in the two cross-platform jobs** (MITIGATION APPLIED, NOT YET VERIFIED):

- `MONGOMS_VERSION: '7.0.14'` at job level, matching `server/tests/globalSetup.js` so the CI download and
  the local pin cannot drift.
- `actions/cache@v4` for `~/.cache/mongodb-binaries` and `node_modules/.cache/mongodb-memory-server`,
  keyed `${{ runner.os }}-mongod-${{ env.MONGOMS_VERSION }}`, restored **after** `npm ci` (which wipes
  `node_modules`) and saved at job end.
- `timeout-minutes` on all three Ubuntu jobs (30 / 30 / 20) as well as the two new ones (30).
- **Not** changed, by decision: `mongodb-memory-server` stays `^11.3.0` (not pinned), and `MONGOMS_ARCH`
  is **not** set — if the Apple-silicon runner rejects the arm64 `mongod` build, that is a decision for
  after a real run.

Nothing in this repository claims Windows or macOS is _supported_ for the database or browser side until
those runs — and the separate native checks — actually pass.

### 3.3 Operational notes

- **Secrets: none.** Nothing reads `${{ secrets.* }}`; the three CI-only credentials are literals inside
  the workflow (`root`, `ci_migrator_pw`, `ci_app_pw`).
- **Settings:** Actions enabled; GitHub-hosted runners. `ubuntu-latest` has Docker, which the MySQL
  _service container_ needs — CI infrastructure, not a local-development dependency. Optional
  branch-protection check names: `tests (mongodb provider)`, `tests (mysql provider)`,
  `API contract parity`, `scripts (windows-latest)`, `scripts (macos-latest)`.
- **To push:** `git add .github/workflows/ci.yml` + the rest of the working tree (§6), commit, push to
  `main`; the first run is the push itself.
- **Still absent, deliberately:** no Playwright E2E job, no snapshot artefacts, no `workflow_dispatch`,
  and no `timeout-minutes` on the three original Ubuntu jobs (the two new jobs have it).

---

## 4. Requirement status

**VERIFIED (Linux, this session):** provider switching by configuration; repository contract identical on both providers; API contract frozen (84/84, `CONTRACT STABLE`); frontend unchanged (E2E 34/34 per provider, DOM budget, responsive, runtime, browser audits); concurrency/no-oversell incl. InnoDB deadlock absorption; transactions (real commit + rollback on a replica set); migration dry run/idempotency/orphans/verify/rollback on messy data; `_id` preserved as `CHAR(24) ascii_bin`; `excludeId` rejected identically; text-search divergence documented and pinned; idempotent seed + pinned fixture set (6 / 6 / 22, `search=aurora` → 5); `/api/v1/health` truthful in both states on both providers; graceful shutdown releases DB handles; no new vulnerabilities; **every npm script cross-platform by construction and unchanged in behaviour on Linux**.

**PARTIALLY VERIFIED:** "both providers fully functional" (MySQL exercised on a single node, not a production-shaped deployment); "all gates green" (green here; the workflow that must reproduce them has never run); migration verification (fixtures and a messy dataset, not production scale).

**NOT VERIFIED:** **all Windows execution** (§1, §2.5); the `scripts (windows-latest)` and `scripts (macos-latest)` CI jobs; **native MySQL, MongoDB and Playwright on Windows or macOS**; `ci.yml` as a whole; reruns on your machine/CI; production-scale performance; backup/restore drill; replication/failover.

**Conditional:** the Windows and macOS jobs verify install, lint, the server suite and both launchers
**only once a real run passes**. Until then their claims are unverified, and no job proves that MySQL,
MongoDB or Playwright work natively on either platform.

---

## 5. Outstanding operational verification (not completed work)

1. **Production-scale performance** — no load test, no query-plan review at volume, no pool sizing exercise, no timing of the migration over a production-sized catalogue.
2. **Backup and restoration** — procedure documented in `PHASE-7-OPS-RUNBOOK.md` §6; **never executed** (no backup tooling here). A restore drill on a copy is the cheapest way to close it.
3. **Replication and failover** — MySQL has only ever been a single node. Primary switchover, connection retry, read-after-write on replicas: untested.
4. Secondary: pool soak testing, alerting for the `/api/v1/health` 503 (§9), and rotation of the two MySQL users.

---

## 6. Files changed in this round (review these, then commit)

Nothing was committed; there is no `.git` in this environment, so this list is authoritative by construction — it is every file this round touched.

**Added**

| File                          | Why                                                                         |
| ----------------------------- | --------------------------------------------------------------------------- |
| `server/scripts/with-env.mjs` | cross-platform `VAR=value cmd` replacement                                  |
| `server/scripts/steps.mjs`    | cross-platform `&&` chain replacement                                       |
| `server/scripts/dev.mjs`      | cross-platform concurrent `dev` (replaces `&`)                              |
| `server/scripts/setup.mjs`    | `npm run setup` (env file, migrations, seeding)                             |
| `.gitattributes`              | LF-forced working tree, binary files marked, CRLF only for `.cmd/.bat/.ps1` |

**Modified**

| File                  | Change                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`        | every script rewritten to Node-only invocation; new `dev:mongodb`, `start:*`, `setup*`, `seed:mongodb`, `db:migrate:dry-run`, `db:down` |
| `server/package.json` | same treatment for workspace scripts (`test:mysql`, `test:migration`, `dev:mysql`, `start:*`, `seed:*`)                                 |
| `.env.example`        | Windows copy instructions, provider-switch commands, `storefront_migrator` vs `storefront_app` note, replica-set wording                |
| `HANDOVER-REPORT.md`  | this document — Windows-first checklist, no Docker, corrected health path, portability evidence                                         |

**Documentation updated in place:** `FINAL-IMPLEMENTATION-REPORT.md` (owner checklist now defers to §1 here; no Docker; `test:mysql` count corrected 82 → 84; stale `db/mysql/schema.js` reference removed).

**Not touched at all:** `server/src/**`, `client/**`, `e2e/**`, `audit/**`, `playwright.config.js`, `eslint.config.js`, and every existing test file. No dependency was added; `package-lock.json` is unchanged.

**Do not commit:** `server/uploads/**`, `test-results/`, `audit/*.json` run outputs, `node_modules/`, `client/dist/` — all gitignored.

Sandbox-only tooling (outside the repo, **not** a dependency for you): `/opt/dev-tools/provision-local-mysql8.sh` provisions MySQL 8.0.44 on `127.0.0.1:3399` for the Linux test runs. It exists because this environment has no installer; it is not part of the product and Windows users never need it. **Docker is not required anywhere in the local workflow.** There is no `docker-compose.yml` in this repository; the one mentioned in an earlier draft of this handover lived only in `/tmp` and was never committed. `.github/workflows/ci.yml` uses a MySQL _service container_ on a GitHub-hosted runner — that is CI infrastructure, not a local dependency.

---

## 7. Known limitations

1. **Text search `text` mode**: MongoDB stems, InnoDB does not — `sneakers`/`sandals` match on MongoDB only. Default `regex` mode (what the storefront uses) is identical. Pinned in both directions by test.
2. **Quarantine is explicit row loss** — the quarantine file must be archived with the migration manifest.
3. **Verification samples** 25 rows per table by default (`sampleSize` configurable); record counts, unique constraints and decimal precision cover whole tables.
4. **The migration never deletes** — extra target rows are reported as orphans and block `--apply` unless `--allow-non-empty`.
5. **Rollback is manifest-bound** — without the manifest, restoring a backup is the only recovery.
6. **E2E on MongoDB uses a standalone in-memory mongod** (`transactions: false`); replica-set proof lives in the integration suites.
7. **MySQL exercised single-node only** — capacity, replication and failover are unproven (§5).
8. **Windows execution unproven** (§2.5).

---

## 8. `/api/v1/health` — note for your external monitors

The path is **`/api/v1/health`** (router mounted under the versioned prefix). Stay on the HTTP status code, not the body:

- **Healthy:** `200` — `{"success": true, "message": "Service healthy", "data": {"status": "ok", "uptimeSeconds": 15, "database": "connected", "environment": "development"}, "requestId": "…"}`; `data.database` is a **string** (`"connected"`), not an object.
- **Degraded: `503`** — an owner-approved change from the Phase 0 baseline (previously `200` with a degraded body, because the response helper overwrote the status). `success` stays `true`, the message becomes `"Service degraded"`, `data.status` becomes `"degraded"`, `data.database` becomes `"disconnected"`, and only the HTTP status changed materially.

So, for external monitors: **the endpoint returns 200 when healthy and 503 when degraded, the body
remains a success envelope even at 503, and you must alert on the HTTP status code only** — not on
`success`, which stays `true` in both states. Nothing in the frontend calls this endpoint: `server/tests/unit/health-consumers.test.js` walks `client/src` and `e2e/` and asserts zero references; the only consumer in the repo is Playwright's readiness probe, which needs a 2xx and gets one on a healthy boot. Verified live in this round: `GET /api/v1/health` → 200 with `provider: mysql` running.

---

## 9. Waiting for your review

No commit, no reset, no application-code change. The three decisions that are yours:

1. **Run §1 on Windows** and send me any command that fails — that is the only way the Windows label changes.
2. **The `windows-latest` and `macos-latest` CI jobs are now in `ci.yml`** (§3) — they are NOT VERIFIED
   until a real run passes; the Windows/macOS labels change only then.
3. The migration `--apply` decision, after reading the orphan report from §1.9.
