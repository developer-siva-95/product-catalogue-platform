# Phase 6 — Seeding parity and the one-way MongoDB → MySQL migration

**Status:** complete. Every gate in the standing gate set was re-run after the phase and passes.
**Date:** 2026-11-06
**Predecessor:** `PHASE-5-REPORT.md` (dual-provider test matrix). **Successor:** Phase 7 (ops/hardening + final report).

---

## 1. What this phase had to deliver

1. **`excludeId` asymmetry fixed** — both providers must reject a malformed id identically, with a shared contract test.
2. **Text-search decision closed** — one option chosen, the other deleted.
3. **Phase 6 proper**:
   - seed scripts idempotent on both providers (run twice: no duplicates **and no changes**);
   - one-way MongoDB → MySQL migration with dry run, idempotency, and orphan detection that fails or quarantines **explicitly, before any insert**;
   - Mongo `_id` preserved as `CHAR(24)` / `ascii_bin`;
   - post-migration verification: counts, sample equality, foreign keys, unique constraints, decimal precision, date/time conversion, null/missing fields;
   - tested against a **deliberately messy** fixture, not only clean seed data;
   - a documented rollback procedure with explicit confirmation before every destructive step.
4. All gates kept, snapshots compared, counts only went up.

---

## 2. Item 1 — `excludeId` is now rejected identically by both providers

Before this phase the same call had two outcomes: Mongoose threw `CastError: Cast to ObjectId failed for value "x"` (a 500), while MySQL ran `WHERE id <> 'x'` and returned `false`. Phase 5 recorded it as a known asymmetry; it is now closed.

**Implementation** — `server/src/repositories/identifier.js`:

```js
export function assertCanonicalId(value, { field = 'excludeId' } = {}) {
  if (value === undefined || value === null || value === '') return value; // "no exclusion"
  if (/^[0-9a-f]{24}$/.test(value)) return value;
  throw ApiError.badRequest(
    `Invalid ${field}: expected a 24-character lowercase hexadecimal identifier`,
    { code: 'INVALID_IDENTIFIER', details: { field, value } },
  );
}
```

Applied at **six** repository entry points on **both** providers: `products.existsBySlug`, `products.existsBySku`, `products.allocateSlug`, `products.allocateSku`, `brands.existsByName`, `categories.existsByName`. Only _exclusions_ are validated — a lookup identifier may legitimately be a slug, so `findById('aurora-buds-pro')` keeps its "not found → null" contract.

**Contract test** (`repository-contract.js`, runs on both providers):
valid exclusion accepted (and genuinely excludes), absent exclusion allowed, and four malformed forms (`not-an-id`, `xyz`, a 23-character id, an **uppercase** id) rejected through all six entry points with exactly:

```
{ statusCode: 400, code: 'INVALID_IDENTIFIER',
  message: 'Invalid excludeId: expected a 24-character lowercase hexadecimal identifier',
  details: { field: 'excludeId', value: <the bad value> } }
```

`ApiError` is operational, so the HTTP layer renders it as a normal 400 error payload — the API snapshots (84/84, both providers) confirm no reachable route changed shape.

**One pre-existing test was updated, not removed** (declared per the standing rules):
`tests/integration/repositories.mysql.test.js` → _"allocates unique slugs and SKUs"_ previously asserted
`existsBySlug('twin-product', { excludeId: 'x' }) === true` — i.e. it was pinning the MySQL side of the bug. It now creates a product and asserts self-exclusion with the real id (`false`); the rejection itself is covered by the shared contract suite for both providers.

---

## 3. Item 2 — text search: **Phase 4 option (a) implemented** (documented divergence kept)

The choice, stated explicitly so it cannot be re-litigated by accident:

> **Option (a): keep the documented divergence. InnoDB FULLTEXT has no stemmer, so inflected forms (`sneakers`, `sandals`) match in MongoDB and not in MySQL. The difference is documented and pinned by test; the default `regex` search mode is identical on both providers.**

Why not the alternatives:

- **(b) return `400 TEXT_SEARCH_UNAVAILABLE` on MySQL** — that would make a _default-capable_ provider refuse a request the other provider serves, which contradicts "MySQL is equally functional" and would add an API error path that the Phase 0 baseline does not have.
- **(c) add a stemming dependency** — the master prompt forbids new dependencies beyond the approved `mysql2`, and a stemmer would also change MongoDB's results (or create a _new_ divergence between `$text` and the application normaliser), i.e. it would break response immutability for search queries.

