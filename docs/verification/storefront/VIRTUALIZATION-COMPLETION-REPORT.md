# Production refactor — virtualization & state restoration — completion report

> **Historical note — added 2026-11-06 during documentation consolidation.**
> The body of this report is preserved exactly as originally written. It was **not** re-run
> or re-verified on 2026-11-06: this workspace has no installed dependencies, so nothing
> below is a fresh result.
> One claim no longer matches the implementation: the customer storefront **does not carry
> `?page=N` in its URL any more**. Pagination depth is owned by the RTK Query cache, and a
> URL that arrives carrying `page` is stripped by `stripPagination` in
> `client/src/hooks/useListingDepth.js` (applied from `useUrlSyncedFilters`, with `replace`).
> Read every `?page=` / "page-param" statement below as a description of the code **as it was
> when this report was written**. Current behaviour: root `README.md` §"Storefront" and
> §"Design decisions", and `docs/architecture/ARCHITECTURE.md`.

Phases 1–3 are in `PHASE-1-3-INSPECTION-ROOT-CAUSE-PLAN.md` (inspection, root-cause,
plan — written before any source file was touched). This document reports Phase 4
(implementation), Phase 5 (verification) and Phase 6 (acceptance criteria).

Round 1 (cart removal, stock, responsive/a11y) is documented in
`STOREFRONT-UI-UX-REPORT.md`; the cache/restoration round that proved and fixed the
RTK Query defects is documented in `STOREFRONT-CACHE-RESTORATION-REPORT.md`. Their
claims were re-verified after this round's changes (§3), not assumed.

---

## 1. Summary of architectural and virtualization decisions

### 1.1 Virtualization

`ProductGrid` now switches to **row windowing** above a documented threshold
(`VIRTUALIZE_THRESHOLD = 60`, `client/src/utils/constants.js`):

| Decision            | Choice                                                                                                                           | Why                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Vehicle             | hand-rolled `useVirtualGrid` (`client/src/hooks/useVirtualGrid.js`, ~330 lines incl. docs)                                       | No new dependency (standing constraint). A 2-D fixed-ratio grid: a general virtualizer would still leave row/cell layout to us |
| Granularity         | rows, not items                                                                                                                  | Column count is a CSS decision; rows keep the grid geometry intact with zero measurement of individual cards                   |
| Row height          | one measurement per layout (uniform cards measured at 390/768/1280 = 288/352/346 px)                                             | No per-item height cache, no estimation drift, no anchoring correction                                                         |
| Columns             | read from `getComputedStyle(grid).gridTemplateColumns`                                                                           | CSS remains the single source of truth; no duplicated breakpoint table                                                         |
| Space               | viewport reserves `rows × stride − gap`; inner grid translated to the first rendered row                                         | Document height is constant, so scroll anchoring, the infinite-scroll sentinel and scroll restoration keep working unchanged   |
| Bound               | visible rows + `OVERSCAN_ROWS = 2` on each side; focus pinning capped (`FOCUS_PIN_MAX_ROWS = 2`)                                 | DOM size is a function of the viewport, not of scroll depth                                                                    |
| Threshold behaviour | ≤60 products → nothing is virtualized                                                                                            | Small result sets keep find-in-page and printing working across the whole list (user decision)                                 |
| Focus/IP            | focused row always mounted (+ context); on a **layout change** the window slides onto the focused row and the page scrolls to it | Tab/Shift+Tab traverse window boundaries; a viewport resize cannot drop focus to `<body>`                                      |
| a11y                | `aria-posinset`/`aria-setsize` per card, `aria-busy` toggling unchanged, real `article` + real links, no tabindex shims          | Screen readers announce "7 of 240" while only part of the list is mounted                                                      |

### 1.2 The four restoration mechanisms stay separate (§2 of the brief)

| Mechanism           | Owner                                                                      | Restores                                                  | Test that pins it                                                                            |
| ------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| URL state           | `useUrlSyncedFilters` + `useListingDepth` (`?page=N`)                      | filters, sort, search, depth                              | `StorefrontPage.test.jsx` (URL sync), e2e "survives a reload"                                |
| RTK cache retention | `apiSlice` (`keepUnusedDataFor: 900` list / 60 s default)                  | pages already fetched                                     | `apiSlice.test.js` (present at 120 s, gone at 910 s; default entry evicted at 61 s)          |
| Accumulated pages   | `merge` (`cursors[]`, `pageCount`), `selectCachedListCursor`, depth replay | depth ≤ cache for free; deeper depth one page per request | `apiSlice.test.js` + `StorefrontPage.test.jsx` (0 requests on remount, 2 on cold start)      |
| Scroll              | `useScrollRestoration` (`sessionStorage`, keyed by filter set)             | viewport offset once depth is painted                     | `useScrollRestoration.test.jsx`, e2e detail round trip, lifecycle probe (777 px, 0 requests) |

Data freshness stays independent: tags/invalidations, the detail→list write-back
(`patchCachedProductLists`) and the 15 s detail revalidation. No restoration path
issues a request; no freshness path touches UI state.

### 1.3 Immutability

