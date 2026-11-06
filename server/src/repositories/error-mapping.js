import { mapMongoError } from './mongo/error-mapping.js';
import { mapMysqlError } from './mysql/error-mapping.js';

/**
 * Provider-neutral error mapping.
 *
 * The HTTP error handler must produce the same payload whichever database is
 * active, without importing either driver. Each provider contributes a mapper;
 * the first one that recognises the error wins. Mappers only claim errors they
 * genuinely own (Mongoose classes / Mongo codes vs MySQL errno values), so the
 * order is not significant.
 *
 * @param {unknown} error
 * @returns {{ statusCode: number, message: string, code: string, details: unknown, isOperational: boolean } | null}
 */
export function mapDatabaseError(error) {
  // Each mapper only claims errors it owns (Mongoose classes / Mongo error codes
  // vs MySQL errno values), so ordering is not significant.
  return mapMongoError(error) ?? mapMysqlError(error);
}

export default { mapDatabaseError };
