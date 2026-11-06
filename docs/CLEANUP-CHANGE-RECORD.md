# Documentation consolidation — change record (2026-11-06)

This file is in two parts:

- **Part 1 — execution record**: exactly what was moved, created, edited and _not_ removed,
  plus the findings that surfaced while doing it.
- **Part 2 — the discovery report** that was presented and approved before any change was made.

> **What this cleanup was and was not.** Documentation and repository organisation only.
> **No application functionality, dependency, package file, lockfile, test, CI job, database
> implementation or API contract was changed.** Nothing was committed, pushed, reset or
> rewritten, and there is no Git history in this workspace to rewrite.

---

# Part 1 — Execution record

## 1.1 Approval basis

Approved before execution, with four decisions: move `PHASE-6-REPORT.md` to `docs/database/`
**and** update the single source-code comment that cites it; preserve both older screenshots
under `docs/assets/screenshots/legacy/`; fix the `server/uploads/.gitkeep` ignore rule; preserve
all 20 reports, all current screenshots and all historical evidence. Explicitly out of scope:
application behaviour, dependencies, package files, lockfiles, tests, CI configuration, database
implementation, API contracts, Git history.

## 1.2 Moves — 20 reports (content preserved verbatim)

| From (repository root)                    | To                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `MODERNIZATION.md`                        | `docs/implementation/MODERNIZATION.md`                                 |
| `FINAL-IMPLEMENTATION-REPORT.md`          | `docs/implementation/FINAL-IMPLEMENTATION-REPORT.md`                   |
| `HANDOVER-REPORT.md`                      | `docs/implementation/HANDOVER-REPORT.md`                               |
| `PHASE-0-DISCOVERY-AND-PLAN.md`           | `docs/implementation/phases/PHASE-0-DISCOVERY-AND-PLAN.md`             |
| `PHASE-1-3-INSPECTION-ROOT-CAUSE-PLAN.md` | `docs/implementation/phases/PHASE-1-3-INSPECTION-ROOT-CAUSE-PLAN.md`   |
| `PHASE-1-GATE-REPORT.md`                  | `docs/implementation/phases/PHASE-1-GATE-REPORT.md`                    |
| `PHASE-2-REPORT.md`                       | `docs/implementation/phases/PHASE-2-REPORT.md`                         |
| `PHASE-3-REPORT.md`                       | `docs/implementation/phases/PHASE-3-REPORT.md`                         |
| `PHASE-4-REPORT.md`                       | `docs/implementation/phases/PHASE-4-REPORT.md`                         |
| `PHASE-5-REPORT.md`                       | `docs/implementation/phases/PHASE-5-REPORT.md`                         |
| `PHASE-7-REPORT.md`                       | `docs/implementation/phases/PHASE-7-REPORT.md`                         |
| `PHASE-6-REPORT.md`                       | `docs/database/PHASE-6-REPORT.md`                                      |
| `PHASE-6-MIGRATION-RUNBOOK.md`            | `docs/database/PHASE-6-MIGRATION-RUNBOOK.md`                           |
| `PHASE-7-OPS-RUNBOOK.md`                  | `docs/database/PHASE-7-OPS-RUNBOOK.md`                                 |
| `PROVIDER-DEFAULT-HANDOVER.md`            | `docs/database/provider-default/PROVIDER-DEFAULT-HANDOVER.md`          |
| `PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md`   | `docs/database/provider-default/PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md` |
| `VERIFICATION-REPORT.md`                  | `docs/verification/VERIFICATION-REPORT.md`                             |
| `STOREFRONT-UI-UX-REPORT.md`              | `docs/verification/storefront/STOREFRONT-UI-UX-REPORT.md`              |
| `STOREFRONT-CACHE-RESTORATION-REPORT.md`  | `docs/verification/storefront/STOREFRONT-CACHE-RESTORATION-REPORT.md`  |
| `VIRTUALIZATION-COMPLETION-REPORT.md`     | `docs/verification/storefront/VIRTUALIZATION-COMPLETION-REPORT.md`     |

## 1.3 Moves + renames — 10 screenshots (all preserved, none deleted)

| From                                     | To                                                           | Embedded in README                                    |
| ---------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| `verification-storefront.png`            | `docs/assets/screenshots/storefront-desktop.png`             | yes                                                   |
| `verification-storefront-mobile.png`     | `docs/assets/screenshots/storefront-mobile.png`              | yes                                                   |
| `verification-product-detail.png`        | `docs/assets/screenshots/product-detail.png`                 | yes                                                   |
| `verification-admin-dashboard.png`       | `docs/assets/screenshots/admin-dashboard.png`                | yes                                                   |
| `verification-admin-products.png`        | `docs/assets/screenshots/admin-products.png`                 | yes                                                   |
| `verification-admin-brands.png`          | `docs/assets/screenshots/admin-brands.png`                   | yes                                                   |
| `verification-admin-product-form.png`    | `docs/assets/screenshots/admin-product-form.png`             | yes                                                   |
| `verification-login-flow.png`            | `docs/assets/screenshots/admin-password-rotation.png`        | yes (captioned as administrative auth)                |
| `verification-modernized-login.png`      | `docs/assets/screenshots/legacy/admin-signin.png`            | no — legacy, indexed in `docs/verification/README.md` |
| `verification-modernized-storefront.png` | `docs/assets/screenshots/legacy/storefront-pre-redesign.png` | no — legacy, indexed in `docs/verification/README.md` |

The renamed files are the _same bytes_: only paths and file names changed. The two legacy images
are preserved exactly as approved.

## 1.4 New files (5 documents)

