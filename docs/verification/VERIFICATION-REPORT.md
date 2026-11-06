# Final Verification & Regression Audit

**Project:** Catalogue (Express 5 API + React 19 SPA, npm workspaces)
**Scope:** Post-modernization verification of the runtime, backend, frontend, E2E, security posture and production build.
**Date:** 2026-11-05
**Auditor role:** Principal QA / Senior Full-Stack Architect / Application Security Engineer

---

## 0. Verdict

| Area                                     | Command                        | Result                                                              |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| Lint + format + unit/integration + build | `npm run verify`               | **PASS** — 0 lint errors, prettier clean, 269 + 194 tests, build OK |
| End-to-end browser suite                 | `npm run test:e2e`             | **PASS** — 20/20                                                    |
| Backend API regression harness           | `node audit/api-audit.mjs`     | **PASS** — 56/56                                                    |
| Runtime / production-posture harness     | `node audit/runtime-audit.mjs` | **PASS** — 9/9                                                      |
| Frontend browser regression harness      | `node audit/browser-audit.mjs` | **PASS** — 15/15                                                    |

**Total: 80/80 automated audit checks, 463/463 unit + integration tests, 20/20 E2E tests, 0 failures.**

**Migration status: `VERIFIED`.**
No application defect was found. Every failure raised during this audit was traced to an incorrect assumption in the _audit harness_ (wrong selector, wrong URL contract, wrong response envelope, stale seeded credential) and was corrected in the harness — never by weakening an application assertion or suppressing an error. The list of those corrections is in §9 so the evidence trail is auditable.

Residual, non-blocking items are recorded in §7 (existing) and §8 (unverified scope).

---

## 1. Environment under test

| Item       | Value                                                                                   |
| ---------- | --------------------------------------------------------------------------------------- |
| Node       | v22.23.4 (`engines.node: >=22.22 <23`)                                                  |
| npm        | 10.9.9                                                                                  |
| OS         | Linux x86_64 (container)                                                                |
| Workspaces | `server` (API), `client` (SPA), root (tooling)                                          |
| Install    | clean `npm ci` from `package-lock.json` (lockfileVersion 3, 711 recorded packages)      |
| Database   | `mongodb-memory-server` (real `mongod` binary) — no external MongoDB instance available |
| Browser    | Playwright Chromium 1248 (headless shell), `playwright install-deps` applied            |

The tree was reinstalled from the lockfile before the final runs, so the numbers below are from a **clean, reproducible install**, not from an incrementally patched `node_modules`.

---

## 2. Part 1 — Runtime & dependency verification

### 2.1 Versions and installability

- `node -v` → `v22.23.4`, `npm -v` → `10.9.9`; all three workspaces declare `engines.node: >=22.22 <23`.
- `npm ci` completes from the lockfile (711 packages). Reproducibility confirmed.

### 2.2 Declared ranges vs installed tree

Custom range verifier (resolves each declared dependency through workspace → root `node_modules` and checks `semver.satisfies`):

```
declared ranges satisfied: 36 | mismatches: 0
```

All 36 declared dependencies/devDependencies across the three workspaces match their ranges.

### 2.3 Duplicates, peers, invalid entries

`npm ls --all | grep -Ei "invalid|extraneous|UNMET"`:

| Entry                                                                                   | Meaning                                                                | Impact                                                                                                |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `vitest@2.1.9 invalid: "^5.1.0" from node_modules/@testing-library/jest-dom overridden` | stale root-hoisted copy kept only to satisfy a `jest-dom` peer marker  | **none** — never executed (`client`/`server` resolve their own `vitest@5.x`); cosmetic `npm ls` noise |
| `@emnapi/runtime@1.11.3 extraneous`, `@img/sharp-wasm32@0.35.5 extraneous`              | optional `sharp`/wasm side-packages installed for a different platform | none                                                                                                  |
| `UNMET OPTIONAL DEPENDENCY @types/react@*`, `@edge-runtime/vm@*`                        | optional peers                                                         | none                                                                                                  |

