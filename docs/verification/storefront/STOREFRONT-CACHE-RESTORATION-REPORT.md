# Storefront cache & state-restoration overhaul — report

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

Scope: the deep-architecture round requested in §4 of the brief — proving the
root cause of "freshness vs pagination reset" before changing anything, then
separating **data freshness** from **UI state restoration**, and keeping
infinite scroll, filters, sort and search consistent across navigation.

Round 1 (cart removal, responsive/UI/UX audit, stock display) is unchanged and
documented in `STOREFRONT-UI-UX-REPORT.md`. This report covers only the work on
top of it. Every number below was measured after the final edit; commands are in
§4.

---

## 1. Summary of architectural and UI changes

### 1.1 The root cause, proven rather than assumed (§4A)

Before touching logic, `audit/lifecycle-probe.mjs` was written to observe what
actually happens across a detail-page round trip. It spawns the real API and a
production build, records every `/api/v1/products` request, the card count,
`scrollY` and the remembered offset at each step.

Findings on the **previous** build:

1. `ProductList`/`ProductGrid` **does unmount** when the detail route renders
   (0 cards on the detail page). So this was not a stale-DOM problem.
2. Warm back-navigation already restored depth and scroll with **0** requests.
   A plain "remount loses state" explanation is therefore wrong.
3. The failure appeared only **after the cache retention window**: 20 cards
   became **8**, and **1 request** was made. That request carried the _stored
   cursor_ — page 2 — into an **empty** cache, so the shopper received page 2 of
   the catalogue as if it were the whole list.
4. The request guard `nextCursor !== lastRequestedCursor` lived in Redux and
   **could never allow the same cursor to be requested twice**, so a replayed
   pagination depth was structurally impossible even when it was needed.
5. `?page=` was written _after_ returning from the detail page, when the page was
   mounted with a depth of 1 — it did not describe the list at navigation time.

**Exact root cause:** the cursor lived in Redux while the pages it addressed
lived in an RTK Query entry that is discarded after `keepUnusedDataFor`. Two
lifetimes, one position. Once the entry was evicted, the surviving cursor
pointed into nothing, and `merge` appended page 2 to an empty array. Long-lived
detail pages (a couple of minutes) were enough to trigger it. Caching was
involved, but "caching alone" was not the cause — the cause was the _split
ownership_ of pagination position and paginated data.

### 1.2 Fixes

**One lifetime for position and data.** The cursor is no longer stored in Redux
at all. `merge` records the cursors it has consumed (`cursors[]`) and derives
`pageCount`; `selectCachedListCursor` reads the deepest cursor straight out of
the cache entry **before the query hook runs**, so a remount resumes on its first
render instead of fetching page one. No pages ⇒ no cursor, by construction.
`paginationSlice` now holds admin page numbers only.

**Retention matched to the cost of rebuilding.** The storefront list sets
`keepUnusedDataFor: 900`; every other entry keeps the default 60 s. Caching is
never globally disabled.

**Freshness without extra requests.** `getProduct`'s `onQueryStarted` writes the
fresher product into every cached listing that contains it
(`patchCachedProductLists` → `selectInvalidatedBy` + `updateQueryData`, covering
storefront and admin lists). Stock/price on the grid are therefore correct after
a detail visit with **zero** additional list requests. The detail document itself
is revalidated on re-entry after 15 s. Note: RTK Query only honours
`refetchOnMountOrArgChange` **per subscription** (or api-wide) — a per-endpoint
value is silently ignored — so the threshold is passed at the call site
(`ProductDetailPage`) rather than declared in the endpoint definition.

**Depth in the URL.** `useListingDepth` mirrors how many pages are loaded as
`?page=N` (clamped 1–20, `replace: true`, never touching filter params).
`StorefrontPage` replays that depth **only when the cache cannot satisfy it**, one
page per request, and corrects a URL that asks for more pages than the catalogue
has (no fetch storm, no loop). The cursor itself never goes into the URL.

**Filters, sort, search unchanged in behaviour** — still URL-owned via
`useUrlSyncedFilters`, which already survived reload and back-navigation. The new
depth parameter is additive and independent, so the two never fight over
`URLSearchParams`.

