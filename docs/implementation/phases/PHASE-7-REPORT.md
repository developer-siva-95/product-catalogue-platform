# Phase 7 — Ops hardening, provider-parity E2E, and accepted review items

**Status:** the five review items are implemented and evidenced. This phase report closes the
review round; it does **not** claim overall completion — see §6 for the Section 10 status split.
**Date:** 2026-11-06 · **Providers:** MongoDB (reference, replica set) and MySQL 8.0.44

---

## 1. Item 1 — `/health` 503 is now an approved contract change

### Decision of record

|                 |                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| Change          | A degraded service answers **HTTP 503** instead of **200** (body unchanged)                                    |
| Approval        | Owner, this review round — "keep the 503 for the degraded state, as a deliberate and approved contract change" |
| Baseline impact | Healthy response unchanged: the 84-entry Phase 0/2 snapshot is still **byte-identical** on both providers      |

The defect it fixes: the route called `res.status(503)` and then `sendSuccess()` overwrote it with
its own default `200`, so the body said `"status": "degraded"` while the status line said healthy.
Orchestrators and load balancers key off the code.

### 1a. No client code calls `/health` — mechanically proven

New guard: `server/tests/unit/health-consumers.test.js`.

1. Walks every file under `client/src` and `e2e/` (`.js/.jsx/.ts/.tsx/.mjs/.cjs/.json/.html`) and
   asserts **none** contains the string `health` (case-insensitive). Result: **0 offenders**.
2. Asserts the one legitimate consumer still exists: Playwright's `webServer` readiness probe
   `url: http://127.0.0.1:${API_PORT}/api/v1/health`, which requires a 2xx — exactly what a
   healthy boot produces. No UI regression is possible because the UI never sees the endpoint.

### 1b. Degraded body shape is unchanged, and both states are tested on both providers

`expectHealthPayload()` in `tests/integration/ops.{mongo,mysql}.test.js` asserts the full envelope,
not a subset:

```
status code           200 (healthy) / 503 (degraded)
content-type          application/json
top-level key order   success, message, data, requestId
success               true in both states
message               "Service healthy" / "Service degraded"
data key order        status, uptimeSeconds, database, environment
data.status           "ok" / "degraded"
data.database         "connected" / "disconnected"
data.uptimeSeconds    number · data.environment "test"
```

| Test                                                                                                                                               | Provider     | Result           |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------- |
| `ops.mongo.test.js` → 200 healthy, 503 degraded, full payload shape                                                                                | MongoDB      | **2 / 2 passed** |
| `ops.mysql.test.js` → 200 healthy, 503 degraded, full payload shape, pool not reopened, disconnect releases pool, capability probe, adapter parity | MySQL 8.0.44 | **5 / 5 passed** |

Precision on "unchanged": the payload is produced by the same helper with the same arguments as
before — only the status code argument was added. The **healthy** response is additionally proven
byte-identical to the Phase 0 baseline by the snapshot diff (84/84). The Phase 0 baseline contained
no _degraded_ `/health` entry (it captured healthy responses only), so for the degraded path the
evidence is the test above plus the code path, not a baseline comparison. Stated plainly so the
claim is not overstated.

---

## 2. Item 2 — the skipped tests, enumerated and accounted for