No duplicate React (React 19.3.1 is deduped — the earlier duplicate-React build failure does not reproduce).

### 2.4 Vulnerabilities — `npm audit`

- `npm audit --omit=dev` → `{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}` — **0 production vulnerabilities**.
- `npm audit` (full) → 6 advisories, **all dev-only**:

| Package          | Severity | Dev-only | Notes                    |
| ---------------- | -------- | -------- | ------------------------ |
| `vitest`         | critical | yes      | test runner; not shipped |
| `tinypool`       | critical | yes      | transitive of `vitest`   |
| `vite`           | high     | yes      | dev/preview server only  |
| `vite-node`      | moderate | yes      | transitive of `vitest`   |
| `esbuild`        | moderate | yes      | transitive of `vite`     |
| `@vitest/mocker` | moderate | yes      | transitive of `vitest`   |

The whole chain collapses to one upgrade: `vitest` 5.x → the fixed line. It was deliberately **not** taken during this audit (it is a test-runner major bump, i.e. a dependency change, which the audit brief excludes).

### 2.5 Outdated packages

```
@eslint/js  9.39.5 -> 10.0.1
eslint      9.39.5 -> 10.14.0
```

Blocked by `eslint-plugin-react`'s peer range `^9.7`. Everything else is current.

---

## 3. Part 2 — Backend regression (`audit/api-audit.mjs`, 56 checks, 56 pass)

Harness: self-contained, boots the real Express app against its own `mongodb-memory-server` (:27996) with an isolated scratch database and upload directory.

### 3.1 Public surface & contract (checks 1–19)

| #   | Check                                                                  | Result |
| --- | ---------------------------------------------------------------------- | ------ |
| 1   | `GET /health` returns 200 with database status                         | PASS   |
| 2   | `GET /docs.json` serves a valid OpenAPI 3 document                     | PASS   |
| 3   | `GET /docs/` serves Swagger UI HTML                                    | PASS   |
| 4   | `GET /` serves the API banner                                          | PASS   |
| 5   | Helmet sets the core hardening headers                                 | PASS   |
| 6   | CORS rejects a foreign origin with 403 `CORS_ORIGIN_DENIED`            | PASS   |
| 7   | CORS allows the configured frontend origin                             | PASS   |
| 8   | `GET /products` returns the first cursor page                          | PASS   |
| 9   | Cursor pagination walks the whole catalogue without duplicates         | PASS   |
| 10  | Search + brand + category + price filters narrow the result set        | PASS   |
| 11  | Every documented sort is applied                                       | PASS   |
| 12  | `GET /products/:slug` and `/products/:id` return the same product      | PASS   |
| 13  | Unknown product → 404 `PRODUCT_NOT_FOUND` through the async controller | PASS   |
| 14  | Inactive products are hidden from the storefront                       | PASS   |
| 15  | Brands/categories list and resolve by slug                             | PASS   |
| 16  | Unknown brand/category → 404                                           | PASS   |
| 17  | Invalid storefront query params rejected with field details            | PASS   |
| 18  | Cursor bound to a different sort → `CURSOR_SORT_MISMATCH`              | PASS   |
| 19  | Malformed ObjectId in path → 400 `INVALID_IDENTIFIER`                  | PASS   |

### 3.2 Input validation, injection, body limits (checks 20–24)

Missing required fields return a field list; unknown body fields rejected (strict schemas); malformed JSON rejected without a stack in the message; oversized JSON body → 413 (100 kB cap); **NoSQL operator injection through query and body is neutralised**. All PASS.

### 3.3 Auth, CSRF, sessions, RBAC (checks 25–43)

- CSRF bootstrap issues a readable, signed cookie; unsafe request **without** a token and with a **forged** token are both rejected.
- Login sets an `httpOnly` / `SameSite` session cookie and leaves **no token in JS-readable storage**.
- Wrong password → generic 401, no account enumeration; payload shape validated.
- `GET /auth/me` restores the session; without a cookie → 401 `AUTH_REQUIRED`; a tampered JWT is rejected.
- Forced password rotation blocks privileged routes until the password changes; `change-password` rejects a wrong current password and password reuse.
- Logout clears the cookie and re-locks protected routes.
- Register creates a customer and never elevates the role; duplicate registration rejected.
- Brute-force protection engages after repeated failures; **account lockout is enforced independently of the IP limiter**.
- Anonymous access to **every** admin route → 401; customer session → 403 `INSUFFICIENT_ROLE`; admin session accepted.