| File                                | Purpose                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/README.md`                    | Documentation index: reading order, per-report summary table, conventions                                                                                                                               |
| `docs/architecture/ARCHITECTURE.md` | Current architecture written from the code: context + sequence + ER diagrams, module layout, request lifecycle, repository pattern, data model, pagination contracts, client state rules, boot order    |
| `docs/database/README.md`           | The provider contract in one page: default MySQL, resolution rules, launchers, unavailability behaviour, MySQL specifics, migrations, seeding, migration tool, test matrix, `MYSQL_*` vs `MYSQL_TEST_*` |
| `docs/implementation/README.md`     | Timeline of the four tracks with per-phase summaries and links; notes the historical provider ordering; lists the two rounds that have no report                                                        |
| `docs/verification/README.md`       | Verification status matrix (executed / skipped / defined-never-run / NOT VERIFIED), reproduction commands, screenshot index and captions, security follow-ups                                           |
| `docs/CLEANUP-CHANGE-RECORD.md`     | This file                                                                                                                                                                                               |

## 1.5 Files edited (3 edits total, all non-functional)

| File                                            | Edit                                                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                     | **Fully rewritten** as the project entry point                                    | Approved requirement: overview, stack by category, dual-DB architecture with Mermaid, features, native PowerShell setup (MySQL and MongoDB paths), testing split into executed / skipped / NOT VERIFIED, limitations, doc links, project status                                                                                                                                                                       |
| `server/src/db/migrate/mongo-to-mysql/index.js` | **One doc comment line**: `PHASE-6-REPORT.md` → `docs/database/PHASE-6-REPORT.md` | The report moved; the citation now resolves. **No code, logic, export or behaviour changed** — the line is inside a `/** */` block comment.                                                                                                                                                                                                                                                                           |
| `.gitignore`                                    | `server/uploads/` → `server/uploads/*` (+ 3 explanatory comment lines)            | Intended to make `!server/uploads/.gitkeep` effective (Git cannot re-include a file inside an excluded directory). **Insufficient as made:** the plain `uploads/` rule also excluded the `server/uploads/` directory, so the placeholder stayed ignored. Completed in the final cleanup round — `uploads/` → `uploads/*` alongside `server/uploads/*` + `!server/uploads/.gitkeep`, verified with `git check-ignore`. |

## 1.6 Historical notes added — 3 files, dated, non-destructive

A blockquote was inserted **directly below the H1** of each file; the original body is untouched:

- `docs/verification/storefront/STOREFRONT-CACHE-RESTORATION-REPORT.md`
- `docs/verification/storefront/VIRTUALIZATION-COMPLETION-REPORT.md`
- `docs/implementation/phases/PHASE-1-3-INSPECTION-ROOT-CAUSE-PLAN.md`

Each note says: the body is preserved as written, nothing was re-run on 2026-11-06, and the
`?page=N` statements describe the code at the time — today the customer URL carries no
pagination parameter, depth is owned by the RTK Query cache, and `stripPagination`
(`client/src/hooks/useListingDepth.js`) removes any `page` that arrives.

No other historical claim was edited. The provider-ordering conflict (MongoDB-first reports vs.
MySQL default) is handled at the index level — `docs/implementation/README.md` §3 and
`docs/database/README.md` §11 — rather than by rewriting six phase reports.

## 1.7 Not removed — and one still awaiting an explicit decision

**No file was deleted.** Every report, screenshot, fixture, harness, test and configuration file
still exists at a documented path.

| Item                                                                                                                                                                                                                                       | Status                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.sudo_as_admin_successful` (0-byte sandbox/OS artifact, not covered by `.gitignore`)                                                                                                                                                      | Left untouched in this round (removal needed an explicit yes). **Deleted in the final cleanup round** after approval — see `FINAL-CLEANUP-PROPOSAL.md`. |
| `server/.env`, `e2e/.auth/admin.json`, `audit/*.json` (incl. one containing a signed token), `audit/responsive/`, `audit/screenshots/{login,storefront-*}.png`, `test-results/`, `server/uploads/products/*.webp`, `node_modules` (absent) | Untouched, still git-ignored. Never commit them.                                                                                                        |
| `audit/screenshots/admin-dashboard.png`                                                                                                                                                                                                    | Untouched. Still **not** covered by any ignore rule, so it would be published; it is a harmless dashboard screenshot, left as-is.                       |
| `e2e/fixtures/product.png`, `audit/api-contract-snapshot.mjs`                                                                                                                                                                              | Untouched — golden fixture and golden contract baseline.                                                                                                |

## 1.8 Findings that surfaced during execution (reported, not fixed)

1. **Unconditional development-credential banner.** `client/src/pages/LoginPage.jsx` renders the
   _"Local development seed: admin@catalogue.com / Admin123!"_ hint with no `import.meta.env.DEV`
   gate, so a production build shows it too. Fixing it changes application behaviour; it needs
   its own approved change. Recorded in `docs/verification/README.md` §5 and in the root
   README's limitations. **Not modified.**
2. **Stale code comment in `server/scripts/setup.mjs`.** Its usage docstring still says
   `# provider from server/.env (default mongodb)`, which the provider-default change made
   wrong (the default is `mysql`). It is a comment in a script, outside the approved edit set,
   so it was **left as-is**. Candidate for a future one-line fix.
3. **Customer registration exists in the API but not in the UI.** `POST /api/v1/auth/register`
   creates a `customer`-role account and `apiSlice.js` defines a `register` mutation that no
   screen uses. The README therefore states precisely: _no customer-facing sign-in UI; the API
   endpoint is groundwork; `/login` is administrative_. This prevents "user-facing login not
   implemented" from being read as a false claim about the API.
4. **`.gitkeep` ignore rule was inert** — fixed (see 1.5). Related and unchanged: adding a rule
   never untracks an already-tracked file; no index exists here to verify, so nothing was
   "un-ignored" retroactively.
5. **Two rounds are undocumented by any report** (storefront URL-state change, admin taxonomy
   refresh). They are described in `docs/implementation/README.md` §5 and marked NOT VERIFIED,
   because no run is recorded for them.

## 1.9 Verification performed on this cleanup

No test suite, lint run or build was executed — there is no `node_modules`, no database server
and no browsers in this workspace, and the only Node available here is v20.20.2 while the project
requires ≥ 22.22. What _was_ verified, mechanically:

| Check                          | Method                                                                                                                                                           | Result                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All 20 reports preserved       | `find docs -name '*.md'` + size comparison against the pre-move inventory recorded in Part 2                                                                     | 25 Markdown files = 20 moved reports + 5 new documents. **17 of the 20 reports are byte-identical in size to before the move**; the other 3 grew only by the inserted historical note (+0.8–0.9 KB)               |
| Historical notes present       | grep for the note header                                                                                                                                         | found in exactly the 3 intended files, nowhere else                                                                                                                                                               |
| All 10 screenshots preserved   | MD5 of each file compared with the hash captured during discovery                                                                                                | **all 10 byte-identical**                                                                                                                                                                                         |
| Relative links and images      | scripted resolution of every Markdown link/image target (and its anchor) against the filesystem, across `README.md` + all 27 files in `docs/`                    | **131 links checked, 0 broken, 0 missing anchors** (3 issues found and fixed during the check: two `#screenshots` anchors, one literal link-looking string)                                                       |
| Markdown formatting            | Prettier **3.9.10** (the version in the project's devDependencies) run from a throwaway install **outside** the repository with the project's `.prettierrc.json` | 7 new/rewritten documents reformatted; `prettier --check README.md "docs/**/*.md"` now reports **clean** for the whole documentation tree. **No dependency or `package.json` change was made.**                   |
| Edited JavaScript still parses | `node --check server/src/db/migrate/mongo-to-mysql/index.js` + `prettier --check` on that file                                                                   | parse OK, formatting clean (the edit is inside a block comment)                                                                                                                                                   |
| Repository root                | listing                                                                                                                                                          | only configuration files, the two workspaces, `audit/`, `e2e/`, `test-results/`, `docs/` and `README.md` remain — no report or screenshot at the top level                                                        |
| Nothing functional changed     | inspection of the edit set                                                                                                                                       | 3 edits: one comment line, one `.gitignore` line (plus explanatory comments), one README rewrite                                                                                                                  |
| Git index / history            | —                                                                                                                                                                | **not verifiable: there is no `.git` in this workspace.** No commit, push or reset was performed, and no file was ever staged                                                                                     |
| Lint / tests / build / E2E     | —                                                                                                                                                                | **not performed** (no dependencies, no servers, Node 20 vs. required ≥ 22.22). Every behavioural statement in the new documents comes from reading the code, not from a run. Those claims remain **NOT VERIFIED** |

