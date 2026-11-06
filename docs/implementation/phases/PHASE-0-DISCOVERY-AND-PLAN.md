# Phase 0 — Discovery, baseline and implementation plan

**Status: Phase 0 complete, decisions D1–D4 approved (§6). No project file has been modified in this phase.**
The only changes made were to the _environment_ (the sandbox lost `node_modules`,
the Node 22 runtime and the Playwright browsers between sessions), because a real
baseline cannot be recorded without them.

Reference implementation for every parity decision below: **the existing MongoDB
behaviour**. MySQL must match it, not the reverse.

---

## 1. Architecture as it exists today

### 1.1 Layout

```
server/src
  app.js, server.js                     Express 5 app + bootstrap/shutdown
  config/{env,db,seed,swagger}.js       Zod-validated env, Mongoose connection, seed, OpenAPI
  modules/{auth,brands,categories,products}/{model,service,controller,routes,validation}.js
  middlewares/{auth,csrf,errorHandler,multer,notFound,rateLimiter,requestId,sanitize,validate}.js
  utils/{ApiError,apiResponse,cursor,fileValidator,imageProcessor,logger,skuGenerator,slugify,validators}.js
  constants/{appConstants,httpStatusCodes}.js
server/tests          269 tests / 20 files (unit + integration, real mongod via mongodb-memory-server)
server/scripts        e2e-server.mjs (memory server + seed), dev-mongo.mjs, reset-admin.mjs
client/src            React 19 + RTK Query storefront/admin (284 tests / 24 files)
e2e                   34 Playwright specs
audit                 responsive, browser, api, runtime, lifecycle, dom-budget harnesses
```

There is **no repository layer today**: controllers call services, services call
Mongoose models directly.

### 1.2 Where MongoDB is coupled (complete inventory)

| File                                                 | Coupling                                                                                                                                                                                                                                                | Needs to move behind a repository                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `config/db.js`                                       | `mongoose.connect`, pool, `readyState` health                                                                                                                                                                                                           | provider factory + health probe                                            |
| `modules/products/model.js`                          | schema, 9 indexes incl. text index, virtuals `inStock`/`stockStatus`, `toJSON` id transform, `optimisticConcurrency` (`__v`), `LOW_STOCK_THRESHOLD`                                                                                                     | schema stays Mongo-only; virtuals/threshold become shared pure helpers     |
| `modules/brands/model.js`, `categories/model.js`     | schema + unique `nameNormalized`/`slug`                                                                                                                                                                                                                 | Mongo-only; uniqueness re-declared in SQL                                  |
| `modules/auth/model.js`                              | user schema, `email` unique index, `tokenVersion`, lock fields                                                                                                                                                                                          | Mongo-only                                                                 |
| `modules/products/service.js`                        | `$or` + `$regex` search, `$gte/$lte` price, ObjectId casts, `$lt/$gt` cursor comparisons, `find().sort().limit().lean().populate()`, `countDocuments`, `findOneAndUpdate` with `$inc` + `$gte` guard, `$set`, `bulkWrite`-free, `VersionError` handling | **all of it** — this is the largest piece of provider-specific query logic |
| `modules/brands/service.js`, `categories/service.js` | `Product.aggregate([{ $group … }])` facet counts                                                                                                                                                                                                        | aggregate → `LEFT JOIN … GROUP BY`                                         |
| `modules/auth/service.js`                            | `User.findOne`, `.save()`, `tokenVersion` bump, login-attempt/lock updates                                                                                                                                                                              | repository CRUD + atomic updates                                           |
| `utils/cursor.js`                                    | HMAC cursor (provider-agnostic **except** `isValidObjectId`)                                                                                                                                                                                            | reuse as-is; swap the id validator to a Mongo-free 24-hex check            |
| `utils/validators.js`                                | `mongoose.isValidObjectId` + `ObjectId` regex                                                                                                                                                                                                           | becomes the canonical ID validator (no driver import)                      |
| `middlewares/errorHandler.js`                        | maps Mongoose `ValidationError`/`VersionError`, Mongo `11000`                                                                                                                                                                                           | add MySQL error mapping to the _same_ codes                                |
| `config/seed.js`                                     | `User.create`, `Product.create`, `deleteMany`                                                                                                                                                                                                           | split into per-provider seed                                               |
| `utils/skuGenerator.js`, `slugify.js`                | uniqueness retry against Mongo unique indexes                                                                                                                                                                                                           | stays; must work through the repository                                    |