All PASS.

### 3.4 CRUD, uploads, concurrency (checks 44–56)

| Check                                                                                                                                          | Result |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Brand create / rename / delete round-trip                                                                                                      | PASS   |
| Brand delete blocked while products still reference it                                                                                         | PASS   |
| Category create / delete round-trip                                                                                                            | PASS   |
| Product create with image → compressed main file + thumbnail (≤1200 px main, ≤300 px thumb, EXIF/ICC stripped, verified with `sharp` metadata) | PASS   |
| Unsafe upload content rejected (422 `UNSUPPORTED_FILE_TYPE`)                                                                                   | PASS   |
| Update bumps `version`                                                                                                                         | PASS   |
| Stale write → 409 `STALE_RESOURCE` (optimistic concurrency)                                                                                    | PASS   |
| Two concurrent edits at the same version: exactly one wins                                                                                     | PASS   |
| Stock deltas are atomic and can never go negative                                                                                              | PASS   |
| Admin listing supports offset pagination + sorting                                                                                             | PASS   |
| Delete removes the document and its image files                                                                                                | PASS   |
| Orphan sweep endpoint reports its work                                                                                                         | PASS   |
| Every documented operation is routed (no `ROUTE_NOT_FOUND`, no 5xx)                                                                            | PASS   |

**56/56, zero 5xx across the run.**

---

## 4. Part 3 — Frontend regression (`audit/browser-audit.mjs`, 15 checks, 15 pass)

Harness: Playwright Chromium against the **production build** served by `vite preview`, proxied to a freshly seeded API. The script now owns the whole stack (spawns both services, waits for health, tears them down) so the run is reproducible from a clean database — the seeded password rotation is therefore deterministic instead of stateful.

| #   | Check                                                                                                                   | Result |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Public routes render with no console errors or failed requests (4 storefront routes)                                    | PASS   |
| 2   | Product detail renders; back-navigation keeps filter state (`?search=aurora`)                                           | PASS   |
| 3   | Unknown route renders the in-app 404 (no console errors)                                                                | PASS   |
| 4   | Unauthenticated `/admin` redirects to `/login`                                                                          | PASS   |
| 5   | Login with the seeded password forces the rotation screen                                                               | PASS   |
| 6   | Rotation succeeds and unlocks the dashboard (stat cards resolved from the API)                                          | PASS   |
| 7   | Full page reload restores the session from the cookie (path + user identity + shell)                                    | PASS   |
| 8   | Admin product table loads 10 rows, paginates, and search narrows the result set                                         | PASS   |
| 9   | RTK Query invalidation refreshes the brand list after a create, then the row is deleted through the confirmation dialog | PASS   |
| 10  | Categories list + dashboard stats render their data (6 categories, numeric cards)                                       | PASS   |
| 11  | Logout clears the session and re-locks the admin area                                                                   | PASS   |
| 12  | Client-side form validation blocks submit and shows inline errors                                                       | PASS   |
| 13  | Keyboard order on the login screen: email → password → submit → back-link (4 stops, no traps)                           | PASS   |
| 14  | No horizontal overflow at 390 px and 768 px                                                                             | PASS   |
| 15  | Screenshots captured for the record                                                                                     | PASS   |

Console/network discipline: the only network error observed for anonymous visitors is the expected `401` from `/auth/me`; the harness filters exactly that one and treats any other console error or failed request as a failure.

Screenshots: `audit/screenshots/{storefront-1280,storefront-768,storefront-390,login,admin-dashboard}.png`.

---

## 5. Part 4 — End-to-end suite (`npm run test:e2e`, 20 tests, 20 pass, 32.1 s)