## 1.10 Final structure

```
README.md                            rewritten entry point
docs/
  README.md                          index + reading order
  CLEANUP-CHANGE-RECORD.md           this file
  architecture/ARCHITECTURE.md
  database/
    README.md
    PHASE-6-REPORT.md  PHASE-6-MIGRATION-RUNBOOK.md  PHASE-7-OPS-RUNBOOK.md
    provider-default/{PROVIDER-DEFAULT-HANDOVER,PROVIDER-DEFAULT-PHASE-0-DISCOVERY}.md
  implementation/
    README.md  MODERNIZATION.md  FINAL-IMPLEMENTATION-REPORT.md  HANDOVER-REPORT.md
    phases/PHASE-0 … PHASE-7 (8 phase reports)
  verification/
    README.md  VERIFICATION-REPORT.md
    storefront/{STOREFRONT-UI-UX,STOREFRONT-CACHE-RESTORATION,VIRTUALIZATION-COMPLETION}-REPORT.md
  assets/screenshots/                8 current PNGs
  assets/screenshots/legacy/         2 preserved PNGs
```

Unchanged and untouched: `client/`, `server/` (except the one comment line), `e2e/`, `audit/`,
`test-results/`, `.github/`, all package files, lockfile, ESLint/Prettier/Playwright configs,
`playwright.config.js`, `.env.example`.

---

# Part 2 — Discovery report (as presented before execution)

## Repository cleanup & documentation consolidation — discovery report — as presented on 2026-11-06

**Status: READ-ONLY DISCOVERY. Nothing has been modified, moved, renamed or deleted.**
No `git` command was run (there is no repository present), no dependency was installed,
no test/lint/build command was executed. Every "would be published / would be ignored"
statement below is derived from reading `.gitignore` rules, **not** from `git check-ignore`,
because there is no Git index in this workspace.

Generated: 2026-11-06 · Scope: cleanup + documentation + GitHub submission prep only.

---

## 1. Method, and what could not be determined

Inspected: the full root tree, `.github/`, `client/`, `server/`, `e2e/`, `audit/`,
`test-results/`; all manifests and scripts (root/`client`/`server` `package.json`);
`.env.example`, `client/.env.example`, `server/.env` (**keys and value _shapes_ only —
no secret value is reproduced anywhere in this report**); `.gitignore`, `e2e/.gitignore`,
`.prettierignore`, `.prettierrc.json`, `.editorconfig`, `.gitattributes`;
`playwright.config.js`, `eslint.config.js`, `.github/workflows/ci.yml`;
all 21 root Markdown files (20 reports + `README.md`) — headings, sizes, cross-references;
all 29 PNGs (dimensions, sizes, MD5 dedupe); the two login/rotation screenshots were opened
and inspected visually; a secret-pattern scan over every non-binary, non-ignored file.

