# Phase 1 gate report — contracts, canonical IDs, mapper extraction

**Status: P1 complete, stopped at the gate. P2 not started.**
No behaviour, no API contract and no frontend code changed. Evidence was captured
_before_ the first edit and compared afterwards.

---

## 1. Scope delivered

| Required                            | Delivered                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `utils/id.js` (new)                 | ✅ canonical id generator/validator/parser, driver-free                                                            |
| `utils/validators.js`               | ✅ Mongoose import removed; `isValidObjectId` now delegates to `utils/id.js`                                       |
| `utils/cursor.js` (remove Mongoose) | ✅ imports `isValidId` from `utils/id.js`; token format and error codes byte-identical                             |
| Repository contracts                | ✅ `products`, `brands`, `categories`, `users` + shared `repository.js` (typedefs, invariants, `defineRepository`) |
| Product mappers extracted           | ✅ `repositories/product.mapper.js`; `service.js` re-exports them                                                  |
| ESLint boundary rule                | ✅ drivers banned in services/controllers, models banned in controllers, positive controls verified                |
| New tests (supplement)              | ✅ 156 new tests across 5 files + 2 fixtures; no existing test removed, renamed or skipped                         |

One small additional change was required to satisfy condition 5: `products/service.js`
imported `mongoose` directly for three `new mongoose.Types.ObjectId(...)` casts. Those
casts moved into `repositories/mongo/objectid.js` (`toObjectId`), which is below the
repository boundary. Same call, same cast, same thrown errors.

## 2. Complete changed-file list (19 files)

**Modified (4)**

| File                                     | Change                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `server/src/utils/validators.js`         | dropped `import mongoose`; `isValidObjectId` = `isValidId`; re-exports `toCanonicalId`       |
| `server/src/utils/cursor.js`             | `isValidObjectId` → `isValidId` (both call sites); no format, message or code change         |
| `server/src/modules/products/service.js` | mappers moved out and re-exported; `mongoose` import replaced by `toObjectId` (3 call sites) |
| `eslint.config.js`                       | new repository-boundary rule + shared messages                                               |

**New — source (8)**

`server/src/utils/id.js`; `server/src/repositories/repository.js`;
`server/src/repositories/product.mapper.js`;
`server/src/repositories/{products,brands,categories,users}.repository.js`;
`server/src/repositories/mongo/objectid.js`.

**New — tests (5) and fixtures (2)**

`server/tests/unit/id.test.js`, `server/tests/unit/product-mapper.test.js`,
`server/tests/unit/repository-contracts.test.js`,
`server/tests/integration/id-rejection.test.js`,
`server/tests/integration/cursor-legacy.test.js`,
`server/tests/fixtures/p1/product-mapper-golden.json`,
`server/tests/fixtures/p1/legacy-cursors.json`.

Nothing was deleted. `client/`, `e2e/`, `audit/`, `server/src/modules/*/{model,controller,routes,validation}.js`
and `server/src/{app,server}.js` are untouched.

## 3. Before → after results

Measured on this tree; the "before" column is the Phase 0 gate re-run at
2026-11-06 06:07–06:41 UTC, the "after" column is 07:07–07:15 UTC.

| Gate                    | Before                       | After                        | Verdict                            |
| ----------------------- | ---------------------------- | ---------------------------- | ---------------------------------- |
| `npm run verify`        | exit 0                       | exit 0                       | same                               |
| ESLint                  | 0 errors / 5 warnings        | 0 errors / 5 warnings        | same (pre-existing React warnings) |
| Prettier                | clean                        | clean                        | same                               |
| Server tests            | 269 / 269 (20 files)         | **425 / 425 (25 files)**     | +156, none removed                 |
| Client tests            | 284 / 284 (24 files)         | 284 / 284 (24 files)         | identical                          |
| Production build        | ✓ 320 ms                     | ✓ 491 ms                     | same bundle hashes                 |
| `npm run test:e2e`      | 34 passed                    | **34 passed**                | identical                          |
| DOM budget              | PASS (11 checks)             | PASS (11 checks)             | identical numbers                  |
| Responsive audit        | 4/4 viewports                | 4/4 viewports                | identical numbers                  |
| API audit               | 56 / 56                      | 56 / 56                      | identical                          |
| Runtime audit           | 9 / 9                        | 9 / 9                        | identical                          |
| Browser audit           | 15 / 15                      | 15 / 15                      | identical                          |
| Lifecycle probe (135 s) | 0 requests, 0 console errors | 0 requests, 0 console errors | identical                          |

