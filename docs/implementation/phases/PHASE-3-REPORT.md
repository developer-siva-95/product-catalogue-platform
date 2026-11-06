# Phase 3 — MySQL Foundation

**Status:** complete. Schema, pool, migration runner and provider bootstrap are in place and
verified against a real **MySQL 8.0.44** server; the MongoDB path is unchanged and the public API
contract is still byte-identical.

**Date:** 2026-11-06 · **Server under test (MySQL):** 8.0.44, InnoDB, `utf8mb4_0900_as_ci`, port 3399 (sandbox)

---

## 1. What this phase delivered

Phase 2 made the application storage-agnostic. Phase 3 gives the second provider a real
foundation: a schema that mirrors the Mongo models, a pool whose settings guarantee identical
JSON, a checksummed migration runner, and a provider facade that both adapters plug into.

```
DATABASE_PROVIDER ──► src/db/index.js ──┬──► db/mongo/provider.js ──► Mongoose (reference)
                                        └──► db/mysql/provider.js ──► mysql2 pool ──► MySQL 8.0
                                                     │
                                                     └── schema via db/mysql/migrate.js (checksummed)
```

### Added

| File                                         | Purpose                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db/index.js`                            | Provider facade: `connectDatabase` (connect → probe → bind registry → enforce `REQUIRE_TRANSACTIONS`), `disconnectDatabase`, `getDatabaseState`, `getDatabaseHealth`, `withTransaction`, `getProvider`, `getProviderName`.                                                                        |
| `src/db/mongo/provider.js`                   | MongoDB adapter: connect/disconnect/state, **transaction capability probe** (start/commit a no-op transaction and report standalone vs replica set), session-based `withTransaction`, ping health.                                                                                                |
| `src/db/mysql/provider.js`                   | MySQL adapter: same surface; probe reports version, default storage engine, isolation level and any non-InnoDB table.                                                                                                                                                                             |
| `src/db/mysql/pool.js`                       | Pool with contract-critical settings (`timezone:'Z'`, `decimalNumbers:false`, `multipleStatements:false`, `utf8mb4` + session collation pin), `query`/`execute`, `withTransaction` with **deadlock retry** (1213/1205, jittered backoff, bounded attempts), `ping`, `closePool`, `isPoolCreated`. |
| `src/db/mysql/migrate.js`                    | Migration runner: discovery, SHA-256 checksums, `up` (idempotent), `status`, `down` (guarded), `--dry-run`, statement splitter, CLI.                                                                                                                                                              |
| `src/db/mysql/migrations/001_init.sql`       | The schema: `brands`, `categories`, `products`, `users` (+ `schema_migrations` ledger created by the runner).                                                                                                                                                                                     |
| `src/db/mysql/migrations/001_init.down.sql`  | Guarded rollback (children first).                                                                                                                                                                                                                                                                |
| `tests/unit/mysql-schema.test.js`            | **24 tests** — DDL invariants (binary ids, `DECIMAL(12,2)`, `DATETIME(3)`, binary slug/sku/email uniqueness, sparse SKU, OCC `version`, FKs, index coverage), statement splitter, checksum stability, destructive-guard rules.                                                                    |
| `tests/unit/db-provider.test.js`             | **12 tests** — exactly two providers, both implement the full adapter surface, unknown provider throws, disconnected-state reporting, pool settings that guarantee parity.                                                                                                                        |
| `tests/integration/mysql-foundation.test.js` | **18 tests** — the real-server suite (see §3).                                                                                                                                                                                                                                                    |
| `tests/helpers/mysql.js`                     | Real-MySQL harness: `*_test`-only guard, database bootstrap, raw connection, version probe, `MYSQL_REQUIRE` semantics.                                                                                                                                                                            |

### Changed

- `src/config/env.js` — `DATABASE_PROVIDER` (`mongodb`|`mysql`), provider-aware required fields (a MySQL
  deployment is not forced to configure MongoDB), `MYSQL_*` block, `REQUIRE_TRANSACTIONS`.
- `src/server.js` — boots through `connectDatabase()`; logs provider, supported providers and
  transaction capability; shutdown closes whichever provider is active.
- `src/routes/index.js` — health reads `getDatabaseState()`; **payload unchanged** (`status`,
  `uptimeSeconds`, `database`, `environment`), because the API contract is immutable.
- `server/package.json` — `mysql2` dependency (justified in the approved Phase 0 plan, §"Justified
  dependency additions") and the provider/migration scripts below.
- `tests/setup.js` — maps `MYSQL_TEST_*` onto `MYSQL_*` before `config/env.js` loads.
- `.env.example` — documents the provider switch, MySQL block, migration safety flags and test-suite variables.

### New npm scripts

```bash
npm run dev:mongodb          # reference provider
npm run dev:mysql            # MySQL provider (DATABASE_PROVIDER=mysql)
npm run start:mysql
npm run db:migrate:mysql     # apply schema (add :dry-run to preview)
npm run db:status:mysql      # ledger + pending
npm run db:down:mysql        # guarded rollback (test databases only by default)
npm run test:mysql           # MYSQL_REQUIRE=1 vitest run tests/integration/mysql-foundation.test.js
```

---

## 2. Schema design — the rules that make parity possible

| Mongo behaviour                          | MySQL mechanism                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_id: ObjectId` exposed as 24-hex string | `id CHAR(24) CHARACTER SET ascii COLLATE ascii_bin` — byte-order comparison, so `ORDER BY id DESC` **is** `sort({ _id: -1 })`, and ids already held by clients stay valid across providers. |
| `price: Number` rounded to 2 dp          | `DECIMAL(12,2)` + repository-level string→number conversion (mysql2 returns DECIMAL as a string); no float ever touches money.                                                              |
| `timestamps: true` (JS `Date`)           | `DATETIME(3)` + pool `timezone:'Z'`; verified to round-trip an exact UTC instant.                                                                                                           |
| `/i` regex search                        | table collation `utf8mb4_0900_as_ci` + session collation pinned per connection.                                                                                                             |
| binary unique `slug`/`sku`/`email`       | those columns pinned to `COLLATE utf8mb4_bin`; verified that `case-brand` and `CASE-BRAND` coexist while an exact duplicate is rejected.                                                    |
| `sku` unique **sparse**                  | nullable `sku` with a unique key — MySQL treats `NULL`s as distinct.                                                                                                                        |
| `__v` optimistic concurrency             | `version INT`; guarded `UPDATE … WHERE id = ? AND version = ?`, `affectedRows = 0` ⇒ stale ⇒ 409.                                                                                           |
| atomic guarded `$inc` for stock          | `UPDATE … SET stock = stock - ? WHERE id = ? AND stock >= ?` inside a transaction.                                                                                                          |
| `ref: 'Brand'` / `ref: 'Category'`       | real FKs (`1451`/`1452`), so orphan products are impossible by construction.                                                                                                                |
| storefront sort/filter indexes           | matching composite indexes (`is_active,id`), (`is_active,price,id`), (`is_active,price DESC,id DESC`), (`is_active,brand_id`), (`is_active,category_id`), (`brand_id,category_id,price`)    |