**Limits that constrain the plan:**

| Limit                            | Consequence                                                                                                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No `.git` directory**          | No tracked/untracked data, no history, no secret-history audit, no `git check-ignore`, no `git log` evidence of previous commits. Whether `server/.env` or `e2e/.auth/admin.json` were _ever_ committed is **UNVERIFIABLE**.                                   |
| **No `node_modules`**            | No test, lint, format, build or E2E run is possible without a network install. Therefore **no current test counts can be asserted** — the numbers in the existing README (20 files/269 tests, 18 files/194 tests, 20 E2E) are historical, from earlier rounds. |
| **No network install performed** | Everything in the README's verification section must be re-labelled as _last recorded run_ vs _NOT VERIFIED today_.                                                                                                                                            |

---

## 2. Inventory snapshot

| Area              | Files                     | Notes                                                                                                                     |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Root (top level)  | 40 entries                | 21 `.md`, 10 `verification-*.png`, 11 config/dotfiles + 6 directories                                                     |
| `client/src`      | 89                        | `api` (4), `app`, `components` (29), `features` (8), `hooks` (12), `pages` (21 incl. `admin/`), `styles`, `test`, `utils` |
| `server/src`      | 80                        | `config`, `constants`, `db`, `middlewares`, `modules`, `repositories`, `routes`, `utils`                                  |
| `server/tests`    | 59                        | `unit`, `integration`, `contracts`, `fixtures`, `globalSetup.js`, `setup.js`                                              |
| `server/scripts`  | 7                         | `dev`, `dev-mongo`, `e2e-server`, `reset-admin`, `setup`, `steps`, `with-env`                                             |
| `server/uploads`  | ~250 `.webp` + `.gitkeep` | generated by seed (sharp placeholders); ignored                                                                           |
| `e2e`             | 10                        | 5 specs, `auth.setup.js`, `support/auth.js`, `fixtures/product.png`, `.gitignore`, `.auth/admin.json`                     |
| `audit`           | 33                        | 8 harness/baseline `.mjs`, 6 generated `.json`, `screenshots/` (5 PNG), `responsive/` (14 PNG)                            |
| `.github`         | 1                         | `workflows/ci.yml`                                                                                                        |
| `test-results`    | 1                         | `.last-run.json` (`status: passed`)                                                                                       |
| **Root Markdown** | **21**                    | `README.md` + 20 reports, 8.6 KB – 44.9 KB each                                                                           |
| **PNGs**          | **29**                    | 10 root + 5 `audit/screenshots` + 14 `audit/responsive`                                                                   |

---

## 3. Reference graph — what points at what

Measured by literal filename search across every text file (`.md`, `.js`, `.jsx`, `.mjs`,
`.json`, `.yml`, `.html`, `.css`, `.gitignore`, `.env.example`).

### 3.1 Report → report (inbound references)

| Report                                                                                  | Referenced by                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `FINAL-IMPLEMENTATION-REPORT.md`                                                        | PHASE-7, HANDOVER, PROVIDER-DEFAULT-PHASE-0, PROVIDER-DEFAULT-HANDOVER               |
| `HANDOVER-REPORT.md`                                                                    | FINAL-IMPLEMENTATION, PROVIDER-DEFAULT-PHASE-0, PROVIDER-DEFAULT-HANDOVER            |
| `PHASE-0-DISCOVERY-AND-PLAN.md`                                                         | FINAL-IMPLEMENTATION                                                                 |
| `PHASE-1-GATE-REPORT.md`, `PHASE-2-REPORT.md`, `PHASE-3-REPORT.md`, `PHASE-4-REPORT.md` | FINAL-IMPLEMENTATION (+ PHASE-5 → PHASE-4)                                           |
| `PHASE-5-REPORT.md`                                                                     | PHASE-6, FINAL-IMPLEMENTATION                                                        |
| **`PHASE-6-REPORT.md`**                                                                 | FINAL-IMPLEMENTATION + **`server/src/db/migrate/mongo-to-mysql/index.js`** (see 3.3) |
| `PHASE-6-MIGRATION-RUNBOOK.md`                                                          | PHASE-6, PHASE-7-OPS, HANDOVER, FINAL-IMPLEMENTATION                                 |
| `PHASE-7-OPS-RUNBOOK.md`                                                                | PHASE-7, HANDOVER, FINAL-IMPLEMENTATION, both PROVIDER-DEFAULT docs                  |
| `PHASE-7-REPORT.md`                                                                     | HANDOVER, FINAL-IMPLEMENTATION, both PROVIDER-DEFAULT docs                           |
| `PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md`                                                 | PROVIDER-DEFAULT-HANDOVER                                                            |
| `PROVIDER-DEFAULT-HANDOVER.md`                                                          | _(none — newest document)_                                                           |
| `MODERNIZATION.md`                                                                      | README                                                                               |
| `PHASE-1-3-INSPECTION-ROOT-CAUSE-PLAN.md`                                               | VIRTUALIZATION-COMPLETION                                                            |
| `STOREFRONT-UI-UX-REPORT.md`                                                            | VIRTUALIZATION-COMPLETION, STOREFRONT-CACHE-RESTORATION                              |
| `STOREFRONT-CACHE-RESTORATION-REPORT.md`                                                | VIRTUALIZATION-COMPLETION                                                            |
| `VERIFICATION-REPORT.md`                                                                | STOREFRONT-UI-UX                                                                     |
| `VIRTUALIZATION-COMPLETION-REPORT.md`                                                   | _(none)_                                                                             |
| `README.md`                                                                             | both PROVIDER-DEFAULT docs                                                           |