The divergence is now a test, not prose: `tests/contracts/text-search-contract.js` asserts the same 10-term matrix on each provider, and asserts the stemming difference **in both directions** — if someone adds a stemmer to MySQL, or Mongo regresses, the suite fails:

| term           | MongoDB `regex` | MySQL `regex`   | MongoDB `text` | MySQL `text` |
| -------------- | --------------- | --------------- | -------------- | ------------ |
| `sneaker`      | 1               | 1               | 1              | 1            |
| `sneakers`     | 0               | 0               | **1**          | **0**        |
| `Sandal`       | 1               | 1               | 1              | 1            |
| `sandals`      | 0               | 0               | **1**          | **0**        |
| `cap` / `boot` | 1 / 1           | 1 / 1           | 1 / 1          | 1 / 1        |
| `the` / `be`   | 1 / 2           | 1 / 2           | 0 / 0          | 0 / 0        |
| blank query    | matches nothing | matches nothing | 0              | 0            |

---

## 4. Item 3 — seeding is now provider-neutral and idempotent

`server/src/config/seed.js` no longer imports Mongoose. It writes exclusively through `getRepositories()`, so the **same fixture set** loads into either database and `npm run seed:mysql` (`DATABASE_PROVIDER=mysql`) is the only difference.

Identity is the natural key — `email`, `nameNormalized`, `slug` — and an existing row is left **completely untouched** (no upsert, no `updatedAt` bump). Two new repository methods make that possible on both providers (`brands.findByNameNormalized`, `categories.findByNameNormalized`); `users.existsByEmail` and `products.existsBySlug` already existed.

The summary keeps the pre-P6 shape (`summary.categories` is still the created count, so the untouched pre-existing `tests/integration/seed.test.js` passes) and adds detail:

```json
{ "provider": "mysql", "admin": { "created": true, "email": "admin@catalogue.com" },
  "categories": 6, "brands": 6,
  "products": { "total": 22, "created": 22, "skipped": 0 },
  "detail": { "categories": { "total": 6, "created": 6, "skipped": 0 }, "brands": { … } },
  "changed": 35 }
```

**Evidence** — `tests/contracts/seed-contract.js`, executed once per provider (`seed.mongo.test.js`, `seed.mysql.test.js`):

| Assertion                                                                                                                       | mongodb | mysql |
| ------------------------------------------------------------------------------------------------------------------------------- | ------- | ----- |
| first run loads 6 categories, 6 brands, 22 products, 1 admin                                                                    | ✓       | ✓     |
| second run: `changed: 0`, every `created` 0 / `skipped` = fixture size                                                          | ✓       | ✓     |
| second run: **full fingerprint** of every row (id, every column, `createdAt`, `updatedAt`, `__v`) is `toEqual` to the first run | ✓       | ✓     |
| partial seed: delete 5 products, re-seed → exactly 5 recreated, 17 kept, survivor rows unmoved                                  | ✓       | ✓     |

The fingerprint comparison is the part that matters: an "upsert" seed would pass a duplicate-count check while silently rewriting timestamps. This one cannot.

---

## 5. Item 3 — the one-way migration

Implementation: `server/src/db/migrate/mongo-to-mysql/` — `mapping.js` (the single declarative mapping), `extract.js` (read-only Mongo extraction), `validate.js` (all findings), `apply.js` (diff + transactional write), `verify.js` (7 checks), `index.js` (orchestrator + rollback + confirmation), `cli.js` (operator surface).

### 5.1 Dry run is the default; nothing is written without two acknowledgements

- `npm run migrate:data` → **read, map, validate, diff**. No INSERT/UPDATE/DELETE, no manifest. Asserted by counting rows before and after.
- `--apply` alone is rejected: `--confirm` must equal the database `SELECT DATABASE()` returns, so a stale `MYSQL_DATABASE` fails instead of migrating into the wrong place (`MIGRATION_CONFIRMATION_REQUIRED` / `MIGRATION_CONFIRMATION_MISMATCH`).
- A target holding rows the source does not know about is refused (`TARGET_NOT_EMPTY`) unless `--allow-non-empty`; the tool **never deletes**.

### 5.2 Orphan detection happens before any insert

