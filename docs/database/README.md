# Database: dual-provider architecture, migrations and operations

> **Status of this document.** Page written 2026-11-06 during the documentation consolidation,
> from `server/src/config/env.js`, `server/src/db/**`, `server/scripts/**` and the
> `package.json` scripts. It states the **current** contract. The historical reports behind it
> are linked at the bottom and are preserved verbatim — including the earlier period in which
> MongoDB was described as the reference implementation.

---

## 1. The contract in one paragraph

Two storage backends are first-class and fully supported: **Oracle MySQL 8.0** and
**MongoDB**. **MySQL is the default**: when `DATABASE_PROVIDER` is unset or empty the
application selects MySQL and logs `provider: mysql, source: default`. MongoDB is equally
supported but must be selected explicitly. Switching provider is **configuration only — never a
code change**. An unsupported value is **fatal at startup**; there is no fallback from one
provider to the other.

## 2. Resolution rules

| `DATABASE_PROVIDER`       | Selected                                       | Reported source |
| ------------------------- | ---------------------------------------------- | --------------- |
| unset / empty             | `mysql`                                        | `default`       |
| `mysql`, `MySQL`, `mySQL` | `mysql`                                        | `environment`   |
| `mongodb`, `MongoDB`      | `mongodb`                                      | `environment`   |
| anything else             | **startup fails** (lists the supported values) | —               |

- Values are trimmed and case-normalised.
- The resolved provider **and where it came from** are logged once at boot
  (`{"msg":"database provider resolved","provider":"mysql","source":"default"}`) and again on
  the `server listening` line as `providerSource`. Credentials and connection strings are never
  logged.
- **Only the selected provider is initialised.** With MySQL selected no Mongoose connection is
  opened; with MongoDB selected no MySQL pool is created. Both directions are covered by the
  test suite (see the provider-default handover).

## 3. Selecting a provider without editing files

`server/scripts/with-env.mjs` is a Node launcher, so the same command works in PowerShell,
`cmd` and bash — no `VAR=value` prefix syntax required.

| Purpose                                          | Command                                                        |
| ------------------------------------------------ | -------------------------------------------------------------- |
| development, both processes, **MySQL** (default) | `npm run dev`                                                  |
| development, MySQL forced                        | `npm run dev:mysql`                                            |
| development, MongoDB forced                      | `npm run dev:mongodb`                                          |
| production-style start                           | `npm start` / `npm run start:mysql` / `npm run start:mongodb`  |
| seed                                             | `npm run seed` / `npm run seed:mysql` / `npm run seed:mongodb` |
| E2E suite                                        | `npm run test:e2e` / `:mysql` / `:mongodb`                     |

Tests never rely on the default: the server suite pins `DATABASE_PROVIDER=mongodb`, the MySQL
suites pin `mysql`, and the audit/E2E harnesses pass the provider they need explicitly.

## 4. When the database is not there

| Situation                                 | Behaviour                                                                                                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unreachable at boot (either provider)     | Startup fails fast, exit code `1`; the message names the **selected** provider, the relevant variables and `host:port/database`, mentions the alternative provider, and states that there is no fallback.                                           |
| Lost **after** a successful boot          | The process keeps running; `GET /api/v1/health` answers **`503`** with `database: "disconnected"`. It deliberately does not crash-loop, so a platform probe can restart it.                                                                         |
| Long-lived `mongod` without a replica set | The capability probe reports `transactions: false`. The inventory path needs no multi-document transactions (guarded single-document updates + optimistic concurrency), so this is fine; set `REQUIRE_TRANSACTIONS=true` to refuse to boot instead. |

`/health` returning `503` was an **approved contract change** in Phase 7 (previously it
answered `200` with `status: degraded` in the body). Orchestrators key off the status code.

## 5. MySQL specifics

- **Version floor: MySQL 8.0 only** — no MariaDB. Schema uses `CHAR(24) ascii_bin` ids,
  `utf8mb4_bin` for case-sensitive name/slug comparisons, `DECIMAL(12,2)` prices, `DATETIME(3)`
  timestamps, composite indexes that lead with `is_active` for the storefront sorts (newest,
  price asc/desc, brand, category), a `FULLTEXT` index for text search, and `CHECK` constraints
  on price, stock, role and counters.
- **Least privilege, two users:**

  | User                  | Privileges                                         | Used by                                           |
  | --------------------- | -------------------------------------------------- | ------------------------------------------------- |
  | `storefront_app`      | `SELECT, INSERT, UPDATE, DELETE` on the app schema | the running API                                   |
  | `storefront_migrator` | DDL + DML on the same schema                       | `db:migrate`, the migration tool, the test suites |

  Pass the migrator per command (`$env:MYSQL_USER='storefront_migrator'; npm run db:migrate`)
  rather than storing it in the runtime `.env`.