All 20 reports are therefore **one connected graph** — none is orphaned except the two
newest/leaf nodes (`PROVIDER-DEFAULT-HANDOVER.md`, `VIRTUALIZATION-COMPLETION-REPORT.md`),
which are entry points rather than dead ends. Moving any file requires fixing the inbound
references listed above (plain filename references, so mostly they keep working; any that
are relative _paths_ must be rewritten).

### 3.2 Screenshots → referencing documents

**Zero.** No report, README, script, test or CI file references any of the 10 root PNGs by
name. They are pure assets — safe to move without breaking anything, and the README's
"screenshots in the repo root" sentence is the only thing that needs updating.

### 3.3 Source-code → documentation references (the only one)

```
server/src/db/migrate/mongo-to-mysql/index.js:16
 * Safety model (see `PHASE-6-REPORT.md` §5 for the operator procedure):
```

This is a **file name, not a path**, in a code comment. Moving the report to
`docs/database/` leaves the sentence still true but harder to locate. This is the single
decision that could force a one-line comment edit inside `server/src/` — the user must
choose (see Open decision **D2**).

### 3.4 Code / script → asset references (must not break)

| Referenced from                                                   | Asset                                                                                     | Action                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| `e2e/admin-products.spec.js:74`, `audit/api-audit.mjs:887`        | `e2e/fixtures/product.png`                                                                | **golden fixture — keep exactly where it is** |
| `audit/api-contract-diff.mjs`, `.github/workflows/ci.yml:138-144` | `audit/api-contract-snapshot.mjs`                                                         | **golden baseline — keep**                    |
| `audit/*-audit.mjs`                                               | write to `audit/screenshots/`, `audit/responsive/`                                        | keep                                          |
| CI                                                                | `npm ci`, `npm run lint/format:check/test/build/launcher:check/test:mysql/test:migration` | untouched                                     |

CI references **no** documentation or root screenshot, so the docs move cannot break CI.

---

## 4. Secrets and ignore posture

Values were never printed; only key names, lengths and character classes were inspected.