**Scroll restoration as pure UI state.** `useScrollRestoration` saves the offset
in `sessionStorage`, keyed by the filter set (path + query **without** `page`), so
appending a page never re-scrolls and changing filters starts at the top. It
restores exactly once, only after the requested depth is on screen, and never
issues a request.

Three browser-fighting details were found and fixed while verifying (§3.4):

- the offset was being overwritten by the position the browser assigns **while
  leaving** (the shorter detail document clamps the scroll to 0/473) — writes are
  now ignored when the URL no longer matches the listing;
- offsets observed before the target depth is painted are not persisted at all;
- `history.scrollRestoration` is set to `manual` while a listing is mounted, and
  the restore is retried over a few frames because the document can still be
  shorter than the remembered offset right after a route swap.

**Race guard.** The observer fires only when a next page exists and nothing is in
flight; `inFlightCursor` blocks a duplicate request for the same cursor while
`isFetching` is true; responses for a superseded filter set land in their own
cache entry (the cursor is excluded from the cache key, the filters are not), and
`listData = currentData ?? data` keeps a stale response from replacing newer
results.

### 1.3 What deliberately did **not** change

No new dependency, no route change, no API/response-shape change, no backend or
database change, no global cache disabling, no refetch-on-mount of the list. Admin
pagination, auth and admin screens are untouched apart from the shared write-back
helper that now also refreshes cached admin lists.

---

## 2. Modified files

