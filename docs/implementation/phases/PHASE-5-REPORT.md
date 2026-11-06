# Phase 5 — Dual-Provider Test Matrix

**Status:** complete. Every gate in the standing gate set was re-run after the phase and passes.
**Date:** 2026-11-06
**Predecessor:** `PHASE-4-REPORT.md` (MySQL repositories). **Successor:** Phase 6 (seeding + one-way migration).

---

## 1. What this phase had to prove

The plan's acceptance criteria say the two providers must be _interchangeable_, and that the
shared contract suite must pass **against real database instances for both**. Before this
phase that was an assertion in a report: the Mongo suite ran on a **standalone** mongod (so
transactions were impossible and the capability probe was never exercised), and the MySQL
suite was a separate, hand-written set of expectations. Two suites that happen to agree is
not evidence that the implementations agree.

Phase 5 replaces that with:

1. **one** contract definition, parameterised over the provider, executed twice — once
   against a real MongoDB **single-node replica set**, once against the real **MySQL 8.0.44**
   server;
2. the **startup capability probe** exercised for real on both providers;
3. the two known-hard areas — **concurrency/overselling** and **text-search parity** — turned
   from manual probes into automated per-provider tests;
4. the whole standing gate set (unit/integration/E2E/lint/build/audits/API snapshot) re-run.

---

## 2. What was built

### 2.1 A real replica set for the test suite

`server/tests/globalSetup.js` now starts `MongoMemoryReplSet` (1 member, port 27999,
`--wiredTigerCacheSizeGB 0.25`, `MONGOMS_VERSION ?? 7.0.14`) instead of a standalone
`MongoMemoryServer`. `SKIP_MONGO_MEMORY=1` still opts out (used by the MySQL-only runs).

This matters because a standalone mongod **cannot** run the multi-document transaction that
`withTransaction()` exists to provide, so the provider's transaction path had never actually
executed in a test. It does now.

### 2.2 One contract suite, two providers

`server/tests/contracts/repository-contract.js` — `defineRepositoryContractSuite(adapter)`.
~26 provider-neutral tests over `products`, `brands`, `categories`, `users`, all written
against the repository interfaces only. Wired by two thin adapters:

| File                                        | Provider | Backing store                           |
| ------------------------------------------- | -------- | --------------------------------------- |
| `tests/integration/contracts.mongo.test.js` | mongodb  | `MongoMemoryReplSet`, `catalogue_test`  |
| `tests/integration/contracts.mysql.test.js` | mysql    | real MySQL 8.0.44, `storefront_it_test` |

Coverage (each assertion runs twice):

- canonical 24-hex string ids, `__v`, `Date` round-trip, mapper key order for the public and
  admin wire shapes;
- inactive products invisible to `findById`, visible to `findAdminById`; slug **and** id lookup;
  `null` (never `undefined`) for a miss;
- atomic stock adjust, `insufficient` reporting with `available`/`requested`, **3 of 10**
  concurrent decrements applied on 3 units, no overselling;
- optimistic version guard → `STALE_RESOURCE` 409 semantics, then the current version accepted;
- re-slug only on a real title change;
- cursor paging with `limit + 1` and no overlap; price sort both directions with the reversed
  `_id` tie-break; exact admin total with page/limit;
- case-insensitive search including the SKU (binary collation) and literal `%` / `_`;
- combined price + brand + category facets;
- delete reporting, taxonomy `productCount` / `activeProductCount`
  (`collectReferencedImageFiles` included), slug/SKU allocation, `DUPLICATE_KEY` through
  `mapDatabaseError`;
- brand/category list key order and `-name` sort; category `image` **omitted** when absent;
- users: bcrypt `$2b$12$`, lockout after 5 failures, password rotation bumping `tokenVersion`,
  and the exact 13-key record order.

### 2.3 The capability probe, exercised for real