Server responses are never mutated. Accumulation happens inside RTK Query's immer
draft (`merge` returns fresh arrays; `updateQueryData` patches a draft), and a
cached page-1 rewrite replaces rather than mutates. Evidence: the write-back test
asserts the untouched sibling product keeps its own values, and the dedupe test
asserts no duplicated ids after overlapping pages.

---

## 2. Modified files

| Path                                         | Change                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `client/src/hooks/useVirtualGrid.js`         | **new** — `computeWindow` (pure), `reservedHeight`, `useVirtualGrid` (measurement, rAF scroll sync, focus pinning/anchoring)         |
| `client/src/hooks/useVirtualGrid.test.js`    | **new** — 13 windowing-maths tests                                                                                                   |
| `client/src/components/ProductGrid.jsx`      | threshold switch, reserved-height viewport, translated window, focus handlers                                                        |
| `client/src/components/ProductGrid.test.jsx` | **new** — 9 grid tests (bounded DOM, identity, a11y, threshold)                                                                      |
| `client/src/components/ProductCard.jsx`      | `data-index`, `aria-posinset`, `aria-setsize` (only while virtualized)                                                               |
| `client/src/utils/constants.js`              | `VIRTUALIZE_THRESHOLD = 60` with the documented trade-off                                                                            |
| `client/src/styles/components.css`           | `.product-grid-viewport`, `.product-grid--virtual` (card visuals untouched)                                                          |
| `e2e/virtualization.spec.js`                 | **new** — 8 specs (bounded DOM, reachability, keyboard+resize, column re-render, reload/depth, detail round trip, threshold control) |
| `audit/dom-budget-audit.mjs`                 | **new** harness — mounted cards / document nodes vs scroll depth at 3 viewports + 20-product control                                 |
| `audit/dom-budget.json`                      | **new** artefact from that run                                                                                                       |
| `.prettierignore`                            | ignores the generated `audit/dom-budget.json`                                                                                        |

**Not modified:** `StorefrontPage.jsx`, `ProductDetailPage.jsx`, every restoration
hook, `apiSlice.js`, the Redux slices, all server code, `package.json`, routes.

**Dependencies: none added, none removed, none upgraded.**

---

## 3. Test commands and verified results