`npx playwright test --list` → 20 tests in 5 files:

- **setup** — seeded admin is forced to rotate the password, then reaches the dashboard.
- **authentication** — anonymous redirect, bad credentials show the server message, rotated password signs in, pre-rotation password rejected, sign-out re-locks admin routes.
- **public storefront** — cursor-paginated catalogue, debounced search encoded in the URL and clearable, brand facet narrows the grid and survives reload, unknown term shows the empty state (not an error), detail page keeps the filtered view on back.
- **admin product management** — dashboard counts match the API, offset pagination, search resets to page one, create-with-image then edit, relative stock delta, delete only after confirmation.
- **admin taxonomy** — brand create/rename/delete, brand referenced by products cannot be deleted, categories listed with product counts.

Interactive accessibility and layout evidence is split between this suite and the browser harness (§4 checks 13–14): keyboard traversal and 390/768 px overflow were executed, not inferred.

---

## 6. Part 6 — Production build & runtime (`audit/runtime-audit.mjs`, 9 checks, 9 pass)

Harness spawns the **real** `server/src/server.js` with `NODE_ENV=production` (port 5072) plus a second instance pointed at a dead MongoDB (port 5071).

| #   | Check                                                                                                                        | Result |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Server fails fast and loudly when MongoDB is unreachable (non-zero exit < 15 s, connection error logged)                     | PASS   |
| 2   | Production server boots and connects; no implicit seeding                                                                    | PASS   |
| 3   | Strict security headers on production responses (CSP, `nosniff`, no `x-powered-by`, rate-limit headers)                      | PASS   |
| 4   | Unexpected errors stay redacted in production (no stack, no source paths in the 404 body)                                    | PASS   |
| 5   | CORS rejects unknown origins, echoes the configured one                                                                      | PASS   |
| 6   | Session cookies are `Secure` + `SameSite=None` + `httpOnly` and replay against `/auth/me` (no `passwordHash` in the payload) | PASS   |
| 7   | 200-request burst → 0×5xx, RSS growth bounded                                                                                | PASS   |
| 8   | No secrets, JWTs, hashes, unhandled rejections or `DeprecationWarning`s in the logs                                          | PASS   |
| 9   | `SIGTERM` → exit code 0 and the port is released                                                                             | PASS   |

Build output (`npm run build`): 155 modules, `index 73.97 kB`, `redux 86.24 kB`, `vendor 307.12 kB`, `css 20.90 kB`, built in 364 ms, no warnings.

Unit/integration tests under `npm run verify`: **server 20 files / 269 tests**, **client 18 files / 194 tests**, 0 failures, 0 act() warnings.

---

## 7. Security findings by severity

### Critical / High — application

**None.** No authentication bypass, no broken access control, no injection path, no secret exposure, no unsafe upload acceptance was reproducible.

### Critical / High — dependencies (dev-only, not shipped)

| Severity    | Advisory             | Exposure                         | Recommendation                                               |
| ----------- | -------------------- | -------------------------------- | ------------------------------------------------------------ |
| critical ×2 | `vitest`, `tinypool` | dev/test toolchain only          | plan the `vitest` major upgrade as a separate, tested change |
| high ×1     | `vite`               | `vite` dev/`preview` server only | follow the `vitest` upgrade                                  |

Production dependency tree: **0 vulnerabilities** (`npm audit --omit=dev`).

### Medium / Low — observations (not exploitable as found)

| #   | Observation                                                                                                                                                              | Severity                  | Evidence                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------- |
| 1   | CSRF token is delivered in a **readable** cookie (double-submit pattern) rather than a `httpOnly` one — inherent to the pattern; the session cookie itself is `httpOnly` | Low                       | API audit checks 25–27                                                                 |
| 2   | CSP is enforced in production only (`contentSecurityPolicy: env.isProduction ? undefined : false`)                                                                       | Low (dev-only relaxation) | `server/src/app.js:48`; prod headers verified by runtime audit check 3                 |
| 3   | No refresh-token rotation or server-side session revocation — logout clears the cookie and the JWT stays valid until expiry                                              | Low (design choice)       | `grep refreshToken` → none; logout behaviour verified (API check 36, browser check 11) |
| 4   | 5 `react-hooks` compiler warnings (e.g. `set-state-in-effect`, `refs`) remain in components                                                                              | Info                      | `npm run lint` → 0 errors, 5 warnings                                                  |

