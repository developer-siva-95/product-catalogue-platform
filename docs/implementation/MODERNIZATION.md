# Modernization & Migration Record

**Project:** MERN Product Catalogue (`catalogue-platform`)
**Role:** Principal Full-Stack Architect
**Started:** 2026-11-05
**Strategy:** audit → record baseline → upgrade in stages → regression-test after every stage. No rebuild, no feature loss, no test weakening.

Legend for the checklist: ✅ verified · 🚧 in progress · ⬜ pending · ❌ failed / blocked · ➖ not applicable

---

## 1. Audit scope (what was inspected before any change)

| Area      | Artifact                                                                                                      | Notes                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Source    | 122 `.js`/`.jsx` files under `server/src`, `client/src`, `e2e`                                                | 4 API modules (products, brands, categories, auth), 1 React SPA, 20 E2E/unit suites      |
| Manifests | root + `server/` + `client/` `package.json`, single root `package-lock.json` (npm workspaces)                 | 36 direct dependencies audited                                                           |
| Config    | `client/vite.config.js`, `server/vitest.config.js`, `eslint.config.js`, `playwright.config.js`, `.prettierrc` | Vitest config in the server is separate; the client keeps `test` inside `vite.config.js` |
| Runtime   | `engines.node >=20.0.0` (root + both workspaces); sandbox default Node v20.20.2, upgrade target Node v22 LTS  | Node v22.23.4 installed locally for verification                                         |
| Tests     | server 20 files / 263 tests, client 18 files / 194 tests, E2E 20 tests                                        | all green before changes                                                                 |

### Baseline recorded **before** any dependency change (Node v22.23.4, original lockfile)

| Gate                      | Command                           | Result                                                     |
| ------------------------- | --------------------------------- | ---------------------------------------------------------- |
| Server unit + integration | `npm run test --workspace server` | **20 files / 263 tests passed**                            |
| Client unit               | `npm run test --workspace client` | **18 files / 194 tests passed**                            |
| Lint                      | `npx eslint .`                    | clean (0 errors, 0 warnings)                               |
| Format                    | `npx prettier --check .`          | 1 pre-existing warning on generated `e2e/.auth/admin.json` |
| E2E                       | `npx playwright test`             | **20 passed** (1 setup + 19 chromium)                      |
| Production build          | `npm run build`                   | OK (vite 5)                                                |

---

## 2. Target version matrix

Latest stable resolved from the registry on 2026-11-05. "Target" is the version actually adopted, after the compatibility check in §3.

### Root tooling

| Package                   | Current    | Target                                                            |
| ------------------------- | ---------- | ----------------------------------------------------------------- |
| node (`engines`)          | `>=20.0.0` | `>=22.22.0` (raised by React Router 8 / Vite 8 / Vitest 5 floors) |
| eslint                    | 9.15.0     | 10.14.0                                                           |
| @eslint/js                | 9.15.0     | 10.0.1                                                            |
| eslint-plugin-react       | 7.37.2     | 7.37.5                                                            |
| eslint-plugin-react-hooks | 5.0.0      | 7.1.1                                                             |
| globals                   | 15.12.0    | 17.14.0                                                           |
| prettier                  | 3.3.3      | 3.9.10                                                            |
| @playwright/test          | 1.49.0     | 1.64.1                                                            |

### Server runtime

| Package            | Current | Target                 |
| ------------------ | ------- | ---------------------- |
| express            | 4.21.1  | **5.3.0**              |
| mongoose           | 8.8.2   | **9.12.0**             |
| zod                | 3.23.8  | **4.6.7**              |
| express-rate-limit | 7.4.1   | **8.7.3**              |
| helmet             | 8.0.0   | 8.3.0                  |
| cors               | 2.8.5   | 2.8.6                  |
| dotenv             | 16.4.5  | 18.0.9                 |
| jsonwebtoken       | 9.0.2   | 9.0.3                  |
| bcrypt             | 5.1.1   | 6.0.0                  |
| sharp              | 0.33.5  | 0.35.5                 |
| multer             | 2.5.0   | 2.5.0 (already latest) |
| cookie-parser      | 1.4.7   | 1.4.7 (already latest) |
| swagger-ui-express | 5.0.1   | 5.0.1 (already latest) |

### Server test tooling