Every document is validated in memory first: `ORPHAN_REFERENCE`, `MISSING_REQUIRED`, `UNIQUE_COLLISION`, `DECIMAL_PRECISION`, `DATE_OUT_OF_RANGE`, `STRING_TOO_LONG`, `VALUE_INVALID`, `ID_INVALID`. Any blocking finding aborts with `ok: false` and the target byte-identical. `--quarantine=<file>` skips rejected rows and records each one with its reason — and refuses (`QUARANTINE_WOULD_ORPHAN`) if the skip itself would leave a child pointing at a missing parent.

### 5.3 Ids are preserved

`_id` → `CHAR(24) CHARACTER SET ascii COLLATE ascii_bin`, verbatim. Test asserts the stored id equals `String(source._id)`, length 24, and reads the charset/collation back from `information_schema`. Cursors and every API response that embeds an id therefore stay valid after the switch.

### 5.4 Verification (7 checks)

`record-counts`, `sample-equality` (every mapped column of a spread sample, source vs stored), `foreign-keys`, `unique-constraints`, `decimal-precision` (per-column scale/min/max), `date-time-conversion` (null counts + min/max), `null-and-missing-fields` (NULL counts per column). A deliberately corrupted target is caught (`sample-equality` reports the tampered column rather than passing).

### 5.5 Idempotent

Rows are matched by preserved id and compared column by column; only genuine differences are written. Second apply: `inserted: 0, updated: 0, unchanged: N`, and the `updated_at` of an existing row is unchanged.

### 5.6 The messy fixture

`server/tests/fixtures/messy-catalogue.js` inserts documents through the **raw driver** (no validation, no defaults, no casting) — the way a legacy database really looks:

| Fixture                                                                                | Defect                             | Expected outcome                                                |
| -------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| product → nonexistent brand / category                                                 | orphaned FK                        | `ORPHAN_REFERENCE`, fatal                                       |
| product with no `description`                                                          | NOT NULL column empty              | `MISSING_REQUIRED`                                              |
| user with no `passwordHash`                                                            | NOT NULL column empty              | `MISSING_REQUIRED`                                              |
| two brands differing by trailing space                                                 | both normalise to one UNIQUE key   | `UNIQUE_COLLISION`                                              |
| two users differing only by email case                                                 | one UNIQUE key after lower-casing  | `UNIQUE_COLLISION`                                              |
| prices `19.999`, `0.005`, `1e10`                                                       | >2 decimals / out of DECIMAL(12,2) | `DECIMAL_PRECISION` (with `wouldBecome`)                        |
| SKU of 80 characters                                                                   | longer than VARCHAR(64)            | `STRING_TOO_LONG`                                               |
| dates: epoch, `2038-01-19T03:14:07Z`, leap day, `9999-12-31T23:59:59.999Z`, year 10000 | DATETIME boundaries                | first four round-trip exactly; year 10000 → `DATE_OUT_OF_RANGE` |
| `sku: null` vs `sku: ''`, `image: null` vs key absent                                  | NULL vs missing                    | both → `NULL` (sparse unique), verified after the move          |

### 5.7 Rollback

Documented in **`PHASE-6-MIGRATION-RUNBOOK.md`** and implemented as `npm run migrate:data:rollback -- --confirm=<db> --manifest=<file>`: deletes rows that run inserted, restores rows it updated to their recorded before-image, in reverse FK order, in **one transaction**, and refuses without the exact database name (`MIGRATION_CONFIRMATION_REQUIRED/MISMATCH`) or when the manifest belongs to another database (`ROLLBACK_MANIFEST_MISMATCH`). A row that existed before the migration is proven to survive the rollback.

---

## 6. Test results

### 6.1 New and extended suites

| Suite                                         | Provider                           | Result                     |
| --------------------------------------------- | ---------------------------------- | -------------------------- |
| `tests/integration/migration.test.js`         | MongoDB replica set → MySQL 8.0.44 | **15 / 15 passed** (4.1 s) |
| `tests/integration/seed.mongo.test.js`        | MongoDB replica set                | **3 / 3 passed**           |
| `tests/integration/seed.mysql.test.js`        | MySQL 8.0.44                       | **3 / 3 passed**           |
| shared contract suite (now incl. `excludeId`) | both                               | **31 / 31** each           |

`npm run test:migration` → **15/15** (new script).
`npm run test:mysql` → **6 files, 77/77** (was 73; +3 seed, +1 contract).