### Verified security controls (positive evidence)

Helmet + strict CSP (prod), `nosniff`, no `x-powered-by`, strict CORS allow-list (403 on foreign origin), rate limiting (global + login window) and account lockout, CSRF double-submit rejection of missing/forged tokens, `httpOnly` + `Secure` + `SameSite=None` session cookie, generic auth errors (no enumeration), RBAC (401 anonymous / 403 customer), Zod strict schemas (unknown-field rejection, no operator injection), upload type/size/dimension validation with re-encoding (metadata stripped), optimistic concurrency (409 `STALE_RESOURCE`), atomic stock updates, redacted production errors, log hygiene, fail-fast on DB loss, graceful `SIGTERM` shutdown.

---

## 8. Existing vs newly introduced

### Pre-existing (uncovered by this audit — no change in status)

1. 6 dev-only dependency advisories (§7) — present before the audit, unchanged; prod tree clean.
2. `eslint` 10 / `@eslint/js` 10 upgrade blocked by the `eslint-plugin-react` peer range.
3. 5 `react-hooks` compiler warnings in client components.
4. Cosmetic `npm ls` noise: hoisted stale `vitest@2.1.9`, two extraneous optional wasm packages, unmet _optional_ peers.
5. No refresh-token rotation / session revocation list (design choice, in scope for a future iteration).

### Newly introduced during this audit

**None in application code** — no `server/src` or `client/src` file was modified.

Two _tooling-gate_ regressions were introduced by adding the audit harnesses and fixed inside the same audit:

1. `eslint` reported 74 `no-undef` errors for `audit/*.mjs` (the files were not covered by any config block). **Fix:** a new `eslint.config.js` block giving `audit/**/*.mjs` Node + browser globals and the project's style rules; two genuinely unused variables were removed from the harness. Result: 0 errors.
2. `prettier --check` flagged `audit/*.mjs` and the generated `audit/*-results.json`. **Fix:** the three harnesses were formatted; generated result files were added to `.prettierignore`.

One environment issue (not a code issue): after a network-aborted `npm ci`, the optional native package `lightningcss-linux-x64-gnu` was missing and the build failed with `Cannot find module '../lightningcss.linux-x64-gnu.node'`. Re-installing that optional binary restored the build; a clean `npm ci` on a stable network installs it automatically. Recorded here because it can bite CI on flaky registries.

### Test-infrastructure changes (kept, justified)

- `audit/api-audit.mjs`, `audit/runtime-audit.mjs`, `audit/browser-audit.mjs` + their result JSONs and screenshots — the executable evidence for this report.
- The browser harness now **starts and stops its own API + preview server** on isolated ports (:5077 / :4177) with a throw-away database, so the run is reproducible and does not depend on a manually started stack or a pre-rotated password.

---

## 9. Harness assumptions that were wrong first (transparency log)

Every red result below was a **harness** defect; the application behaviour it exposed was correct. No assertion was deleted or relaxed to make a real failure disappear.

**Backend (18 initial failures → 0):** envelope shape (`data` is the array, `meta` is top-level for storefront lists); CSRF token must be fetched _and bound to the same session_ before login-validation/bad-password/injection probes; `register` and `change-password` require `confirmPassword`; cursor errors are `CURSOR_INVALID` / `CURSOR_SORT_MISMATCH`; auth uses `INVALID_TOKEN`; upload rejection is `422`, create-with-image is `201`; the upload assertion was rewritten from a byte-size heuristic to `sharp` metadata assertions (dimension bounds, metadata stripping, thumbnail ≤300 px).

