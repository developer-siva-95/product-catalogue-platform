# Phase 4 — MySQL Repositories

**Status:** complete, with one **measured behavioural deviation that needs your decision** (text-search
stemming, §5). Everything else is byte-identical to the MongoDB reference.

**Date:** 2026-11-06 · **MySQL:** 8.0.44 / InnoDB (sandbox, port 3399) · **MongoDB:** reference provider

---

## 1. What this phase delivered

The four MySQL repositories, plus the two cross-provider details that had to be pulled out of the Mongo
implementation for a second provider to be possible.

| File                                                                       | Purpose                                                                                                                            |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/repositories/mysql/products.repository.js`                            | 14-method products contract: cursor pagination, facets, search, OCC updates, guarded stock, taxonomy counts, image-orphan scan.    |
| `src/repositories/mysql/brands.repository.js`                              | Brands contract (+ `countProducts` via one `GROUP BY`).                                                                            |
| `src/repositories/mysql/categories.repository.js`                          | Categories contract, including the conditional `image` key.                                                                        |
| `src/repositories/mysql/users.repository.js`                               | Users contract: bcrypt (cost 12, shared with Mongo), lockout, login recording, password rotation + `tokenVersion`.                 |
| `src/repositories/mysql/objectid.js`                                       | ObjectId-compatible 24-hex ids (time prefix + random + counter) so `ORDER BY id` equals Mongo's `_id` order and ids stay portable. |
| `src/repositories/mysql/sql.js`                                            | LIKE escaping, placeholder lists, DECIMAL→number, binary-collation ORDER BY.                                                       |
| `src/repositories/mysql/error-mapping.js`                                  | 1062→`DUPLICATE_KEY` 409, 1451→`RESOURCE_IN_USE` 409, 1452→`VALIDATION_ERROR` 400, 1406/1264/3819→422, 1213/1205→`CONFLICT` 409.   |
| `src/repositories/storefront-query.js`                                     | **The shared cursor filter fingerprint** — one definition of the hash embedded in every cursor.                                    |
| `src/db/mysql/migrations/002_categories_image_nullable.sql` (+`.down.sql`) | See §3.                                                                                                                            |

### Refactors required (all behaviour-preserving, all verified by the 84-entry snapshot)

1. **`repositories/storefront-query.js`.** The filter hash that signs every storefront cursor now has a
   single definition used by both providers. Pre-P1 cursor fixtures still decode, and a cursor minted by
   MongoDB is accepted by MySQL for the same filters (verified by the fixture suite).
2. **`utils/slugify.js` / `utils/skuGenerator.js`** accept either a Mongoose model or a provider-neutral
   `(candidate, { excludeId }) => boolean` probe, so _the candidate sequence itself_ (which decides the
   slug you actually get: `x`, `x-2`, `x-3`, then randomised) is the same code for both providers.
   `withDuplicateKeyRetry` now also retries MySQL's `ER_DUP_ENTRY`.
3. **`repositories/index.js`** registers the `mysql` provider, so `DATABASE_PROVIDER=mysql` boots and
   serves. Importing the set validates all four implementations against their contracts.
4. `audit/api-contract-snapshot.mjs` is now **provider-agnostic**: same boot, same 84 requests, same
   masking; only the fixture inserts differ. `DATABASE_PROVIDER=mysql` records the MySQL snapshot.

---

## 2. The headline result: MySQL passes the MongoDB contract snapshot

```
$ node audit/api-contract-snapshot.mjs --out /opt/snapshots/mysql-after-p4.json     # DATABASE_PROVIDER=mysql
wrote 84 contract snapshots to /opt/snapshots/mysql-after-p4.json (provider: mysql)

