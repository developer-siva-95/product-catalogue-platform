import {
  CANONICAL_ID,
  DATETIME_MAX,
  DATETIME_MIN,
  PRICE_MAX,
  PRICE_MIN,
  PRICE_SCALE,
  TABLES,
} from './mapping.js';

/**
 * Pre-insert validation for the MongoDB → MySQL migration.
 *
 * **Nothing here writes anything.** Every finding is produced from the extracted
 * source documents plus the mapped rows, so the whole migration can be refused
 * before the first INSERT — which is what "orphan detection that fails or
 * quarantines explicitly before any insert" means in practice.
 *
 * Severity model:
 *  - `fatal: true`  — the row cannot be represented faithfully in MySQL. The run
 *    aborts. `--quarantine <file>` may downgrade *quarantinable* findings to
 *    "skip this row, record it in the file", but only when the operator asks.
 *  - `fatal: false` — the row is representable but something was normalised (e.g.
 *    an empty SKU became NULL). Reported, never silently swallowed.
 */

/**
 * Findings that may be quarantined (row skipped, rejection recorded) instead of
 * aborting the whole run.
 *
 * Every finding is row-level, so in principle all of them *can* be quarantined —
 * but only when the operator passes `--quarantine`. Without that flag each one is
 * fatal and the migration stops before the first INSERT. The set is spelled out
 * rather than "always allowed" so that a future finding type has to make a
 * deliberate decision about whether silent row loss is acceptable.
 */
export const QUARANTINABLE = new Set([
  'ORPHAN_REFERENCE',
  'DECIMAL_PRECISION',
  'DATE_OUT_OF_RANGE',
  'STRING_TOO_LONG',
  'VALUE_INVALID',
  'MISSING_REQUIRED',
  'UNIQUE_COLLISION',
  'ID_INVALID',
]);

/**
 * @param {object} input
 * @param {Record<string, object[]>} input.documents documents keyed by collection
 * @param {Record<string, object[]>} input.rows mapped rows keyed by collection
 * @returns {{ findings: object[], fatal: object[], quarantinable: object[], ok: boolean }}
 */