- **Migrations** live in `server/src/db/mysql/migrations/*.sql` with matching `*.down.sql`.

  | Command                      | Effect                                                                                                                                                                          |
  | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `npm run db:migrate`         | apply pending migrations                                                                                                                                                        |
  | `npm run db:migrate:dry-run` | print what would run, write nothing                                                                                                                                             |
  | `npm run db:status`          | applied / pending / checksum state                                                                                                                                              |
  | `npm run db:down`            | **destructive** rollback — refused unless `ALLOW_DESTRUCTIVE_MIGRATIONS=true` **and** the target database ends in `_test` or is listed in `MYSQL_ALLOWED_DESTRUCTIVE_DATABASES` |

- **Configuration keys:** `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`,
  `MYSQL_DATABASE`, `MYSQL_CONNECTION_LIMIT`, `MYSQL_QUERY_TIMEOUT_MS`, `MYSQL_SSL`.

## 6. Seeding

`npm run seed` is idempotent and provider-neutral: **6 brands, 6 categories, 22 products and
one administrator** (`admin@catalogue.com`, flagged `mustChangePassword`, so the first sign-in
forces a rotation). Product images are generated placeholders (sharp → webp) written under
`server/uploads/products/`, which is git-ignored. Seeding refuses to run in `production`
(`SEED_FORBIDDEN_ENVIRONMENT`). `node server/scripts/reset-admin.mjs` restores the known dev
credentials and is dev/test only.

## 7. MongoDB → MySQL data migration

One-way, dry-run by default, never the upgrade path for production data.

| Command                         | Effect                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `npm run migrate:data`          | **dry run** (default): read, validate, diff — writes nothing, not even a manifest |
| `npm run migrate:data:apply`    | performs the writes; requires `--confirm <database>` matching the live target     |
| `npm run migrate:data:verify`   | re-reads source and target and compares                                           |
| `npm run migrate:data:rollback` | undoes a run recorded in a manifest; also requires `--confirm`                    |

Validation runs **entirely before the first INSERT**, so an orphaned reference aborts with the
target untouched; the tool refuses to write into a target holding rows the source does not know
about unless `allowNonEmpty` is set, and it never deletes. Full operator procedure:
[`PHASE-6-MIGRATION-RUNBOOK.md`](./PHASE-6-MIGRATION-RUNBOOK.md); design and acceptance:
[`PHASE-6-REPORT.md`](./PHASE-6-REPORT.md) (§5 is the section cited from
`server/src/db/migrate/mongo-to-mysql/index.js`).

## 8. Testing matrix (what runs against which provider)

| Suite                                                                                 | Provider                                     | Command                                                                                                             | Needs a server?                                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| server unit + integration                                                             | MongoDB (in-memory, `mongodb-memory-server`) | `npm run test:server`                                                                                               | no                                                                                 |
| MySQL foundation / repositories / contracts / capabilities / concurrency / seed / ops | MySQL 8.0                                    | `npm run test:mysql`                                                                                                | **yes** — and `MYSQL_REQUIRE=1` turns "no server" into a failure instead of a skip |
| migration suite                                                                       | MySQL 8.0                                    | `npm run test:migration`                                                                                            | **yes**                                                                            |
| contract parity                                                                       | both                                         | `npm run test:contracts`, plus `audit/api-contract-snapshot.mjs` on each provider and `audit/api-contract-diff.mjs` | yes for MySQL                                                                      |
| E2E                                                                                   | either, chosen explicitly                    | `npm run test:e2e[:mysql                                                                                            | :mongodb]`                                                                         | yes |

## 9. Environment variables — `MYSQL_*` vs `MYSQL_TEST_*`

`MYSQL_*` configures the **running API**. `MYSQL_TEST_*` configures the **test suites**
(`MYSQL_TEST_HOST/PORT/USER/PASSWORD/DATABASE`, plus `MYSQL_REQUIRE`). They are deliberately
separate so a test run can never be pointed at the application schema by accident. The MySQL
suites **skip** when `MYSQL_TEST_*` is absent; `MYSQL_REQUIRE=1` makes a skip impossible.

## 10. Operations

Startup/shutdown, switching provider under load, connection sizing, backups, common incidents
and the log lines worth watching: [`PHASE-7-OPS-RUNBOOK.md`](./PHASE-7-OPS-RUNBOOK.md).

## 11. History of this contract

1. The system was MongoDB-first; the dual-provider programme extracted repositories
   (`implementation/phases/PHASE-2-REPORT.md`), built the MySQL foundation and repositories
   (`PHASE-3`, `PHASE-4`), pinned parity (`PHASE-5`), added the one-way migration (`PHASE-6`)
   and hardened operations (`PHASE-7`).
2. **MySQL then became the default**, which is the newest change and the reason several
   old reports describe MongoDB as the reference implementation:
   [`provider-default/PROVIDER-DEFAULT-HANDOVER.md`](./provider-default/PROVIDER-DEFAULT-HANDOVER.md)
   (evidence, matrix, honest labelling) and
   [`provider-default/PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md`](./provider-default/PROVIDER-DEFAULT-PHASE-0-DISCOVERY.md)
   (where the default is decided, what would break).

Reports written before step 2 are correct for their date and are **not** rewritten.
