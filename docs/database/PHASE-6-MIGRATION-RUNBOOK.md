# MongoDB → MySQL migration — operator runbook

One-way data migration (`MongoDB` → `MySQL`). Phase 6 deliverable.
Implementation: `server/src/db/migrate/mongo-to-mysql/`. Tests: `server/tests/integration/migration.test.js`.

> **Nothing in this document is safe to run against a database you care about without a backup.**
> Every destructive step is listed with the confirmation it demands and the way to undo it.

---

## 1. Prerequisites

```bash
# 1. Target schema (never touches data)
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3399 MYSQL_USER=storefront_migrator MYSQL_PASSWORD=... \
MYSQL_DATABASE=storefront node server/src/db/mysql/migrate.js up

# 2. Both databases reachable; the tool reads Mongo and writes MySQL in one run
export MONGO_URI='mongodb://127.0.0.1:27017/catalogue'
export MYSQL_HOST=127.0.0.1 MYSQL_PORT=3399 MYSQL_USER=storefront_migrator \
       MYSQL_PASSWORD=... MYSQL_DATABASE=storefront
```

The tool connects to **both** databases on purpose: it is the only component that is
allowed to be dual-provider, because moving data between the two is its entire job.

## 2. Dry run (default, writes nothing)

```bash
npm run migrate:data            # == cli.js --dry-run
```

It reads every collection, maps each document to a MySQL row, validates, and diffs against
the target. **No INSERT, UPDATE, DELETE or manifest write happens** — the test suite asserts
this by counting rows before and after (`dry-runs without writing a single row`).

The JSON summary reports:

| Field                               | Meaning                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| `sourceCounts`                      | documents found per collection                                |
| `plan[].inserted/updated/unchanged` | what an apply _would_ do                                      |
| `plan[].orphaned`                   | target rows the source knows nothing about (never deleted)    |
| `tolerated`                         | findings accepted by an explicit flag (e.g. rounded decimals) |
| `quarantined`                       | rows that would be skipped, with the reason for each          |
| `ok`                                | `false` when a blocking finding exists (exit code 1)          |

### Finding codes

| Code                | Meaning                                                        | Default   | Flag to accept                       |
| ------------------- | -------------------------------------------------------------- | --------- | ------------------------------------ |
| `ORPHAN_REFERENCE`  | product points at a brand/category that does not exist         | **fatal** | `--quarantine=<file>`                |
| `MISSING_REQUIRED`  | a NOT NULL column has no source value                          | **fatal** | `--quarantine=<file>`                |
| `UNIQUE_COLLISION`  | two rows normalise to the same UNIQUE key                      | **fatal** | `--quarantine=<file>`                |
| `DECIMAL_PRECISION` | price needs more than 2 decimals, or exceeds DECIMAL(12,2)     | **fatal** | `--quarantine` or `--round-decimals` |
| `DATE_OUT_OF_RANGE` | timestamp outside MySQL `DATETIME` (1000-01-01 … 9999-12-31)   | **fatal** | `--quarantine=<file>`                |
| `STRING_TOO_LONG`   | value longer than the column                                   | **fatal** | `--quarantine=<file>`                |
| `VALUE_INVALID`     | wrong type / negative integer                                  | **fatal** | `--quarantine=<file>`                |
| `ID_INVALID`        | `_id` is not 24 lowercase hex characters (cannot be preserved) | **fatal** | `--quarantine=<file>`                |

Validation runs **entirely before the first INSERT**. A run with any blocking finding leaves
the target byte-identical to how it was found.

## 3. Apply (destructive — two explicit acknowledgements)

```bash
npm run migrate:data:apply -- --confirm=storefront --manifest=/var/backups/migration-$(date +%s).json
```

- `--apply` alone is **not enough**. The `--confirm` token must equal the database the pool is
  actually connected to (`SELECT DATABASE()`), so a stale `MYSQL_DATABASE` in the environment
  fails loudly instead of migrating into the wrong database.
- Rows are inserted **parents first** (brands → categories → products → users), each chunk of
  200 inside one InnoDB transaction.
- Nothing is ever deleted. If the target already holds rows the source does not know about,
  the run refuses with `TARGET_NOT_EMPTY`; `--allow-non-empty` acknowledges the mixing.
