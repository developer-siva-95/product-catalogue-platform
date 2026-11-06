# Implementation record — timeline and index

> **How to read this file.** Every report linked below is preserved **exactly as it was
> written**, including claims that later changed. Nothing was re-executed on 2026-11-06 (this
> workspace has no installed dependencies), so no statement below is a fresh result. Where a
> report is known to be superseded, a dated **historical note** was added above it instead of
> editing the text.
>
> **Ordering caveat.** The sequence below is inferred from the reports' cross-references, not
> from file timestamps (every file in this tree carries the same copy timestamp). Two clusters —
> the dual-database programme and the storefront rounds — overlap in the record and their exact
> interleaving is not documented anywhere; they are listed as separate tracks.

---

## 1. Track A — stack modernization

| #   | Report                                   | What it delivered                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | [`MODERNIZATION.md`](./MODERNIZATION.md) | The pre-change audit and the version matrix that the whole codebase now targets: audit scope → target matrix → breaking-change risk register → staged plan → migration checklist → security/database review → final verification **of that round** → residual items deliberately left out of scope. |

## 2. Track B — the dual-database programme

| #   | Report                                                                                 | What it delivered                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0  | [`phases/PHASE-0-DISCOVERY-AND-PLAN.md`](./phases/PHASE-0-DISCOVERY-AND-PLAN.md)       | Read-only discovery: architecture as it stood, baseline results, target architecture, the phase plan, risks, and the approved decisions (including "MySQL 8.0 only, no MariaDB").                                                                                |
| B1  | [`phases/PHASE-1-GATE-REPORT.md`](./phases/PHASE-1-GATE-REPORT.md)                     | Contracts, canonical 24-hex identifiers, mapper extraction; a 30/30 identical API snapshot; ESLint boundary rules so modules cannot reach around the repositories.                                                                                               |
| B2  | [`phases/PHASE-2-REPORT.md`](./phases/PHASE-2-REPORT.md)                               | MongoDB access extracted behind provider-neutral repository interfaces — the code stopped knowing it was Mongoose.                                                                                                                                               |
| B3  | [`phases/PHASE-3-REPORT.md`](./phases/PHASE-3-REPORT.md)                               | MySQL 8.0 schema foundation and the parity rules (`CHAR(24)` ids, `utf8mb4_bin` comparisons, `DECIMAL` money, canonical timestamps).                                                                                                                             |
| B4  | [`phases/PHASE-4-REPORT.md`](./phases/PHASE-4-REPORT.md)                               | MySQL repositories; the MySQL implementation passes the MongoDB contract snapshot; the one documented divergence (`searchMode=text` does not stem on MySQL).                                                                                                     |
| B5  | [`phases/PHASE-5-REPORT.md`](./phases/PHASE-5-REPORT.md)                               | The dual-provider test matrix, plus the defects it caught and the fixes.                                                                                                                                                                                         |
| B6  | [`../database/PHASE-6-REPORT.md`](../database/PHASE-6-REPORT.md)                       | Provider-neutral idempotent seeding, `excludeId` parity, and the one-way MongoDB → MySQL migration (design, quarantine rules, confirmations, idempotency, rollback).                                                                                             |
| B6r | [`../database/PHASE-6-MIGRATION-RUNBOOK.md`](../database/PHASE-6-MIGRATION-RUNBOOK.md) | The operator procedure for B6: dry run → apply → re-run → rollback → verify → switch the app to MySQL.                                                                                                                                                           |
| B7  | [`phases/PHASE-7-REPORT.md`](./phases/PHASE-7-REPORT.md)                               | Ops hardening: `/health` `503` as an approved contract change, the skipped tests enumerated and accounted for, Playwright E2E per provider, the seeded fixture set pinned by a test, and a per-provider VERIFIED / NOT VERIFIED split (no overall "done" claim). |
| B7r | [`../database/PHASE-7-OPS-RUNBOOK.md`](../database/PHASE-7-OPS-RUNBOOK.md)             | The operations runbook: live provider, lifecycle, switch, health wiring, connection sizing, backups, incidents, logs, `MYSQL_*` vs `MYSQL_TEST_*`.                                                                                                               |
| B8  | [`FINAL-IMPLEMENTATION-REPORT.md`](./FINAL-IMPLEMENTATION-REPORT.md)                   | Cumulative programme summary: architecture, schema, what each phase delivered, cumulative changed files, setup, results **of that session**, acceptance criteria per provider, limitations, and what the owner must re-run.                                      |
| B9  | [`HANDOVER-REPORT.md`](./HANDOVER-REPORT.md)                                           | Portability round and handover: scripts made runner-agnostic, CI readiness (**NOT VERIFIED**), requirement status, outstanding operational verification.                                                                                                         |