---

## 3. Verification against the real MySQL server

`npm run test:mysql` (i.e. `MYSQL_REQUIRE=1` + credentials) → **18 / 18 passed** on **MySQL 8.0.44**.

| Check               | Result                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Server identity     | `8.0.44`, InnoDB, `utf8mb4_0900_as_ci`                                                                                               |
| Tables created      | `brands`, `categories`, `products`, `schema_migrations`, `users` — every app table InnoDB + `utf8mb4_0900_as_ci`                     |
| Ledger              | `001_init`, 64-hex checksum, statement count recorded                                                                                |
| Idempotency         | second `up` → `applied: []`, `skipped: ['001_init']`; `status` shows 0 pending                                                       |
| `--dry-run`         | reports the pending migration and writes **nothing** (verified via `information_schema`)                                             |
| Drift detection     | tampered migration file → `Migration 001_init was modified after it was applied`                                                     |
| Money               | column is `decimal(12,2)`; driver returns `'19.99'` (string)                                                                         |
| Timestamps          | inserted `2026-01-02T12:00:00.000Z` → read back as the same `Date`; session `time_zone` UTC                                          |
| Transactions        | commit persists; thrown error rolls back (row absent)                                                                                |
| Duplicate key       | `ER_DUP_ENTRY` / `1062`, message names the constraint                                                                                |
| Binary uniqueness   | `case-brand` + `CASE-BRAND` both allowed; exact duplicate rejected; lowercased `name_normalized` collides                            |
| Foreign keys        | unknown brand → `1452`; deleting a referenced brand → `1451`                                                                         |
| **Oversell guard**  | 12 concurrent guarded decrements against stock=5 → **exactly 5 succeed**, final stock 0                                              |
| **Deadlock retry**  | transaction that deadlocks twice then succeeds → 3 attempts, returns normally; retry budget exhaustion rethrows the original `errno` |
| Rollback round trip | `down` → tables gone → `up` rebuilds; `down` refuses a non-`_test` database                                                          |
| Pool facade         | `SELECT VERSION()` through the shared pool matches the server version                                                                |

Migration CLI against the dev database (`storefront`) — additive only (`CREATE TABLE IF NOT EXISTS`):