### 6.2 Standing gate set (all re-run after the phase)

| Gate                   | Result                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run verify`       | **exit 0** — ESLint **0 errors / 5 warnings** (baseline), Prettier clean                                        |
| Server tests           | **543 passed / 92 skipped (40 files)** — was 539 / 73; nothing removed or renamed (one expectation updated, §2) |
| Client tests           | **284 / 284**                                                                                                   |
| Client build           | ✓ 462 ms                                                                                                        |
| E2E                    | **34 / 34** (1.3 m)                                                                                             |
| DOM-budget audit       | **PASS (11 checks)** — tablet 372/≤24, laptop 372/≤28, control 20/20 not virtualized, 0 console errors          |
| Responsive audit       | **exit 0** — 4/4 viewports, 0 px overflow, 0 small taps                                                         |
| API audit              | **56 / 56**                                                                                                     |
| Runtime audit          | **9 / 9**                                                                                                       |
| Browser audit          | **15 / 15**                                                                                                     |
| Lifecycle probe        | **exit 0** — 0 console errors, legacy cursors still decode                                                      |
| API snapshot — MongoDB | 84 / 84 **byte-identical** to `mongo-before-p2.json`                                                            |
| API snapshot — MySQL   | 84 / 84 **byte-identical** to `mongo-before-p2.json`                                                            |

Test universe grew 612 → 635. Counts only went up.

### 6.3 An incident worth recording

My first version of the provider-neutral seeder replaced the seeded **fixture data** with a hand-written catalogue of similar shape. It type-checked, and every unit/integration suite passed — the damage showed up only in the browser gate chain: **api-audit failed 2 of 56 checks** (`search=aurora` returned 3 instead of 5; an admin total came back falsy) because the audits assert against the fixture catalogue.

I restored the original `CATEGORY_SEED` / `BRAND_SEED` / `PRODUCT_SEED` arrays verbatim from the pre-phase snapshot (`server/src/config/seed.js` in `/tmp/arena-workspace/hydrate.zip`, 554 lines) and re-ran everything: 56/56, 34/34, 84 entries stable. The fixture set is **6 categories, 6 brands, 22 products, 1 admin** — the seed tests now pin those numbers.

Lesson, for the record: a rewrite that "keeps the shape" of fixture data is still a behaviour change, and only the end-to-end audits were pointing at it.

---

## 7. Section 10 acceptance criteria — Phase 6 position

| Criterion                                                                          | Status                    | Evidence                                                       |
| ---------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------- |
| Seeding idempotent on both providers (twice, no duplicates, no changes)            | **VERIFIED**              | §4, fingerprint equality per provider                          |
| One-way migration, dry-run mode                                                    | **VERIFIED**              | §5.1, `dry-runs without writing a single row`                  |
| Migration idempotency                                                              | **VERIFIED**              | §5.5, second apply `0/0/N`, `updated_at` unchanged             |
| Orphan detection fails or quarantines explicitly before any insert                 | **VERIFIED**              | §5.2, messy fixture suite                                      |
| `_id` preserved as CHAR(24) ascii_bin                                              | **VERIFIED**              | §5.3, information_schema assertion                             |
| Post-migration verification: counts, samples, FKs, uniques, decimals, dates, nulls | **VERIFIED**              | §5.4, 7 named checks                                           |
| Messy fixture (orphans, nulls, duplicates, decimals, boundary dates)               | **VERIFIED**              | §5.6                                                           |
| Rollback documented + explicit confirmation before destructive steps               | **VERIFIED**              | `PHASE-6-MIGRATION-RUNBOOK.md`, §5.7, guard tests              |
| `excludeId` rejected identically on both providers                                 | **VERIFIED**              | §2, shared contract test                                       |
| Text search: documented behaviour pinned by test                                   | **VERIFIED** (option (a)) | §3                                                             |
| No API/ID/cursor change                                                            | **VERIFIED**              | 84/84 snapshots both providers, legacy cursor probe            |
| No new dependencies                                                                | **VERIFIED**              | none added (no `package.json` dependency change in this phase) |
| Both providers fully functional; switch by config only                             | **VERIFIED**              | `DATABASE_PROVIDER` only; MySQL suite 77/77                    |
| Final implementation report                                                        | **pending** — Phase 7     |

---

## 8. Files changed this phase

| File                                                                                        | Change                                                                              |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `server/src/repositories/identifier.js`                                                     | **new** — `assertCanonicalId` / `isCanonicalId`                                     |
| `server/src/repositories/{mongo,mysql}/products.repository.js`                              | validate `excludeId` at four entry points                                           |
| `server/src/repositories/{mongo,mysql}/{brands,categories}.repository.js`                   | validate `excludeId`; **new** `findByNameNormalized`                                |
| `server/src/repositories/index.js`                                                          | **new** `getActiveProvider()`                                                       |
| `server/src/config/seed.js`                                                                 | rewritten provider-neutral (repositories, not Mongoose); idempotency by natural key |
| `server/src/db/migrate/mongo-to-mysql/{mapping,extract,validate,apply,verify,index,cli}.js` | **new** — the migration                                                             |
| `server/tests/contracts/repository-contract.js`                                             | **new** `excludeId` rejection test (both providers)                                 |
| `server/tests/contracts/seed-contract.js`                                                   | **new** — seed idempotency suite                                                    |
| `server/tests/integration/seed.{mongo,mysql}.test.js`                                       | **new** adapters                                                                    |
| `server/tests/integration/migration.test.js`                                                | **new** — 15 tests                                                                  |
| `server/tests/fixtures/messy-catalogue.js`                                                  | **new** — the dirty fixture                                                         |
| `server/tests/integration/repositories.mysql.test.js`                                       | one expectation updated (`excludeId: 'x'` → real id)                                |
| `server/package.json`, `package.json`                                                       | `test:migration`, `seed:mysql`, `migrate:data[:*]` scripts; `test:mysql` extended   |
| `PHASE-6-MIGRATION-RUNBOOK.md`                                                              | **new** — operator procedure incl. rollback                                         |

No frontend file was touched; no dependency was added; no API response changed.

---

## 9. Reproducing this phase

```bash
export PATH=/home/user/.cache/runtime/node22/bin:$PATH
# MySQL credentials are never committed — they arrive through MYSQL_TEST_*
export MYSQL_TEST_HOST=127.0.0.1 MYSQL_TEST_PORT=3399 \
       MYSQL_TEST_USER=storefront_migrator MYSQL_TEST_PASSWORD=... \
       MYSQL_TEST_DATABASE=storefront_it_test

