# Operations runbook — dual-provider storefront

Phase 7 deliverable. Covers day-two operations for **both** providers, the switch
between them, and the things that go wrong.

---

## 1. Which provider is live?

```bash
curl -s localhost:5000/api/v1/health | jq
# { "success": true, "message": "Service healthy",
#   "data": { "status": "ok", "uptimeSeconds": 42, "database": "connected", "environment": "production" } }
```

- **HTTP 200** with `"status": "ok"` → healthy.
- **HTTP 503** with `"status": "degraded"` → the process is up but the database is not
  connected. Take the instance out of rotation; it will recover on its own when the
  database returns.

The code is the contract, not the body: load balancers and Kubernetes probes read the
status code. (Phase 7 fixed a real defect here — the endpoint used to answer `200` with a
degraded body, because the response helper's default status silently overwrote the one set
by the route.)

Which database is behind it is decided by one variable:

```bash
echo $DATABASE_PROVIDER     # mysql (default) | mongodb — MongoDB must be explicit
```

Values are trimmed and case-normalised (`MySQL` == `mysql`). An unsupported value is fatal
at startup; there is no fallback to the other provider. Unset means **Oracle MySQL 8.0**.

The startup log line records the resolved provider _and its source_, together with the
capability probe:

```json
{"msg":"database provider resolved","provider":"mysql","source":"default"}
{"msg":"server listening","provider":"mysql","providerSource":"default","transactions":true,...}
{"msg":"database capabilities","provider":"mysql","transactions":true,"version":"8.0.44","storageEngine":"InnoDB"}
```

## 2. Startup and shutdown

```bash
npm --workspace server start                             # MySQL: the default
DATABASE_PROVIDER=mysql  npm --workspace server start    # explicit, identical result
DATABASE_PROVIDER=mongodb npm --workspace server start   # MongoDB, must be explicit
```

Unsuffixed commands assume a reachable Oracle MySQL 8.0 and the `MYSQL_*` variables. Every
deployment manifest should still pin `DATABASE_PROVIDER` explicitly rather than depend on
the default. If the selected database is unreachable **at boot**, startup fails fast with
exit `1` and an error naming the _selected_ provider (MySQL: names MySQL, `MYSQL_*`,
`host:port/database`, and states there is no fallback). If the database disappears **after**
a successful boot, the process stays up and `GET /api/v1/health` answers `503`.

Shutdown is graceful and idempotent (SIGINT/SIGTERM):

1. stop accepting connections and drain in-flight requests;
2. close the database handles — the MySQL pool is drained, so no server-side connection is
   left half-open and no pool slot leaks;
3. exit `0`. A stuck socket or a pool that refuses to drain forces `exit 1` after 15 s.

A second signal while shutting down is ignored on purpose (double-closing a pool during
drain is how a rolling restart produces a burst of `ECONNRESET`).

## 3. Switching provider

```bash
# MongoDB → MySQL
export DATABASE_PROVIDER=mysql
# schema first, then data (see PHASE-6-MIGRATION-RUNBOOK.md)
npm run db:migrate --workspace server
npm run migrate:data                                  # dry run, writes nothing
npm run migrate:data:apply -- --confirm=storefront --manifest=/var/backups/migration.json
npm run migrate:data:verify
# restart the server with DATABASE_PROVIDER=mysql
```

Switching back is a configuration change: `DATABASE_PROVIDER=mongodb` and restart. The API
contract is byte-identical on both (84/84 snapshot entries), so no client change is needed.

## 4. Health checks to wire into the platform

| Probe     | Command                       | Expected                                      | Meaning                                      |
| --------- | ----------------------------- | --------------------------------------------- | -------------------------------------------- |
| liveness  | `GET /api/v1/health`          | `200`                                         | process is alive and the DB is reachable     |
| readiness | same endpoint                 | `200` **and** `data.database === "connected"` | safe to send traffic                         |
| startup   | server log `server listening` | —                                             | repository registry is bound to the provider |

There is deliberately **no separate readiness endpoint**: `/api/v1/health` already reports the
database, and adding a second endpoint would create a second contract to keep in sync.

**Monitors must alert on the HTTP status code only** — `200` = healthy, `503` = degraded. The
body stays a success envelope even at `503`, so alerting on `success: true/false` inside the
body, or on `message`, will silently miss outages.

## 5. Connection sizing

| Provider | Setting                                  | Guidance                                                                                                                       |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| MySQL    | `MYSQL_CONNECTION_LIMIT` (default 10)    | `instances × limit ≤ max_connections × 0.8`. The sandbox server is configured with `max_connections=100`.                      |
| MongoDB  | driver pool (default 100, uncapped here) | keep the node count × pool under the cluster's connection budget; a replica set counts each connection twice during elections. |

