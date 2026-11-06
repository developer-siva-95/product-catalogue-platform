import fs from 'node:fs/promises';
import path from 'node:path';
import env from '../../../config/env.js';
import { query, withTransaction } from '../../mysql/pool.js';
import { TABLES } from './mapping.js';
import { extractDocuments, mapRows } from './extract.js';
import { QUARANTINABLE, validate } from './validate.js';
import { applyPlan, diffAgainstTarget } from './apply.js';
import { verifyMigration } from './verify.js';

export { verifyMigration };

/**
 * One-way MongoDB → MySQL data migration.
 *
 * Safety model (see `docs/database/PHASE-6-REPORT.md` §5 for the operator procedure):
 *  - the **default mode is a dry run**; it reads, validates and diffs, and writes
 *    nothing at all — not even a manifest;
 *  - validation happens *entirely before* the first INSERT, so an orphaned
 *    reference aborts the run with the database untouched;
 *  - writes require `apply: true` **and** a confirmation token equal to the
 *    target database name, so pointing the tool at the wrong database fails
 *    rather than truncating something;
 *  - the tool refuses to write into a target that holds rows the source does not
 *    know about unless `allowNonEmpty` is set: it never deletes, but it will not
 *    silently mix two catalogues either;
 *  - rollback is a separate, separately-confirmed command driven by the manifest
 *    the apply run wrote.
 */

/** @returns {Promise<string>} the database the pool is actually connected to */
export async function currentDatabase() {
  const [row] = await query('SELECT DATABASE() AS name');
  return row?.name ?? '';
}

/** Guards every write. The token must equal the connected database name. */
export function assertDestructiveConfirmation(confirmation, database) {
  if (!confirmation) {
    const error = new Error(
      `Refusing to write: pass --confirm ${database} to acknowledge that this modifies "${database}".`,
    );
    error.code = 'MIGRATION_CONFIRMATION_REQUIRED';
    throw error;
  }
  if (confirmation !== database) {
    const error = new Error(
      `Confirmation "${confirmation}" does not match the connected database "${database}". Refusing to write.`,
    );
    error.code = 'MIGRATION_CONFIRMATION_MISMATCH';
    throw error;
  }

  return true;
}

/**
 * Reads, maps and validates. Never writes.
 *
 * @param {{quarantinePath?: string, allowQuarantine?: boolean, acceptRoundedDecimals?: boolean}} [options]
 */
export async function prepareMigration(options = {}) {
  const { documents, counts } = await extractDocuments();
  const { rows, documents: sourceDocs } = mapRows(documents);

  const validation = validate({ documents: sourceDocs, rows });

  // Which findings are acceptable, and on what terms.
  const tolerated = validation.findings.filter((finding) => {
    if (!finding.fatal) return true;
    if (options.acceptRoundedDecimals && finding.code === 'DECIMAL_PRECISION' && finding.details) {
      return true;
    }
    if (options.allowQuarantine && QUARANTINABLE.has(finding.code)) return true;
    return false;
  });

  const blocking = validation.fatal.filter((finding) => !tolerated.includes(finding));

  // Rows to exclude when quarantining is permitted.
  const rejected = new Map();
  if (options.allowQuarantine) {
    for (const finding of tolerated) {
      if (finding.index === undefined) continue;
      const key = `${finding.collection}#${finding.index}`;
      if (!rejected.has(key)) {
        rejected.set(key, { collection: finding.collection, id: finding.id, findings: [] });
      }
      rejected.get(key).findings.push({ code: finding.code, message: finding.message });
    }
  }

  const acceptedRows = {};
  const acceptedDocuments = {};
  for (const spec of TABLES) {
    // Rows and documents are filtered by the same index, so verification compares
    // the *accepted* subset against the target (a quarantined row must not look
    // like a missing row later).
    acceptedRows[spec.collection] = (rows[spec.collection] ?? []).filter(
      (_row, index) => !rejected.has(`${spec.collection}#${index}`),
    );
    acceptedDocuments[spec.collection] = (sourceDocs[spec.collection] ?? []).filter(
      (_doc, index) => !rejected.has(`${spec.collection}#${index}`),
    );
  }

  // A rejection that leaves a child row pointing at a removed parent is fatal:
  // quarantine must never manufacture an orphan.
  if (options.allowQuarantine && rejected.size) {
    const removedIds = new Set();
    for (const entry of rejected.values()) removedIds.add(`${entry.collection}:${entry.id}`);

    for (const spec of TABLES) {
      for (const reference of spec.references ?? []) {
        for (const row of acceptedRows[spec.collection]) {
          if (removedIds.has(`${reference.table}:${row[reference.column]}`)) {
            const error = new Error(
              `Quarantining ${reference.table} row ${row[reference.column]} would orphan ${spec.collection} row ${row.id}. Refusing.`,
            );
            error.code = 'QUARANTINE_WOULD_ORPHAN';
            throw error;
          }
        }
      }
    }
  }

  return {
    counts,
    validation: { ...validation, tolerated, blocking },
    rejected: [...rejected.values()],
    rows: acceptedRows,
    sourceDocuments: acceptedDocuments,
  };
}

/**
 * Runs the migration.
 *
 * @param {object} [options]
 * @param {boolean} [options.apply] perform the writes (default: dry run)
 * @param {string} [options.confirm] must equal the connected database name
 * @param {boolean} [options.allowQuarantine] skip-and-record rejected rows
 * @param {string} [options.quarantinePath] where the rejection report is written
 * @param {boolean} [options.acceptRoundedDecimals] accept 2dp rounding
 * @param {boolean} [options.allowNonEmpty] write even though the target has extra rows
 * @param {boolean} [options.verify] run verification after applying (default true)
 * @param {string} [options.manifestPath] where the apply manifest is written
 */
