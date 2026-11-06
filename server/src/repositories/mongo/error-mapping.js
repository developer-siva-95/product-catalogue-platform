import mongoose from 'mongoose';
import { HTTP_STATUS } from '../../constants/httpStatusCodes.js';

/**
 * MongoDB → API error mapping.
 *
 * Mongoose error classes therefore never leave the repository layer: the HTTP
 * handler asks `repositories/error-mapping.js` (which tries every provider's
 * mapper) instead of importing the driver. The MySQL mapper added in P4 returns
 * descriptors with the same codes for `ER_DUP_ENTRY`, affected-rows staleness and
 * CHECK violations.
 *
 * @param {unknown} error
 * @returns {{ statusCode: number, message: string, code: string, details: unknown, isOperational: boolean } | null}
 */
export function mapMongoError(error) {
  if (!error) return null;

  if (error.name === 'VersionError') {
    return {
      statusCode: HTTP_STATUS.CONFLICT,
      message:
        'This record was modified by someone else. Reload the latest version and re-apply your changes.',
      code: 'STALE_RESOURCE',
      details: null,
      isOperational: true,
    };
  }

  if (error.code === 11_000) {
    const field = Object.keys(error.keyPattern ?? error.keyValue ?? {})[0] ?? 'field';
    return {
      statusCode: HTTP_STATUS.CONFLICT,
      message: `A record with this ${field} already exists.`,
      code: 'DUPLICATE_KEY',
      details: { field },
      isOperational: true,
    };
  }

  if (error instanceof mongoose.Error.ValidationError) {
    const details = Object.entries(error.errors).map(([field, entry]) => ({
      path: field,
      message: entry.message,
    }));
    return {
      statusCode: HTTP_STATUS.UNPROCESSABLE_ENTITY,
      message: 'Validation failed',
      code: 'MONGOOSE_VALIDATION_ERROR',
      details,
      isOperational: true,
    };
  }

  if (error instanceof mongoose.Error.CastError) {
    return {
      statusCode: HTTP_STATUS.BAD_REQUEST,
      message: `Invalid value for ${error.path ?? 'field'}`,
      code: 'INVALID_IDENTIFIER',
      details: null,
      isOperational: true,
    };
  }

  return null;
}

export default { mapMongoError };