`tests/integration/db-capabilities.test.js` (Mongo, 7 tests) and
`tests/integration/db-capabilities.mysql.test.js` (MySQL, 2 tests) assert that the boot-time
probe reports `transactions: true` on the deployed topology, that a real transaction
**commits** and one **rolls back** leaving no residue, and that `REQUIRE_TRANSACTIONS=true`
refuses to boot on a topology that cannot transact. The policy is now a pure exported
function, `assertTransactionCapability(capabilities, required)`, so the refusal path is
testable without provisioning a deliberately broken database.

### 2.4 Concurrency and text search, automated

- `tests/integration/concurrency.mysql.test.js` — 8 concurrent buyers × 5 products against 5
  units each: exactly 25 applied, 15 refused, every product lands on stock 0 with
  `__v = 5` (no lost update). Plus a **genuine InnoDB deadlock**: two transactions locking the
  same two rows in opposite order; InnoDB returns 1213, the retry wrapper in
  `pool.withTransaction` re-runs the whole transaction and both calls fulfil. The test proves
  the deadlock was real by asserting at least one handler ran twice.
- `tests/contracts/text-search-contract.js` — the Phase 4 measurement, pinned. Default
  `regex` mode is asserted **identical** on both providers (including SKU matches and the
  no-stopword behaviour of substrings such as `be` inside _beanie_/_beach_); `text` mode is
  asserted against each provider's documented vocabulary, and the stemming divergence is
  asserted in both directions — if someone adds a stemmer to MySQL, or Mongo regresses, the
  suite fails and this report becomes wrong on purpose.

---

## 3. Defects found and fixed by this phase

Phase 5 was not bookkeeping — the new tests found three real defects:

1. **The Mongo capability probe always answered "no transactions".** It started a transaction
   and ran `ping`, but `ping` is not on MongoDB's allow-list of commands permitted inside a
   multi-document transaction, so a healthy replica set was reported as `transactions: false`.
   With `REQUIRE_TRANSACTIONS=true` the server would have refused to boot against a perfectly
   correct topology. Fixed to probe with a real `find` inside the transaction; the replica-set
   test now asserts `true`.
2. **The MySQL probe inferred capability from engine flags only** — a promise, not a proof.
   It now starts a transaction on a scratch `TEMPORARY` table, inserts, rolls back and verifies
   the row is gone.
3. **…and the first version of that fix reported a false negative**, because a `TEMPORARY`
   table is session-scoped and the probe read it back through a _different_ pooled connection.
   Now pinned to one connection.

Two contract-test bugs were also mine, not the providers': a shared taxonomy name colliding on
the unique index when a test created two products, and an `excludeId: 'x'` that made Mongoose
throw a `CastError` while MySQL returned `false` (a non-canonical id is a caller error in both;
the test now uses a real 24-hex id).

---

## 4. Test results

### 4.1 Shared contract + capability suites

| Suite                                                   | Provider            | Result                     |
| ------------------------------------------------------- | ------------------- | -------------------------- |
| `contracts.mongo.test.js` (contract 26 + text search 4) | MongoDB replica set | **30 / 30 passed** (6.2 s) |
| `contracts.mysql.test.js` (contract 26 + text search 4) | MySQL 8.0.44        | **30 / 30 passed** (6.6 s) |
| `db-capabilities.test.js`                               | MongoDB replica set | **7 / 7 passed**           |
| `db-capabilities.mysql.test.js`                         | MySQL 8.0.44        | **2 / 2 passed**           |
| `concurrency.mysql.test.js`                             | MySQL 8.0.44        | **2 / 2 passed**           |

`npm run test:mysql` (the CI-posture, self-contained MySQL entry point:
`SKIP_MONGO_MEMORY=1 MYSQL_REQUIRE=1`) → **5 files, 73 / 73 passed, 17.2 s**:

```
✓ tests/integration/concurrency.mysql.test.js     (2 tests)
✓ tests/integration/contracts.mysql.test.js       (30 tests)
✓ tests/integration/db-capabilities.mysql.test.js (2 tests)
✓ tests/integration/mysql-foundation.test.js      (18 tests)
✓ tests/integration/repositories.mysql.test.js    (21 tests)
```

A new `npm run test:contracts` runs the four contract/capability files in one shot for a
provider-parity check.