$ node audit/api-contract-diff.mjs /opt/snapshots/mongo-before-p2.json /opt/snapshots/mysql-after-p4.json
compared 84 entries against 84
CONTRACT STABLE: every entry is byte-identical (status, key order, types, values)
```

All **84** entries — every endpoint and error path recorded in P2, including cursor pages, 409/400/404/401/
403 payloads, the taxonomy `productCount` numbers, OCC staleness, duplicate keys, the orphan sweep and the
delete flows — produce **byte-identical JSON** (status, key order, types, values) from MySQL.

Three defects were found by this diff and fixed, i.e. the harness is doing real work:

| Symptom                                                               | Root cause                                                                                                         | Fix                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `search=b` returned 0 rows on MySQL                                   | `sku` is `utf8mb4_bin` (exact uniqueness), so an inherited `LIKE` was case-sensitive while Mongo uses `/b/i`       | search forces `COLLATE utf8mb4_0900_as_ci` on the compared _expressions_ |
| `sort=price` was ordered as text (`100` < `1000` < `250.50` < `5.25`) | `COLLATE utf8mb4_bin` applied to a `DECIMAL` column                                                                | collation only on text sort columns                                      |
| Writes returned 500 after the slug refactor                           | a Mongoose model _is_ a function, so the "probe function" branch captured it and called the model as a constructor | `typeof target.exists === 'function'` is tested first                    |

---

## 3. Schema change in this phase

`002_categories_image_nullable.sql` — `categories.image` is now `NULL DEFAULT NULL`.

Why: the Mongo category schema never declared `image`, so the key is _absent_ for application-created
categories but _present_ (`""`) for documents that were inserted directly (the snapshot fixtures do this).
A `NOT NULL DEFAULT ''` column cannot represent that difference, and the category detail payload would
have diverged. `NULL` now means "no field" and `''` means "present but empty", which reproduces both cases
(verified by `category.detail_id`, which contains `"image":""`, while `admin.category_create` omits the key).

The migration pair is also evidence that the runner handles **multiple** migrations, applies them in order
and stores a checksum for each.

---

## 4. Verification

### 4.1 MySQL suite (real server) — 39/39

```
$ npm run test:mysql        # SKIP_MONGO_MEMORY=1 MYSQL_REQUIRE=1 vitest run <the two MySQL files>
Test Files  2 passed (2)
     Tests  39 passed (39)          Duration 7.10s
```

- `tests/integration/mysql-foundation.test.js` — **18** (schema, ledger, idempotency, dry-run, drift
  detection, DECIMAL/timestamp round-trip, transaction commit/rollback, duplicate key, binary uniqueness,
  FKs, **12 concurrent guarded decrements on stock 5 → exactly 5 succeed**, deadlock retry + budget
  exhaustion, down→up round trip, destructive guard).
- `tests/integration/repositories.mysql.test.js` — **21**, deliberately the same expectations as
  `repositories.mongo.test.js`: canonical ids, `null` vs missing, SKU upper-casing, inactive visibility,
  slug lookup, stock overdraw, stale version 409, re-slug on rename, cursor paging with no overlap,
  price/cursor sort order, search + facets, delete, taxonomy counts, image-file scan, slug/SKU allocation,
  duplicate SKU, taxonomy CRUD/rename/sort, user hashing/lockout/rotation and the exact record key shape.

### 4.2 Gates

| Gate                        | Result                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`            | **exit 0** — ESLint **0 errors / 5 warnings** (unchanged), Prettier clean, server **502 passed / 39 skipped**, client **284/284**, build ✓ 382 ms |
| MySQL suite                 | **39 / 39**                                                                                                                                       |
| E2E                         | **34 / 34**                                                                                                                                       |
| DOM budget                  | **PASS (11 checks)**                                                                                                                              |
| Responsive                  | 4 / 4 viewports                                                                                                                                   |
| API audit                   | **56 / 56**                                                                                                                                       |
| Runtime audit               | **9 / 9**                                                                                                                                         |
| Browser audit               | **15 / 15**                                                                                                                                       |
| Lifecycle probe             | 20 cards restored @ scrollY 777, 0 refetches, 0 console errors                                                                                    |
| Mongo contract snapshot     | **84 / 84 byte-identical**                                                                                                                        |
| **MySQL contract snapshot** | **84 / 84 byte-identical**                                                                                                                        |

Server test count: 448 → 489 → **502** (+13 `mysql-helpers` unit tests this phase; 39 MySQL integration
tests skip without credentials). No test was removed, renamed or skipped that previously ran.

### 4.3 Real-server smoke test (least-privilege user)

```
$ DATABASE_PROVIDER=mysql MYSQL_USER=storefront_app MYSQL_PASSWORD=… node src/server.js
{"msg":"mysql connected","database":"storefront","version":"8.0.44","poolLimit":10}
{"msg":"server listening","provider":"mysql","supportedProviders":["mongodb","mysql"],"transactions":true}

GET /api/v1/health       200 {"status":"ok","uptimeSeconds":4,"database":"connected",…}
GET /api/v1/products     200 {"data":[],"meta":{"limit":2,"count":0,"sort":"newest",…}}
GET /api/v1/brands       200 {"data":[],"meta":{"total":0}}
```

The app user has DML rights only — proving the request path never needs DDL.

---

## 5. ⚠️ Open decision: `searchMode=text` does not stem on MySQL

`searchMode=text` (admin table, opt-in) uses Mongo `$text` on the reference provider and InnoDB `FULLTEXT`
on MySQL. Measured on the same six-product corpus:

