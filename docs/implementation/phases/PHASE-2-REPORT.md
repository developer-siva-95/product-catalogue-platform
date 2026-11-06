# Phase 2 — MongoDB Repository Extraction

**Status:** complete. All gates green; the public API contract is byte-identical to the P2 baseline.
**Date:** 2026-11-06 · **Provider under test:** MongoDB (replica-set-capable mongod via `mongodb-memory-server`)

---

## 1. What this phase changed

Phase 2 moved _every_ database decision out of the services and middlewares into a repository
layer, without changing a single byte of the HTTP surface. MongoDB is now just one
implementation of four plain-JS interfaces; Phase 3–4 plug MySQL into the same interfaces.

```
modules/*/controller.js   →  modules/*/service.js  →  repositories/index.js (registry)
                                                          └── repositories/mongo/*.repository.js  →  Mongoose
                                                          └── repositories/mysql/*.repository.js  →  P3–P4
```

### Added

| File                                              | Purpose                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/repositories/repository.js`                  | `defineRepository(name, methods, impl)` contract validator — a provider that misses a method fails at import, not at request time.                                                                     |
| `src/repositories/index.js`                       | Provider registry: `registerRepositories`, `configureRepositories`, `getRepositories`, `availableProviders`, `defineRepositorySet`. Unknown provider throws (no silent Mongo fallback).                |
| `src/repositories/products.repository.js`         | Products contract (14 methods) + doc.                                                                                                                                                                  |
| `src/repositories/brands.repository.js`           | Brands contract (9 methods).                                                                                                                                                                           |
| `src/repositories/categories.repository.js`       | Categories contract (9 methods).                                                                                                                                                                       |
| `src/repositories/users.repository.js`            | Users contract (12 methods).                                                                                                                                                                           |
| `src/repositories/product.mapper.js`              | Shared `toAdminProduct` / `toPublicProduct` — key-order-locked wire projection.                                                                                                                        |
| `src/repositories/users.mapper.js`                | Shared `toSafeUser`.                                                                                                                                                                                   |
| `src/repositories/error-mapping.js`               | `mapDatabaseError` — provider-neutral error translation.                                                                                                                                               |
| `src/repositories/mongo/objectid.js`              | `toObjectId`, `toIdString`, `isValidId` (driver details stay here).                                                                                                                                    |
| `src/repositories/mongo/errors.js`                | `RepositoryError` + codes (`STALE_RESOURCE`, `DUPLICATE_KEY`, …).                                                                                                                                      |
| `src/repositories/mongo/error-mapping.js`         | `mapMongoError` — Mongo/Mongoose → neutral codes.                                                                                                                                                      |
| `src/repositories/mongo/products.repository.js`   | 472 lines: query builders, cursor filter hash, OCC updates, image-orphan queries.                                                                                                                      |
| `src/repositories/mongo/brands.repository.js`     | 160 lines incl. `countProducts`.                                                                                                                                                                       |
| `src/repositories/mongo/categories.repository.js` | 164 lines.                                                                                                                                                                                             |
| `src/repositories/mongo/users.repository.js`      | 128 lines: lockout, login recording, password rotation + `tokenVersion`.                                                                                                                               |
| `tests/unit/registry.test.js`                     | **9 new tests** — registry completeness, contract satisfaction, unknown-provider throw, frozen set false-positive guard.                                                                               |
| `tests/integration/repositories.mongo.test.js`    | **14 new tests** — repository conformance against a real mongod: id canonicalisation, `null` vs `undefined`, limit+1 pagination, atomic stock guard, OCC staleness, taxonomy counts, lockout/rotation. |

### Rewritten (storage-agnostic)

- `src/modules/products/service.js` (293 lines), `src/modules/brands/service.js`, `src/modules/categories/service.js`, `src/modules/auth/service.js` — no driver, no model, no Mongoose type imports left.
- `src/middlewares/auth.js` — resolves users via `getRepositories().users.findById`.
- `src/middlewares/errorHandler.js` — delegates to `mapDatabaseError`; no `mongoose` import (this is what makes the ESLint boundary rule satisfiable).
- `src/modules/*/controller.js` — return repository records directly (records _are_ the wire shape; `.toJSON()` removed).
- `eslint.config.js` — `no-restricted-imports` now also covers `server/src/middlewares/**/*.js` and the `**/model.js` pattern, so the boundary is enforced, not merely intended.

**Frontend, `useVirtualGrid`, RTK Query, routes and response shapes: untouched.**

---

## 2. Gate results (P2 close)

| Gate                                                  | Command                                               | Result                                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Full verify (lint + format + server + client + build) | `npm run verify`                                      | **exit 0** — ESLint **0 errors** / 5 pre-existing warnings, Prettier clean, server **448/448 (27 files)**, client **284/284**, build ✓ 452 ms |
| Server tests                                          | `npx vitest run` (in `server/`)                       | **448 passed / 448** (425 baseline + 23 new) — count went **up**                                                                              |
| Client tests                                          | `npx vitest run` (in `client/`)                       | **284 / 284** — unchanged                                                                                                                     |
| E2E                                                   | `npx playwright test`                                 | **34 / 34 passed** (1.4 min)                                                                                                                  |
| DOM budget                                            | `audit/dom-budget-audit.mjs`                          | **PASS (11 checks)** — 372 loaded, mounted ≤14/≤24/≤28 at 390/768/1280, 0 px overflow                                                         |
| Responsive                                            | `audit/responsive-audit.mjs`                          | 4/4 viewports — 2/3/4/4 columns, 0 px overflow, min tap 40 px                                                                                 |
| API audit                                             | `audit/api-audit.mjs`                                 | **56 / 56**                                                                                                                                   |
| Runtime audit                                         | `audit/runtime-audit.mjs`                             | **9 / 9**                                                                                                                                     |
| Browser audit                                         | `audit/browser-audit.mjs`                             | **15 / 15**                                                                                                                                   |
| Lifecycle probe                                       | `audit/lifecycle-probe.mjs`                           | exit 0 — back → 20 cards @ scrollY 777, 0 refetches, 0 console errors                                                                         |
| **API contract snapshot**                             | `api-contract-snapshot.mjs` + `api-contract-diff.mjs` | **84 / 84 byte-identical** — "CONTRACT STABLE: every entry is byte-identical (status, key order, types, values)"                              |

Baseline for the snapshot was captured **before** the refactor (`/opt/snapshots/mongo-before-p2.json`,
84 entries) and covers every endpoint and error path the moved services touch — well beyond the
30-entry P1 set, per the P2 rules. Set grew from 30 → 84 entries; nothing was renamed, skipped or removed.

Per-test baseline preserved: **425 → 448 server tests (all 425 still present)**, client 284, E2E 34.
No existing test was renamed, skipped or deleted.

### Environmental note (browser-timing flake, resolved)

The first full E2E run failed 2 tests, the second failed 1 _different_ test, and every failing test
passed in isolation. Root cause was **memory pressure, not code**: the sandbox has 2 GB RAM / 2 cores,
and a resident `mysqld` (128 MB buffer pool) plus mongod plus Chromium plus the preview server pushed
the scroll-restoration polling (`expect.poll(…, { timeout: 5000 })`) past its budget.
With `mysqld` stopped, the same suite is **34/34** and reproducible.

→ **Standing practice:** browser-based gates (E2E + DOM/responsive/runtime/browser audits) run with the
provider processes limited to the provider under test. From P3 onward MySQL is started only for
MySQL-provider runs. This is a sandbox-resource constraint, not a behavioural change.

---

## 3. Contract invariants established in this phase

These are what Phase 4's MySQL implementation must reproduce, and what Phase 5's shared suite asserts.

- **Ids** are canonical 24-char lowercase hex strings everywhere above the repository; no `ObjectId`,
  no `_id` leaking into JSON, no `null`/`undefined` ambiguity (`null` for "not found", never `undefined`).
- **Records** returned by repositories are plain objects in final wire key order — controllers do not
  re-map them. Brand list row: `{id,name,slug,description,logo,productCount,activeProductCount,createdAt,updatedAt}`;
  brand detail appends `productCount/activeProductCount` after `id`; category emits `image` only when present;
  product delete returns `{id,title}`.
- **Cursor format** unchanged (`v:1,s,i,f[,p]`); the filter hash is computed inside the Mongo query builder
  from `{activeOnly,search,minPrice,maxPrice,brand,category,sort}` and pre-P1 fixtures still decode.
- **Error codes** unchanged: `STALE_RESOURCE` → 409, `DUPLICATE_KEY` → 409, `MONGOOSE_VALIDATION_ERROR` → 422,
  `INVALID_IDENTIFIER` → 400, all via `mapDatabaseError`.
- **Auth**: JWT `iss=catalogue-api`/`aud=catalogue-web`, claims `{sub,role,ver}`; `TOKEN_EXPIRED` vs
  `SESSION_INVALID` vs `SESSION_REVOKED`; login/register return `{user, csrfToken, expiresInMs}`;
  unknown-email logins run against a real bcrypt dummy hash so timing stays flat.
- **Storefront pagination** fetches `limit + 1` rows and derives `hasNextPage` — no count query, so the
  MySQL implementation can use the same `LIMIT ?` strategy and stay index-friendly.

---

## 4. Known limitations carried into P3

1. `DATABASE_PROVIDER` is not yet wired: the registry exists but only `mongodb` is registered, and
   `config/db.js` still connects Mongoose directly at boot.
2. `config/seed.js` still imports Mongoose models (it is a script, not request-path code; it becomes
   provider-aware in P6).
3. `mongodb-memory-server` currently starts a **standalone** mongod. The final verification requires a
   **replica set** (transactions), and the health probe will require multi-document transactions, so P3
   switches the helper to `MongoMemoryReplSet` and adds a startup capability probe.
4. `mysql2` is deliberately **not** a dependency yet (P3 adds it). Provider-neutral error mapping for
   MySQL (1062 → duplicate, 1213 deadlock → retry, 1451/1452 → in-use) lands with the first MySQL repo.

---

## 5. Next: Phase 3 — MySQL foundation

Planned scope (no application behaviour change yet):

1. `mysql2` dependency; `MYSQL_*` env validation in `config/env.js` (conditionally required only when
   `DATABASE_PROVIDER=mysql`).
2. `db/schema.sql` DDL for `brands`, `categories`, `products`, `users`, `schema_migrations` — `CHAR(24)`
   primary keys holding the same hex ids, `DECIMAL(10,2)` prices, `DATETIME(3)` timestamps,
   `utf8mb4_0900_as_ci` collation for search, `utf8mb4_bin` ordering, generated `slug`/`sku` uniques,
   and a guarded `UPDATE … WHERE stock >= ?` shape for inventory.
3. Versioned migration runner (`up`, idempotent `schema_migrations` bookkeeping) + `npm run db:*:mysql` scripts.
4. Pool with `timezone:'Z'`, `DECIMAL`-as-string handling, and a transaction helper.
5. Provider bootstrap: `DATABASE_PROVIDER` selects the connection module; `/health` reports the provider
   and its latency; startup transaction-capability probe (replica set for Mongo, InnoDB for MySQL) that
   fails loudly instead of silently degrading.