npm run test:mysql          # 77/77  (foundation, repositories, contracts, capabilities, concurrency, seed)
npm run test:migration      # 15/15  (messy fixture, dry run, confirmations, idempotency, rollback)

# Operator flow against real databases
npm run db:migrate --workspace server          # schema only
npm run migrate:data                           # dry run — writes nothing
npm run migrate:data:apply -- --confirm=storefront --manifest=/var/backups/migration.json
npm run migrate:data:verify
npm run migrate:data:rollback -- --confirm=storefront --manifest=/var/backups/migration.json
```

---

## 10. Known limitations carried forward

1. **Text search in `text` mode is not stemming-equivalent** — documented, pinned by test (§3). Chosen option (a).
2. **Quarantine is explicit row loss.** Rows that cannot be represented are skipped _and recorded_; the quarantine file must be kept with the manifest. The tool refuses any quarantine that would create an orphan.
3. **Verification samples** (25 rows per table by default) rather than comparing every row; `sampleSize` is a parameter and `record-counts`/`unique-constraints`/`decimal-precision` cover the whole table.
4. **The migration never deletes.** Extra rows in the target are reported as `orphaned` and require `--allow-non-empty` to proceed.
5. **Rollback is manifest-bound.** Without the manifest of the run that inserted the rows, rollback cannot be reconstructed — restoring a backup is then the only option (documented in the runbook).
6. **Sandbox provisioning** — MySQL 8.0.44, Playwright browsers and Node 22 were installed inside this sandbox; a fresh session must re-run `bash /opt/dev-tools/provision-local-mysql8.sh` and `npm ci`, and every command above must be re-run in the user's environment or CI (recommended ≥ 4 GB RAM, `MYSQL_REQUIRE=1`, single-node replica set for Mongo).

---

## 11. Next phase (7)

Ops/hardening and the final implementation report: health/readiness semantics under both providers, connection-pool and graceful-shutdown review, backup/restore guidance, CI wiring for both providers, a final security pass, and the Section 10 implementation report with the per-criterion **VERIFIED / NOT VERIFIED** table.