**No MongoDB leakage into the frontend**: the client only ever sees JSON
(`id` strings, ISO dates, numbers) — verified by reading `client/src/**` (no
ObjectId parsing; IDs are opaque path segments).

### 1.3 API contracts (baseline, must not change)

Envelope: `{ success: true, message, data, meta?, requestId }`;
errors: `{ success: false, message, error: { statusCode, message, code, details } }`.

| Method & path                                           | Auth             | Shape highlights                                                                                                                                                |
| ------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/health`                                    | –                | `data.status` (`ok`/`degraded`), `data.database`, uptime                                                                                                        |
| `GET /api/v1/auth/csrf`                                 | –                | CSRF token (readable cookie + body)                                                                                                                             |
| `POST /api/v1/auth/login`                               | – (rate-limited) | sets httpOnly JWT cookie; `mustChangePassword` flag                                                                                                             |
| `POST /api/v1/auth/change-password`                     | JWT              | rotates password, bumps `tokenVersion`                                                                                                                          |
| `POST /api/v1/auth/logout`                              | –                | clears cookies                                                                                                                                                  |
| `GET /api/v1/auth/me`                                   | JWT              | current user                                                                                                                                                    |
| `GET /api/v1/products`                                  | –                | **cursor pagination**: `meta { limit, count, sort, hasNextPage, nextCursor }`                                                                                   |
| `GET /api/v1/products/:id`                              | –                | public product (`id,title,slug,sku,price,stock,inStock,stockStatus,description,image,thumbnail,brand{id,name,slug},category{...},isActive,createdAt,updatedAt`) |
| `GET /api/v1/brands`, `/categories`                     | –                | each row carries `productCount`, `activeProductCount`                                                                                                           |
| `GET /api/v1/admin/products`                            | admin            | **offset pagination**: `meta { page, limit, total, totalPages }`, rows add `version` (`__v`)                                                                    |
| `POST/PUT/PATCH/DELETE /api/v1/admin/products[/:id]`    | admin            | `PATCH /:id/stock` = `{ delta }` (atomic) or `{ stock }` (absolute)                                                                                             |
| `POST /api/v1/admin/products/maintenance/sweep-orphans` | admin            | deletes products whose brand/category vanished (Mongo has no FKs)                                                                                               |
| CRUD `/api/v1/{brands,categories}`                      | admin            | unique name (case-insensitive) + slug                                                                                                                           |

**IDs**: 24-char lowercase hex (`OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/`), validated
at the route boundary by Zod (`objectIdParam`); malformed ⇒ `400` with
`code: 'VALIDATION_ERROR'`-style payload from the validate middleware.

**Cursors**: `base64url(JSON{v:1,s:sort,i:id,f:filterHash}) + '.' + HMAC-SHA256`,
signed with a key derived from `JWT_SECRET` (domain separated). Rejections: 400
`CURSOR_INVALID` / `CURSOR_SORT_MISMATCH` / `CURSOR_FILTER_MISMATCH`.

**Sorts**: `newest` = `_id DESC`; `price_asc` = `price ASC,_id ASC`;
`price_desc` = `price DESC,_id DESC` (id is the tie-breaker everywhere).

**Search**: storefront = case-insensitive substring `RegExp` over `title` + `sku`;
admin supports `searchMode=text` → Mongo `$text` (weighted title 10 / description 2).

**Money**: MongoDB `Number` rounded to 2 dp (`Math.round(v*100)/100`), returned as a
JSON number. **Stock**: integer ≥ 0; badge thresholds `5` (`LOW_STOCK_THRESHOLD`,
mirrored in `client/src/utils/constants.js`).

**Concurrency (already implemented and tested)**: stock via `$inc` + `stock: {$gte: -delta}`
guard; edits via `optimisticConcurrency` (`__v`) ⇒ `VersionError` ⇒ `409
STALE_RESOURCE`; unique `slug`/`sku`/`email`/`nameNormalized` ⇒ `409 DUPLICATE_KEY`;
7 concurrency tests in `products.concurrency.test.js`.

**Auth persistence**: users only. There is **no** session/refresh-token collection —
sessions are stateless JWTs in an httpOnly cookie, invalidated by `tokenVersion`.

---

## 2. Baseline results (regression reference)

Environment rebuilt first (Node 22.23.4, `npm ci`, Playwright chromium,
mongodb-memory-server 7.0.14). Recorded 2026-11-06 06:34–06:41 UTC on this exact tree (commit-identical).

| Gate                                                                   | Result                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify` (lint → format → client tests → server tests → build) | **PASS** — ESLint 0 errors / 5 pre-existing warnings, Prettier clean                                                                                                                |
| Server tests                                                           | **269 passed / 20 files**                                                                                                                                                           |
| Client tests                                                           | **284 passed / 24 files**                                                                                                                                                           |
| Production build                                                       | ✓ 320 ms; `index-*.css` 26.35 kB, `index-*.js` 85.69 kB, redux 86.24 kB, vendor 307.12 kB                                                                                           |
| `npm run test:e2e`                                                     | **34 passed, 0 failed**                                                                                                                                                             |
| `audit/dom-budget-audit.mjs`                                           | **PASS (11 checks)** — 372 products loaded: mounted ≤ 14 / 24 / 28 cards, document nodes ≤ 236 / 366 / 466 (390 / 768 / 1280 px), 0 px overflow; 20-product control not virtualized |
| `audit/responsive-audit.mjs`                                           | 4/4 viewports at expected column counts (2/3/4/4), 0 px overflow, min tap target 40–42 px, a11y clean                                                                               |
| `audit/api-audit.mjs`                                                  | **56 passed, 0 failed**                                                                                                                                                             |
| `audit/runtime-audit.mjs`                                              | **9 passed, 0 failed**                                                                                                                                                              |
| `audit/browser-audit.mjs`                                              | **15 passed, 0 failed**                                                                                                                                                             |
| `audit/lifecycle-probe.mjs 135000`                                     | 20 cards / scrollY 777 / **0 requests** after Back, and the same after the 135 s cache window; 0 console errors                                                                     |