- The manifest written at `--manifest` is the rollback input. **Keep it.**
- Verification (counts, samples, foreign keys, uniques, decimals, dates, nulls) runs
  automatically afterwards; a failed check exits non-zero.

### Quarantine (explicit row loss)

```bash
npm run migrate:data:apply -- --confirm=storefront \
  --quarantine=/var/backups/quarantine-$(date +%s).json
```

Each skipped row is written to that file with the exact reason. A quarantined row that would
leave a child pointing at a missing parent aborts the run (`QUARANTINE_WOULD_ORPHAN`): the
tool will not manufacture the very orphans it exists to detect.

## 4. Re-running (idempotency)

Applying twice is safe and expected:

```bash
npm run migrate:data      # → inserted: 0, updated: 0, unchanged: N
```

Rows are matched by preserved `_id`, compared column by column, and only written when a value
actually differs. A second run therefore touches no row and no `updated_at` — asserted by the
test suite (`applies, verifies, and is idempotent on the second run`).

## 5. Rollback

Rollback is driven by the manifest of one specific apply run, and it is confined to that run:

- rows **inserted** by that run are deleted;
- rows **updated** by that run are restored to their recorded before-image;
- everything else is untouched;
- the whole rollback happens in **one transaction**, in reverse foreign-key order
  (users → products → categories → brands), so a failure leaves the target unchanged.

```bash
# 1. See what the manifest covers (no database access at all)
node -e "const m=require('/var/backups/migration-XXXX.json'); console.log(Object.fromEntries(Object.entries(m.tables).map(([t,v])=>[t,{inserted:v.inserted.length,updated:v.updated.length}])))"

# 2. Roll back — refuses without the exact database name
npm run migrate:data:rollback -- --confirm=storefront --manifest=/var/backups/migration-XXXX.json
```

Guards:

| Situation                                               | Result                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `--confirm` missing or not equal to `SELECT DATABASE()` | `MIGRATION_CONFIRMATION_REQUIRED` / `MIGRATION_CONFIRMATION_MISMATCH`, exit 1, no writes |
| manifest written for a different database               | `ROLLBACK_MANIFEST_MISMATCH`, exit 1, no writes                                          |
| manifest missing/unreadable                             | command fails before touching the database                                               |
| `--delete-inserted=false`                               | keeps the inserted rows, restores only updated ones                                      |
| `--restore-updated=false`                               | deletes the inserted rows, leaves updates in place                                       |

### What rollback does **not** do

- It does not drop the schema — that is `node src/db/mysql/migrate.js down`, a separate,
  separately destructive command guarded by `ALLOW_DESTRUCTIVE_MIGRATIONS`.
- It does not resurrect rows the _source_ lost after the migration.
- It cannot restore a quarantined row: those were never written. The quarantine file is the
  record of what was skipped, and it must be kept with the manifest.

### Full disaster recovery (schema + data)

Only with a verified backup and an explicit decision:

```bash
# 1. Restore the pre-migration dump (your DBA's responsibility, not this tool's)
# 2. Re-run the migration
npm run migrate:data                      # dry run — expect 0 blocking findings
npm run migrate:data:apply -- --confirm=storefront --manifest=/var/backups/migration-retry.json
```

## 6. Verifying a completed migration

```bash
npm run migrate:data:verify     # standalone: no writes, exit 1 on any failed check
```

| Check                     | Compares                                                    |
| ------------------------- | ----------------------------------------------------------- |
| `record-counts`           | source documents vs target rows, per collection             |
| `sample-equality`         | every mapped column for a spread sample, source vs target   |
| `foreign-keys`            | target products → brands/categories exist                   |
| `unique-constraints`      | no duplicate slug/sku/email/name_normalized in the target   |
| `decimal-precision`       | every price equals its 2-decimal rounding; min/max reported |
| `date-time-conversion`    | null counts and min/max per timestamp column                |
| `null-and-missing-fields` | NULL counts per column match the source exactly             |

## 7. Switching the application to MySQL

```bash
DATABASE_PROVIDER=mysql npm --workspace server start   # or: npm run dev:mysql
```

No source change, no rebuild of the client, no API contract change: the Phase 2/4/5 snapshot
comparison holds the two providers byte-identical.