| File                                                                                                               | Content shape                                                                                                                                                                                     | `.gitignore` coverage                           | Verdict                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/.env`                                                                                                      | `MONGO_URI` = localhost, **no credentials in the URI**; `JWT_SECRET` = 62 chars, lowercase + digits + symbols, **not** a 128-char hex (so _not_ what `npm run setup` generates — it was hand-set) | line 7 `.env` ✓                                 | **Never commit. Rotate if this tree was ever pushed anywhere.** Ignored status unverifiable without Git.                                                                                                                                     |
| `e2e/.auth/admin.json`                                                                                             | Playwright storage state: 2 cookies, one 261-char value, `origins: []` → **a live admin session credential**                                                                                      | line 81 `e2e/.auth/` **and** `e2e/.gitignore` ✓ | **Never commit.** Regenerated by `e2e/auth.setup.js`.                                                                                                                                                                                        |
| `.env.example`                                                                                                     | `JWT_SECRET` looks alarming (54 chars, 11 hyphen-separated tokens) but **contains the literal token `replace-me`**                                                                                | committable by design (line 9 `!.env.example`)  | **Safe to publish.** Verified: `server/scripts/setup.mjs:101` regenerates the secret when it contains `replace-me`, and `server/src/config/env.js` rejects well-known placeholder tokens at boot. Placeholder confirmed, _not_ a credential. |
| `audit/lifecycle-probe.json`                                                                                       | contains a **real signed JWT** (143-char `eyJ…` match)                                                                                                                                            | line 65 ✓                                       | generated artifact — never commit                                                                                                                                                                                                            |
| `audit/api-audit.mjs:29`, `server/tests/setup.js:23`                                                               | secrets prefixed `audit-secret-` / `test-secret-`                                                                                                                                                 | tracked source                                  | obvious test fixtures — safe                                                                                                                                                                                                                 |
| `server/src/constants/appConstants.js:129-133`                                                                     | `DEFAULT_ADMIN` = `admin@catalogue.com` / `Admin123!`, flagged `mustChangePassword`                                                                                                               | tracked source                                  | documented dev seed — safe, already public in README                                                                                                                                                                                         |
| All other scans (private keys, AWS, GitHub tokens, `sk-`, Slack webhooks, URI-with-password, `password=` literals) | 40 matches total                                                                                                                                                                                  | —                                               | every match resolved to a test fixture, the dev seed constant, a SHA-256 digest, or an already-ignored file. **No unpublishable secret found outside the two ignored files above.**                                                          |

### 4.1 Files that _would_ be published and probably should not be

| Path                                    | Why                                                                                                                                   | Proposed class                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `.sudo_as_admin_successful`             | 0-byte sandbox/OS artifact, **not covered by any ignore rule** → would land in a public repo                                          | **REMOVE** (with approval)                                  |
| `audit/screenshots/admin-dashboard.png` | ignored rules cover `login.png`, `storefront-{390,768,1280}.png` but **not** this one → would be published while its siblings are not | KEEP (harmless, useful) or add an ignore rule — user's call |

### 4.2 Two real ignore-rule defects (reported, not fixed)

1. **`.gitkeep` cannot be committed.** Lines 28–29 are `server/uploads/` followed by
   `!server/uploads/.gitkeep`. Git cannot re-include a file inside an _excluded directory_,
   so the negation is inert and the uploads directory will simply not exist after a clone.
   Fix would be `server/uploads/*` + `!server/uploads/.gitkeep`. **No edit made** — the user
   instructed that `.gitignore` is not changed blindly.
2. Adding a rule does not untrack anything already tracked — not applicable here (no index),
   but it is why no file is being "un-ignored" or "un-tracked" in this plan.

### 4.3 Implementation observation (out of scope for cleanup — flagged only)

`client/src/pages/LoginPage.jsx:141-148` renders the _"Local development seed:
admin@catalogue.com / Admin123!"_ banner **unconditionally** — there is no
`import.meta.env.DEV` gate. It therefore also renders in a production build, which is why
it is visible in `verification-modernized-login.png`. That is an implementation/security
nit, **not** a cleanup item; changing it would violate "no app changes". Recommended as a
separate follow-up. The README must not claim the hint is dev-only while this is true.

---

## 5. Documentation conflicts to flag, never silently rewrite

| #   | Conflict                                                                                                                                                                                                                        | Affected files                                                                                                             | Handling                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | **`?page=` is described as a live storefront feature.** The implementation no longer uses `page` in customer URLs (pagination is cursor-based; `useListingDepth` strips `page`).                                                | `STOREFRONT-CACHE-RESTORATION-REPORT.md`, `VIRTUALIZATION-COMPLETION-REPORT.md`, `PHASE-1-3-INSPECTION-ROOT-CAUSE-PLAN.md` | Keep the historical claim, add a dated **"Historical note"** banner at the top of each file pointing to the current behaviour. No text is deleted.                                                                 |
| C2  | **Provider ordering.** Phase 0–5 reports present MongoDB as the reference implementation; `PROVIDER-DEFAULT-HANDOVER.md` later made **Oracle MySQL 8.0 the default** (`DATABASE_PROVIDER` unset → `mysql`, source `default`).   | PHASE-0…PHASE-5, FINAL-IMPLEMENTATION, plus the new README                                                                 | The new README states the _current_ contract (MySQL default, MongoDB equally supported) and links the history. The phase reports are read in chronological order via a timeline index rather than being rewritten. |
| C3  | **Stale test counts.** `README.md` asserts 20 files/269 server tests, 18 files/194 client tests, 20 E2E tests. Test files were added after those runs (storefront URL-state work, hooks tests), and nothing can be re-run here. | `README.md`, `VERIFICATION-REPORT.md` (§4 says 20 E2E / 32.1 s)                                                            | New README drops hard counts; it states _which suites exist_ and labels every result **last recorded run — not re-run in this session / NOT VERIFIED**.                                                            |
| C4  | **CI never executed.** `.github/workflows/ci.yml` defines 5 jobs (mongodb, mysql, contract-parity, windows-scripts, macos-scripts). No evidence of a single run exists in this workspace.                                       | README, all handovers                                                                                                      | README says: workflow committed, jobs defined, **execution NOT VERIFIED**. No green-badge language.                                                                                                                |
| C5  | **Screenshots are dated.** Two root screenshots (`verification-modernized-*.png`, 1280×900) are from the modernization round; the eight 1440×950 / 390×844 ones are newer and show the current UI.                              | README image gallery                                                                                                       | README embeds only current-era shots; legacy ones move to a clearly labelled `legacy/` folder.                                                                                                                     |

---

## 6. Proposed documentation tree

```
README.md                                  ← rewritten (see §7)
CLEANUP-DISCOVERY.md                       ← this file (becomes the cleanup change record)
docs/
  README.md                                ← new: documentation index + reading order
  architecture/
    ARCHITECTURE.md                        ← new: consolidated (no historical text lost)
  database/
    README.md                              ← new: provider contract in one page (MySQL default)
    PHASE-6-REPORT.md                      ← moved (see D2)
    PHASE-6-MIGRATION-RUNBOOK.md           ← moved
    PHASE-7-OPS-RUNBOOK.md                 ← moved
    provider-default/
      PROVIDER-DEFAULT-HANDOVER.md         ← moved
      PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md← moved
  implementation/
    README.md                              ← new: phase timeline index + status per phase
    MODERNIZATION.md                       ← moved
    FINAL-IMPLEMENTATION-REPORT.md         ← moved
    HANDOVER-REPORT.md                     ← moved
    phases/
      PHASE-0-DISCOVERY-AND-PLAN.md        ← moved
      PHASE-1-3-INSPECTION-ROOT-CAUSE-PLAN.md ← moved (+ C1 note)
      PHASE-1-GATE-REPORT.md               ← moved
      PHASE-2-REPORT.md … PHASE-5-REPORT.md← moved
      PHASE-7-REPORT.md                    ← moved
  verification/
    README.md                              ← new: what was verified when + NOT VERIFIED list
    VERIFICATION-REPORT.md                 ← moved
    storefront/
      STOREFRONT-UI-UX-REPORT.md           ← moved (+ C1 note where applicable)
      STOREFRONT-CACHE-RESTORATION-REPORT.md ← moved (+ C1 note)
      VIRTUALIZATION-COMPLETION-REPORT.md  ← moved (+ C1 note)
  assets/screenshots/                      ← 8 current PNGs, renamed descriptively
  assets/screenshots/legacy/               ← 2 modernization-era PNGs (see D3)
```

20 reports → 20 files, all preserved, none merged away. Three new index/summary documents
plus `ARCHITECTURE.md` and `database/README.md` are the only _new prose_; the reports
themselves keep their original text (plus dated banners for C1).

---

## 7. README rewrite outline (requirements-mapped)

1. Title + one-paragraph positioning; explicit "what this is / what it is not".
2. **Stack table by category** — runtime, API, data access, frontend, styling, testing, tooling, CI. (Taken from the three `package.json` files, not from prose.)
3. **Dual-database architecture** — Mermaid flowchart; MySQL 8.0 is the default, `DATABASE_PROVIDER=mysql|mongodb`, both first-class, resolved provider + source logged, unsupported value fatal, no silent fallback, provider isolation.
4. **Features** — storefront (cursor pagination, facets, URL-synced filters, virtualization), admin (products CRUD + uploads, brands, categories, offset pagination, optimistic concurrency), auth (cookie JWT + CSRF double-submit, forced rotation), observability (health 503 semantics, structured logs), docs (Swagger UI).
5. **Architecture** — Mermaid diagram + module map (server `modules/` + `repositories/`, client `api/` + `features/`), why modular monolith, Repository Pattern for provider parity.
6. **Native Windows (PowerShell) setup** — `npm install`, `npm run setup` (creates `server/.env` + generates `JWT_SECRET`), MongoDB local service path, **MySQL 8.0 native installer path**, database creation, `npm run db:migrate`, `npm run seed`, `npm run dev`; provider switch commands; no Docker/WSL/cloud required. macOS/Linux equivalents in a parallel block.
7. **Testing & verification** — three buckets: **executed & passed (last recorded run, with the date and the command)**, **executed & skipped (enumerated: MySQL suites skip without `MYSQL_TEST_*`; `MYSQL_REQUIRE=1` turns a skip into a failure)**, **NOT VERIFIED (everything in this session — no dependencies installed here)**.
8. **Screenshots** — the current-era set, each captioned truthfully (see below).
9. **Intentional exclusions / limitations** — including the two mandated ones (below).
10. **Documentation links** — `docs/` index, runbooks, phase history.
11. **Project status** — honest: feature-complete for the implemented scope, CI committed but not executed, historical verification evidence committed, corrections/limitations listed.

### 7.1 The two exclusions the README must state plainly

> **Customer accounts and sign-in are not implemented.** The storefront is browse-only:
> there is no shopper registration, no shopper sign-in, no customer profile. The app's
> `/login` route is **administrative** sign-in for the catalogue dashboard — it is part of
> the existing admin auth stack (`server` JWT + CSRF, `client` `ProtectedRoute`,
> `e2e/auth.setup.js`, `e2e/.auth/`). Its existence must not be read as a user-facing
> login feature.
>
> **The shopping cart is not implemented.** Products can be browsed, filtered and viewed;
> there is no cart, no quantity selection for checkout, no checkout or payment flow.

The two login/rotation screenshots will therefore be captioned
_"Administrative sign-in (`/login`) — administrative auth, not a customer feature"_ and
_"Forced password rotation on first admin sign-in"_, and never as proof of a user login.

---

## 8. Per-file action table

Legend — **KEEP** unchanged · **MOVE** relocated (content preserved, links fixed) ·
**CONSOLIDATE** new/rewritten prose · **IGNORE** already ignored, untouched on disk ·
**REMOVE** deleted from the workspace (approval required, nothing executed).

### 8.1 Root documentation (21 files)

| File                                      | Action              | Destination / note                                       |
| ----------------------------------------- | ------------------- | -------------------------------------------------------- |
| `README.md`                               | **CONSOLIDATE**     | rewritten in place per §7                                |
| `MODERNIZATION.md`                        | MOVE                | `docs/implementation/MODERNIZATION.md`                   |
| `FINAL-IMPLEMENTATION-REPORT.md`          | MOVE                | `docs/implementation/`                                   |
| `HANDOVER-REPORT.md`                      | MOVE                | `docs/implementation/`                                   |
| `PHASE-0-DISCOVERY-AND-PLAN.md`           | MOVE                | `docs/implementation/phases/`                            |
| `PHASE-1-3-INSPECTION-ROOT-CAUSE-PLAN.md` | MOVE                | `docs/implementation/phases/` + C1 banner                |
| `PHASE-1-GATE-REPORT.md`                  | MOVE                | `docs/implementation/phases/`                            |
| `PHASE-2-REPORT.md`                       | MOVE                | `docs/implementation/phases/`                            |
| `PHASE-3-REPORT.md`                       | MOVE                | `docs/implementation/phases/`                            |
| `PHASE-4-REPORT.md`                       | MOVE                | `docs/implementation/phases/`                            |
| `PHASE-5-REPORT.md`                       | MOVE                | `docs/implementation/phases/`                            |
| `PHASE-7-REPORT.md`                       | MOVE                | `docs/implementation/phases/`                            |
| `PHASE-6-REPORT.md`                       | MOVE _(pending D2)_ | `docs/database/` — cited by `server/src/.../index.js:16` |
| `PHASE-6-MIGRATION-RUNBOOK.md`            | MOVE                | `docs/database/`                                         |
| `PHASE-7-OPS-RUNBOOK.md`                  | MOVE                | `docs/database/`                                         |
| `PROVIDER-DEFAULT-HANDOVER.md`            | MOVE                | `docs/database/provider-default/`                        |
| `PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md`   | MOVE                | `docs/database/provider-default/`                        |
| `VERIFICATION-REPORT.md`                  | MOVE                | `docs/verification/`                                     |
| `STOREFRONT-UI-UX-REPORT.md`              | MOVE                | `docs/verification/storefront/` (+ C1 if applicable)     |
| `STOREFRONT-CACHE-RESTORATION-REPORT.md`  | MOVE                | `docs/verification/storefront/` + C1 banner              |
| `VIRTUALIZATION-COMPLETION-REPORT.md`     | MOVE                | `docs/verification/storefront/` + C1 banner              |
| `CLEANUP-DISCOVERY.md` (this file)        | MOVE                | `docs/CLEANUP-CHANGE-RECORD.md` after execution          |

### 8.2 Screenshots — 10 root PNGs

| Current                                                                        | Action              | New name                             | README embedding                                  |
| ------------------------------------------------------------------------------ | ------------------- | ------------------------------------ | ------------------------------------------------- |
| `verification-storefront.png` (1440×950)                                       | MOVE                | `storefront-desktop.png`             | ✅ hero                                           |
| `verification-storefront-mobile.png` (390×844)                                 | MOVE                | `storefront-mobile.png`              | ✅                                                |
| `verification-product-detail.png`                                              | MOVE                | `product-detail.png`                 | ✅                                                |
| `verification-admin-dashboard.png`                                             | MOVE                | `admin-dashboard.png`                | ✅                                                |
| `verification-admin-products.png`                                              | MOVE                | `admin-products.png`                 | ✅                                                |
| `verification-admin-brands.png`                                                | MOVE                | `admin-brands.png`                   | ✅                                                |
| `verification-admin-product-form.png`                                          | MOVE                | `admin-product-form.png`             | ✅                                                |
| `verification-login-flow.png` (**admin forced rotation**)                      | MOVE                | `admin-password-rotation.png`        | ✅ with admin-auth caption                        |
| `verification-modernized-login.png` (**admin sign-in, dev seed hint visible**) | MOVE _(pending D3)_ | `legacy/admin-signin.png`            | ⛔ not embedded; linked from `docs/verification/` |
| `verification-modernized-storefront.png` (superseded)                          | MOVE _(pending D3)_ | `legacy/storefront-pre-redesign.png` | ⛔ not embedded                                   |

No screenshot depicts a customer login because none exists; captions will say so.

### 8.3 Configuration, source, tests, CI — all KEEP

`.editorconfig`, `.env.example`, `.gitattributes`, `.gitignore`, `.prettierignore`,
`.prettierrc.json`, `eslint.config.js`, `playwright.config.js`, `package.json`,
`package-lock.json`, `.github/workflows/ci.yml`, and every file under `client/`, `server/src/`,
`server/tests/`, `server/scripts/`, `e2e/` (specs, `auth.setup.js`, `support/auth.js`,
`fixtures/product.png`), `audit/*.mjs` (8 harness/baseline scripts incl.
`api-contract-snapshot.mjs` **golden baseline**), `audit/screenshots/admin-dashboard.png`,
`test-results/.last-run.json` (ignored), `server/uploads/.gitkeep`.
**No dependency, lockfile, test, CI or implementation change is proposed.**

### 8.4 Already ignored — untouched (no action, listed for completeness)

`server/.env` · `e2e/.auth/admin.json` · `node_modules/` (absent) · `test-results/` ·
`server/uploads/products/*.webp` (~250) · `audit/api-audit-results.json` ·
`audit/runtime-audit-results.json` · `audit/browser-audit-results.json` ·
`audit/dom-budget.json` · `audit/responsive-audit.json` · `audit/lifecycle-probe.json`
(contains a live JWT — ignored, correctly) · `audit/responsive/` (14 PNGs) ·
`audit/screenshots/{login,storefront-390,storefront-768,storefront-1280}.png`.

### 8.5 REMOVE — approval required, not executed

| Path                                                      | Reason                                                             | Risk                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `.sudo_as_admin_successful`                               | 0-byte OS/sandbox artifact, not ignored, would be published        | none (regenerated by the host, outside the project)        |
| _(optional, D3)_ `verification-modernized-storefront.png` | superseded by `verification-storefront.png`, referenced by nothing | loses one historical frame; `legacy/` alternative keeps it |

**Nothing else is proposed for deletion.** No report, fixture, harness, screenshot,
test, config or source file is removed by this plan.

---

## 9. Open decisions needed before execution

| ID     | Decision                                         | Options                                                                                                                                                                                                     | Recommendation                                                                                        |
| ------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **D1** | Approve the plan as written?                     | approve / approve with edits / hold                                                                                                                                                                         | —                                                                                                     |
| **D2** | `PHASE-6-REPORT.md` is cited by a source comment | (a) move to `docs/database/` **and** update the one comment line in `server/src/db/migrate/mongo-to-mysql/index.js`; (b) move and leave the comment as a bare file name; (c) keep the file at the repo root | **(a)** — one comment line, no behaviour change; (b) is acceptable if you want `server/src` untouched |
| **D3** | The 2 modernization-era screenshots              | (a) move to `docs/assets/screenshots/legacy/` (nothing lost); (b) delete the superseded storefront one, keep admin sign-in; (c) delete both                                                                 | **(a)**                                                                                               |
| **D4** | Optional additive fixes                          | (a) none — docs move only; (b) fix the `server/uploads/.gitkeep` ignore rule (`server/uploads/` → `server/uploads/*`); (c) (b) + add `LICENSE`; (d) (b) + `LICENSE` + `SECURITY.md` + `.nvmrc`              | **(b)** — smallest change that makes a fresh clone behave; licensing is your call, not mine           |

After approval I execute in this order: create `docs/` tree → move reports & screenshots →
fix intra-doc links → add C1 banners + 3 index documents + `ARCHITECTURE.md` → rewrite
`README.md` → apply D3/D4 → re-verify every relative link resolves and no filename is
orphaned → report every changed/moved/ignored/removed file with a final `README`+`docs/`
tree, and label anything unexecuted **NOT VERIFIED**.