```
$ npm run db:migrate:mysql
applied: 001_init · already applied: (none)      # 4 statements, 99 ms
$ npm run db:status:mysql
applied  001_init  4 stmt(s)  99 ms
$ npm run db:migrate:mysql:dry-run
would apply: (none)                              # idempotent
```

Startup probe on the MySQL provider (before the repository binding, which lands in P4):

```json
{"msg":"mysql connected","database":"storefront","version":"8.0.44","poolLimit":10}
{"msg":"database capabilities","provider":"mysql","transactions":true,"version":"8.0.44",
 "storageEngine":"InnoDB","isolation":"REPEATABLE-READ"}
```

---

## 4. Gate results (P3 close)

| Gate                               | Result                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`                   | **exit 0** — ESLint **0 errors / 5 warnings** (unchanged), Prettier clean, server **489 passed / 18 skipped**, client **284/284**, build ✓ 365 ms |
| Server tests (default provider)    | **489 passed, 18 skipped** (the MySQL suite, no credentials) — up from 448; **no test removed, renamed or skipped that previously ran**           |
| MySQL suite (`npm run test:mysql`) | **18 / 18 passed** against MySQL 8.0.44                                                                                                           |
| E2E                                | **34 / 34 passed** (1.4 min)                                                                                                                      |
| DOM budget                         | **PASS (11 checks)**                                                                                                                              |
| Responsive                         | 4 / 4 viewports, 0 px overflow                                                                                                                    |
| API audit                          | **56 / 56**                                                                                                                                       |
| Runtime audit                      | **9 / 9**                                                                                                                                         |
| Browser audit                      | **15 / 15**                                                                                                                                       |
| Lifecycle probe                    | exit 0 — 20 cards restored @ scrollY 777, 0 refetches, 0 console errors                                                                           |
| **API contract snapshot**          | **84 / 84 byte-identical** vs the P2 baseline (`mongo-after-p3.json`)                                                                             |

Environmental note (unchanged from P2): browser gates run with `mysqld` stopped, because a resident
MySQL buffer pool on a 2 GB sandbox pushes scroll-restoration polling over its budget. MySQL is
started only for the MySQL suites.

---

## 5. Decisions and limitations

1. **`/health` payload is unchanged.** It reports `database: 'connected'` for both providers. The
   provider name is logged at boot and available from `getProviderName()`, but exposing it in the
   response would change the contract snapshot, which the ruleset forbids. (If the contract may be
   extended later, adding `provider` is a one-line change.)
2. **`DATABASE_PROVIDER=mysql` does not serve traffic yet** — by design, at the end of P3 the registry
   has only the MongoDB implementation, so boot fails fast with
   `Unknown DATABASE_PROVIDER "mysql". Supported: mongodb`. P4 registers the MySQL repositories.
3. **MySQL test suites skip without credentials.** `npm run verify` must stay runnable on a machine
   without MySQL; `MYSQL_REQUIRE=1` (used by `npm run test:mysql` and intended for CI) converts a
   missing server into a failure so a skipped suite can never look like a green one.
4. **Text search parity is still open.** The DDL declares a `FULLTEXT` index on `(title, description)`,
   but InnoDB's parser (stopwords, `innodb_ft_min_token_size=3`, stemming) cannot be assumed to match
   Mongo's `$text` with `weights {title:10, description:2}`. P4 measures both and reports the residual
   difference rather than silently choosing.
5. **DDL is not transactional in MySQL.** Each migration file is therefore written to be individually
   re-runnable, the runner reports the failing statement index, and the ledger is only written after a
   file succeeds — so a crashed run repeats instead of half-marking.
6. `mysql2` is the only new runtime dependency, as approved in the Phase 0 plan.

---

## 6. Next: Phase 4 — MySQL repositories

1. `repositories/mysql/{products,brands,categories,users}.repository.js` implementing the exact P2
   contracts (same method names, same argument shapes, same return shapes, same error codes via a new
   `repositories/mysql/error-mapping.js`: `1062`→`DUPLICATE_KEY`, `1451/1452`→in-use/orphan,
   `1213/1205`→retried then `CONFLICT`).
2. Register the provider and make `npm run dev:mysql` serve the full API.
3. Cursor pagination and the **filter hash must stay byte-identical** to the Mongo implementation
   (`buildStorefrontQueryParts` is shared), so pre-P1 cursor tokens keep decoding.
4. Text search: implement `MATCH … AGAINST` and a weights-compatible fallback, then measure against
   the Mongo reference on the fixture corpus and report the difference.
5. Extend the API contract snapshot run to the MySQL provider and diff it against the Mongo baseline.
