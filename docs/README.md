# Documentation index

Everything that is not the code lives here. The root **[`README.md`](../README.md)** is the
entry point; this page is the map.

> **Consolidation note — 2026-11-06.** The 20 engineering reports that used to sit in the
> repository root were moved into this tree during a documentation-only cleanup. **No report
> was deleted, merged away or rewritten.** Their text is preserved as originally written,
> including claims that later changed; where a claim is now known to be superseded, a dated
> **historical note** was added above it rather than editing it. Nothing here was re-executed
> on 2026-11-06. The full before/after inventory is in
> [`CLEANUP-CHANGE-RECORD.md`](./CLEANUP-CHANGE-RECORD.md).

---

## 1. Start here

| I want to…                                           | Read                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| understand what the project is and run it            | [`../README.md`](../README.md)                                                     |
| understand how the code is put together              | [`architecture/ARCHITECTURE.md`](./architecture/ARCHITECTURE.md)                   |
| understand the two databases and switch between them | [`database/README.md`](./database/README.md)                                       |
| know exactly what has and has not been verified      | [`verification/README.md`](./verification/README.md)                               |
| read the chronological build record                  | [`implementation/README.md`](./implementation/README.md)                           |
| operate the system (backups, incidents, health)      | [`database/PHASE-7-OPS-RUNBOOK.md`](./database/PHASE-7-OPS-RUNBOOK.md)             |
| migrate MongoDB data into MySQL                      | [`database/PHASE-6-MIGRATION-RUNBOOK.md`](./database/PHASE-6-MIGRATION-RUNBOOK.md) |

## 2. Documents written during the consolidation (current, maintained)

| Document                                                         | Contents                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`architecture/ARCHITECTURE.md`](./architecture/ARCHITECTURE.md) | System context, module layout (server + client), request lifecycle, repository pattern, data model, pagination contracts, error model, cross-cutting concerns. Summary written from the code as it stands; supersedes the _descriptive_ parts of the phase reports. |
| [`database/README.md`](./database/README.md)                     | The provider contract in one page: MySQL 8.0 is the default, how `DATABASE_PROVIDER` resolves, launcher scripts, provider isolation, health semantics, migrations, seeding, the migration tool, per-provider tests.                                                 |
| [`implementation/README.md`](./implementation/README.md)         | Timeline of every phase with a one-line summary, status and a link; explains the historical provider ordering (MongoDB-first → MySQL default) so the older reports read correctly.                                                                                  |
| [`verification/README.md`](./verification/README.md)             | Verification status matrix: what was executed when, what was skipped and why, what is **NOT VERIFIED**, and the commands to reproduce each claim.                                                                                                                   |
| [`CLEANUP-CHANGE-RECORD.md`](./CLEANUP-CHANGE-RECORD.md)         | The discovery report and complete change inventory for the 2026-11-06 documentation consolidation (this cleanup's own record).                                                                                                                                      |

## 3. Historical reports (preserved verbatim)

### 3.1 Architecture, phases and handovers — `implementation/`

| Report                                                                                                              | Date/period                  | What it covers                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`MODERNIZATION.md`](./implementation/MODERNIZATION.md)                                                             | stack modernization round    | Audit → target matrix → breaking-change register → staged plan → checklist; final version matrix and residual items.                                                                |
| [`phases/PHASE-0-DISCOVERY-AND-PLAN.md`](./implementation/phases/PHASE-0-DISCOVERY-AND-PLAN.md)                     | planning                     | Architecture as it was, baseline results, target architecture, phase plan, risks, approved decisions.                                                                               |
| [`phases/PHASE-1-3-INSPECTION-ROOT-CAUSE-PLAN.md`](./implementation/phases/PHASE-1-3-INSPECTION-ROOT-CAUSE-PLAN.md) | inspection                   | Read-only codebase inspection, root-cause report for the freshness/pagination defects, implementation plan. **Contains superseded `?page=` claims — see its historical note.**      |
| [`phases/PHASE-1-GATE-REPORT.md`](./implementation/phases/PHASE-1-GATE-REPORT.md)                                   | Phase 1 gate                 | Contracts, canonical IDs, mapper extraction; 30/30 API snapshot parity; ESLint boundary rules.                                                                                      |
| [`phases/PHASE-2-REPORT.md`](./implementation/phases/PHASE-2-REPORT.md)                                             | Phase 2                      | MongoDB repository extraction behind a provider-neutral interface.                                                                                                                  |
| [`phases/PHASE-3-REPORT.md`](./implementation/phases/PHASE-3-REPORT.md)                                             | Phase 3                      | MySQL 8.0 schema foundation and the rules that make parity possible.                                                                                                                |
| [`phases/PHASE-4-REPORT.md`](./implementation/phases/PHASE-4-REPORT.md)                                             | Phase 4                      | MySQL repositories; MySQL passes the MongoDB contract snapshot; documented `searchMode=text` divergence.                                                                            |
| [`phases/PHASE-5-REPORT.md`](./implementation/phases/PHASE-5-REPORT.md)                                             | Phase 5                      | Dual-provider test matrix; defects found and fixed.                                                                                                                                 |
| [`phases/PHASE-7-REPORT.md`](./implementation/phases/PHASE-7-REPORT.md)                                             | Phase 7                      | Ops hardening, provider-parity E2E, `/health` 503 as an approved contract change, per-provider VERIFIED / NOT VERIFIED split.                                                       |
| [`FINAL-IMPLEMENTATION-REPORT.md`](./implementation/FINAL-IMPLEMENTATION-REPORT.md)                                 | end of the dual-DB programme | Cumulative summary: architecture, schema, per-phase delivery, changed files, setup, test results **of that session**, acceptance criteria, limitations, what the owner must re-run. |
| [`HANDOVER-REPORT.md`](./implementation/HANDOVER-REPORT.md)                                                         | handover                     | Script portability round, CI readiness (**NOT VERIFIED**), requirement status, outstanding operational verification.                                                                |