## 3. Track C — provider default (newest runtime change)

| #   | Report                                                                                                                                     | What it delivered                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | [`../database/provider-default/PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md`](../database/provider-default/PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md) | Where the default was decided, every place that ran without `DATABASE_PROVIDER`, what would break, the minimal file set, and the conflicts to expect.                                                                                                                                                                            |
| C2  | [`../database/provider-default/PROVIDER-DEFAULT-HANDOVER.md`](../database/provider-default/PROVIDER-DEFAULT-HANDOVER.md)                   | **The newest document in the repository.** MySQL became the default: resolution contract, runtime evidence, explicit selection, unavailability behaviour, provider isolation proven in both directions, CI additions, the full test matrix, byte-identical API snapshots, every file changed, and honest verification labelling. |

**This is the change that makes several earlier reports read "wrong".** Track B describes
MongoDB as the reference implementation because that is what it was at the time. The current
contract — MySQL by default, MongoDB equally supported, switch by configuration only — is stated
in the root README and in [`../database/README.md`](../database/README.md).

## 4. Track D — storefront rounds

| #   | Report                                                                                                                                   | What it delivered                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | [`../verification/storefront/STOREFRONT-UI-UX-REPORT.md`](../verification/storefront/STOREFRONT-UI-UX-REPORT.md)                         | Responsive layout, accessibility, stock display, component inventory, the tests that were run, and the traceability matrix. Round 1 of the storefront work (this is also the round in which the cart was removed). |
| D2  | [`phases/PHASE-1-3-INSPECTION-ROOT-CAUSE-PLAN.md`](./phases/PHASE-1-3-INSPECTION-ROOT-CAUSE-PLAN.md)                                     | Read-only inspection and root-cause report for the freshness vs. pagination-reset defects, plus the implementation plan. **Superseded `?page=` claims — see the historical note in the file.**                     |
| D3  | [`../verification/storefront/STOREFRONT-CACHE-RESTORATION-REPORT.md`](../verification/storefront/STOREFRONT-CACHE-RESTORATION-REPORT.md) | Proving the root cause before changing anything, then separating data freshness from UI state restoration. **Superseded `?page=` claims — see the historical note.**                                               |
| D4  | [`../verification/storefront/VIRTUALIZATION-COMPLETION-REPORT.md`](../verification/storefront/VIRTUALIZATION-COMPLETION-REPORT.md)       | Virtualization + state restoration completion, DOM budget measurement, acceptance criteria. **Superseded `?page=` claims — see the historical note.**                                                              |
| D5  | [`../verification/VERIFICATION-REPORT.md`](../verification/VERIFICATION-REPORT.md)                                                       | The full regression audit that followed: backend harness, frontend harness, E2E, production-build runtime checks, security findings by severity, and an explicit list of what was **not** verified.                |

## 5. Changes that came after the last report in this tree

Two rounds of work were completed in this workspace **after** the newest report here, so they
are described only in the root README and in the code itself. They are documented facts, not
verified test results:

| Round                  | What changed                                                                                                                                                                                                                                                                  | Evidence                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Storefront URL state   | The customer listing URL no longer carries `?page=N`. Pagination depth is owned by the RTK Query cache; `stripPagination` (`client/src/hooks/useListingDepth.js`) removes the parameter from any URL that still has one, and `useUrlSyncedFilters` applies it with `replace`. | code + `client/src/pages/StorefrontUrlState.test.jsx`, `e2e/storefront.spec.js`, `e2e/virtualization.spec.js` (updated, **not re-run here**) |
| Admin taxonomy refresh | Brand/category mutations now invalidate the product lists they affect, and the Brands/Categories screens refresh deterministically.                                                                                                                                           | `client/src/api/apiSlice.js` tag wiring (**not re-run here**)                                                                                |

Because no report covers these two rounds, they are also the most likely place for stale prose
elsewhere in this tree. If you find a claim that contradicts them, treat the code and the root
README as authoritative and add a dated note — do not rewrite the historical report.

## 6. Reading order if you only have ten minutes

1. Root [`README.md`](../../README.md) — what it is, how to run it, what is verified.
2. [`../architecture/ARCHITECTURE.md`](../architecture/ARCHITECTURE.md) — how the code is shaped.
3. [`../verification/README.md`](../verification/README.md) — what has and has not been proven.
4. [`C2`](../database/provider-default/PROVIDER-DEFAULT-HANDOVER.md) — the provider default, if
   you are about to deploy or change database behaviour.
5. [`B8`](./FINAL-IMPLEMENTATION-REPORT.md) — the consolidated dual-database programme.
