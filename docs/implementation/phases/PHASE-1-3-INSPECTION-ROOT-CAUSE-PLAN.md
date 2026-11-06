# Phases 1–3 — inspection, root cause, implementation plan

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

Status: **inspection and planning only.** No source file has been modified in this
round. Nothing in this document is reported as implemented.

---

## Phase 1 — Codebase inspection (read-only)

### 1.1 Stack and structure (verified by reading `package.json`, `client/package.json`)

| Area            | Fact                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| Client deps     | `react`, `react-dom`, `react-redux`, `react-router`, `@reduxjs/toolkit` — **no virtualization or scroll library** |
| Client dev deps | vite, vitest, jsdom, @testing-library/{react,user-event,jest-dom}, @vitejs/plugin-react                           |
| Root dev deps   | eslint, prettier, @playwright/test                                                                                |
| Build           | Vite 8 (Rolldown), `vite preview` serving `client/dist`                                                           |
| Tests           | Vitest, 22 client files / 262 tests; server 269; Playwright 27 specs                                              |

### 1.2 Listing pipeline (files inspected)

| File                                                                 | Role                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client/src/pages/StorefrontPage.jsx`                                | listing page: filter/sort/search orchestration, cursor derivation (`filterArgs` → `selectCachedListCursor` → `pendingCursor`), depth replay, `?page=` sync, scroll restoration, observer wiring, skeleton/empty/error states                                                                                       |
| `client/src/components/ProductGrid.jsx`                              | **renders every product unconditionally** (`products.map`), plus `ProductGridSkeleton`                                                                                                                                                                                                                             |
| `client/src/components/ProductCard.jsx`                              | `memo`ised `article`; three links per card (media link `tabIndex={-1}`, title link, "Details" link) → **2 tabbable controls per card**                                                                                                                                                                             |
| `client/src/components/{StockBadge,FilterSidebar,FilterFacet}.jsx`   | stock badge (public fields only), drawer-capable filter facet buttons                                                                                                                                                                                                                                              |
| `client/src/hooks/useInfiniteScroll.js`                              | `IntersectionObserver` sentinel, `rootMargin: 200px 0px`, observer created once per node, callbacks read through refs                                                                                                                                                                                              |
| `client/src/hooks/useListingDepth.js`                                | `?page=N`, clamp 1–20, `replace: true`, never touches filter params                                                                                                                                                                                                                                                |
| `client/src/hooks/useScrollRestoration.js`                           | `sessionStorage` offset keyed by filter set; `history.scrollRestoration = 'manual'`; retries over frames; ignores writes after the route changed                                                                                                                                                                   |
| `client/src/hooks/useUrlSyncedFilters.js`                            | Redux ⇄ `URLSearchParams` sync (filters/sort/search), exports `buildSearchParams`                                                                                                                                                                                                                                  |
| `client/src/api/apiSlice.js`                                         | `getStorefrontProducts` (`serializeQueryArgs` strips cursor, `merge` accumulates + records `cursors[]`/`pageCount`, `keepUnusedDataFor: 900`, cursor-driven `forceRefetch`), `getProduct` (`onQueryStarted` write-back, detail revalidation at the call site), `patchCachedProductLists`, `selectCachedListCursor` |
| `client/src/pages/ProductDetailPage.jsx`                             | detail, subscribes with `refetchOnMountOrArgChange: DETAIL_REVALIDATE_SECONDS`                                                                                                                                                                                                                                     |
| `client/src/features/pagination/paginationSlice.js`                  | admin page/limit only (storefront cursor removed in the previous round)                                                                                                                                                                                                                                            |
| `client/src/styles/components.css`                                   | `.product-grid { grid-template-columns: repeat(auto-fill, minmax(min(220px,100%),1fr)); gap: var(--space-4) }`, phone override `repeat(2, minmax(0,1fr))`, `.product-card__media { aspect-ratio: 4/3 }`                                                                                                            |
| `e2e/storefront.spec.js`, `client/src/pages/StorefrontPage.test.jsx` | existing suites — several assertions assume **every** product is in the DOM (`.product-card` count = 12/20, `.nth(6)`); these will need to become "bounded DOM + item reachable" assertions                                                                                                                        |
| `audit/responsive-audit.mjs`, `audit/lifecycle-probe.mjs`            | measurement harnesses reused later for verification                                                                                                                                                                                                                                                                |

### 1.3 Measured DOM budget of the current grid (runtime, production build)

Probe: real API + `vite preview`, 20-product seed, 12 per page, script scrolled to
the end at three viewports (`/tmp` scratch script, not added to the repo).

| Viewport   | Columns | Card height (distinct values) | Grid nodes / document nodes @12 cards | @20 cards     | Tabbable controls |
| ---------- | ------- | ----------------------------- | ------------------------------------- | ------------- | ----------------- |
| 390 × 844  | 2       | 288 (single value)            | 158 / 210                             | **263 / 314** | 24 → 40           |
| 768 × 1024 | 3       | 352 (single value)            | 158 / 210                             | **263 / 314** | 24 → 40           |
| 1280 × 800 | 4       | 346 (single value)            | 158 / 258                             | **263 / 362** | 24 → 40           |

Two facts that drive the design:

1. **DOM grows linearly with pages loaded** — ≈ 13 nodes and 2 tab stops per card,
   no upper bound. Infinite scroll in a large catalogue would keep every product
   mounted forever.
2. **Card height is uniform per breakpoint** (one distinct value at each size,
   because the media frame is `aspect-ratio: 4/3` and the title is line-clamped).
   Row heights are only a function of container width ⇒ **row-based windowing is
   viable without per-item measurement**, and no height cache is needed.

### 1.4 What already satisfies the brief (verified in earlier rounds, not re-done)

- Cart removal — there is no cart state; the dead "Add to cart" button and checkout
  copy were removed from `ProductDetailPage.jsx`.
- Stock — the server is authoritative (`LOW_STOCK_THRESHOLD = 5`), payload exposes
  `stock` + `stockStatus`, and `describeStock()` renders `In stock · N available`
  (detail) / `N in stock` (card) / `Low stock · N left` / `Out of stock` /
  `Stock unavailable`. No client-side threshold invention.
- Responsive audit — 4 viewports, 0 px overflow, 0 small tap targets, drawer at
  ≤ 900 px, a11y probes clean (measured with `audit/responsive-audit.mjs`).
- Cache/restoration root cause — proven with `audit/lifecycle-probe.mjs` and fixed
  (see Phase 2).

---

## Phase 2 — Root cause report

### 2.1 Confirmed issues (with evidence, all fixed in the previous round)

| #   | Issue                                                                                                                                                                                                                      | Responsible code                                                                                                        | Evidence                                                                                                          | Status                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| C1  | Cursor and the pages it addressed had **different lifetimes** (cursor in Redux, pages in an RTK entry expiring after `keepUnusedDataFor`) → after eviction the cursor fetched page 2 into an empty cache: 20 cards → **8** | old `paginationSlice` storefront cursor + `StorefrontPage` cursor selectors; `apiSlice.getStorefrontProducts` retention | lifecycle probe: "after Back past the cache window" = 8 cards / 1 request _before_, 20 cards / 0 requests _after_ | Fixed                                                                                             |
| C2  | Request guard `nextCursor !== lastRequestedCursor` made a cursor **unrequestable a second time**, so a replayed depth could never be fetched                                                                               | old `StorefrontPage` + slice                                                                                            | code inspection + probe (no replay happened even when depth demanded it)                                          | Fixed (replaced by per-render `inFlightCursor` + `isFetching`)                                    |
| C3  | `?page=` was written **after** returning from a detail page, not at navigation time → URL did not describe the list                                                                                                        | old `StorefrontPage` mount effect                                                                                       | probe: depth not in URL at Back time                                                                              | Fixed (depth mirrored whenever the rendered depth changes)                                        |
| C4  | Scroll offset was **clobbered by the route change** (shorter detail document clamps scroll to 0, the passive cleanup runs after paint, the clamped value overwrote the remembered one: 777 → 0/473)                        | `useScrollRestoration`                                                                                                  | probe `savedScroll` before/after; browser playwright log of `scrollTo` calls                                      | Fixed (URL check before persisting, settle window, `scrollRestoration = 'manual'`, frame retries) |
| C5  | Per-endpoint `refetchOnMountOrArgChange` is **silently ignored** by RTK Query (only api-level or per-subscription) → the detail page was never revalidated                                                                 | `apiSlice.getProduct` definition                                                                                        | read of RTK Query source (`isForcedQuery` → `selectConfig(state).refetchOnMountOrArgChange`) + remount test       | Fixed (threshold passed at the call site)                                                         |
| C6  | Single-page lists reported `loadedPages = 0` (RTK writes a first page into an empty entry **without** calling `merge`)                                                                                                     | `StorefrontPage` depth derivation                                                                                       | unit test of `merge` semantics                                                                                    | Fixed (`pageCount ?? 1`)                                                                          |

### 2.2 What is **not** the cause (stated so it is not "fixed" by accident)

- **`merge` is not a duplicate source.** It dedupes by `product.id` on every
  append (`apiSlice.js:128`), and the listing has a regression test for two
  overlapping pages. Removing or neutering `merge` would break accumulation
  entirely and would be the wrong response to the brief's "remove the specific
  cache merging behaviour" instruction. The behaviour that _was_ wrong is C1 —
  position stored outside the cache — and it is already gone.
- **Cache retention alone was not enough.** Warm back-navigation already cost 0
  requests before any change; the failure needed eviction _plus_ the split
  ownership of C1/C2.
- **`ProductGrid` unmounting on the detail route is not a bug.** It is expected
  React behaviour; the fix belongs in restoration (cache depth + URL + scroll),
  not in keeping the grid mounted.

### 2.3 Potential risks still present (not defects today; to be addressed or documented in Phase 4)

| #   | Risk                                                                                                                                   | Where                         | Planned handling                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| R1  | A page-1 refetch while pages 2..n are cached **replaces** the accumulated list (`merge` with no cursor truncates)                      | `apiSlice.js:128`             | Keep, but assert it with a test; only reachable via an explicit invalidation       |
| R2  | `serializeQueryArgs` key is `JSON.stringify(filters)` — depends on stable key order from `filterArgs`                                  | `apiSlice.js:124`             | Already a single construction site; will add an assertion test                     |
| R3  | Depth replay assumes monotonic cursors; a cursor cycle would stop only when `nextCursor` becomes null                                  | `StorefrontPage` depth effect | Documented limitation (`MAX_LISTING_DEPTH` caps the blast radius at 20)            |
| R4  | **Unbounded DOM**: every loaded product stays mounted (Phase 1 §1.3)                                                                   | `ProductGrid.jsx`             | This round's implementation                                                        |
| R5  | `products.map` re-renders the whole grid on every page append (memoised cards limit the cost, but reconciliation still walks all rows) | `ProductGrid.jsx`             | Solved by windowing                                                                |
| R6  | Virtualization can unmount the focused card → focus loss, tab order break                                                              | new                           | Focus pinning + window growth on `focusin` + `aria-setsize`/`aria-posinset`        |
| R7  | Virtualization must not fight the infinite-scroll sentinel or scroll restoration                                                       | new + `useInfiniteScroll`     | Reserved-height container keeps document geometry stable; scroll restore unchanged |

---

## Phase 3 — Implementation plan

### 3.1 Architecture: four restoration mechanisms, kept independent

| Mechanism                        | Owner                                                                                             | Restores                                                                         | Never does                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| **URL state**                    | `useUrlSyncedFilters` (filters, sort, search) + `useListingDepth` (`?page=N`, clamp 20)           | the shopper's _intent_; survives reload, deep link, shared link                  | holds product data or cursors   |
| **RTK cache retention**          | `apiSlice` (`keepUnusedDataFor: 900` on the list, 60 s default elsewhere, tag-based invalidation) | the pages already fetched                                                        | drives UI state                 |
| **Accumulated page restoration** | `merge` (`cursors[]`, `pageCount`) + `selectCachedListCursor` + depth replay                      | depth ≤ cache without a request; depth > cache by replaying one page per request | re-fetches pages it already has |
| **Scroll restoration**           | `useScrollRestoration` (`sessionStorage`, keyed by filter set)                                    | the viewport offset once the depth is on screen                                  | triggers a request              |

Data freshness stays separate: `providesTags`/`invalidatesTags`, the detail→list
write-back, and the 15 s detail revalidation. None of them touch URL state; none
of the restoration code refetches anything.

### 3.2 Virtualization design (multi-column, row-windowed)

```
<div class="product-grid-viewport" style="height: rows*stride + trailing gap">
  <div class="product-grid" style="transform: translate3d(0, startRow*stride, 0)">
    …only the rows in [startRow - overscan, endRow + overscan]…
  </div>