### 4.2 Standing gate set (all re-run after the phase)

| Gate                    | Result                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`        | **exit 0** — ESLint **0 errors / 5 warnings** (baseline), Prettier clean                                                  |
| Server tests            | **539 passed / 73 skipped (37 files)** — was 502 / 39; nothing renamed, skipped or removed                                |
| Client tests            | **284 / 284**                                                                                                             |
| Client build            | ✓ 419 ms                                                                                                                  |
| E2E (`playwright test`) | **34 / 34** (1.3 m)                                                                                                       |
| DOM-budget audit        | **PASS (11 checks)** — tablet 372 loaded / ≤24 mounted, laptop 372 / ≤28, control 20/20 not virtualized, 0 console errors |
| Responsive audit        | **exit 0** — 4/4 viewports, 0 px overflow, 0 small taps, a11y counters all 0                                              |
| API audit               | **56 / 56**                                                                                                               |
| Runtime audit           | **9 / 9**                                                                                                                 |
| Browser audit           | **15 / 15**                                                                                                               |
| Lifecycle probe         | **exit 0** — 20 cards mounted at `scrollY 777`, 0 console errors, legacy cursors still decode                             |
| API snapshot — MongoDB  | 84 / 84 **byte-identical** to `mongo-before-p2.json`                                                                      |
| API snapshot — MySQL    | 84 / 84 **byte-identical** to `mongo-before-p2.json`                                                                      |

The 73 skipped server tests are exactly the five MySQL-provider files (73 tests when the
suite runs with credentials), so nothing is silently lost when `verify` runs on a machine
without MySQL.

Environment note (unchanged from Phase 4, recorded for honesty): the sandbox has 2 GB RAM, so
the browser gates are run with `mysqld` stopped and the Mongo memory server is capped at a
0.25 GB WiredTiger cache. Those are sandbox constraints, not product constraints.

---

## 5. Section 10 acceptance criteria — Phase 5 position

| Criterion                                                                                         | Status                                                                                                                                        | Evidence                                                                                                    |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Shared contract suite passes against real DB instances, both providers                            | **VERIFIED**                                                                                                                                  | 30/30 on each provider, same file, §4.1                                                                     |
| Both providers fully functional                                                                   | **VERIFIED** (API level)                                                                                                                      | 84/84 API snapshot identical on each provider; full MySQL suite 73/73                                       |
| Concurrency-safe inventory on both                                                                | **VERIFIED**                                                                                                                                  | contract oversell test on both providers; MySQL heavy-contention + real deadlock-retry tests                |
| API contracts / frontend behaviour identical to the Phase 0 baseline                              | **VERIFIED**                                                                                                                                  | 84/84 snapshots, E2E 34/34, virtualisation and DOM-budget audits unchanged                                  |
| Switching provider by config, zero source changes                                                 | **VERIFIED**                                                                                                                                  | `DATABASE_PROVIDER` only; `npm run dev:mysql` / `npm run start:mysql`                                       |
| No new critical/high vulnerabilities                                                              | **VERIFIED**                                                                                                                                  | **no new dependencies** added this phase (no new dependency at all beyond the previously approved `mysql2`) |
| Migration verified (dry run, idempotency, orphans, counts, samples, constraints, decimals, dates) | **VERIFIED** (MySQL foundation suite, 18/18) — the full one-way _data_ migration is Phase 6                                                   |
| Final implementation report                                                                       | pending — Phase 7                                                                                                                             |
| Text-search parity                                                                                | **VERIFIED as documented divergence** — `regex` (default) identical; `text` mode differs on inflected forms by design; no silent substitution |

---

## 6. Files changed this phase

| File                                                     | Change                                                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `server/tests/globalSetup.js`                            | `MongoMemoryReplSet` (1 member, port 27999, 0.25 GB cache)                                                                 |
| `server/tests/contracts/repository-contract.js`          | **new** — shared dual-provider contract suite (26 tests)                                                                   |
| `server/tests/contracts/text-search-contract.js`         | **new** — text-search parity suite (4 tests × 2 providers)                                                                 |
| `server/tests/integration/contracts.mongo.test.js`       | **new** — Mongo adapter (contract + text search)                                                                           |
| `server/tests/integration/contracts.mysql.test.js`       | **new** — MySQL adapter (contract + text search)                                                                           |
| `server/tests/integration/db-capabilities.test.js`       | **new** — replica-set probe, real transaction commit/rollback, `REQUIRE_TRANSACTIONS` policy, registry bootstrap (7 tests) |
| `server/tests/integration/db-capabilities.mysql.test.js` | **new** — MySQL probe + real rollback (2 tests)                                                                            |
| `server/tests/integration/concurrency.mysql.test.js`     | **new** — heavy contention and a real deadlock retry (2 tests)                                                             |
| `server/src/db/index.js`                                 | extracted and exported `assertTransactionCapability`                                                                       |
| `server/src/db/mongo/provider.js`                        | probe inside a transaction now uses `find`, not `ping` (**bug fix**)                                                       |
| `server/src/db/mysql/provider.js`                        | probe proves rollback on one connection (**bug fix**)                                                                      |
| `server/package.json`                                    | `test:mysql` extended to five files; **new** `test:contracts`                                                              |

No application behaviour changed except the two probe fixes, and those are confirmed inert by
the 84/84 API snapshot on both providers. No frontend file was touched. No dependency was added.

---

## 7. Reproducing this phase

```bash
export PATH=/home/user/.cache/runtime/node22/bin:$PATH