| Command                                                                | Result                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify` (lint → format → client tests → server tests → build) | **exit 0** — ESLint **0 errors / 5 warnings** (all pre-existing `react-hooks` advisories in untouched admin/modal/hook files), Prettier clean, client **284 passed / 24 files**, server **269 passed / 20 files**, build ✓ 319 ms |
| `npm run test:e2e` (Playwright, production build, 1 worker)            | **34 passed, 0 failed** (1.3 m) — 26 pre-existing + 8 new virtualization specs                                                                                                                                                    |
| `node audit/dom-budget-audit.mjs`                                      | **PASS (11 checks)** — see §4                                                                                                                                                                                                     |
| `node audit/lifecycle-probe.mjs 135000`                                | depth 20 / scroll 777 / **0 requests** on Back, also after the 135 s cache window; cold reload of `/?page=2` → 20 cards from 2 requests; **0 console errors**                                                                     |
| `node audit/responsive-audit.mjs`                                      | 4/4 viewports expected columns (2/3/4/4), **0 px** overflow, min tap 40 px, a11y clean                                                                                                                                            |
| `node audit/browser-audit.mjs`                                         | 15 passed, 0 failed                                                                                                                                                                                                               |
| `node audit/api-audit.mjs`                                             | 56 passed, 0 failed                                                                                                                                                                                                               |
| `node audit/runtime-audit.mjs`                                         | 9 passed, 0 failed                                                                                                                                                                                                                |

Test count movement: client 262 → **284** (+22: 13 windowing, 9 grid; no existing
test was deleted, none was weakened); E2E 27 → **34**.

**Mutation checks** (tests have teeth, not just green):

- disabling focus pinning → the keyboard E2E fails;
- disabling the depth-replay effect → 3 listing tests fail (previous round);
- the resize-with-focus test found a **real defect** (focus was dropped to `<body>`
  when the column count changed) that is now fixed by the anchoring path.

---

## 4. DOM budget (acceptance criterion 4)

`audit/dom-budget.json`, 480-product catalogue served through the real cursor
contract, measured at increasing scroll depth:

| Viewport                       | Products loaded | Max mounted cards    | Max document nodes | Overflow |
| ------------------------------ | --------------- | -------------------- | ------------------ | -------- |
| 390 × 844                      | 372             | **14**               | **236**            | 0 px     |
| 768 × 1024                     | 372             | **24**               | **366**            | 0 px     |
| 1280 × 800                     | 372             | **28**               | **466**            | 0 px     |
| control: seeded catalogue (20) | 20              | 20 (not virtualized) | 362                | 0 px     |

Before this round the same page held **263 grid nodes / 314–362 document nodes with
just 20 products**, and grew by ~13 nodes and 2 tab stops per additional product
without limit (Phase 1 §1.3). Depth no longer changes the node count.

---

## 5. Production build

`vite build` (Vite 8 / Rolldown) — ✓ **319 ms**.

```
dist/index.html                     0.93 kB │ gzip:  0.48 kB
dist/assets/index-C8yjlqf7.css     26.35 kB │ gzip:  5.82 kB
dist/assets/index-CcePP7Ij.js      85.69 kB │ gzip: 23.22 kB
dist/assets/redux-CBO0vs_2.js      86.24 kB │ gzip: 28.93 kB
dist/assets/vendor-ZEA1hnRG.js    307.12 kB │ gzip: 96.71 kB
```

Storefront entry 81.44 kB → 85.69 kB (+4.25 kB raw, +1.54 kB gzip) for the
virtualizer. CSS +0.12 kB. Zero runtime console errors in the E2E run, the
lifecycle probe, the DOM-budget audit and the responsive audit.

---

## 6. Acceptance criteria (Phase 6)

| #   | Criterion                                                                                        | Verdict  | Evidence                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No duplicate products after repeated list/detail/back navigation                                 | **PASS** | `ProductGrid.test.jsx` "never mounts the same product twice"; `StorefrontPage.test.jsx` overlapping-pages test; `apiSlice.test.js` retried-cursor test; e2e seed spec asserts 20 unique titles after scroll; lifecycle probe shows 20 distinct cards after two Back navigations                    |
| 2   | Updated product info/stock appear after refetch/invalidation                                     | **PASS** | `apiSlice.test.js`: detail fetch patches cached pages with **0 extra list requests**; revalidation test (fresh within threshold, refetch after); e2e stock spec on card + detail                                                                                                                   |
| 3   | Filters, sorting, search, pagination depth, scroll restored across all four mechanisms           | **PASS** | URL: `?brand`/`?search`/`?page` tests + e2e reload. Cache retention: fake-timer eviction tests. Accumulated pages: warm remount = 3 pages, 0 requests. Scroll: 777 px restored after detail (lifecycle probe), plus e2e round trip **on the virtualized path** (≥1000 px offset, 0 extra requests) |
| 4   | Grid DOM bounded during extended scrolling, stable anchoring, focus retention                    | **PASS** | §4 table (372 products → ≤28 cards, ≤466 nodes); reserved-height viewport keeps `scrollHeight` constant (unit test + probe scrollY stability); keyboard E2E: 60 Tab presses never leave the grid, focus survives a resize                                                                          |
| 5   | No duplicate requests or stale responses overwriting newer results                               | **PASS** | `StorefrontPage.test.jsx`: duplicate-fire guard, stale page-2 response after a filter change never renders; probe request counts (1 page load = 1 request, 2 pages = 2, Back = 0); e2e detail round trip asserts an unchanged list-request count                                                   |
| 6   | Responsive multi-column virtualization works after resizing without breaking keyboard navigation | **PASS** | e2e: columns 4→2 measured after resize, DOM still bounded (≤24), 0 px overflow, focus retained and Tab continues; unit tests for column/stride changes. See limitation L3 about the intentional page scroll-to-focus after a reflow                                                                |
| 7   | Auth, admin and backend contracts unaffected                                                     | **PASS** | server suite 269/269, `api-audit` 56/56, `browser-audit` 15/15 (admin flows incl. login/password rotation/CRUD); no server file, route, response shape or `package.json` changed; admin list write-back only consumes the existing public fields                                                   |
| 8   | All executed tests and builds have verifiable results                                            | **PASS** | §3 command table with exact counts; artefacts in `audit/`, `/tmp` logs retained for this session                                                                                                                                                                                                   |

Nothing in this round is reported as PASS on code inspection alone: every verdict
above names a command or artefact that was executed.

## 7. Limitations and unverified edges

- **L1 — Cross-browser:** all runtime verification is Chromium (Playwright). No
  Firefox/WebKit run, so `getComputedStyle` grid-track reading and `ResizeObserver`
  timing are unverified there.
- **L2 — Large-catalogue payloads are test doubles.** The 240/480-product
  catalogues used by the E2E and the DOM-budget audit are served by request
  interception with the backend's own pagination contract; the seeded backend has
  20 products, so the windowed path has never run against a real >60-product
  database. The application itself has no mock path (the threshold guarantees it).
- **L3 — Resize with a focused off-screen card** intentionally scrolls the page to
  the focused row (that is what prevents focus loss). If a user resizes while
  focus sits far from the viewport, the page moves to that card rather than staying
  put. Deliberate, covered by the e2e test, but it is a behaviour change worth
  knowing.
- **L4 — Find-in-page and printing only cover mounted rows above the threshold** —
  the accepted trade-off of the threshold decision; below 60 products they cover
  the whole list.
- **L5 — 900 s retention** remains unit-verified (fake timers), not waited out live;
  the probe uses a 135 s window.
- **L6 — Cursor monotonicity:** depth replay still relies on `nextCursor` advancing;
  a backend cursor cycle would be stopped by `MAX_LISTING_DEPTH` (20), not by cycle
  detection.
- **L7 — Not measured:** scroll _velocity_ / frame timing (no `requestAnimationFrame`
  profiling was done), so no performance number beyond DOM node counts is claimed.
