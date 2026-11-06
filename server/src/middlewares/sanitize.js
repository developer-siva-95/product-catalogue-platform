/**
 * NoSQL-operator injection guard (defence in depth).
 *
 * Zod schemas already reject object payloads where strings are expected, but this
 * middleware guarantees that no key beginning with `$` and no key containing `.`
 * ever reaches a Mongoose query, even if a future schema forgets a coercion.
 *
 * Implemented in-place over a copy; arrays are traversed recursively.
 */
const FORBIDDEN_KEY = /^\$|\./;

export function sanitizeValue(value, depth = 0) {
  if (depth > 10 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));

  const clean = {};
  for (const [key, val] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    clean[key] = sanitizeValue(val, depth + 1);
  }
  return clean;
}

export function sanitizeRequest(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  // req.query / req.params are getter-only in Express 4: rebuild via a shadow
  // property consumed by the validate middleware (which reads req.query).
  if (req.query && typeof req.query === 'object') {
    const safeQuery = sanitizeValue({ ...req.query });
    Object.defineProperty(req, 'query', {
      value: safeQuery,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  next();
}

export default sanitizeRequest;
