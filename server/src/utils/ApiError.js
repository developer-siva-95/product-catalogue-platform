import { HTTP_STATUS, HTTP_STATUS_MESSAGES } from '../constants/httpStatusCodes.js';

/**
 * Operational error type. Anything thrown as an ApiError is considered safe to
 * expose to clients (message + optional details); everything else is treated as
 * a programmer error and is masked in production by the error handler.
 */
export class ApiError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} [message]
   * @param {object} [options]
   * @param {unknown} [options.details] machine readable details (e.g. Zod issues)
   * @param {string} [options.code] stable machine-readable error code
   * @param {boolean} [options.isOperational]
   * @param {Error} [options.cause]
   */
  constructor(statusCode, message, options = {}) {
    super(message || HTTP_STATUS_MESSAGES[statusCode] || 'Error');
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.isOperational = options.isOperational ?? true;
    this.code = options.code ?? null;
    this.details = options.details ?? null;
    if (options.cause) this.cause = options.cause;
    Error.captureStackTrace?.(this, this.constructor);
  }

  static badRequest(message = 'Bad Request', options) {
    return new ApiError(HTTP_STATUS.BAD_REQUEST, message, options);
  }

  static unauthorized(message = 'Unauthorized', options) {
    return new ApiError(HTTP_STATUS.UNAUTHORIZED, message, options);
  }

  static forbidden(message = 'Forbidden', options) {
    return new ApiError(HTTP_STATUS.FORBIDDEN, message, options);
  }

  static notFound(message = 'Not Found', options) {
    return new ApiError(HTTP_STATUS.NOT_FOUND, message, options);
  }

  static conflict(message = 'Conflict', options) {
    return new ApiError(HTTP_STATUS.CONFLICT, message, options);
  }

  static payloadTooLarge(message = 'Payload Too Large', options) {
    return new ApiError(HTTP_STATUS.PAYLOAD_TOO_LARGE, message, options);
  }

  static unprocessable(message = 'Unprocessable Entity', options) {
    return new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, message, options);
  }

  static tooManyRequests(message = 'Too Many Requests', options) {
    return new ApiError(HTTP_STATUS.TOO_MANY_REQUESTS, message, options);
  }

  static internal(message = 'Internal Server Error', options) {
    return new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, message, {
      isOperational: false,
      ...options,
    });
  }
}

export default ApiError;