# MongoDB side (replica set is started by the test globalSetup)
npm --workspace server test

# MySQL side — credentials are never committed, so they come from the environment
export MYSQL_TEST_HOST=127.0.0.1 MYSQL_TEST_PORT=3399 \
       MYSQL_TEST_USER=storefront_migrator MYSQL_TEST_PASSWORD=... \
       MYSQL_TEST_DATABASE=storefront_it_test
npm run test:mysql        # 73/73
npm run test:contracts    # both providers in one run

# Provider-parity API snapshot
DATABASE_PROVIDER=mysql node audit/api-contract-snapshot.mjs --out /tmp/mysql.json
node audit/api-contract-diff.mjs /opt/snapshots/mongo-before-p2.json /tmp/mysql.json
```

`MYSQL_REQUIRE=1` (set by `npm run test:mysql`) makes a missing MySQL server a **failure**, not
a skip — a skipped MySQL suite must never be able to masquerade as a green one.

---

## 8. Known limitations carried forward

1. **Text search in `text` mode is not stemming-equivalent** (InnoDB has no stemmer):
   `sneakers`/`sandals` match in MongoDB and not in MySQL. Pinned by test; the default
   `regex` mode is identical. Accepting and documenting this is the recommended option (a);
   options (b) `400 TEXT_SEARCH_UNAVAILABLE` on MySQL and (c) adding a stemmer dependency were
   offered in Phase 4 §5 and remain open for the user to choose.
2. **`excludeId` must be a canonical id**; a malformed one throws a `CastError` on Mongo and
   returns `false` on MySQL. Both callers pass validated ids, so this is unreachable through the
   API, but it is a genuine asymmetry rather than a tested guarantee.
3. The **browser gates** run against the MongoDB provider only (they assert frontend behaviour,
   which is provider-independent); the MySQL provider is held to the same behaviour by the API
   snapshot and the full MySQL suite.
4. **Sandbox provisioning** — MySQL 8.0.44, Playwright browsers and Node 22 were installed
   inside this sandbox; a fresh session must re-run
   `bash /opt/dev-tools/provision-local-mysql8.sh` and `npm ci`. All commands above must be
   re-run in the user's own environment or CI (recommended: ≥ 4 GB RAM, `MYSQL_REQUIRE=1`).

---

## 9. Next phase (6)

Seeding parity and the one-way MongoDB → MySQL data migration: identical seed fixtures on both
providers, a migration command with dry run, idempotency and orphan detection, plus count /
sample / constraint / decimal-precision / date comparisons between the two databases.