| Package               | Current | Target |
| --------------------- | ------- | ------ |
| vitest                | 2.1.5   | 5.1.0  |
| @vitest/coverage-v8   | 2.1.5   | 5.1.0  |
| mongodb-memory-server | 10.1.2  | 11.3.0 |
| supertest             | 7.0.0   | 7.3.1  |

### Client runtime

| Package           | Current | Target                                                                     |
| ----------------- | ------- | -------------------------------------------------------------------------- |
| react / react-dom | 18.3.1  | **19.3.1**                                                                 |
| react-router-dom  | 6.28.0  | **removed** → `react-router` 8.x (v8 deletes the `-dom` re-export package) |
| @reduxjs/toolkit  | 2.3.0   | 2.14.0                                                                     |
| react-redux       | 9.1.2   | 9.3.1                                                                      |

### Client build/test tooling

| Package                     | Current | Target    |
| --------------------------- | ------- | --------- |
| vite                        | 5.4.11  | **8.3.6** |
| @vitejs/plugin-react        | 4.3.3   | 6.2.1     |
| vitest                      | 2.1.5   | 5.1.0     |
| jsdom                       | 25.0.1  | 31.0.0    |
| @testing-library/react      | 16.0.1  | 16.3.3    |
| @testing-library/jest-dom   | 6.6.3   | 7.0.1     |
| @testing-library/user-event | 14.5.2  | 14.6.8    |

---

## 3. Breaking-change risk register (from the audit, before editing)

### Express 4 → 5

- ✅ Async rejections are forwarded natively → `utils/asyncHandler.js` and its 11+6+6+7 call sites become redundant. **Only** `middlewares/auth.js` and `middlewares/multer.js` legitimately call `next(err)` inside non-async middleware (multer callback style) — those stay.
- ✅ No `res.sendfile`, `req.param()`, `app.del`, `res.send(status)` in `server/src`.
- ⚠️ `path-to-regexp@8`: `*` wildcards and `:param?` optionals are gone. Route strings audited — all are literals or single `:id` params; no wildcard router is registered (404 is a terminal middleware). Must be re-verified with a targeted grep of `app.use(` patterns.
- ✅ `req.query` is still a getter — `validate()` already writes to `req.validated`, never to `req.query`.
- ⚠️ `req.body` is `undefined` when nothing was parsed — `validate()` already guards with `?? {}`.
- ⚠️ Error thrown inside `cors` origin callback: Express 5 surfaces it the same way; the CORS rejection test must stay green.

### Mongoose 8 → 9

- ❌ **`pre()` hooks can no longer take `next()`** — `brands/model.js:48` and `categories/model.js:42` (`pre('validate', function (next) { … next(); })`) must become promise-returning hooks.
- ❌ `new: true` is deprecated (runtime warning) → `returnDocument: 'after'` in `products/service.js` (2×), `config/seed.js` (2×).
- ✅ `isValidObjectId` returning `false` for numbers is irrelevant — `utils/validators.js` also enforces a canonical 24-hex regex.
- ✅ No update pipelines, no `doValidate`, no `isAsync` middleware, no UUID fields, no `Document#updateOne(cb)`, no `caster` usage.
- ⚠️ `strictQuery` + connection options (`serverSelectionTimeoutMS`, `autoIndex`, `maxPoolSize`) unchanged in 9 — keep as is.
- ⚠️ Deprecation warnings are printed by Mongoose by default; tests must not rely on stderr being empty.

### Zod 3 → 4

- ❌ `{ invalid_type_error }` / `{ required_error }` are gone → every `z.string(...)`, `z.number(...)`, `z.boolean(...)` call using them (products/brands/categories/auth `validation.js`) must use the unified `error` parameter. Untouched, they would silently change validation messages that the API returns to clients and that tests assert on.
- ✅ `.strict()`, `.merge()`, `z.preprocess`, `z.coerce`, `z.enum`, `safeParse`, `error.issues` all still supported (some deprecated but functional). No `error.errors`, no `.format()`, no `errorMap` in the codebase.

### express-rate-limit 7 → 8

- ⚠️ `MemoryStore` import path / `resetAll()` and the `handler`, `skip`, `limit` function signatures must be re-checked against v8 (`standardHeaders`, `legacyHeaders` kept).

### Vite 5 → 8 (Rolldown)

- ⚠️ `build.rollupOptions.output.manualChunks` is the main risk: Rolldown replaces `manualChunks` with `advancedChunks`. Must verify against the installed build and keep the `vendor`/`redux` split (or migrate to `advancedChunks` groups).
- ⚠️ `server.allowedHosts: true`, `proxy.configure` and `preview` options are still supported; Vitest 5 keeps reading `test` from `vite.config.js`.