| Path                                                     | Change                                                                                                                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client/src/api/apiSlice.js`                             | `merge` records `cursors[]` + `pageCount`; list `keepUnusedDataFor: 900`; `selectCachedListCursor`; `patchCachedProductLists`; `DETAIL_REVALIDATE_SECONDS` + `onQueryStarted` write-back on `getProduct` |
| `client/src/api/apiSlice.test.js`                        | **new** — 9 cache-contract tests (§4)                                                                                                                                                                    |
| `client/src/hooks/useListingDepth.js`                    | **new** — `?page=N` depth in the URL                                                                                                                                                                     |
| `client/src/hooks/useScrollRestoration.js`               | **new** — sessionStorage offset restore                                                                                                                                                                  |
| `client/src/hooks/useScrollRestoration.test.jsx`         | **new** — 5 restoration tests                                                                                                                                                                            |
| `client/src/pages/StorefrontPage.jsx`                    | derived cursor, depth replay, `?page=` sync, scroll key, `currentData` guard; Redux cursor plumbing removed                                                                                              |
| `client/src/pages/StorefrontPage.test.jsx`               | **new suite** "pagination depth and scroll restoration" (7 tests)                                                                                                                                        |
| `client/src/pages/ProductDetailPage.jsx`                 | detail subscribes with the 15 s revalidation threshold                                                                                                                                                   |
| `client/src/features/pagination/paginationSlice.js`      | storefront cursor state removed (admin page/limit kept)                                                                                                                                                  |
| `client/src/features/pagination/paginationSlice.test.js` | updated to the trimmed slice                                                                                                                                                                             |
| `e2e/storefront.spec.js`                                 | **new suite** "listing state restoration" (3 specs); one facet test made deterministic                                                                                                                   |
| `audit/lifecycle-probe.mjs`                              | **new** harness (§3) — request/card/scroll log per navigation step, plus a cold-cache reload step                                                                                                        |
| `audit/lifecycle-probe.json`                             | **new** artefact from the run below                                                                                                                                                                      |
| `.prettierignore`                                        | ignores the generated probe JSON                                                                                                                                                                         |

Unchanged public surfaces: `ProductCard`, `ProductGrid`, `FilterSidebar`,
`FilterFacet`, `StockBadge`, routing wrappers, server code, `package.json`.

---

## 3. Evidence

### 3.1 Lifecycle probe — before vs after (same script, 135 s retention window)

| Step                                       | Before: cards / scrollY / requests | After: cards / scrollY / requests                  |
| ------------------------------------------ | ---------------------------------- | -------------------------------------------------- |
| initial load                               | 12 / 0 / 1                         | 12 / 0 / 1                                         |
| after scrolling (2 pages)                  | 20 / 777 / 2                       | 20 / 777 / 2                                       |
| on product detail                          | 0 / 0 / –                          | 0 / 0 / –                                          |
| after browser Back                         | 20 / 1501 / 0                      | 20 / 777 / 0                                       |
| after in-app "Back to results"             | 20 / 1501 / 0                      | 20 / 777 / 0                                       |
| **after Back past the 135 s cache window** | **8 / 267 / 1**                    | **20 / 777 / 0**                                   |
| cold reload of `/?page=2` (no cache)       | —                                  | **20 / 777 / 2** (page 1, then exactly one cursor) |

Console errors during the whole probe: **0**. The remembered offset survives the
detail visit (`savedScroll` stays `777`; previously it was clobbered to `0`/`473`
by the route-change clamp).

### 3.2 Test suite additions

- Cache contract (9): page accumulation, `cursors`/`pageCount`, a retried cursor
  not counting as a new page, cache-parked cursor resolution, write-back into
  cached pages, detail fetch refreshing the listing with **no** extra list
  request, 15-minute retention of the paged list, default 60 s eviction for other
  entries, and detail revalidation before/after the threshold.
- Listing (7): cold-start depth replay (one request per page), warm remount
  restoring 3 pages and `?page=2` with **0** requests, URL depth correction when
  the catalogue is shallower than `?page=`, page-param reset on filter change,
  scroll restore once the depth is painted (no request), skip when the offset is
  unreachable, and a superseded page-two response never rendering after a filter
  change.
- Scroll hook (5): no saved offset, restore after `ready`, unreachable offset
  skipped, leaving-position never persisted, normal persistence on the listing.
- E2E (3): reload restores depth from the URL; returning from a product keeps 20
  cards, the scroll offset and the request count; browser Back costs 0 requests.

Mutation check (teeth, not just green): disabling the depth-replay effect makes 3
of the new tests fail; they are not vacuous.

### 3.3 Responsive / a11y / API / runtime audits (unchanged build behaviour)

Measured after this round's changes, 4 viewports:

| Viewport     | Columns (expected) | Card      | Overflow | Min tap | A11y                                        |
| ------------ | ------------------ | --------- | -------- | ------- | ------------------------------------------- |
| mobile-390   | 2 (2)              | 175 × 288 | 0 px     | 40 px   | 0 unnamed controls, 0 missing alt, 1 `<h1>` |
| tablet-768   | 3 (3)              | 229 × 352 | 0 px     | 42 px   | clean                                       |
| laptop-1280  | 4 (4)              | 221 × 346 | 0 px     | 40 px   | clean                                       |
| desktop-1680 | 4 (4)              | 221 × 346 | 0 px     | 40 px   | clean                                       |

Drawer at 390 px: 340 px wide, backdrop + scroll lock + sticky footer, 0 overflow.
Detail page: `In stock · 33 available`, no cart control, images 4:3 undistorted.

### 3.4 Defects found and fixed during verification

1. **Scroll offset clobbered on the way out.** A route change shrinks the
   document; the clamp-to-0 scroll event reaches the still-attached listener
   (passive cleanup runs after paint) and the old code saved `0` over `777`.
   Fixed by ignoring writes when `location.pathname` no longer matches the key.
2. **Not-ready phase was treated as settled**, so the same clobbering could
   happen before the target depth had painted.
3. **`refetchOnMountOrArgChange` per endpoint is ignored by RTK Query** — it only
   reads the api-level config or the per-subscription option. Moved to the call
   site after reading the library source; a per-endpoint declaration would have
   looked correct and done nothing.
4. **`loadedPages` reported 0 for a single-page list** (RTK writes a first page
   into an empty entry without calling `merge`), so depth was mis-derived until a
   second page landed.

---

## 4. Commands executed

| Command                                                                | Result                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify` (lint → format → client tests → server tests → build) | **exit 0** — ESLint **0 errors / 5 warnings** (all pre-existing `react-hooks` advisories in untouched admin/modal/hook files), Prettier clean, client **262 passed / 22 files**, server **269 passed / 20 files**, build ✓ |
| `npm run test:e2e` (Playwright, production build)                      | **27 passed, 0 failed** (38.9 s)                                                                                                                                                                                           |
| `node audit/lifecycle-probe.mjs 135000`                                | probe completed, `audit/lifecycle-probe.json` — table §3.1, 0 console errors                                                                                                                                               |
| `node audit/responsive-audit.mjs`                                      | 4/4 viewports match expected columns, 0 px overflow, 0 small tap targets, a11y clean                                                                                                                                       |
| `node audit/browser-audit.mjs`                                         | **15 passed, 0 failed**                                                                                                                                                                                                    |
| `node audit/api-audit.mjs`                                             | **56 passed, 0 failed**                                                                                                                                                                                                    |
| `node audit/runtime-audit.mjs`                                         | **9 passed, 0 failed**                                                                                                                                                                                                     |

