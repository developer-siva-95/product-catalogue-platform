import { HTTP_STATUS } from '../../constants/httpStatusCodes.js';

/**
 * MySQL → API error mapping.
 *
 * The MySQL counterpart of `mongo/error-mapping.js`: it turns driver errnos into
 * the *same* codes the MongoDB provider publishes, so an HTTP client cannot tell
 * which database answered. Nothing above the repository layer imports mysql2.
 *
 * Errno reference (MySQL 8.0):
 *   1062 ER_DUP_ENTRY                  unique index violation  → 409 DUPLICATE_KEY
 *   1451 ER_ROW_IS_REFERENCED_2        FK blocks a delete      → 409 RESOURCE_IN_USE
 *   1452 ER_NO_REFERENCED_ROW_2        insert of a bad FK      → 400 VALIDATION_ERROR
 *   3819 ER_CHECK_CONSTRAINT_VIOLATED  CHECK failed            → 422 VALIDATION_ERROR
 *   1406 ER_DATA_TOO_LONG              value exceeds the column→ 422 VALIDATION_ERROR
 *   1264 ER_WARN_DATA_OUT_OF_RANGE     numeric overflow        → 422 VALIDATION_ERROR
 *   1213 ER_LOCK_DEADLOCK              retried in pool.js; if it escapes → 409 CONFLICT
 *   1205 ER_LOCK_WAIT_TIMEOUT          same
 */

/** Maps a unique index name to the field name the API names in its message. */
const INDEX_FIELD_HINTS = [
  ['product_slug_unique', 'slug'],
  ['product_sku_unique_sparse', 'sku'],
  ['brand_slug_unique', 'slug'],
  ['brand_name_normalized_unique', 'name'],
  ['category_slug_unique', 'slug'],
  ['category_name_normalized_unique', 'name'],
  ['email_unique', 'email'],
];

/** @param {Error & {sqlMessage?: string}} error */
export function duplicateKeyField(error) {
  const message = String(error?.sqlMessage ?? error?.message ?? '');
  for (const [index, field] of INDEX_FIELD_HINTS) {
    if (message.includes(index)) return field;
  }
  if (/Duplicate entry .* for key 'email/.test(message)) return 'email';
  if (/slug/i.test(message)) return 'slug';
  if (/sku/i.test(message)) return 'sku';
  return 'field';
}

/**
 * @param {unknown} error
 * @returns {{ statusCode: number, message: string, code: string, details: unknown, isOperational: boolean } | null}
 */
export function mapMysqlError(error) {
  if (!error) return null;

  switch (error.errno) {
    case 1062: {
      const field = duplicateKeyField(error);
      return {
        statusCode: HTTP_STATUS.CONFLICT,
        message: `A record with this ${field} already exists.`,
        code: 'DUPLICATE_KEY',
        details: { field },
        isOperational: true,
      };
    }
    case 1451:
      return {
        statusCode: HTTP_STATUS.CONFLICT,
        message: 'This record is still referenced by other records and cannot be removed.',
        code: 'RESOURCE_IN_USE',
        details: null,
        isOperational: true,
      };
    case 1452: {
      const constraint = String(error.sqlMessage ?? '').match(/CONSTRAINT `([^`]+)`/)?.[1] ?? null;
      return {
        statusCode: HTTP_STATUS.BAD_REQUEST,
        message: 'A referenced record does not exist.',
        code: 'VALIDATION_ERROR',
        details: constraint ? { constraint } : null,
        isOperational: true,
      };
    }
    case 3819:
    case 1406:
    case 1264:
      return {
        statusCode: HTTP_STATUS.UNPROCESSABLE_ENTITY,
        message: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: [{ path: 'value', message: String(error.sqlMessage ?? error.message) }],
        isOperational: true,
      };
    case 1213:
    case 1205:
      return {
        statusCode: HTTP_STATUS.CONFLICT,
        message: 'The request conflicted with a concurrent update. Please retry.',
        code: 'CONFLICT',
        details: null,
        isOperational: true,
      };
    default:
      return null;
  }
}

export default { mapMysqlError, duplicateKeyField };