New tests: `id` 28 · `product-mapper` 69 · `repository-contracts` 10 ·
`id-rejection` 39 · `cursor-legacy` 10 = **156**. Suite-wide skip/todo/only count: **0**.
Build time moved 320 → 491 ms; the emitted asset hashes are unchanged
(`index-CcePP7Ij.js`, `redux-CBO0vs_2.js`, `vendor-ZEA1hnRG.js`, `index-C8yjlqf7.css`),
so it is machine variance, not an output difference.

## 4. API snapshot comparison — 30/30 identical

Method: before editing any file, a throwaway harness booted the real app against an
ephemeral `mongod` with a fully deterministic fixture (fixed 24-hex ids, fixed
timestamps, 2 brands, 2 categories, 6 products incl. an inactive one, an admin user
and an admin session), then recorded for 30 requests: status, `content-type`, the
request's JSON **text** (key order preserved) and a recursive type map. Only genuinely
volatile values were masked (`requestId` UUID, `uptimeSeconds`, CSRF token, the login
instant, stack traces) — every other byte, including key order, was compared.

Coverage: `/health`; storefront list (default, cursor page 2, `price_asc`,
`price_desc`, search, price filter, all); detail (present, missing SKU, absent,
inactive, malformed id, invalid sort, invalid cursor, cursor/sort mismatch); brands
(list, detail, duplicate create); categories; 401 unauthenticated admin access; login;
`/auth/me`; admin list (offset pagination) and detail; duplicate SKU 409; stale
version 409; stock over-draw 409; unknown route 404.

Result: **30 of 30 entries byte-identical, and the two issued cursor tokens are
identical to the pre-P1 tokens.** Verified deterministic first by running the harness
twice before any edit (identical output), which rules out flaky comparison.

Confirmed unchanged in particular: envelope key order
(`success, message, data|error, requestId`), error payload
(`error: { code, details, stack }`), `price` as a JSON number, `sku: null` for absent
SKUs, `createdAt`/`updatedAt` as `…Z` ISO strings with millisecond precision, admin
`version` last, `meta` key order, and every published error code
(`PRODUCT_NOT_FOUND`, `VALIDATION_ERROR`, `CURSOR_INVALID`, `CURSOR_SORT_MISMATCH`,
`CURSOR_FILTER_MISMATCH`, `INSUFFICIENT_STOCK`, `DUPLICATE_KEY`, `STALE_RESOURCE`,
`AUTH_REQUIRED`, `ROUTE_NOT_FOUND`).

## 5. Pre-P1 cursors still decode

`server/tests/fixtures/p1/legacy-cursors.json` holds two tokens minted by the Phase 0
code (one `newest`, one `price_asc`, both with their original payloads). Tests assert:

- both decode to their exact original payload;
- both are **accepted by the live endpoint** (`200`, correct `meta.sort`, page strictly
  after the cursor position);
- both **re-encode to the identical token string** — the format is stable, not merely
  readable;
- the wrong-sort and different-filter rejections still fire with
  `CURSOR_SORT_MISMATCH` / `CURSOR_FILTER_MISMATCH`;
- `buildStorefrontQueryParts()` still computes the same filter fingerprint the old
  cursors carry.

## 6. ESLint boundary enforcement

Rule (`eslint.config.js`):

- `server/src/modules/**/service.js` — `no-restricted-imports` for `mongoose`,
  `mongodb`, `bson`, `mysql2`, `mysql2/promise`, `mongodb/*`, `mysql2/*`,
  `**/config/db.js`, `**/db/index.js`.
- `server/src/modules/**/controller.js` — the same plus `**/model.js`.

Verification:

| Check                                                                          | Result                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------- |
| Real codebase (`npx eslint .`)                                                 | **0 errors**, 5 pre-existing React warnings |
| Positive control: service importing `mongoose` + `mysql2/promise`              | 3 errors raised                             |
| Positive control: controller importing `../products/model.js` + `config/db.js` | 2 errors raised                             |
| Driver imports left in any service or controller                               | **0**                                       |

Still driver-coupled, and therefore explicitly **not** covered by the rule yet (P2
targets): the four `model.js` files, `middlewares/errorHandler.js` (maps Mongoose
error types), `config/db.js`, `config/seed.js`, and the new
`repositories/mongo/objectid.js` — the last is inside the allowed zone by design.

## 7. Frontend untouched

- Files changed under `client/src`: **0**.
- `client/dist` was regenerated by the gate's own build step; all emitted asset
  hashes are identical to the pre-P1 build.
- `useVirtualGrid`, the RTK Query slice, components and styles were not opened for
  writing at all. DOM budget / responsive / lifecycle numbers are unchanged, which is
  the independent behavioural confirmation.

## 8. Secrets and repository hygiene

- The MySQL provisioning helper existed at `tools/provision-local-mysql8.sh` during
  Phase 0. Per condition 7 it has been **removed from the project tree** and now lives
  at `/opt/dev-tools/provision-local-mysql8.sh` (outside the project). No credentials
  were added to the tree, and `.env.example` is unchanged and contains placeholders
  only (`JWT_SECRET=replace-me-with-a-long-random-string-at-least-32-chars`).
- No commit was made (the workspace has no VCS); no real data or secret is in any new
  file. The MySQL instance used for later phases keeps its dev-only credentials outside
  the project.
- Snapshot/golden evidence is stored outside the project tree (`/opt/p1-evidence/`), so
  `prettier --check .` and the build stay clean.

## 9. Test-count integrity

- Before: 269 server tests / 20 files. After: 425 / 25 files. Delta is exactly the five
  new files (156 tests). No existing file changed test count.
- No test was renamed, removed, skipped or marked todo: repo-wide grep for
  `.skip` / `.todo` / `.only` in `server/tests` returns 0 (the single `skipped` hit is a
  property name in a seed assertion).
- The golden mapper fixture was generated from the **pre-extraction** implementation
  before it was moved, so the mapper tests compare new code against old behaviour rather
  than against itself.

## 10. Risks and dependencies for P2

1. **P2 must move queries, not just imports.** The three `toObjectId` casts and every
   `Product.find/aggregate/findOneAndUpdate` in `products/service.js` are still
   Mongoose-shaped; P2 relocates them into `repositories/mongo/products.repository.js`.
   Until then the ESLint rule cannot be extended to ban `**/model.js` in services.
2. **`LOW_STOCK_THRESHOLD` is duplicated** (mapper 5, `products/model.js` 5) and pinned
   by a test. P2 should unify it in `constants/appConstants.js`; the test will fail loudly
   if the two drift, which is intended.
3. **`errorHandler.js` maps Mongoose error names.** The MySQL implementation must map
   `ER_DUP_ENTRY`/`1062`, affected-rows staleness and CHECK violations onto the same
   codes. The mapping belongs next to the mongo mapping so the two stay reviewable side
   by side (P2/P4).
4. **Cursor codec is now driver-free but still imports `PRODUCT_SORTS`**; if P4 adds a
   provider-specific sort the cursor must remain provider-agnostic — keep sorts in
   `constants/appConstants.js`.
5. **Consistency test baseline is Mongo-only.** `id-rejection.test.js` encodes today's
   real behaviour (admin routes 400, storefront detail 404). The dual-provider contract
   suite in P5 must reuse these expectations verbatim instead of re-deriving them.
6. **Environment**: the local MySQL 8.0.44 instance and the Node 22 runtime live outside
   `/home/user` and must be re-provisioned in a new session
   (`/opt/dev-tools/provision-local-mysql8.sh`); E2E needs ports 5050/4173 free —
   a stale server from an interrupted run caused one spurious `E2E_EXIT=1`, which is why
   the E2E gate was re-run in isolation (34/34).