Test totals across the round: client 262 (was 244 before this round; +18 net after
removing the 3 obsolete storefront-cursor slice tests), server 269, E2E 27 (was
24), audits 56 + 15 + 9 + 4 viewports.

## 5. Production build

`vite build` (Vite 8 / Rolldown) — ✓ **389 ms**.

```
dist/index.html                     0.93 kB │ gzip:  0.48 kB
dist/assets/index-yRIkwxX9.css     26.23 kB │ gzip:  5.78 kB
dist/assets/index-CMPaA8Fu.js      81.44 kB │ gzip: 21.68 kB
dist/assets/redux-CBO0vs_2.js      86.24 kB │ gzip: 28.93 kB
dist/assets/vendor-ZEA1hnRG.js    307.12 kB │ gzip: 96.71 kB
```

Storefront entry grew 78.75 kB → 81.44 kB (+2.69 kB raw, +0.25 kB gzip) for the
restoration logic. Zero runtime console errors in the probe, the E2E run and all
audits.

## 6. Dependencies

**Added: none. Removed: none.** `package.json` is untouched. Restoration uses
`URLSearchParams`, `sessionStorage`, `IntersectionObserver` and `history` — all
platform APIs; no state library or scroll library was introduced.

## 7. Limitations and unverified edge cases

- **The 900 s retention is verified by unit test, not end-to-end.** The probe runs
  a 135 s window (post-eviction under the _old_ 60 s default, well inside the new
  900 s one). A 15-minute live wait was not run; the eviction boundary itself is
  asserted in `apiSlice.test.js` with fake timers (present at 120 s, gone at
  910 s).
- **Cold-start depth replay costs requests by design** — one per replayed page —
  because those pages genuinely are not in memory. Only the warm path is
  request-free.
- Depth is capped at 20 pages (`MAX_LISTING_DEPTH`), so a hand-edited
  `?page=999` cannot trigger a fetch storm; catalogues deeper than 20 pages ×
  page size cannot be fully restored from the URL alone.
- Scroll restoration is skipped when the remembered offset exceeds the rendered
  document (e.g. a shorter result set); the shopper lands at the top of the
  restored list instead of at a clamped mid-page position.
- **jsdom has no layout**, so the unit tests stub `scrollHeight`/`innerHeight` and
  `scrollTo`; real geometry is only exercised in Chromium (E2E + responsive
  audit). Firefox/WebKit were not run.
- `history.scrollRestoration` is browser-observable state; Safari's handling of
  `manual` during bfcache restores is untested here.
- Depth replay assumes monotonic cursors (each `nextCursor` advances); if the
  backend ever returns a cursor cycle the guard stops the loop only via
  `nextCursor` becoming null, not by cycle detection.
- Admin screens were left functionally untouched; the only shared change is that
  a detail fetch may now also patch cached admin lists.
- `loadedPages`/`pageCount` depend on `merge` running; RTK writes a _first_ page
  into an empty entry without calling `merge`, so both the UI and the tests treat
  `pageCount ?? 1` as the depth of a single-page list.