**Frontend (6 initial failures → 0):** detail route is `/product/:id` (singular); the admin shell renders `<div class="admin-main">`, not `<main>`; brands/categories are `ul.taxonomy-list > li` rows with `+ New brand` / `Save` / `Delete` / `Delete brand`, not a table; the storefront brand filter takes the brand **document id** (not slug); an anonymous `401` from `/auth/me` is expected; `networkidle` is unreliable for this polling SPA and was replaced by explicit UI waits; the dashboard heading is "Catalogue management" and its stat cards resolve asynchronously; after login the app returns to the originally requested route (`/admin/products`), which is correct.

---

## 10. Functionality explicitly **not** verified

| #   | Area                                                                                                      | Why                                                           | Risk                                                       |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | A real, external MongoDB (replica set, auth, TLS)                                                         | only `mongodb-memory-server` is available in this environment | transactions/index behaviour under a real cluster unproven |
| 2   | TLS/HTTPS termination, HSTS in front of a reverse proxy, cookie behaviour over real HTTPS                 | no proxy/CA available                                         | deployment-level; cookie flags were verified               |
| 3   | Cross-browser (Firefox, WebKit, Safari/iOS)                                                               | only Chromium 1248 installed                                  | medium for CSS/DOM edge cases                              |
| 4   | Automated accessibility conformance (axe / WCAG AA audit)                                                 | not in the brief beyond keyboard + responsive checks          | medium; an axe pass is recommended                         |
| 5   | Multi-user/session revocation semantics (concurrent sessions, forced global logout, JWT expiry over time) | no refresh-token model                                        | low–medium                                                 |
| 6   | Sustained load / soak testing (only a 200-request burst measured)                                         | environment limits                                            | capacity unknown                                           |
| 7   | Object storage / CDN upload path (local disk only), image serving performance                             | not implemented in app                                        | n/a                                                        |
| 8   | Email/notification flows, password reset by email                                                         | no such feature exists in the codebase                        | n/a                                                        |
| 9   | Container image build, orchestration, health-probe wiring, backup/restore                                 | outside the app repo                                          | deployment gate                                            |
| 10  | Mobile-native / touch-gesture behaviour beyond viewport overflow checks                                   | no device farm                                                | low                                                        |
| 11  | Windows/macOS developer environments                                                                      | Linux only                                                    | low                                                        |
| 12  | Dependency _upgrades_ for the dev-only advisories (vitest/eslint majors)                                  | excluded by the brief (no dependency changes during audit)    | tracked in §7                                              |

---

## 11. Exact commands executed (reproduction)

```bash
export PATH=/home/user/.cache/runtime/node22/bin:$PATH   # Node v22.23.4
cd /home/user

node -v && npm -v                     # v22.23.4 / 10.9.9
npm ci                                # clean install from the lockfile
npx playwright install chromium       # + playwright install-deps chromium

npm run verify                        # lint + format:check + test + build
npm run test:e2e                      # Playwright suite (20)

node audit/api-audit.mjs              # 56 checks  -> audit/api-audit-results.json
node audit/runtime-audit.mjs          # 9 checks   -> audit/runtime-audit-results.json
node audit/browser-audit.mjs          # 15 checks  -> audit/browser-audit-results.json

npm audit --omit=dev                  # 0 production vulnerabilities
npm audit                             # 6 dev-only advisories
npm outdated                          # eslint / @eslint/js 10.x blocked by peer range
npm ls --all | grep -Ei "invalid|extraneous|UNMET"
```

Machine-readable evidence lives in `audit/*-audit-results.json`; screenshots in `audit/screenshots/`.

---

## 12. Final status

**`VERIFIED`**

- Application code unchanged during the audit; every check below is backed by an executed command.
- 80/80 audit checks, 463/463 unit + integration tests, 20/20 E2E tests, lint/format clean, production build and production runtime healthy.
- 0 production dependency vulnerabilities; 6 dev-only advisories and 5 compiler warnings documented and accepted as residual.
- Outstanding work is **not** migration debt: it is scope that this environment cannot exercise (§10) plus one optional dependency-upgrade track (§7).

_Prepared from executed evidence only. No result in this report is inferred from configuration._