`npm run verify` reports **98 skipped** (was 96 before this round's two new fixture-pinning tests).
All 98 are skipped for **one** reason: no live MySQL credentials in the default run. Every one of
them executes and passes under `test:mysql`, `test:migration` or `test:contracts`.

| #   | File                                              | Skipped in `verify` | Reason                                                                                                                      | Executes & passes in                  | Passed there    |
| --- | ------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------- |
| 1   | `tests/integration/repositories.mysql.test.js`    | 21                  | needs a real MySQL (`MYSQL_TEST_*` unset → `shouldSkipMysql()`)                                                             | `npm run test:mysql`                  | 21              |
| 2   | `tests/integration/contracts.mysql.test.js`       | 31                  | same                                                                                                                        | `test:mysql` **and** `test:contracts` | 31              |
| 3   | `tests/integration/mysql-foundation.test.js`      | 18                  | same                                                                                                                        | `npm run test:mysql`                  | 18              |
| 4   | `tests/integration/seed.mysql.test.js`            | 5                   | same                                                                                                                        | `npm run test:mysql`                  | 5               |
| 5   | `tests/integration/concurrency.mysql.test.js`     | 2                   | same                                                                                                                        | `npm run test:mysql`                  | 2               |
| 6   | `tests/integration/db-capabilities.mysql.test.js` | 2                   | same                                                                                                                        | `test:mysql` **and** `test:contracts` | 2               |
| 7   | `tests/integration/ops.mysql.test.js`             | 4                   | 4 of 5 need MySQL; the 5th (adapter parity) runs everywhere — that is why the file shows `1 passed / 4 skipped` in `verify` | `npm run test:mysql` (all 5)          | 5               |
| 8   | `tests/integration/migration.test.js`             | 15                  | needs a real MySQL **and** MongoDB                                                                                          | `npm run test:migration`              | 15              |
|     | **total**                                         | **98**              |                                                                                                                             |                                       | **99 executed** |

(The 99 vs 98 above is not a discrepancy: `ops.mysql.test.js`'s parity test is the one that runs in
`verify` too, so 98 skipped + 1 already-passing = 99 executed across those files.)

Proof of execution — three separate runs, `0 skipped` in each:

| Command                  | Result                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run test:mysql`     | **7 files, 84 passed, 0 skipped** (repositories 21, contracts 31, foundation 18, seed 5, concurrency 2, capabilities 2, ops 5) |
| `npm run test:migration` | **1 file, 15 passed, 0 skipped**                                                                                               |
| `npm run test:contracts` | **4 files, 71 passed, 0 skipped** (contracts.mongo 31, contracts.mysql 31, db-capabilities 7, db-capabilities.mysql 2)         |

**No test is skipped in every run.** The only file that is skipped in _two_ of the four runs
(`contracts.mysql`, `db-capabilities.mysql`) passes in the other two.

---

## 3. Item 3 — Playwright E2E on both providers, run separately

The E2E harness (`server/scripts/e2e-server.mjs`) now honours `DATABASE_PROVIDER`:

- **mongodb**: disposable in-memory MongoDB, as before; _(at the time of this phase this was
  the harness default — since the provider-default correction MySQL is the application
  default and every MongoDB harness passes `DATABASE_PROVIDER=mongodb` explicitly, so these
  commands are unchanged in effect)_;
- **mysql**: rebuilds the schema of a dedicated `*_test` database from the migration files
  (`migrateDown` → `migrateUp`) and seeds it — same seeds, same API, same SPA.

New scripts: `npm run test:e2e:mongodb` and `npm run test:e2e:mysql`.

| Run     | Command                                                                                                                                     | API server bootstrap line                                                        | Result                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------- |
| MongoDB | `npx playwright test`                                                                                                                       | `provider: mongodb, products: 22, brands: 6, categories: 6, transactions: false` | **34 / 34 passed (1.3 m)** |
| MySQL   | `DATABASE_PROVIDER=mysql MYSQL_HOST=… MYSQL_PORT=3399 MYSQL_USER=… MYSQL_PASSWORD=… MYSQL_DATABASE=storefront_e2e_test npx playwright test` | `provider: mysql, products: 22, brands: 6, categories: 6, transactions: true`    | **34 / 34 passed (1.3 m)** |

The same 34 specs — listing, virtualisation depth/scroll restoration, infinite scroll, admin CRUD,
first-login password rotation, detail round-trips — pass against both databases. This is the
strongest evidence yet that the frontend behaviour is provider-independent, because the browser
never learns which database is behind the API.

(`transactions: false` in the MongoDB run is the E2E harness's standalone in-memory mongod, which
cannot run multi-document transactions; the MongoDB _replica-set_ evidence comes from the test
suites in §5, not from the E2E harness.)

### API snapshots captured on each provider in this round

| Snapshot                                         | Compared against                            | Result                     |
| ------------------------------------------------ | ------------------------------------------- | -------------------------- |
| `/opt/snapshots/mongo-after-p7b.json`            | `mongo-before-p2.json` (Phase 0/2 baseline) | **84 / 84 byte-identical** |
| `/opt/snapshots/mysql-after-p7b.json`            | `mongo-before-p2.json`                      | **84 / 84 byte-identical** |
| `mongo-after-p7b.json` vs `mysql-after-p7b.json` | each other                                  | **84 / 84 byte-identical** |

### Other gates re-run in this round

| Gate             | Result                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify` | **exit 0** — ESLint 0 errors / 5 warnings (baseline), Prettier clean, server **555 passed / 98 skipped (44 files)**, client **284/284**, build ✓ 390 ms |
| DOM-budget audit | **PASS (11 checks)**, 0 console errors                                                                                                                  |
| Responsive audit | **exit 0** (4 viewports, 0 px overflow, 0 small taps)                                                                                                   |
| API audit        | **56 / 56**                                                                                                                                             |
| Runtime audit    | **9 / 9**                                                                                                                                               |
| Browser audit    | **15 / 15**                                                                                                                                             |
| Lifecycle probe  | **exit 0**                                                                                                                                              |

---

## 4. Item 4 — the seeded fixture set is now pinned by a test

Phase 6 shipped a seeder rewrite that replaced the _contents_ of the fixture catalogue while keeping
its shape; every unit suite stayed green and only the browser audits caught it. That gap is closed
by two tests in `tests/contracts/seed-contract.js`, which run on **both** providers:

**"pins the seeded fixture catalogue exactly"**

- 6 brands, in exact name order: `Aurora, Kettle & Co, Lumen, NovaTech, Trailmade, Vertex`
- 6 categories, in exact name order: `Accessories, Audio, Computing, Home & Kitchen, Photography, Wearables`
- 22 products total (`listAdmin().total`)
- exactly 2 retired products, by title: `Lumen Ring Sleep Tracker`, `Trailmade Hard Case for Earbuds`
- exactly **20** storefront-visible products — the number the E2E spec _"keeps the seeded 20-product
  grid fully mounted"_ and the DOM-budget control both rely on

**"keeps the search=aurora fixture count the audits assert (5)"**

- `listStorefront({ query: { search: 'aurora' } })` → exactly **5** records, all active — the same
  number `audit/api-audit.mjs` asserts as `meta.count === 5`.

| Provider     | Result                                   |
| ------------ | ---------------------------------------- |
| MongoDB      | **5 / 5 passed** in `seed.mongo.test.js` |
| MySQL 8.0.44 | **5 / 5 passed** in `seed.mysql.test.js` |

A future seeder change now fails in milliseconds, on both providers, instead of two minutes into the
audit chain.

---

## 5. Per-provider VERIFIED / NOT VERIFIED

Every row cites a test, an audit, a snapshot or a command output produced in this session.

| Criterion                                       | MongoDB                                                                                                                      | Evidence                                                          | MySQL                                                                   | Evidence                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Server boots and serves the full API            | **VERIFIED**                                                                                                                 | E2E run (34/34) + snapshot 84/84                                  | **VERIFIED**                                                            | E2E run (34/34) + snapshot 84/84                                         |
| Version / topology actually used                | **VERIFIED** — `MongoMemoryReplSet`, 1 member, `transactions: true` (capability probe asserted in `db-capabilities.test.js`) | probe test: "reports transactions available on a replica set"     | **VERIFIED** — **8.0.44**, `InnoDB`, `@@transaction_isolation` reported | `db-capabilities.mysql.test.js`, provider `health()`/`probe()` output    |
| Repository contract (31 assertions)             | **VERIFIED**                                                                                                                 | `contracts.mongo.test.js` 31/31                                   | **VERIFIED**                                                            | `contracts.mysql.test.js` 31/31                                          |
| Transactions genuinely work                     | **VERIFIED**                                                                                                                 | real commit + rollback test on the replica set                    | **VERIFIED**                                                            | rollback probe + `withTransaction` deadlock retry test                   |
| Concurrency safety (no oversell)                | **VERIFIED**                                                                                                                 | contract oversell test                                            | **VERIFIED**                                                            | 8×5 contention (25 applied / 15 refused) + real InnoDB deadlock absorbed |
| Idempotent seeding                              | **VERIFIED**                                                                                                                 | `seed.mongo.test.js` 5/5 incl. fixture pin                        | **VERIFIED**                                                            | `seed.mysql.test.js` 5/5 incl. fixture pin                               |
| Fixture set pinned (6/6/22, aurora = 5)         | **VERIFIED**                                                                                                                 | seed contract                                                     | **VERIFIED**                                                            | seed contract                                                            |
| Migration into this provider                    | **n/a** (it is the source)                                                                                                   | —                                                                 | **VERIFIED**                                                            | `migration.test.js` 15/15 against a messy fixture                        |
| API contract identical to Phase 0 baseline      | **VERIFIED**                                                                                                                 | 84/84 byte-identical                                              | **VERIFIED**                                                            | 84/84 byte-identical (and provider-to-provider identical)                |
| Frontend behaviour identical                    | **VERIFIED**                                                                                                                 | E2E 34/34, DOM-budget 11, responsive/runtime/browser audits       | **VERIFIED**                                                            | E2E 34/34 (MySQL-backed API, `transactions: true`)                       |
| `/health` 200 healthy / 503 degraded, same body | **VERIFIED**                                                                                                                 | `ops.mongo.test.js` 2/2 + consumer guard                          | **VERIFIED**                                                            | `ops.mysql.test.js` 5/5 + consumer guard                                 |
| Graceful shutdown releases DB handles           | **VERIFIED**                                                                                                                 | `tests/unit/shutdown.test.js` 5/5 (provider-independent sequence) | **VERIFIED**                                                            | `isPoolCreated() === false` after disconnect                             |
| Text search parity                              | **VERIFIED as documented divergence**                                                                                        | `regex` identical; `text` stems                                   | **VERIFIED as documented divergence**                                   | `regex` identical; `text` does not stem (see §7.1)                       |
| `excludeId` rejection identical                 | **VERIFIED**                                                                                                                 | contract test                                                     | **VERIFIED**                                                            | contract test                                                            |
| Dependency/vulnerability posture                | **VERIFIED**                                                                                                                 | `npm audit` 0                                                     | **VERIFIED**                                                            | `npm audit` 0; no new dependency                                         |

### Environment-qualified rows (read these before quoting any number)

| Item                         | Status                                          | Wording                                                                                                                                               |
| ---------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| MySQL verification           | **VERIFIED IN SANDBOX, PENDING OWNER/CI RERUN** | verified in the sandbox on a locally provisioned **8.0.44** (`provision-local-mysql8.sh`, port 3399); pending a rerun in CI or on the owner's machine |
| MongoDB verification         | **VERIFIED IN SANDBOX, PENDING OWNER/CI RERUN** | verified against a local single-node `MongoMemoryReplSet` (7.0.14, `--wiredTigerCacheSizeGB 0.25`)                                                    |
| `.github/workflows/ci.yml`   | **NOT VERIFIED**                                | **never executed** — this sandbox has no GitHub runner. Every command inside it is a command that passed here, but the workflow itself is unverified. |
| Production-scale performance | **NOT VERIFIED**                                | no load test was run; the concurrency tests prove correctness under contention, not throughput                                                        |
| Backup/restore drill         | **NOT VERIFIED**                                | commands are documented in `PHASE-7-OPS-RUNBOOK.md` §6 but were not executed against a real backup (no backup tooling in the sandbox)                 |

---

## 6. Section 10 — status split (no overall completion claim)

**Fully met (verified in this session):**

1. Both providers fully functional — API parity 84/84, MySQL suite 84/84, E2E 34/34 on each.
2. Switching provider by configuration with zero source changes.
3. Shared contract suite against real databases for both providers.
4. API contracts and frontend behaviour identical to the Phase 0 baseline (snapshots + E2E).
5. Concurrency-safe inventory on both, including deadlock absorption.
6. Virtualisation / DOM-budget audits still pass (PASS, 11 checks).
7. All unit/integration/E2E/lint/build gates green.
8. Migration dry run, idempotency, orphan detection, counts, samples, constraints, decimal
   precision, dates, nulls — verified against clean _and_ deliberately messy data.
9. `_id` preserved as `CHAR(24) ascii_bin`.
10. Rollback procedure documented with explicit confirmation before every destructive step.
11. `excludeId` rejected identically on both providers.
12. Text-search divergence documented **and** pinned by test.
13. Seeding idempotent on both providers, with the fixture set pinned.
14. `/health` reports the truth (500-class correctness), no client regression, tests on both
    providers — approved change recorded.
15. No new critical/high vulnerabilities; no dependency added beyond the approved `mysql2`.

**Partially met:**

1. **"Both providers fully functional"** — functionally complete and contract-identical, but the
   MySQL side is verified only against a single-node sandbox server (8.0.44, 2 vCPU / 2 GB), not
   against a production-shaped deployment (replication, proxies, real data volumes).
2. **"All unit/integration/E2E/lint/build green"** — green here, but the **CI workflow that is
   supposed to reproduce it has never run** (see NOT VERIFIED).
3. **Migration verification** — verified in the sandbox against fixtures and messy data; not yet run
   against a production-sized MongoDB (millions of documents), where batch size and lock behaviour
   would matter.

**Unverified:**

1. `.github/workflows/ci.yml` — never executed.
2. Owner-machine and CI reruns of every suite (the sandbox's MySQL 8.0.44, Node 22, Playwright
   browsers and mongod are provisioned _inside_ the sandbox and do not persist).
3. Production-scale performance, load, and backup/restore drills.
4. MySQL replication / failover behaviour (out of scope of the plan; no replica was provisioned).

**Final implementation report:** delivered (`FINAL-IMPLEMENTATION-REPORT.md`), updated with this
split, the per-provider table above, and the owner rerun list in §8.

---

## 7. Known limitations (carried)

1. **Text search stems in MongoDB and does not in MySQL.** `sneakers` / `sandals` match in MongoDB's
   `text` mode and not in MySQL's (InnoDB FULLTEXT has no stemmer). The default `regex` mode is
   identical on both, and the divergence is asserted in both directions by
   `tests/contracts/text-search-contract.js`, so it cannot drift silently. Chosen option: (a) —
   documented and pinned.
2. `excludeIds` must be canonical 24-hex lowercase ids (uppercase is rejected, not normalised).
3. Quarantine in the migration is explicit data loss; the quarantine file must be kept.
4. Verification samples 25 rows per table for row-level equality (counts/uniques/decimals cover
   whole tables).
5. The migration never deletes and cannot be rolled back without its manifest.
6. Browser audits run against MongoDB only; MySQL parity is covered by the E2E run and the snapshot.
7. E2E's MongoDB harness is a standalone in-memory mongod (`transactions: false`); the
   replica-set evidence lives in the integration suites.

---

## 8. Exactly what the owner must rerun

```bash
# --- once, on a machine with Node 22 -------------------------------------------------
npm ci
npx playwright install --with-deps chromium        # browser gates + E2E

# --- MySQL 8.0 (any 8.0.x; the sandbox used 8.0.44) ----------------------------------
# provision a server + least-privilege users, then:
export MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 \
       MYSQL_TEST_HOST=127.0.0.1 MYSQL_TEST_PORT=3306 \
       MYSQL_TEST_USER=storefront_migrator MYSQL_TEST_PASSWORD='…' \
       MYSQL_TEST_DATABASE=storefront_it_test
mysql -h127.0.0.1 -uroot -p -e 'CREATE DATABASE IF NOT EXISTS storefront_e2e_test;'   # for the MySQL E2E run

# --- every gate ---------------------------------------------------------------
npm run verify                                     # expect: 555 passed / 98 skipped, client 284, build ok
npm run test:mysql                                 # expect: 7 files, 84 passed, 0 skipped
npm run test:migration                             # expect: 15 passed
npm run test:contracts                             # expect: 71 passed
npx playwright test                                # MongoDB E2E  → expect 34 passed
DATABASE_PROVIDER=mysql MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER=storefront_migrator \
  MYSQL_PASSWORD='…' MYSQL_DATABASE=storefront_e2e_test npm run test:e2e:mysql   # → expect 34 passed

# --- API contract parity -------------------------------------------------------
node audit/api-contract-snapshot.mjs --out /tmp/mongo.json
DATABASE_PROVIDER=mysql node audit/api-contract-snapshot.mjs --out /tmp/mysql.json
node audit/api-contract-diff.mjs /tmp/mongo.json /tmp/mysql.json      # expect CONTRACT STABLE
node audit/api-contract-diff.mjs /opt/snapshots/mongo-before-p2.json /tmp/mysql.json

# --- audits --------------------------------------------------------------------
node audit/dom-budget-audit.mjs && node audit/responsive-audit.mjs && node audit/api-audit.mjs
node audit/runtime-audit.mjs && node audit/browser-audit.mjs && node audit/lifecycle-probe.mjs

# --- migration on real data (dry run first, then with the confirmation token) ---
npm run migrate:data
npm run migrate:data:apply -- --confirm=storefront --manifest=/var/backups/migration.json
npm run migrate:data:verify
```

Sandbox note (unchanged): MySQL 8.0.44, Node 22, the Playwright browsers and mongod were
**provisioned inside this sandbox**; a fresh environment must provision them again. The browser
gates were run with `mysqld` stopped because the sandbox has 2 GB RAM.
