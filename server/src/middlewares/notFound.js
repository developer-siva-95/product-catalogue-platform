import { HTTP_STATUS } from '../constants/httpStatusCodes.js';
import { ApiError } from '../utils/ApiError.js';

/** Terminal middleware for unmatched routes — produces a 404 in the standard envelope. */
export function notFoundHandler(req, _res, next) {
  next(
    new ApiError(HTTP_STATUS.NOT_FOUND, `Route ${req.method} ${req.originalUrl} not found`, {
      code: 'ROUTE_NOT_FOUND',
    }),
  );
}

export default notFoundHandler;
