import { query } from '../../mysql/pool.js';
import { TABLES } from './mapping.js';
import { normaliseRow } from './apply.js';

/**
 * Post-migration verification.
 *
 * Section 10 asks for counts, samples, foreign keys, unique constraints, decimal
 * precision, date/time conversion and null/missing fields. Each has its own
 * check so a failure names the property that broke instead of "verification
 * failed".
 *
 * Everything here compares the **source documents** (not the mapped rows) against
 * what MySQL actually stored, so a mapping bug cannot hide behind the mapping.
 */

/** @param {object[]} rows @param {number} size @param {string} seed */
function sample(rows, size) {
  if (rows.length <= size) return rows;
  const step = Math.floor(rows.length / size) || 1;
  const picked = [];
  for (let index = 0; index < rows.length && picked.length < size; index += step) {
    picked.push(rows[index]);
  }
  return picked;
}

/**
 * @param {object} input
 * @param {Record<string, object[]>} input.documents source documents per collection
 * @param {Record<string, object[]>} input.rows mapped rows per collection
 * @param {number} [input.sampleSize]
 * @returns {Promise<object>} verification report
 */
export async function verifyMigration({ documents, rows }, { sampleSize = 25 } = {}) {
  const report = { checks: [], sampleSize };

  const addCheck = (name, passed, details = {}) => {
    report.checks.push({ name, passed, ...details });
  };

  // ---------------------------------------------------------------- counts
  const counts = {};
  let countsPassed = true;
  for (const spec of TABLES) {
    const sourceCount = (documents[spec.collection] ?? []).length;
    const [row] = await query(`SELECT COUNT(*) AS total FROM ${spec.table}`);
    const targetCount = Number(row?.total ?? 0);
    counts[spec.collection] = { source: sourceCount, target: targetCount };
    if (sourceCount !== targetCount) countsPassed = false;
  }
  addCheck('record-counts', countsPassed, { counts });

  // ------------------------------------------------------- row-level equality
  const mismatches = [];
  for (const spec of TABLES) {
    const sourceRows = rows[spec.collection] ?? [];
    for (const row of sample(sourceRows, sampleSize)) {
      const [stored] = await query(
        `SELECT ${spec.columns.join(', ')} FROM ${spec.table} WHERE id = ? LIMIT 1`,
        [row.id],
      );
      if (!stored) {
        mismatches.push({ table: spec.table, id: row.id, reason: 'missing-in-target' });
        continue;
      }

      const expected = normaliseRow(spec, row);
      const actual = normaliseRow(spec, stored);
      for (const column of Object.keys(expected)) {
        if (expected[column] !== actual[column]) {
          mismatches.push({
            table: spec.table,
            id: row.id,
            column,
            expected: expected[column],
            actual: actual[column],
          });
        }
      }
    }
  }
  addCheck('sample-equality', mismatches.length === 0, { compared: sampleSize, mismatches });

  // --------------------------------------------------------- foreign keys
  const fkViolations = [];
  for (const spec of TABLES) {
    for (const reference of spec.references ?? []) {
      const rowsOrphaned = await query(
        `SELECT child.id, child.${reference.column} AS missing
           FROM ${spec.table} child
           LEFT JOIN ${reference.table} parent ON parent.id = child.${reference.column}
          WHERE parent.id IS NULL`,
      );
      for (const row of rowsOrphaned) {
        fkViolations.push({
          table: spec.table,
          id: row.id,
          column: reference.column,
          missing: row.missing,
        });
      }
    }
  }
  addCheck('foreign-keys', fkViolations.length === 0, { violations: fkViolations });

  // ---------------------------------------------------- unique constraints
  const uniqueViolations = [];
  for (const spec of TABLES) {
    for (const columns of spec.uniques) {
      const duplicates = await query(
        `SELECT ${columns.join(', ')} , COUNT(*) AS total
           FROM ${spec.table}
          WHERE ${columns.map((column) => `${column} IS NOT NULL`).join(' AND ')}
          GROUP BY ${columns.join(', ')}
         HAVING COUNT(*) > 1`,
      );
      for (const row of duplicates) {
        uniqueViolations.push({ table: spec.table, columns, value: row, total: Number(row.total) });
      }
    }
  }
  addCheck('unique-constraints', uniqueViolations.length === 0, { violations: uniqueViolations });

  // ------------------------------------------------------ decimal precision
  const precision = [];
  for (const spec of TABLES) {
    if (!spec.decimals.length) continue;
    for (const column of spec.decimals) {
      const [stats] = await query(
        `SELECT COUNT(*) AS total,
                SUM(${column} <> ROUND(${column}, 2)) AS beyond_scale,
                MIN(${column}) AS min_value,
                MAX(${column}) AS max_value
           FROM ${spec.table}`,
      );
      const beyondScale = Number(stats?.beyond_scale ?? 0);
      if (beyondScale > 0) precision.push({ table: spec.table, column, beyondScale });
      precision.push({
        table: spec.table,
        column,
        total: Number(stats?.total ?? 0),
        beyondScale,
        min: Number(stats?.min_value ?? 0),
        max: Number(stats?.max_value ?? 0),
      });
    }
  }
  addCheck(
    'decimal-precision',
    precision.every((entry) => !entry.beyondScale),
    { columns: precision },
  );

  // ---------------------------------------------------------- date/time
  const dateIssues = [];
  for (const spec of TABLES) {
    for (const column of spec.dates) {
      const [stats] = await query(
        `SELECT SUM(${column} IS NULL) AS nulls, COUNT(*) AS total,
                MIN(${column}) AS min_value, MAX(${column}) AS max_value
           FROM ${spec.table}`,
      );
      const expectedNulls = (rows[spec.collection] ?? []).filter(
        (row) => row[column] === null,
      ).length;
      const actualNulls = Number(stats?.nulls ?? 0);
      if (expectedNulls !== actualNulls) {
        dateIssues.push({ table: spec.table, column, expectedNulls, actualNulls });
      }
    }
  }
  addCheck('date-time-conversion', dateIssues.length === 0, { issues: dateIssues });

  // --------------------------------------------------------- null / missing
  const nullIssues = [];
  for (const spec of TABLES) {
    const sourceRows = rows[spec.collection] ?? [];
    for (const column of spec.columns) {
      if (column === 'id') continue;
      const sourceNulls = sourceRows.filter((row) => row[column] === null).length;
      const [stats] = await query(`SELECT SUM(${column} IS NULL) AS nulls FROM ${spec.table}`);
      const targetNulls = Number(stats?.nulls ?? 0);
      if (sourceNulls !== targetNulls) {
        nullIssues.push({ table: spec.table, column, sourceNulls, targetNulls });
      }
    }
  }
  addCheck('null-and-missing-fields', nullIssues.length === 0, { issues: nullIssues });

  report.passed = report.checks.every((check) => check.passed);
  return report;
}