### 3.2 Database, migration and operations — `database/`

| Report                                                                                                                                 | What it covers                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`database/PHASE-6-REPORT.md`](./database/PHASE-6-REPORT.md)                                                                           | Seeding parity, `excludeId` parity, the documented text-search divergence, and the one-way MongoDB → MySQL migration (its §5 is the operator procedure cited from `server/src/db/migrate/mongo-to-mysql/index.js`).                                                       |
| [`database/PHASE-6-MIGRATION-RUNBOOK.md`](./database/PHASE-6-MIGRATION-RUNBOOK.md)                                                     | Operator runbook: dry run → apply (two acknowledgements) → re-run/ idempotency → rollback → verify → switch the app to MySQL.                                                                                                                                             |
| [`database/PHASE-7-OPS-RUNBOOK.md`](./database/PHASE-7-OPS-RUNBOOK.md)                                                                 | Which provider is live, startup/shutdown, switching, health checks, connection sizing, backups, migrations, common incidents, logs, `MYSQL_*` vs `MYSQL_TEST_*`.                                                                                                          |
| [`database/provider-default/PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md`](./database/provider-default/PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md) | Discovery for making MySQL the default: where the default was decided, every site that ran without `DATABASE_PROVIDER`, what would break, minimal file set.                                                                                                               |
| [`database/provider-default/PROVIDER-DEFAULT-HANDOVER.md`](./database/provider-default/PROVIDER-DEFAULT-HANDOVER.md)                   | **The newest document in the repository.** Provider resolution contract, runtime evidence for the default, explicit selection, unavailability behaviour, provider isolation in both directions, test matrix, byte-identical API snapshots, honest verification labelling. |

### 3.3 Verification and frontend rounds — `verification/`

| Report                                                                                                                               | What it covers                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`verification/VERIFICATION-REPORT.md`](./verification/VERIFICATION-REPORT.md)                                                       | Full regression audit: backend harness (56 checks), frontend harness (15), E2E (20), production build/runtime (9), security findings by severity, and what was explicitly **not** verified. |
| [`verification/storefront/STOREFRONT-UI-UX-REPORT.md`](./verification/storefront/STOREFRONT-UI-UX-REPORT.md)                         | Storefront UI/UX round: responsive layout, accessibility, stock display, component inventory, tests run and results.                                                                        |
| [`verification/storefront/STOREFRONT-CACHE-RESTORATION-REPORT.md`](./verification/storefront/STOREFRONT-CACHE-RESTORATION-REPORT.md) | Cache vs. state-restoration root cause and fix; freshness separated from UI restoration. **Contains superseded `?page=` claims — see its historical note.**                                 |
| [`verification/storefront/VIRTUALIZATION-COMPLETION-REPORT.md`](./verification/storefront/VIRTUALIZATION-COMPLETION-REPORT.md)       | Virtualization + state restoration completion: DOM budget, acceptance criteria, limitations. **Contains superseded `?page=` claims — see its historical note.**                             |

## 4. Screenshots

All screenshots are under [`assets/screenshots/`](./assets/screenshots/); the README embeds
eight current ones. Index and captions:
[`verification/README.md`](./verification/README.md#4-screenshots).

| Folder                       | Contents                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `assets/screenshots/`        | 8 current-era screenshots (1440×950 desktop, 390×844 mobile) of the storefront and the admin dashboard.                         |
| `assets/screenshots/legacy/` | 2 older 1280×900 screenshots from the modernization round, kept for provenance and deliberately **not** embedded in the README. |

Screenshots captured by the audit harnesses (`audit/screenshots/`, `audit/responsive/`) are
**build artifacts**: they are git-ignored and regenerated on every run, so they are not part
of this documentation tree.

## 5. Conventions used in this tree

1. **A report is dated by its content, not by the file timestamp.** Older reports describe the
   code as it was; they are never retro-edited.
2. **Superseded claims get a historical note, not a rewrite.** The note says what changed, when
   it was noticed, and where the current behaviour is documented.
3. **Verification statements are labelled.** "Executed" only means it was executed at the time
   that report was written. Anything not re-run is marked **NOT VERIFIED** — see
   [`verification/README.md`](./verification/README.md).
4. **No test counts are quoted in the current-facing documents.** Counts belong to the run that
   produced them; the suite inventory is stable, numbers are not.