export async function migrate(options = {}) {
  const database = await currentDatabase();
  if (options.apply) assertDestructiveConfirmation(options.confirm, database);

  const prepared = await prepareMigration(options);

  if (prepared.validation.blocking.length) {
    return {
      ok: false,
      mode: 'dry-run',
      database,
      stage: 'validation',
      findings: prepared.validation.blocking,
      quarantined: prepared.rejected,
    };
  }

  const plan = await diffAgainstTarget(prepared.rows);

  if (options.apply && plan.totals.orphaned > 0 && !options.allowNonEmpty) {
    const error = new Error(
      `Target "${database}" holds ${plan.totals.orphaned} row(s) the source knows nothing about. ` +
        'This tool never deletes; pass --allow-non-empty to write anyway.',
    );
    error.code = 'TARGET_NOT_EMPTY';
    throw error;
  }

  const summary = {
    ok: true,
    mode: options.apply ? 'apply' : 'dry-run',
    database,
    provider: env.DATABASE_PROVIDER,
    sourceCounts: prepared.counts,
    quarantined: prepared.rejected,
    tolerated: prepared.validation.tolerated.map((finding) => ({
      code: finding.code,
      collection: finding.collection,
      id: finding.id,
      message: finding.message,
    })),
    plan: plan.tables.map((table) => ({
      table: table.table,
      inserted: table.inserted,
      updated: table.updated,
      unchanged: table.unchanged,
      orphaned: table.orphaned,
    })),
    totals: plan.totals,
  };

  if (options.quarantinePath && prepared.rejected.length) {
    await fs.mkdir(path.dirname(options.quarantinePath), { recursive: true });
    await fs.writeFile(
      options.quarantinePath,
      `${JSON.stringify({ database, generatedAt: new Date().toISOString(), rejected: prepared.rejected }, null, 2)}\n`,
    );
    summary.quarantineFile = options.quarantinePath;
  }

  if (!options.apply) return summary;

  const applied = await applyPlan(plan);
  summary.applied = { inserted: applied.inserted, updated: applied.updated };

  if (options.manifestPath) {
    await fs.mkdir(path.dirname(options.manifestPath), { recursive: true });
    await fs.writeFile(
      options.manifestPath,
      `${JSON.stringify({ ...applied.manifest, database }, null, 2)}\n`,
    );
    summary.manifestFile = options.manifestPath;
  }

  if (options.verify !== false) {
    summary.verification = await verifyMigration(
      { documents: prepared.sourceDocuments, rows: prepared.rows },
      { sampleSize: options.sampleSize ?? 25 },
    );
  }

  return summary;
}

/**
 * Rollback, driven by the manifest the apply run wrote.
 *
 * Two operations, in reverse foreign-key order:
 *  1. rows inserted by that run are deleted;
 *  2. rows that run updated are restored to their recorded before-image.
 *
 * Nothing else is touched, and the whole rollback runs in one transaction, so a
 * failure leaves the target exactly as it was.
 *
 * @param {{manifestPath: string, confirm: string, deleteInserted?: boolean, restoreUpdated?: boolean}} options
 */
export async function rollback(options) {
  const database = await currentDatabase();
  assertDestructiveConfirmation(options.confirm, database);

  const manifest = JSON.parse(await fs.readFile(options.manifestPath, 'utf8'));
  if (manifest.database && manifest.database !== database) {
    const error = new Error(
      `Manifest was written for database "${manifest.database}", but this connection points at "${database}". Refusing.`,
    );
    error.code = 'ROLLBACK_MANIFEST_MISMATCH';
    throw error;
  }

  const deleted = {};
  const restored = {};
  const deleteInserted = options.deleteInserted !== false;
  const restoreUpdated = options.restoreUpdated !== false;

  await withTransaction(async (connection) => {
    // Children before parents.
    for (const spec of [...TABLES].reverse()) {
      const record = manifest.tables?.[spec.table];
      if (!record) continue;
      deleted[spec.table] = 0;
      restored[spec.table] = 0;

      if (restoreUpdated && record.updated?.length) {
        const updateColumns = spec.columns.filter((column) => column !== 'id');
        for (const entry of record.updated) {
          await connection.query(
            `UPDATE ${spec.table} SET ${updateColumns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`,
            [...updateColumns.map((column) => entry.before[column] ?? null), entry.id],
          );
          restored[spec.table] += 1;
        }
      }

      if (deleteInserted && record.inserted?.length) {
        const placeholders = record.inserted.map(() => '?').join(', ');
        const result = await connection.query(
          `DELETE FROM ${spec.table} WHERE id IN (${placeholders})`,
          record.inserted,
        );
        deleted[spec.table] += Number(result?.[0]?.affectedRows ?? 0);
      }
    }
  });

  return { ok: true, database, manifest: options.manifestPath, deleted, restored };
}

/** Convenience wrapper used by the CLI's `--check` mode and by the tests. */
export async function verify(documentsInput, options = {}) {
  const extracted = documentsInput ?? (await extractDocuments());
  const mapped = extracted.rows ? extracted : mapRows(extracted.documents);
  return verifyMigration(mapped, options);
}

export { TABLES };
