import multer from 'multer';
import { HTTP_STATUS, HTTP_STATUS_MESSAGES } from '../constants/httpStatusCodes.js';
import { ApiError } from '../utils/ApiError.js';
import { mapDatabaseError } from '../repositories/error-mapping.js';
import logger from '../utils/logger.js';

/**
 * Translates any thrown value into a `{ statusCode, message, code, details }`
 * descriptor. Keeping this pure-ish and exported means the mapping rules are
 * unit-testable without spinning up Express.
 */
export function normalizeError(err) {
  // Already an ApiError
  if (err instanceof ApiError) {
    return {
      statusCode: err.statusCode,
      message: err.message,
      code: err.code ?? `HTTP_${err.statusCode}`,
      details: err.details ?? null,
      isOperational: err.isOperational,
    };
  }

  // Provider errors (duplicate key, stale version, validation, cast) are mapped
  // inside the repository layer so this handler stays database-agnostic.
  const providerError = mapDatabaseError(err);
  if (providerError) return providerError;

  if (err?.type === 'entity.too.large') {
    return {
      statusCode: HTTP_STATUS.PAYLOAD_TOO_LARGE,
      message: 'Request body too large',
      code: 'PAYLOAD_TOO_LARGE',
      details: null,
      isOperational: true,
    };
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return {
      statusCode: HTTP_STATUS.BAD_REQUEST,
      message: 'Malformed JSON body',
      code: 'INVALID_JSON',
      details: null,
      isOperational: true,
    };
  }

  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: 'Uploaded file exceeds the maximum allowed size',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field',
      LIMIT_FILE_COUNT: 'Too many files uploaded',
      LIMIT_PART_COUNT: 'Too many form parts',
    };
    return {
      statusCode:
        err.code === 'LIMIT_FILE_SIZE' ? HTTP_STATUS.PAYLOAD_TOO_LARGE : HTTP_STATUS.BAD_REQUEST,
      message: messages[err.code] ?? `Upload error: ${err.code}`,
      code: err.code,
      details: null,
      isOperational: true,
    };
  }

  if (err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError') {
    return {
      statusCode: HTTP_STATUS.UNAUTHORIZED,
      message:
        err.name === 'TokenExpiredError'
          ? 'Session expired, please sign in again'
          : 'Invalid session',
      code: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
      details: null,
      isOperational: true,
    };
  }

  return {
    statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    message: 'Something went wrong',
    code: 'INTERNAL_ERROR',
    details: null,
    isOperational: false,
  };
}

/**
 * Centralised error handler.
 * - Never leaks stack traces or driver internals in production.
 * - Logs 5xx at error level (with request id) and 4xx at warn level.
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
export function errorHandler(err, req, res, next) {
  const { statusCode, message, code, details, isOperational } = normalizeError(err);
  const isProduction = process.env.NODE_ENV === 'production';
  const requestId = req.id ?? null;

  const logPayload = {
    requestId,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    code,
    err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
  };
  if (statusCode >= HTTP_STATUS.INTERNAL_SERVER_ERROR) logger.error('request failed', logPayload);
  else logger.warn('request rejected', logPayload);

  const body = {
    success: false,
    message:
      !isOperational && isProduction
        ? 'Something went wrong'
        : message || HTTP_STATUS_MESSAGES[statusCode] || 'Error',
    error: { code, details },
    requestId,
  };
  if (!isProduction && err instanceof Error && err.stack) {
    body.error.stack = err.stack;
  }

  res.status(statusCode).json(body);
}

export default errorHandler;
