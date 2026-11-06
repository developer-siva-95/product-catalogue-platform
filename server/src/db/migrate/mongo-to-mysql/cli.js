import path from 'node:path';
import { pathToFileURL } from 'node:url';
import env from '../../../config/env.js';
import logger from '../../../utils/logger.js';
import { connectDB, disconnectDB } from '../../../config/db.js';
import { closePool } from '../../mysql/pool.js';
import { migrate, rollback, verify } from './index.js';

/**
 * CLI for the one-way MongoDB → MySQL data migration.
 *
 *   npm run migrate:data            # dry run: reads, validates, diffs, writes nothing
 *   npm run migrate:data:apply      # requires --confirm <database>
 *   npm run migrate:data:verify     # verification only
 *   npm run migrate:data:rollback   # requires --confirm <database> and a manifest
 *
 * The dry run is the default *by design*: the destructive path has to be named
 * explicitly, twice (a flag and a confirmation token that must equal the live
 * database name).
 */

/** @param {string[]} argv @returns {Record<string, string|boolean>} */
export function parseArgs(argv) {
  const args = {};

  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [flag, ...rest] = raw.slice(2).split('=');
    const value = rest.join('=');
    args[flag] = value === '' ? true : (value ?? true);
  }

  return args;
}

const USAGE = `
MongoDB → MySQL data migration (one-way).

  node src/db/migrate/mongo-to-mysql/cli.js [options]

  --dry-run                 read + validate + diff only (default)
  --apply                   write to MySQL; requires --confirm <database>
  --confirm=<database>      acknowledgement token; must equal the target database
  --verify                  run verification (after apply, or standalone)
  --quarantine=<file>       skip rows that cannot be migrated and record them
  --round-decimals          accept DECIMAL(12,2) rounding (reported, not hidden)
  --allow-non-empty         write even though the target has rows the source lacks
  --manifest=<file>         where the apply manifest is written (default: /tmp)
  --rollback                undo the run recorded in --manifest (requires --confirm)
  --delete-inserted=false   rollback: keep inserted rows
  --restore-updated=false   rollback: do not restore updated rows

Destructive flags (--apply, --rollback) never act without a matching --confirm.
`.trim();

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const manifestPath = String(
    args.manifest ?? path.join('/tmp', `migration-manifest-${Date.now()}.json`),
  );

  await connectDB();
  try {
    if (args.rollback) {
      const result = await rollback({
        manifestPath,
        confirm: typeof args.confirm === 'string' ? args.confirm : '',
        deleteInserted: args['delete-inserted'] !== 'false',
        restoreUpdated: args['restore-updated'] !== 'false',
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    if (args.verify && !args.apply) {
      const report = await verify();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.passed ? 0 : 1;
    }

    const summary = await migrate({
      apply: Boolean(args.apply),
      confirm: typeof args.confirm === 'string' ? args.confirm : '',
      allowQuarantine: Boolean(args.quarantine),
      quarantinePath: typeof args.quarantine === 'string' ? args.quarantine : undefined,
      acceptRoundedDecimals: Boolean(args['round-decimals']),
      allowNonEmpty: Boolean(args['allow-non-empty']),
      verify: args.verify !== false && Boolean(args.apply),
      manifestPath: args.apply ? manifestPath : undefined,
    });

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.ok) return 1;
    if (summary.verification && !summary.verification.passed) return 1;
    return 0;
  } finally {
    await disconnectDB();
    await closePool().catch(() => {});
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      logger.error('migration failed', { err: error, provider: env.DATABASE_PROVIDER });
      process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
      process.exitCode = 1;
    });
}
