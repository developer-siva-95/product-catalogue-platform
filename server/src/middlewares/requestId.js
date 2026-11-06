import { randomUUID } from 'node:crypto';

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Attaches a unique request id to every request (`req.id`) and echoes it back in
 * the `X-Request-Id` response header so clients can correlate a failure with a
 * specific server log line.
 *
 * An inbound X-Request-Id is only honoured when it matches a strict allow-list
 * pattern — otherwise a caller could inject newlines/log-forging payloads.
 */
export function requestId(req, res, next) {
  const inbound = req.get('x-request-id');
  req.id = inbound && VALID_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  // `req.app` may be absent when the middleware is exercised in isolation
  // (unit tests, custom mounts) — never assume the Express app is wired up.
  const appLogger = req.app?.locals?.logger;
  req.log =
    typeof appLogger?.child === 'function' ? appLogger.child({ requestId: req.id }) : undefined;
  next();
}

export default requestId;