export function validate({ documents, rows }) {
  const findings = [];
  const add = (finding) => findings.push({ ...finding, fatal: finding.fatal ?? true });

  const idSets = {};
  for (const spec of TABLES) {
    idSets[spec.table] = new Set((rows[spec.collection] ?? []).map((row) => row.id));
  }

  for (const spec of TABLES) {
    const collectionRows = rows[spec.collection] ?? [];
    const collectionDocs = documents[spec.collection] ?? [];
    // One map per unique key: two groups can legitimately share a value
    // ("audio" is both a slug and a name_normalized), and that is not a collision.
    const seenUnique = spec.uniques.map(() => new Map());

    collectionRows.forEach((row, index) => {
      const doc = collectionDocs[index] ?? {};
      const where = { collection: spec.collection, id: row.id, index };

      // ---- identifiers are preserved verbatim; anything else cannot be.
      if (!CANONICAL_ID.test(row.id)) {
        add({
          code: 'ID_INVALID',
          ...where,
          message: `id "${row.id}" is not a 24-character lowercase hex string; CHAR(24) ascii_bin cannot hold it`,
        });
      }

      // ---- required source fields
      for (const field of spec.requiredSource) {
        const value = doc[field];
        const missing =
          value === undefined || value === null || (typeof value === 'string' && !value.trim());
        if (missing) {
          add({
            code: 'MISSING_REQUIRED',
            ...where,
            field,
            message: `${spec.collection}.${field} is required by MySQL but missing/empty in the source document`,
          });
        }
      }

      // ---- orphan references (before any insert: parents are known here)
      for (const reference of spec.references) {
        const value = row[reference.column];
        if (!idSets[reference.table].has(value)) {
          add({
            code: 'ORPHAN_REFERENCE',
            ...where,
            field: reference.column,
            message: `${spec.collection}.${reference.column}="${value}" has no matching row in ${reference.table}`,
          });
        }
      }

      // ---- decimal precision (DECIMAL(12,2) is exact only for 2dp)
      for (const column of spec.decimals) {
        const value = row[column];
        if (typeof value !== 'number' || Number.isNaN(value)) {
          add({
            code: 'VALUE_INVALID',
            ...where,
            field: column,
            message: `${spec.collection}.${column} is not a number (got ${JSON.stringify(value)})`,
          });
          continue;
        }
        if (value < PRICE_MIN || value > PRICE_MAX) {
          add({
            code: 'DECIMAL_PRECISION',
            ...where,
            field: column,
            message: `${spec.collection}.${column}=${value} is outside DECIMAL(12,2) range ${PRICE_MIN}..${PRICE_MAX}`,
          });
          continue;
        }
        const scaled = Math.round(value * 10 ** PRICE_SCALE) / 10 ** PRICE_SCALE;
        if (Math.abs(value - scaled) > Number.EPSILON * 4) {
          add({
            code: 'DECIMAL_PRECISION',
            ...where,
            field: column,
            message: `${spec.collection}.${column}=${value} needs more than ${PRICE_SCALE} decimals (would become ${scaled})`,
            details: { value, wouldBecome: scaled },
          });
        }
      }

      // ---- dates must fit DATETIME (1000-01-01 .. 9999-12-31)
      for (const column of spec.dates) {
        const value = row[column];
        if (value === null) {
          if (spec.requiredSource.includes(column)) {
            add({
              code: 'MISSING_REQUIRED',
              ...where,
              field: column,
              message: `${spec.collection}.${column} is missing but the column is NOT NULL`,
            });
          }
          continue;
        }
        if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
          add({
            code: 'VALUE_INVALID',
            ...where,
            field: column,
            message: `${spec.collection}.${column} is not a valid date`,
          });
          continue;
        }
        const time = value.getTime();
        if (time < DATETIME_MIN || time > DATETIME_MAX) {
          add({
            code: 'DATE_OUT_OF_RANGE',
            ...where,
            field: column,
            message: `${spec.collection}.${column}=${value.toISOString()} is outside MySQL DATETIME range`,
          });
        }
      }

      // ---- strings must fit the VARCHAR limits, or they fail mid-run
      for (const [column, limit] of Object.entries(spec.stringLimits)) {
        const value = row[column];
        if (typeof value === 'string' && value.length > limit) {
          add({
            code: 'STRING_TOO_LONG',
            ...where,
            field: column,
            message: `${spec.collection}.${column} is ${value.length} characters; the column allows ${limit}`,
          });
        }
      }

      // ---- integers that MySQL CHECK constraints would reject
      for (const column of ['stock', 'version', 'token_version', 'login_attempts']) {
        if (!(column in row)) continue;
        const value = row[column];
        if (!Number.isInteger(value) || value < 0) {
          add({
            code: 'VALUE_INVALID',
            ...where,
            field: column,
            message: `${spec.collection}.${column}=${JSON.stringify(value)} is not a non-negative integer`,
          });
        }
      }

      // ---- uniqueness inside the source itself (a Mongo index can be missing)
      spec.uniques.forEach((uniqueColumns, groupIndex) => {
        const key = uniqueColumns.map((column) => row[column]).join('\u0000');
        // NULL SKUs are distinct in MySQL (and sparse in Mongo), so skip them.
        if (uniqueColumns.every((column) => row[column] === null)) return;
        if (seenUnique[groupIndex].has(key)) {
          add({
            code: 'UNIQUE_COLLISION',
            ...where,
            field: uniqueColumns.join('+'),
            message: `${spec.collection} rows ${seenUnique[groupIndex].get(key)} and ${row.id} share ${uniqueColumns.join('+')}="${key.replaceAll('\u0000', ', ')}"`,
          });
        } else {
          seenUnique[groupIndex].set(key, row.id);
        }
      });
    });
  }

  const fatal = findings.filter((finding) => finding.fatal);
  const quarantinable = findings.filter((finding) => QUARANTINABLE.has(finding.code));

  return { findings, fatal, quarantinable, ok: fatal.length === 0 };
}

/** Groups fatal findings by the row they belong to, for quarantine decisions. */
export function rejectedRowKeys(findings) {
  const rejected = new Set();
  for (const finding of findings) {
    if (finding.index === undefined) continue;
    rejected.add(`${finding.collection}#${finding.id}#${finding.index}`);
  }
  return rejected;
}
