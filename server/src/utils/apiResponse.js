import { HTTP_STATUS } from '../constants/httpStatusCodes.js';

/**
 * Single response envelope for every endpoint:
 *   { success, message, data, meta?, requestId }
 * Errors use the same shape plus `error`, so the frontend has one parser.
 */
export function buildSuccessPayload({ message = 'OK', data = null, meta = null, requestId }) {
  const payload = { success: true, message, data };
  if (meta !== null && meta !== undefined) payload.meta = meta;
  if (requestId) payload.requestId = requestId;
  return payload;
}

export function sendSuccess(
  res,
  { statusCode = HTTP_STATUS.OK, message = 'OK', data = null, meta } = {},
) {
  return res.status(statusCode).json(
    buildSuccessPayload({
      message,
      data,
      meta: meta ?? null,
      requestId: res.req?.id,
    }),
  );
}

export function sendCreated(res, { message = 'Created', data = null, meta } = {}) {
  return sendSuccess(res, { statusCode: HTTP_STATUS.CREATED, message, data, meta });
}

export function sendNoContent(res) {
  return res.status(HTTP_STATUS.NO_CONTENT).end();
}

export default { sendSuccess, sendCreated, sendNoContent, buildSuccessPayload };