| search term | MongoDB `$text`     | MySQL `FULLTEXT` | note                                                          |
| ----------- | ------------------- | ---------------- | ------------------------------------------------------------- |
| `sneaker`   | 1 (`Alpha Sneaker`) | 1                | exact token — identical                                       |
| `sneakers`  | 1                   | **0**            | Mongo stems plurals, InnoDB does not                          |
| `Sandal`    | 1                   | 1                | identical                                                     |
| `sandals`   | 1                   | **0**            | same stemming difference                                      |
| `cap`       | 1                   | 1                | identical                                                     |
| `boot`      | 1                   | 1                | identical                                                     |
| `the`       | 0                   | 0                | stopword on both                                              |
| `be`        | 0                   | 0                | stopword (Mongo) / below `innodb_ft_min_token_size=3` (MySQL) |

InnoDB ships **no stemmer**; MySQL 8 has no built-in English analyser, and adding one means a new
dependency (forbidden without your approval). So a strict "identical text-search recall" requirement
**cannot be met** with the current stack.

I have deliberately **not** chosen a workaround, because each one is a behaviour change:

- **(a) Accept and document** _(no code change; my recommendation)_ — `searchMode` defaults to `regex`,
  which is byte-identical on both providers (proven by the snapshot). Text mode stays an admin-only,
  opt-in convenience whose recall differs only for inflected forms; document it in the README/API docs.
- **(b) Keep Mongo-only strictness** — return a documented `400 TEXT_SEARCH_UNAVAILABLE` when
  `searchMode=text` is used on MySQL, so behaviour never silently differs.
- **(c) Add a small stemmer dependency** (or maintain a hand-written suffix table) and apply it to both
  providers' text mode — new dependency, needs explicit approval, and it still will not match Lucene's
  analyser exactly.

Until you choose, the P5 matrix asserts text-mode parity for exact tokens and records the inflection
difference as a known deviation. **No API response shape changes under any option.**

Two further, non-actionable differences worth knowing:

- A product referencing a non-existent brand **cannot exist** in MySQL (real FK). The snapshot's orphan
  product is therefore MongoDB-only; the `sweep-orphans` endpoint reports orphaned _image files_, so its
  response is unaffected (proven identical).
- MySQL comparisons are accent-insensitive (`utf8mb4_0900_as_ci`) where Mongo's `/i` is accent-sensitive:
  `search=cafe` matches `café` on MySQL and not on Mongo. Making this exact would require
  `LOWER(col) LIKE LOWER(?)`, which trades an index-free scan for an edge case; not done, documented.

---

## 6. Environmental fixes (sandbox only — you will not need these on CI)

| Problem                                                  | Cause                                                                                                       | Fix                                                                                                                                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mongod` died with `invariant() failure`; suites stalled | `/tmp` is a **992 MB tmpfs** and had filled with three abandoned 301 MB `mongo-mem-*` db paths              | cleaned `/tmp`; the memory server already cleans up on success — only crashed runs leak                                                                                                                     |
| 30 s test timeouts and a load average of 16              | 2 GB RAM: a 128 MB MySQL buffer pool + per-connection buffers pushed the kernel into swap (`kswapd` at 8 %) | provisioner now uses a **48 MB** buffer pool and `performance_schema=OFF`; `--wiredTigerCacheSizeGB 0.25` added to all three mongod launchers; MySQL-only runs skip mongod entirely (`SKIP_MONGO_MEMORY=1`) |
| Browser gates flaked on scroll restoration               | MySQL resident during Chromium runs                                                                         | browser gates run with `mysqld` stopped                                                                                                                                                                     |

Recommended for a real machine/CI: ≥ 4 GB RAM, MySQL 8.0 with the default buffer pool, and
`MYSQL_REQUIRE=1` so a missing MySQL fails instead of skipping.

---

## 7. Next: Phase 5 — dual-provider test matrix

1. One **shared contract suite** parameterised over `DATABASE_PROVIDER`, run against real MongoDB
   (single-node replica set, per decision D2(a)) and real MySQL.
2. Switch `mongodb-memory-server` to `MongoMemoryReplSet` (1 member) and assert the startup probe reports
   transactions **available**; add a `REQUIRE_TRANSACTIONS=true` boot test for both providers.
3. Concurrency/oversell, deadlock-retry, duplicate-key, case-sensitive-id, pagination and text-search
   results recorded **per provider** (the P4 evidence moves into the automated suite).
4. Both snapshots regenerated and diffed in CI, not by hand.