### Vitest 2 → 5, jsdom 25 → 31

- ⚠️ `poolOptions.forks.singleFork` (server config) is the main API risk; `fileParallelism`, `globalSetup`, `env`, `restoreMocks` should carry over.
- ⚠️ jsdom 31 may change `matchMedia`/`URL.createObjectURL` shims — `src/test/setup.js` already feature-detects.

### React 18 → 19

- ✅ No `ReactDOM.render`, `findDOMNode`, `defaultProps`, `propTypes`, or `forwardRef` in `client/src` → no source rewrites expected.
- ⚠️ RTL `act` environment flag (`IS_REACT_ACT_ENVIRONMENT`) is handled by `@testing-library/react` 16.3; keep `globals: true`.

### React Router 6 → 8

- ❌ `react-router-dom` must be uninstalled; every import (`Link`, `NavLink`, `Outlet`, `Navigate`, `Route`, `Routes`, hooks, `createBrowserRouter`, `createMemoryRouter`, `RouterProvider`, `MemoryRouter`) moves to `react-router`, with browser-only entry points (`RouterProvider` for DOM) from `react-router/dom`. Exact export map to be read from the installed package.
- ✅ No `data`/`loaderData` usage, no framework mode, no future flags, no `useHistory`/`Switch`/`Redirect`.

### eslint 9 → 10

- ⚠️ Flat config only (already the case). `eslint-plugin-react-hooks` 7 ships its own flat presets; `@eslint/js` 10 must stay aligned with the `eslint` version.

---

## 4. Staged execution plan

| Stage | Scope                                                                                                                                   | Regression gate                                     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 0     | Audit + baseline (this document)                                                                                                        | baseline table §1                                   |
| 1     | Root tooling (eslint 10, plugins, globals, prettier, playwright)                                                                        | `eslint .`, `prettier --check`, server+client tests |
| 2     | Server runtime (express 5, mongoose 9, zod 4, rate-limit 8, helmet/cors/dotenv/bcrypt/sharp/jwt) + native async error handling refactor | `npm run test --workspace server`                   |
| 3     | Client runtime (react 19, react-router 8, RTK/react-redux)                                                                              | `npm run test --workspace client`                   |
| 4     | Build/test tooling (vite 8, plugin-react 6, vitest 5, jsdom 31, RTL, memory-server 11, supertest)                                       | both test suites + `vite build`                     |
| 5     | Full E2E, `npm run verify`, docs, `engines` bump                                                                                        | 20 E2E + verify + README                            |

---

## 5. Migration checklist (completed / pending / failed / verified)

Updated as each stage lands. Nothing is marked ✅ until the gate for that row has been run after the change.

