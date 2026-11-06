import { HTTP_STATUS } from '../constants/httpStatusCodes.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Turns Zod issues into a compact, field-addressed list so clients can map
 * errors onto form inputs without string parsing.
 */
export function formatZodIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Centralised request validation for `body`, `query` and `params`.
 *
 * Results are written to `req.validated` instead of overwriting `req.query`
 * (Express 4 exposes `req.query` through a getter-only property; assigning to it
 * throws in ESM strict mode). Controllers therefore read validated, type-coerced
 * input from a single, predictable place.
 *
 * @param {{
 *   body?: import('zod').ZodTypeAny | ((req: import('express').Request) => import('zod').ZodTypeAny),
 *   query?: import('zod').ZodTypeAny,
 *   params?: import('zod').ZodTypeAny
 * }} schemas
 * @returns {import('express').RequestHandler}
 */
export function validate(schemas = {}) {
  return function validateRequest(req, _res, next) {
    const validated = { ...(req.validated ?? {}) };
    const errors = [];

    for (const key of ['params', 'query', 'body']) {
      const entry = schemas[key];
      if (!entry) continue;
      // A schema may be a factory when its rules depend on the request (e.g. a
      // patch that only carries an image needs no body fields).
      const schema = typeof entry === 'function' ? entry(req) : entry;
      const result = schema.safeParse(req[key] ?? {});
      if (result.success) {
        validated[key] = result.data;
      } else {
        for (const issue of formatZodIssues(result.error)) {
          errors.push({ ...issue, location: key, path: `${key}.${issue.path}` });
        }
      }
    }

    if (errors.length > 0) {
      return next(
        new ApiError(HTTP_STATUS.BAD_REQUEST, 'Validation failed', {
          code: 'VALIDATION_ERROR',
          details: errors,
        }),
      );
    }

    req.validated = validated;
    return next();
  };
}

export default validate;
