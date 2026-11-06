import { query, withTransaction } from '../../mysql/pool.js';
import { TABLES, normaliseForComparison } from './mapping.js';

/**
 * Diffing and writing for the MongoDB → MySQL migration.
 *
 * The write path is deliberately boring:
 *  - **idempotent**: a row is inserted only when its id is absent, updated only
 *    when a column differs, and left alone otherwise. A second run therefore
 *    reports `inserted: 0, updated: 0` and touches no DATETIME;
 *  - **additive**: nothing is ever deleted here. Removing rows is the rollback
 *    command's job, and that one demands an explicit confirmation;
 *  - **transactional**: each chunk of a table is written inside one InnoDB
 *    transaction, parents before children, so a crash never leaves a dangling
 *    foreign key behind.
 */

const CHUNK_SIZE = 200;

/** Columns a diff can compare (everything except the primary key). */
function comparableColumns(spec) {
  return spec.columns.filter((column) => column !== 'id');
}

/** Normalises one stored row (from either driver) into comparable primitives. */
export function normaliseRow(spec, row) {
  /** @type {Record<string, unknown>} */
  const normalised = { id: row.id };
  for (const column of comparableColumns(spec)) {
    const kind = spec.dates.includes(column)
      ? 'date'
      : spec.decimals.includes(column)
        ? 'decimal'
        : spec.booleans.includes(column)
          ? 'boolean'
          : typeof row[column] === 'number'
            ? 'int'
            : 'text';
    normalised[column] = normaliseForComparison(row[column], kind);
  }
  return normalised;
}

/**
 * Computes what an apply would do, without doing it.
 *
 * @param {Record<string, object[]>} rows mapped source rows per collection
 * @returns {Promise<{tables: object[], totals: {inserted: number, updated: number, unchanged: number, orphaned: number}}>}
 */
export async function diffAgainstTarget(rows) {
  const tables = [];

  for (const spec of TABLES) {
    const source = rows[spec.collection] ?? [];
    const existing = await query(`SELECT ${spec.columns.join(', ')} FROM ${spec.table}`);
    const targetById = new Map(existing.map((row) => [row.id, row]));

    const inserts = [];
    const updates = [];

    for (const row of source) {
      const current = targetById.get(row.id);
      if (!current) {
        inserts.push(row);
        continue;
      }

      const before = normaliseRow(spec, current);
      const after = normaliseRow(spec, row);
      const changed = comparableColumns(spec).filter((column) => before[column] !== after[column]);

      if (changed.length) updates.push({ row, before: current, changed });
      targetById.delete(row.id);
    }

    tables.push({
      table: spec.table,
      inserted: inserts.length,
      updated: updates.length,
      unchanged: source.length - inserts.length - updates.length,
      // Rows in the target that the source knows nothing about. Never deleted.
      orphaned: targetById.size,
      inserts,
      updates,
    });
  }

  const totals = tables.reduce(
    (accumulator, table) => ({
      inserted: accumulator.inserted + table.inserted,
      updated: accumulator.updated + table.updated,
      unchanged: accumulator.unchanged + table.unchanged,
      orphaned: accumulator.orphaned + table.orphaned,
    }),
    { inserted: 0, updated: 0, unchanged: 0, orphaned: 0 },
  );

  return { tables, totals };
}

/** Columns that should be written as `NULL` rather than a value. */
function valueFor(column, value) {
  if (value === undefined) return null;
  return value;
}

/**
 * Applies a diff.
 *
 * @param {{tables: object[]}} plan
 * @param {{chunkSize?: number}} [options]
 * @returns {Promise<{inserted: number, updated: number, manifest: object}>}
 */
export async function applyPlan(plan, options = {}) {
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;
  const manifest = { startedAt: new Date().toISOString(), tables: {} };
  let inserted = 0;
  let updated = 0;

  for (const table of plan.tables) {
    const spec = TABLES.find((candidate) => candidate.table === table.table);
    const record = { inserted: [], updated: [] };

    const insertSql = `INSERT INTO ${spec.table} (${spec.columns.join(', ')}) VALUES (${spec.columns
      .map(() => '?')
      .join(', ')})`;
    const updateColumns = spec.columns.filter((column) => column !== 'id');
    const updateSql = `UPDATE ${spec.table} SET ${updateColumns
      .map((column) => `${column} = ?`)
      .join(', ')} WHERE id = ?`;

    for (let index = 0; index < table.inserts.length; index += chunkSize) {
      const chunk = table.inserts.slice(index, index + chunkSize);
      await withTransaction(async (connection) => {
        for (const row of chunk) {
          await connection.query(
            insertSql,
            spec.columns.map((column) => valueFor(column, row[column])),
          );
        }
      });
      inserted += chunk.length;
      record.inserted.push(...chunk.map((row) => row.id));
    }

    for (let index = 0; index < table.updates.length; index += chunkSize) {
      const chunk = table.updates.slice(index, index + chunkSize);
      await withTransaction(async (connection) => {
        for (const { row } of chunk) {
          await connection.query(updateSql, [
            ...updateColumns.map((column) => valueFor(column, row[column])),
            row.id,
          ]);
        }
      });
      updated += chunk.length;
      record.updated.push(
        ...chunk.map(({ row, before, changed }) => ({
          id: row.id,
          changed,
          before: pickColumns(before, spec.columns),
        })),
      );
    }

    manifest.tables[spec.table] = record;
  }

  manifest.finishedAt = new Date().toISOString();
  return { inserted, updated, manifest };
}

/** Keeps only the columns a rollback needs to restore. */
function pickColumns(row, columns) {
  const picked = {};
  for (const column of columns) picked[column] = row[column] ?? null;
  return picked;
}