| #    | Item                                                                          | Status | Evidence                                                                                                                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.1  | Audit of 122 source files, 3 manifests, 5 config files                        | ✅     | §1                                                                                                                                                                                                                                                                                   |
| 0.2  | Baseline test/lint/build results recorded before changes                      | ✅     | §1 table: 263 + 194 + 20 E2E, lint clean, build OK                                                                                                                                                                                                                                   |
| 0.3  | Dependency target matrix + compatibility check (peer deps/engines)            | ✅     | §2                                                                                                                                                                                                                                                                                   |
| 0.4  | Breaking-change risk register per package with affected files                 | ✅     | §3                                                                                                                                                                                                                                                                                   |
| 1.1  | Root tooling upgrade                                                          | ✅     | eslint 9.39.5, @eslint/js 9.39.5, plugin-react 7.37.5, plugin-react-hooks 7.1.1, globals 17.14.0, prettier 3.9.10, playwright 1.64.1                                                                                                                                                 |
| 1.2  | `eslint.config.js` adjusted for flat presets of the new plugins               | ✅     | `react-hooks` 7 bundles the React Compiler rules in `recommended`; `rules-of-hooks`/`exhaustive-deps` stay blocking, compiler-only rules downgraded to `warn` (5 sites, §6)                                                                                                          |
| 1.3  | Prettier ignore for generated `e2e/.auth/admin.json`                          | ✅     | `e2e/.auth` + `.cache` added to `.prettierignore`; `prettier --check .` clean                                                                                                                                                                                                        |
| 2.1  | Express 5 upgrade                                                             | ✅     | 4.21.1 → 5.3.0; every route string is a literal or a single `:param`, no wildcard routers needed                                                                                                                                                                                     |
| 2.2  | `asyncHandler` removed from controllers — native Express 5 rejection handling | ✅     | 26 handlers de-wrapped across 4 controllers; `src/utils/asyncHandler.js` deleted, zero references left                                                                                                                                                                               |
| 2.3  | Dedicated tests proving async rejection → global error handler                | ✅     | `tests/integration/asyncErrors.test.js` — 10 tests replacing the 4 wrapper unit tests (net +6); suite 263 → **269**                                                                                                                                                                  |
| 2.4  | Mongoose 9 upgrade                                                            | ✅     | 8.8.2 → 9.12.0; no `new: true`, no update pipelines, no callback APIs left                                                                                                                                                                                                           |
| 2.5  | `pre('validate')` hooks → promise style (brands, categories)                  | ✅     | Mongoose 9 dropped `next()` from pre middleware (`TypeError: next is not a function`); both hooks now synchronous returns                                                                                                                                                            |
| 2.6  | `new: true` → `returnDocument: 'after'`                                       | ✅     | 2 sites in `products/service.js`, 2 in `config/seed.js`                                                                                                                                                                                                                              |
| 2.7  | Zod 4 upgrade + `error` parameter migration                                   | ✅     | 10 `required_error`/`invalid_type_error` sites → unified `error`; update schemas no longer depend on Zod 3 non-materialised defaults                                                                                                                                                 |
| 2.8  | express-rate-limit 8 upgrade (stores/reset)                                   | ✅     | 7.4.1 → 8.7.3; explicit `MemoryStore` instances + `resetAllRateLimits()` still valid, rate-limit tests green                                                                                                                                                                         |
| 2.9  | helmet / cors / dotenv / bcrypt / sharp / jwt / multer verification           | ✅     | helmet 8.3, cors 2.8.6, dotenv 18 (banner silenced with `quiet: true`), jsonwebtoken 9.0.3, bcrypt 6.0.0 and sharp 0.35.5 (both native, verified), multer 2.5 unchanged                                                                                                              |
| 2.10 | Security review: helmet, CORS, rate limits, trust proxy, sanitisation         | ✅     | see §6 security review                                                                                                                                                                                                                                                               |
| 3.1  | React 19 upgrade                                                              | ✅     | 18.3.1 → 19.3.1 (react + react-dom); no `ReactDOM.render`/`findDOMNode`/`defaultProps`/`forwardRef` in the tree, so no source rewrites were needed                                                                                                                                   |
| 3.2  | react-router 8 migration (drop `react-router-dom`)                            | ✅     | `react-router-dom` removed; 23 files now import from `react-router`, `RouterProvider` from `react-router/dom` (DOM entry). LoginPage's post-login destination now derives from the session, so the rotation redirect can no longer be pre-empted by React 19's synchronous re-render |
| 3.3  | RTK / react-redux latest                                                      | ✅     | @reduxjs/toolkit 2.3.0 → 2.14.0, react-redux 9.1.2 → 9.3.1 (peers: react ^19, redux ^5)                                                                                                                                                                                              |
| 4.1  | Vite 8 + plugin-react 6 (incl. chunking API)                                  | ✅     | vite 5.4.11 → 8.3.6, @vitejs/plugin-react 4.3.3 → 6.2.1; Rolldown rejects the object form of `manualChunks`, converted to a function keeping the `vendor`/`redux` split (vendor 307 kB, redux 86 kB)                                                                                 |
| 4.2  | Vitest 5 (client + server configs)                                            | ✅     | vitest 2.1.5 → 5.1.0 (both workspaces); server `poolOptions.forks.singleFork` → `maxWorkers/minWorkers: 1` (removed in Vitest 4)                                                                                                                                                     |
| 4.3  | jsdom 31 + RTL 16.3 + jest-dom 7                                              | ✅     | jsdom 25 → 31, RTL 16.3.3, jest-dom 7.0.1, user-event 14.6.8. jest-dom 7's `/vitest` entry extended a second chai (nested vitest under the package) → matchers registered explicitly on our own `expect`; root `overrides` pin a single vitest                                       |
| 4.4  | mongodb-memory-server 11 + supertest 7.3                                      | ✅     | mongodb-memory-server 10.1.2 → 11.3.0 (downloads MongoDB 7.0.14), supertest 7.0.0 → 7.3.1, @vitest/coverage-v8 5.1.0                                                                                                                                                                 |
| 5.1  | Playwright 1.64 + full E2E suite green                                        | ✅     | playwright 1.49.0 → 1.64.1 (chromium-1248 installed): **20/20 passed** against the Express 5 API and the Vite 8 production build                                                                                                                                                     |
| 5.2  | `npm run verify` green                                                        | ✅     | `npm run verify` green: eslint 0 errors (5 known warnings), prettier clean, server 269, client 194, vite build OK                                                                                                                                                                    |
| 5.3  | `engines.node` bumped to the real floor                                       | ✅     | `engines.node` = `>=22.22.0` in root, server and client (React Router 8 requires ≥22.22.0; Vitest 5 requires ^22.12; Vite 8 requires ≥22.12)                                                                                                                                         |
| 5.4  | README/version docs updated                                                   | ✅     | README stack table, engines, design notes and verification counts updated (269 / 194 / 20)                                                                                                                                                                                           |