Any Phase 4+ change must leave these numbers at least as green.

### 2.1 Environment constraints discovered

- **No Docker** in this sandbox, and **no `mysql-server` apt candidate** on
  Debian 13. Per decision **D1(b)** (MySQL 8 only — MariaDB refused), a **real
  Oracle MySQL 8.0.44** instance has been provisioned from the official
  `linux-glibc2.17-x86_64-minimal` tarball, listening on `127.0.0.1:3399`
  (`bin/mysqld  Ver 8.0.44 for Linux on x86_64 (MySQL Community Server - GPL)`).
  Databases `storefront` / `storefront_test` (`utf8mb4_0900_ai_ci`, InnoDB) and two
  least-privilege users exist: `storefront_app` (**DML only** — `DROP TABLE`
  correctly returns `ER_TABLEACCESS_DENIED_ERROR`) and `storefront_migrator` (DDL).
- The sandbox keeps **no state outside `/home/user`**, so the server must be
  re-provisioned in a new session with `bash tools/provision-local-mysql8.sh`
  (dev-only helper; compose/CI remain the reproducibility authority).
- MongoDB is exercised through `mongodb-memory-server` (a real `mongod`, not a
  mock), currently a **single node without a replica set** ⇒ **transactions are not
  available today** (addressed by D2(a)).
- Node 22 is required by `engines` (`>=22.22.0`); the base image ships Node 20.

### 2.2 Measured provider behaviour (MySQL 8.0.44, real instance, this sandbox)

Evidence for the parity decisions in §3.2 — not assumptions:

| Probe                                                        | Measured result                                                                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SELECT VERSION(), @@collation_server`                       | `8.0.44`, `utf8mb4_0900_ai_ci`, InnoDB                                                                                                                             |
| `title LIKE '%SNEAKER%'`                                     | matches `Canvas Sneaker` under every collation except `_bin`                                                                                                       |
| `LIKE '%leather%'` vs stored `LÉATHER Boot`                  | `utf8mb4_0900_as_ci` → **0** (accent-sensitive, case-insensitive = Mongo `/i` semantics); `utf8mb4_general_ci` / `0900_ai_ci` → 1 (over-matches vs Mongo)          |
| `ORDER BY title`                                             | `_bin` → `Canvas Sneaker, LÉATHER Boot, canvas sneaker Pro` (Mongo-like binary order); `0900_ai_ci` → `Canvas Sneaker, canvas sneaker Pro, LÉATHER Boot` (differs) |
| `MATCH(title) AGAINST ('sneaker')`                           | 2 rows — usable for `searchMode=text`, semantics differ from `$text` (D3(a))                                                                                       |
| `DECIMAL(12,2)` read through `mysql2`                        | returned as **string** `'19.99'` (`typeof 'string'`); `CAST(price AS DOUBLE)` → `19.99` ⇒ the repository **must** convert, else the JSON payload changes type      |
| `INSERT 1.005` into `DECIMAL(12,2)`                          | stored as `1.01` (round-half-up)                                                                                                                                   |
| `DATETIME(3)` read through `mysql2`                          | JS `Date` `2026-01-01T12:34:56.789Z` in a UTC container ⇒ pool must pin `timezone: 'Z'` so behaviour is TZ-independent                                             |
| `UPDATE … SET stock = stock + ? WHERE id = ? AND stock >= ?` | over-draw → `affectedRows 0`, valid decrement → `1` (exact analogue of the Mongo `$inc` + `$gte` guard)                                                            |
| `UPDATE … WHERE version = ?`                                 | stale version → `affectedRows 0` ⇒ same `409 STALE_RESOURCE` path                                                                                                  |
| duplicate PK insert                                          | `ER_DUP_ENTRY` / `1062`, `sqlMessage` carries `for key 't.PRIMARY'` ⇒ constraint name maps to `details.field`                                                      |

## 3. Target architecture

```
                       ┌──────────────────────────────┐
  controllers ────────▶│  services (provider-agnostic)│  ← no driver imports
                       └──────────────┬───────────────┘
                                      │ repository interfaces (JSDoc contracts)
                    ┌─────────────────┴─────────────────┐
        ┌───────────▼──────────┐            ┌───────────▼──────────┐
        │ mongo/*.repository.js│            │ mysql/*.repository.js│
        │  (Mongoose)          │            │  (mysql2/promise)    │
        └───────────┬──────────┘            └───────────┬──────────┘
                    │                                   │
                MongoDB                            MySQL (InnoDB)
```

- `server/src/db/index.js` — `DATABASE_PROVIDER` factory; validates env, opens
  **only** the selected provider, logs `provider=<x> status=connected`, exposes
  `health()`, `transaction(fn)`, `close()`.
- `server/src/repositories/<domain>.repository.js` — the **contract** (JSDoc types +
  the shared invariants). `mongo/` and `mysql/` are the two implementations.
- Normalisation happens **inside** repositories: no `_id`, no `ObjectId`, no
  `row.affectedRows`, no SQL `Date` object may cross the boundary. Everything above
  is plain JSON-able data identical to today's `toPublicProduct`/`toAdminProduct`.
- Canonical ID: **24-char lowercase hex**, generated in the application
  (`server/src/utils/id.js`) in **ObjectId layout** (4-byte seconds + 5 random +
  3-byte counter) so `id` keeps its time-ordering meaning for `newest` on both
  providers. MySQL stores it as `CHAR(24) CHARACTER SET ascii COLLATE ascii_bin`.

### 3.1 Schema sketch (MySQL)

Tables: `users`, `brands`, `categories`, `products`, `schema_migrations`.
`products(id CHAR(24) PK, title VARCHAR(160), slug VARCHAR(180) UNIQUE, sku
VARCHAR(64) NULL UNIQUE, price DECIMAL(12,2), stock INT UNSIGNED, description
TEXT, image/thumbnail VARCHAR(512), brand_id/category_id CHAR(24) FK, is_active
TINYINT(1), version INT, created_at/updated_at DATETIME(3) UTC)` plus indexes
mirroring the Mongo ones (`(is_active, id)`, `(is_active, price, id)`,
`(is_active, brand_id)`, `(is_active, category_id)`, `(brand_id, category_id, price)`)
and a FULLTEXT index for the text-search mode.

### 3.2 Parity decisions (each one tested)

| Concern                         | Decision                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor                          | Reuse the existing signed cursor **unchanged** (identical bytes on both providers); only its ObjectId import is replaced with the canonical 24-hex validator               |
| `newest` order                  | `ORDER BY id DESC` on MySQL (canonical ids carry the ObjectId timestamp) ⇒ byte-identical page order                                                                       |
| `price_*` order                 | `ORDER BY price ASC, id ASC` / `price DESC, id DESC`, same tie-breaker                                                                                                     |
| Search (default)                | Mongo `RegExp(/term/i)` on title+sku ⇔ MySQL `LIKE` with explicit `COLLATE utf8mb4_general_ci` and `%`/`_`/`\` escaping; equivalence table in the contract test            |
| Search (`text`)                 | Mongo `$text` vs MySQL `MATCH … AGAINST` — **semantics cannot be identical** (stemming/stop-words/relevance) → decision **D3**                                             |
| Sorting strings (admin `title`) | compare with `COLLATE utf8mb4_bin` on MySQL to match Mongo's binary ordering, avoiding accent/case folding                                                                 |
| Money                           | `DECIMAL(12,2)` in MySQL ⇔ `Number` rounded to 2 dp in Mongo; repository converts to `Number` before returning so JSON is identical; contract test asserts `19.99` on both |
| Dates                           | `DATETIME(3)` stored UTC, returned as ISO-8601 `…Z`; millisecond precision preserved                                                                                       |
| Booleans                        | `TINYINT(1)` ⇔ JS `true/false` (converted in the repo)                                                                                                                     |
| Nulls                           | `sku`/`lockedUntil` etc. returned as `null` (never `undefined`) on both providers                                                                                          |
| Duplicate key                   | Mongo `11000` ⇔ MySQL `ER_DUP_ENTRY`/`1062` → same `409 DUPLICATE_KEY` + `details.field` (mapped from index/constraint name)                                               |
| Validation                      | Zod at the boundary; repository-level constraint violations mapped to the same 422 payload                                                                                 |
| Stale write                     | `VersionError` ⇔ `affectedRows === 0` → `409 STALE_RESOURCE`                                                                                                               |
| Not found                       | `null` from the repo → `404 NOT_FOUND` in the service, single code path                                                                                                    |

---

## 4. Implementation plan (phases, each independently reviewable)

| Phase                              | Deliverable                                                                                                                                                                                            | Files (new/modified)                                                                                                                               | Tests                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **P1 — Contracts & ID**            | Repository interfaces, canonical id generator/validator, shared normalisers (`toPublicProduct`, `stockStatus`, `LOW_STOCK_THRESHOLD`), cursor decoupled from Mongoose                                  | `db/*`, `repositories/*.repository.js`, `utils/id.js`, `utils/validators.js`, `utils/cursor.js`, `modules/products/service.js` (mapping extracted) | id/cursor/normaliser units; **no behaviour change** (full suite must stay 269/284/34) |
| **P2 — Mongo repository**          | Move all Mongoose queries/services into `repositories/mongo/*`; services become provider-agnostic. Pure refactor — Mongo behaviour byte-identical                                                      | mongo repositories, service/controller slim-down                                                                                                   | existing 269 tests must pass unchanged (they are the parity oracle)                   |
| **P3 — MySQL foundation**          | `mysql2` pool, env validation, provider factory, health probe, migrations runner (up/down, `schema_migrations`), DDL, seed, graceful shutdown                                                          | `db/mysql.js`, `db/migrations/*`, `db/seed-mysql.js`, `config/env.js`, `routes/index.js` health                                                    | connection/startup/config-failure tests; migration up→down→up                         |
| **P4 — MySQL repositories**        | products/brands/categories/users CRUD, filtering, sorting, cursor + offset pagination, facet counts, OCC, atomic stock, duplicate/validation mapping                                                   | `repositories/mysql/*`                                                                                                                             | **shared contract suite** run against real MariaDB/MySQL                              |
| **P5 — Dual-provider test matrix** | Parameterised contract suite (`PROVIDER` env), per-provider setup/teardown, concurrency (parallel decrements), auth/integration suites, Playwright matrix, config-failure tests, state-separation test | `server/tests/contract/*`, `server/tests/helpers/{mysql,mongo}.js`, `e2e` harness per provider, CI workflow                                        | the full matrix table in §6                                                           |
| **P6 — Seeding & migration**       | Idempotent MySQL seed, one-way `migrate:mongo-to-mysql` with dry-run, confirmation, orphan scan, post-checks (counts, samples, FKs, uniques, decimals, dates, nulls), rollback doc                     | `server/scripts/migrate-mongo-to-mysql.mjs`, `docs/MIGRATION.md`                                                                                   | migration tests: dry-run, idempotency, orphans, mismatch reporting                    |
| **P7 — Ops & hardening**           | Structured query telemetry (duration/signature/provider, no params), least-privilege `docker-compose` users, `/api/health` per provider, dependency audit, README/env templates                        | `docker-compose.yml`, `.env.example` per provider, `utils/queryMetrics.js`, docs                                                                   | health tests, log-content assertions, `npm audit`                                     |

**npm scripts** (root): `dev:mysql`, `dev:mongodb`, `start:mysql`, `start:mongodb`,
`db:setup:{mysql,mongodb}`, `db:migrate:mysql`, `db:seed:{mysql,mongodb}`,
`test:{mysql,mongodb}`, `test:e2e:{mysql,mongodb}`, `migrate:mongo-to-mysql`.

**Env** (`.env.example.{mysql,mongodb}`): `DATABASE_PROVIDER`, plus
`MYSQL_HOST/PORT/USER/PASSWORD/DATABASE/POOL_MIN/POOL_MAX/CONNECT_TIMEOUT_MS`,
`MYSQL_MIGRATION_USER/PASSWORD`, `MONGO_URI`; provider-specific vars are validated
only for the selected provider.

**Justified dependency additions**: `mysql2` (runtime). Dev-only: none required —
tests use the same driver; `dotenv`/`zod` already present. **No frontend change and
no frontend dependency change.**

### 4.1 Explicitly out of scope

Bidirectional migration; JSON/Swagger contract changes; frontend refactors;
rewriting `useVirtualGrid`; multi-tenant or dual-write runtime; changing the auth
model (see D4).

---

## 5. Risks

| #   | Risk                                                             | Impact                                | Mitigation                                                                                         |
| --- | ---------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| R1  | `$text` vs `MATCH…AGAINST` cannot be made identical              | admin text search differs by provider | D3 decision + documented, tested divergence                                                        |
| R2  | MariaDB locally vs MySQL 8 in CI (collations, `CHECK`, FULLTEXT) | green here, red in CI (or vice-versa) | portable DDL (`ascii_bin`/`utf8mb4_bin`, explicit `COLLATE` in comparisons), CI runs MySQL 8 first |
| R3  | Money precision (double ⇔ DECIMAL)                               | 1-cent drift in JSON                  | normalise to 2 dp at the repo boundary; property test over random values                           |
| R4  | id ordering (`ORDER BY id` relies on ObjectId layout)            | wrong page order / duplicates         | canonical id generator keeps the 4-byte timestamp prefix; ordering test with crafted ids           |
| R5  | Transactions unavailable on single-node mongod                   | `transaction()` untestable today      | probe at startup + switch test/e2e mongod to a single-node replica set (D2)                        |
| R6  | Silent divergence between providers                              | acceptance criterion 3 fails late     | one provider-agnostic contract suite, run twice on real engines                                    |
| R7  | Refactor regressions in the 269 existing tests                   | behaviour drift                       | P2 is pure refactor; the existing suite is the oracle before MySQL lands                           |
| R8  | Pool/connection lifecycle leaks in tests                         | flaky suite                           | per-provider setup/teardown + `state separation` test                                              |
| R9  | Secrets in logs/compose files                                    | security                              | env templates only, no real secrets, log-content assertions                                        |
| R10 | Deadline/scope creep in P4 (query logic is the bulk)             | partial parity                        | ship in the phase order above; each phase keeps the full suite green                               |

---

## 6. Decisions (approved by the requester)

| #      | Question                      | Decision                                                                                                                                                                                                                                                                        | Consequence for the plan                                                                                                                                                                                                |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | MySQL engine for verification | **(b) MySQL 8 only** — MariaDB rejected                                                                                                                                                                                                                                         | A genuine **MySQL 8.0.44** instance was provisioned here (§2.1/§2.2); `docker-compose` and the CI matrix pin `mysql:8.0`; all collation choices in §3.2 are legal on MySQL 8                                            |
| **D2** | Transaction policy            | **(a) capability probe** — keep the atomic single-document `$inc` + OCC design, add a startup session/transaction probe that logs capability and enforces `REQUIRE_TRANSACTIONS`, and move the test/E2E mongod to a single-node replica set so the probe is genuinely exercised | P3 adds the probe + `REQUIRE_TRANSACTIONS` env; P5 changes `mongodb-memory-server` to `MongoMemoryReplSet` (1 member) and adds a test that asserts the probe reports transactions _available_                           |
| **D3** | `searchMode=text`             | **(a) MySQL `MATCH … AGAINST`, divergence documented and tested**                                                                                                                                                                                                               | P4 implements FULLTEXT (measured working in §2.2); the contract suite pins relevance _ordering_ and token matches on a fixed corpus and lists the known differences (stemming, stop-words, relevance scores) in `docs/` |
| **D4** | Auth repository scope         | **(a) users only** — parity, no session table                                                                                                                                                                                                                                   | P2/P4 expose a `users` repository matching today's stateless JWT + `tokenVersion` behaviour; no new tables, no new endpoints                                                                                            |

No open questions remain. The plan of record is §4 with these four decisions applied.