</div>
```

- **Columns** are read from the existing CSS (`auto-fill` / phone override) via
  `getComputedStyle(grid).gridTemplateColumns`, so CSS stays the single source of
  truth and no JS breakpoint table can drift from it.
- **Row stride** = measured card height + row gap of the first rendered card
  (`ResizeObserver` on the grid + a `window` resize listener), not a hard-coded
  number; uniform heights (Phase 1 §1.3) make a single measurement sufficient.
- **Window** = `scrollY` vs container top, rAF-throttled; `overscan` rows above and
  below (default 2). DOM is bounded at ≈ (viewport rows + 2×overscan) × columns:
  laptop 1280 → ≈ 7 rows × 4 = 28 cards (~364 nodes) regardless of catalogue size;
  phone → ≈ 7 × 2 = 14 cards.
- **Stable identity**: `key={product.id}`, and rendered items are a contiguous slice,
  so appending, reordering or refreshing does not remount neighbours; a product
  leaving the window is unmounted by design (bounded DOM), a product entering it
  mounts once.
- **Scroll anchoring**: the container keeps the _full_ height at all times, so the
  document height never changes when rows mount/unmount; no manual offset
  correction is required, and the infinite-scroll sentinel keeps its position.
- **Focus management**: `focusin` inside the grid pins the focused row into the
  window (it is never unmounted); if focus sits within `overscan` of a window edge,
  the window grows by one row in that direction so `Tab`/`Shift+Tab` continues
  through the list instead of dropping to `<body>`.
- **a11y**: each card keeps its `article` semantics plus `aria-setsize` (total
  products) and `aria-posinset` (1-based position) so screen readers announce
  "7 of 43" even though only part of the list is mounted; the grid exposes
  `aria-busy` while a page is in flight. No `tabindex` shim, no
  `aria-hidden` on real content.
- **Resize**: column count changes → new stride and window are recomputed from the
  same measurement path; the first visible item index is preserved so the shopper
  does not jump (asserted in Phase 5).

### 3.3 Files to be modified (Phase 4, not yet touched)

| File                                         | Change                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `client/src/hooks/useVirtualGrid.js`         | **new** — windowing hook: columns, stride, window range, focus pinning, `ResizeObserver` + scroll subscription     |
| `client/src/components/ProductGrid.jsx`      | render the windowed slice inside a reserved-height container; keep `ProductGridSkeleton` unchanged                 |
| `client/src/styles/components.css`           | `.product-grid-viewport` (relative, reserved height) + absolutely positioned inner grid; no change to card visuals |
| `client/src/pages/StorefrontPage.jsx`        | pass `totalCount` for `aria-setsize`; no restoration logic changes                                                 |
| `client/src/hooks/useVirtualGrid.test.jsx`   | **new** — windowing math, resize, focus pinning                                                                    |
| `client/src/components/ProductGrid.test.jsx` | **new** — bounded DOM, `aria-setsize`/`posinset`, identity stability                                               |
| `client/src/pages/StorefrontPage.test.jsx`   | adapt assertions that assume all cards are mounted                                                                 |
| `e2e/storefront.spec.js`                     | adapt card-count assertions to "bounded DOM + every product reachable"; add tab-through-window spec                |
| `audit/dom-budget-audit.mjs`                 | **new** — records node counts while scrolling before/after, viewport resize, focus retention                       |

### 3.4 Trade-offs considered

| Decision                              | Alternative                                          | Why this way                                                                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Row windowing with **uniform stride** | per-item dynamic measurement (variable height cache) | Measured heights are uniform per breakpoint (`aspect-ratio` + line clamp); dynamic measurement would add a height cache, estimation drift and scroll-anchoring bugs for no benefit                                                      |
| **Hand-rolled** ~150-line hook        | `@tanstack/react-virtual`, `react-window`            | Standing constraint: no unnecessary dependencies; the grid is a fixed-ratio 2-D grid, so a virtualizer still leaves row/cell layout to us. A library would add ~10–15 kB and a second abstraction over CSS that already decides columns |
| Columns from **CSS measurement**      | JS breakpoint table                                  | One source of truth; the responsive audit already asserts the CSS column counts                                                                                                                                                         |
| **Always** virtualize                 | threshold (e.g. only > 30 items)                     | One code path, one set of tests; a threshold adds a second behaviour that must itself be tested and can differ subtly from the windowed path                                                                                            |
| Keep `merge`                          | remove it on suspicion                               | It is the dedupe; C1 (the real defect) is already fixed and `merge` has regression coverage (Phase 2 §2.2)                                                                                                                              |

### 3.5 Risks and mitigations for Phase 4

| Risk                                              | Mitigation                                                                                                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus lost when a focused card leaves the window  | pin the focused row; grow the window at edges; E2E tab-through test                                                                                                                           |
| `scrollTo` / restoration fighting the virtualizer | container height is static, so `document.scrollHeight` never changes; scroll restore runs after depth is painted, exactly as today (no change to that code)                                   |
| jsdom has no layout                               | hook unit tests inject explicit geometry (container height, scroll offset) instead of relying on layout; real geometry verified in Chromium via the DOM-budget audit and the responsive audit |
| Column/stride drift on resize                     | both derived from one measurement function, asserted in an E2E resize spec                                                                                                                    |
| Existing tests assuming full DOM                  | rewritten to assert boundedness **and** reachability (scroll to item, assert visible), not weakened                                                                                           |

### 3.6 Test plan (Phase 5)

1. Unit: windowing math (window bounds, overscan, first/last row, empty and
   single-item lists), resize recomputation, focus pinning, bounded node count.
2. Component: `aria-setsize`/`aria-posinset`, stable keys on append, no duplicate
   ids in DOM.
3. Integration (`StorefrontPage.test.jsx`): append page 2 → only the window is in
   the DOM, all products reachable; depth replay and `?page=` still pass.
4. E2E: extended scroll keeps DOM bounded; resize 390 → 1280 → 390 keeps the
   current item in view; keyboard Tab traverses the whole list across window
   boundaries; back-navigation still restores depth + scroll with 0 requests.
5. Full gates: `npm run verify`, `npm run test:e2e`, `audit/lifecycle-probe.mjs`,
   `audit/responsive-audit.mjs`, new `audit/dom-budget-audit.mjs`.

### 3.7 Open decision (blocks Phase 4)

Virtualization vehicle: hand-rolled hook (no dependency, recommended) vs
`@tanstack/react-virtual` (mature, +~12 kB). The standing instruction "avoid
unnecessary dependencies" points at the hand-rolled hook; the brief's
"prefer clean maintainable solutions over heavy libraries" reads the same way, but
adding a well-tested virtualizer is a legitimate engineering choice that should be
the user's call rather than an assumption.