### Failed / blocked

| Item           | Status     | Reason / decision                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eslint 10.14.0 | ❌ blocked | `eslint-plugin-react@7.37.5` declares `peerDependencies.eslint: ^3 … ^9.7` and no v8 exists (`next` is 7.8.0-rc). Forcing the peer range would mean shipping a lint stack that upstream does not support. Staying on **eslint 9.39.5** (latest 9.x) keeps the pair mutually compatible, which the brief requires. Revisit when the plugin supports eslint 10. |

### Decisions of record

1. **`asyncHandler` will be deleted, not kept as dead code.** Express 5 forwards rejected promises to the error handler natively. Its 5 unit tests are replaced by a larger integration suite that asserts the behaviour end-to-end (rejected controller → standard error envelope, sync throw, rejected middleware, 404 fallthrough). Test count must go **up**, never down.
2. **No test is deleted to make a suite pass.** Where an implementation disappears by design, its tests are superseded by strictly broader coverage and that substitution is recorded here.
3. **`sanitizeFilter` stays off** — the audit confirmed the app relies on `$regex`/`$ne`/`$gt`; injection defence stays at the request boundary (strict Zod schemas + `sanitizeRequest`).
4. **MongoDB server version** is supplied by `mongodb-memory-server` in tests; no real `mongod` in this environment, so index/behaviour changes are verified through that harness.
5. **Zod 4 materialises defaults for absent keys** (Zod 3 did not). `.optional().default('')` on the _update_ schemas made `{}` parse to `{ description: '' }` and silently defeated the "provide at least one field" guard — a documented 400 turned into a 200. Fixed in the product code (default-free variant for updates) so the API contract is preserved instead of the test being relaxed.
6. **Express 5 removed `app._router`** and hides mounted-router paths (`layer.regexp` → opaque matchers). `src/routes/index.js` now exports a `routeMounts` table that both mounts the routers and feeds the OpenAPI parity test; the test throws if a router is ever mounted without being listed, so the spec/implementation comparison stays honest instead of being deleted.
7. **`dotenv` 18 prints a load banner** on every start; `quiet: true` keeps structured logs and test output clean.

---

## 6. Security & database review (requirement 3)

Verified by running the app with `NODE_ENV=production` and probing it with supertest, not by reading config alone.