A health probe never opens a connection: `/api/v1/health` reads cached provider state, so a
monitoring loop cannot exhaust `max_connections`. This is asserted by
`tests/integration/ops.mysql.test.js` (_"never opens a connection just to answer are we
connected"_).

## 6. Backups

Both providers must be backed up **by the same schedule** while both are in use; during and
after the switch the pre-migration MongoDB backup is the rollback of last resort.

```bash
# MongoDB (consistent snapshot of one database)
mongodump --uri="$MONGO_URI" --out=/var/backups/mongo-$(date +%F) --gzip

# MySQL (single transaction, routines/triggers included, no table locks)
mysqldump --single-transaction --routines --triggers --set-gtid-purged=OFF \
  -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -p \
  "$MYSQL_DATABASE" | gzip > /var/backups/mysql-$(date +%F).sql.gz
```

Restore drill (do this quarterly, on a scratch host):

```bash
gunzip -c /var/backups/mysql-2026-11-06.sql.gz | mysql -h "$MYSQL_HOST" -u root -p scratch_restore
mongorestore --uri="$MONGO_URI" --gzip --nsFrom='storefront.*' --nsTo='storefront_restore.*' /var/backups/mongo-2026-11-06
```

`.github/workflows/ci.yml` + `PHASE-6-MIGRATION-RUNBOOK.md` §5 describe the rollback path for a
migration; a backup restore is the fallback when the manifest is lost.

## 7. Migrations

```bash
npm run db:status --workspace server      # ledger + pending migrations
npm run db:migrate --workspace server     # apply pending (advisory-locked, idempotent)
npm run db:migrate:mysql:dry-run --workspace server
```

Destructive downgrades require `ALLOW_DESTRUCTIVE_MIGRATIONS=true` and refuse to run against
a database whose name does not end in `_test`.

## 8. Common incidents

| Symptom                                                                          | Likely cause                                             | Action                                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/api/v1/health` 503, `database: "disconnected"`                                 | database lost **after** boot, or wrong credentials       | check `MYSQL_*` or `MONGO_URI`; the server does not crash-loop by design                                   |
| startup fails with `REQUIRE_TRANSACTIONS=true but the … cannot run transactions` | MongoDB started standalone, or a non-InnoDB table exists | start the replica set; `SELECT table_name, engine FROM information_schema.tables WHERE engine <> 'InnoDB'` |
| `connect ECONNREFUSED 127.0.0.1:3399` in tests                                   | no local MySQL                                           | `bash /opt/dev-tools/provision-local-mysql8.sh`                                                            |
| `ER_LOCK_DEADLOCK` in logs                                                       | expected under concurrency, retried automatically        | if it escalates to a 409, the retry budget (`attempts`) was exhausted — reduce contention                  |
| `ER_TOO_MANY_USER_CONNECTIONS`                                                   | pool × instances exceeds `max_connections`               | shrink `MYSQL_CONNECTION_LIMIT`; check for leaked pools (`isPoolCreated()`)                                |
| ids look like Mongo ids but data is MySQL (or vice versa)                        | `DATABASE_PROVIDER` differs between processes            | pin it explicitly in every deployment manifest (unset = MySQL, MongoDB must be named)                      |
| startup exits with `DATABASE_PROVIDER: unsupported value …`                      | typo or an unsupported backend                           | use `mysql` or `mongodb`; the process refuses to guess and never falls back                                |
| startup exits with `MONGO_URI is required when DATABASE_PROVIDER=mongodb`        | MongoDB selected without a URI                           | set `MONGO_URI`, or unset `DATABASE_PROVIDER` to use MySQL                                                 |

## 9. Logs and metrics worth watching

- `mysql transaction retry` (warn) — deadlock absorption, expect a trickle under load;
- `shutdown initiated` / `shutdown complete` — every restart should contain both;
- `database capabilities` — once per boot; `transactions: false` is a red flag;
- response `requestId` — present on every payload, correlates client reports with logs.

## 10. Environment variables per context — `MYSQL_*` vs `MYSQL_TEST_*`

There are two families of names, and they are **not interchangeable**. What you must export
depends on which entry point you are running. Everything below is what the code actually does.

### 10.1 The application reads `MYSQL_*` only

`server/src/config/env.js` loads `server/.env` with `dotenv.config({ override: false })`, so a
real process/CI environment variable **always wins over the file**. It then validates:

| Variable                              | Default in `env.js` | Required when `DATABASE_PROVIDER=mysql`       |
| ------------------------------------- | ------------------- | --------------------------------------------- |
| `MYSQL_HOST`                          | `127.0.0.1`         | no                                            |
| `MYSQL_PORT`                          | `3306`              | no                                            |
| `MYSQL_USER`                          | — (unset)           | **yes**                                       |
| `MYSQL_PASSWORD`                      | `''` (empty)        | only when `NODE_ENV=production`               |
| `MYSQL_DATABASE`                      | — (unset)           | **yes**                                       |
| `MYSQL_CONNECTION_LIMIT`              | `10`                | no                                            |
| `MYSQL_QUERY_TIMEOUT_MS`              | `30000`             | no                                            |
| `MYSQL_SSL`                           | `false`             | no                                            |
| `MYSQL_ALLOWED_DESTRUCTIVE_DATABASES` | `''`                | no — allow-list for `db:down` / data rollback |

The API, `seed`, `db:migrate`, `migrate:data` and the audit scripts that boot the application
all read this family. **`MYSQL_TEST_*` is inert in every one of them.**

### 10.2 The vitest suites read `MYSQL_TEST_*` and alias it onto `MYSQL_*`

`server/tests/setup.js` runs before any test file imports `config/env.js` and does this, only
when `MYSQL_TEST_USER` is set:

```js
process.env.MYSQL_HOST = process.env.MYSQL_TEST_HOST ?? '127.0.0.1';
process.env.MYSQL_PORT = process.env.MYSQL_TEST_PORT ?? '3306';
process.env.MYSQL_USER = process.env.MYSQL_TEST_USER;
process.env.MYSQL_PASSWORD = process.env.MYSQL_TEST_PASSWORD ?? '';
process.env.MYSQL_DATABASE = process.env.MYSQL_TEST_DATABASE ?? 'storefront_it_test';
```

Consequences worth knowing:

- **Precedence: `MYSQL_TEST_*` wins over `MYSQL_*`** inside the test process — these are plain
  assignments, so an exported `MYSQL_USER` is overwritten whenever `MYSQL_TEST_USER` exists.
- No `MYSQL_TEST_USER` → the MySQL suites **skip**. `MYSQL_REQUIRE=1` turns that into a hard
  failure (`shouldSkipMysql()` throws), which is the CI posture so a skipped suite can never
  look green.
- The test database name must end with `_test` (`helpers/mysql.js` refuses anything else) and
  is created on demand; the migration runner resets its schema.

### 10.3 The E2E harness reads `MYSQL_*` — not `MYSQL_TEST_*`

`server/scripts/e2e-server.mjs` (spawned by `playwright.config.js`) requires, for the MySQL
run: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER` set **and** `MYSQL_DATABASE` ending in `_test`,
otherwise it refuses to start:

```
Refusing to run the MySQL E2E server against "<unset>": the database name must end with "_test".
```

`playwright.config.js` forwards `MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD /
MYSQL_DATABASE` to that process **only when `MYSQL_HOST` is already set** in your shell.

> **Paper-cut to avoid:** `MYSQL_TEST_*` alone is enough for `npm run test:mysql`, but **not**
> for `npm run test:e2e:mysql`. Exporting only `MYSQL_TEST_*` and then running the MySQL E2E
> suite fails at web-server start (observed). Export `MYSQL_*` for E2E, or export both — which
> is what the CI MySQL job does.

### 10.4 The API contract snapshot tool reads `MYSQL_TEST_*` and aliases it too

`audit/api-contract-snapshot.mjs` with `DATABASE_PROVIDER=mysql` requires
`MYSQL_TEST_USER` **and** `MYSQL_TEST_DATABASE` (exit code `2` with a message naming them),
then maps them onto `MYSQL_*` with the same defaults as §10.2 (`HOST` `127.0.0.1`, `PORT`
`3306`, `PASSWORD` `''`). Again `MYSQL_TEST_*` beats `MYSQL_*`.

### 10.5 Summary of precedence

| Context                                                   | Reads                      | Precedence                                                                      |
| --------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| API, seed, migrate, audits booting the app                | `MYSQL_*`                  | shell/CI env **>** `server/.env` (`dotenv override:false`); other names ignored |
| vitest (`test:mysql`, `test:contracts`, `test:migration`) | `MYSQL_TEST_*` → `MYSQL_*` | `MYSQL_TEST_*` **overwrites** `MYSQL_*`                                         |
| API contract snapshot (`DATABASE_PROVIDER=mysql`)         | `MYSQL_TEST_*` → `MYSQL_*` | `MYSQL_TEST_*` **overwrites** `MYSQL_*`                                         |
| E2E (`npm run test:e2e:mysql`)                            | `MYSQL_*`                  | shell env only; `MYSQL_TEST_*` is ignored                                       |

The CI MySQL job therefore exports `MYSQL_HOST`/`MYSQL_PORT` **and** all five `MYSQL_TEST_*`
values, pointing both families at the same service container — one export satisfies every
context above.