| Control             | Configuration                                                                                                                                       | Verified behaviour                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Helmet              | 8.3.0, `crossOriginResourcePolicy: cross-origin`, CSP enabled in production / disabled in dev                                                       | `content-security-policy` present on every API response; uploads served with `X-Content-Type-Options: nosniff` + CORP `cross-origin`                                               |
| Swagger UI CSP      | Relaxed `script-src 'self' 'unsafe-inline'` only for the docs mount                                                                                 | `/api/v1/docs/` returns 200 with a CSP that lets the UI render, while `/api/v1/docs.json` keeps the strict default policy                                                          |
| CORS                | Exact-origin allowlist from `FRONTEND_URL`, `credentials: true`, explicit method/header lists, `maxAge: 600`                                        | Allowed origin → `access-control-allow-origin` echoed; foreign origin → `403 CORS_ORIGIN_DENIED` in the standard envelope (Express 5 surfaces the thrown callback error correctly) |
| Rate limiting       | express-rate-limit 8.7.3, explicit `MemoryStore` per limiter (api / login / upload), `skipSuccessfulRequests` on login, per-request limit functions | `RateLimit-*` headers present (`limit=300` default); reset helper still works for tests; `429 RATE_LIMITED` path covered by tests                                                  |
| Proxy trust         | `app.set('trust proxy', env.isProduction ? 1 : false)`                                                                                              | Correct `req.ip` derivation behind one reverse proxy; no permissive-trust validation error from express-rate-limit 8                                                               |
| CSRF                | Signed double-submit cookie (HMAC-SHA256), `X-CSRF-Token` required on every unsafe method                                                           | Enforced by the existing CSRF suite; docs test asserts every mutating operation documents the header                                                                               |
| Injection           | Strict Zod 4 schemas (`.strict()`), `sanitizeRequest` at the boundary, regex escaping in search                                                     | `sanitizeFilter` intentionally **not** enabled globally (would break `$regex`/`$ne`/`$gt`); rationale kept in `config/db.js`                                                       |
| Mongoose connection | 8 → 9: `strictQuery: true`, `serverSelectionTimeoutMS: 5000`, `autoIndex` disabled in production, `maxPoolSize` 20/10, explicit lifecycle listeners | Unchanged semantics in Mongoose 9; `disconnectDB()` remains safe to call when already closed                                                                                       |
| Auth                | bcrypt 6 hashes, JWT 9.0.3 in httpOnly cookie, token-version revocation, account lockout, forced password rotation                                  | Full auth suite green (locking, rotation, revocation, RBAC)                                                                                                                        |
| Uploads             | multer 2.5 + sharp 0.35.5 (native binding verified), magic-byte sniffing, re-encode, metadata stripping, 30/min limiter                             | Upload tests green (size limit, polyglot rejection, thumbnail generation)                                                                                                          |

## 7. Final verification (after all stages)

| Gate                   | Result                                                                          |
| ---------------------- | ------------------------------------------------------------------------------- |
| `npm run lint`         | 0 errors, 5 warnings (React Compiler-only rules, see §8)                        |
| `npm run format:check` | clean                                                                           |
| `npm run test:server`  | **20 files / 269 tests passed** (baseline 263 → +6 net)                         |
| `npm run test:client`  | **18 files / 194 tests passed** (baseline 194 — no test lost)                   |
| `npm run build`        | Vite 8 / Rolldown: 155 modules, `vendor` 307 kB, `redux` 86 kB, `index` 74 kB   |
| `npm run test:e2e`     | **20 passed** (1 setup + 19 chromium) in ~40 s                                  |
| Runtime                | verified on Node **v22.23.4**; `engines.node: >=22.22.0` in all three manifests |

Test-count accounting: 263 → 269 server tests. Removed 4 unit tests that exercised the
deleted `asyncHandler` wrapper; added 10 integration tests that assert the same guarantee
through the real app (rejected controller, rejected middleware, ApiError status/code
preservation, production message/stack redaction, 404 fallthrough, structural check that no
controller is wrapped, zero unhandled rejections). No client test was removed or relaxed;
two debounce tests were made stricter (they now wait out the debounce window inside `act`).

## 8. Known residual items (deliberately out of scope)

| Item                                                                                    | Why it is not changed now                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eslint 9.39.5 instead of 10.14.0                                                        | `eslint-plugin-react@7.37.5` caps its peer range at `^9.7`; forcing eslint 10 would ship an unsupported pairing. Blocked, tracked.                                                                                                                                                                                                      |
| 5 `react-hooks` compiler-rule warnings                                                  | `set-state-in-effect` / `refs` hits in `ImageUpload`, `Modal`, `useDebouncedValue`, `useUrlSyncedFilters`, `ProductFormPage`. These are React Compiler readiness hints, not defects; rewriting them is a behaviour-affecting refactor that does not belong in a dependency migration, so they are reported as warnings and listed here. |
| `MaxListenersExceededWarning` (11 error listeners on `[Server]`) in the server test run | Emitted by the driver/server objects the MongoDB Memory Server + supertest combination creates inside the single test worker; no production path. Harmless, left in place to avoid masking a real leak later.                                                                                                                           |
| `npm audit` reports remaining advisories                                                | Resolved transitively through the manifests; `npm audit fix --force` would downgrade majors and break the compatibility set. Recommended follow-up: re-audit after the ecosystem publishes fixes.                                                                                                                                       |
| Server-side pagination/index behaviour                                                  | Verified only through MongoDB Memory Server (no standalone `mongod` available here).                                                                                                                                                                                                                                                    |
