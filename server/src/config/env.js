import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, '..', '..');

// Load <server>/.env once. `override: false` means real process env (CI, Docker,
// vitest setup) always wins over the file, which is what tests rely on.
// `quiet: true` suppresses the promotional banner dotenv >= 17 prints on load,
// which would otherwise pollute the structured logs and the test output.
dotenv.config({ path: path.join(SERVER_ROOT, '.env'), override: false, quiet: true });

/** Values that must never be used as a signing secret, regardless of length. */
const WEAK_SECRETS = new Set([
  'secret',
  'supersecret',
  'changeme',
  'change-me',
  'password',
  'jwtsecret',
  'jwt-secret',
  'test',
  'development',
  'replace-me-with-a-long-random-string-at-least-32-chars',
  'your-secret-key',
  'mysecretkey',
]);

const MIN_SECRET_LENGTH = 32;
const MIN_PROD_SECRET_LENGTH = 48;

/**
 * Validates JWT secret strength at startup.
 *
 * Rationale: a weak signing secret silently compromises every session; failing
 * fast at boot (instead of at first login) makes misconfiguration impossible to
 * ship. Returns the list of problems so callers/tests can assert on them.
 *
 * @param {string|undefined} secret
 * @param {string} nodeEnv
 * @returns {string[]} array of human readable problems (empty === strong enough)
 */
export function validateJwtSecret(secret, nodeEnv = 'development') {
  const problems = [];
  if (typeof secret !== 'string' || secret.length === 0) {
    return ['JWT_SECRET is required and must be a non-empty string.'];
  }

  const requiredLength = nodeEnv === 'production' ? MIN_PROD_SECRET_LENGTH : MIN_SECRET_LENGTH;
  if (secret.length < requiredLength) {
    problems.push(
      `JWT_SECRET must be at least ${requiredLength} characters in ${nodeEnv} (received ${secret.length}).`,
    );
  }
  const normalized = secret.trim().toLowerCase();
  if (WEAK_SECRETS.has(normalized)) {
    problems.push('JWT_SECRET is a well-known placeholder value and must be replaced.');
  } else {
    // Catches padded placeholders such as "changeme" + "xxxx..." where the token
    // is masked by low-entropy padding rather than being an exact match.
    const weakToken = [...WEAK_SECRETS].find((token) => normalized.includes(token));
    if (weakToken && new Set(secret).size < 16) {
      problems.push(
        `JWT_SECRET contains the well-known placeholder token "${weakToken}" with insufficient entropy.`,
      );
    }
  }
  if (/^(.)\1+$/.test(secret)) {
    problems.push('JWT_SECRET must not consist of a single repeated character.');
  }
  // Entropy proxy: count distinct characters. A 32-char secret with 4 distinct
  // characters has trivially low entropy even though it passes the length rule.
  if (new Set(secret).size < 8) {
    problems.push('JWT_SECRET must contain at least 8 distinct characters.');
  }
  if (nodeEnv === 'production' && /^(dev|test|local)/i.test(secret)) {
    problems.push('JWT_SECRET must not start with a development/test prefix in production.');
  }
  return problems;
}

const booleanFromString = (defaultValue) =>
  z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true'));

const MONGO_URI_PREFIXES = ['mongodb://', 'mongodb+srv://'];

// ---------------------------------------------------------------------------
// Database provider resolution
// ---------------------------------------------------------------------------
// The application default is Oracle MySQL 8.0. MongoDB stays a first-class
// provider, but it is now selected *explicitly* (`DATABASE_PROVIDER=mongodb`).
//
// Rules (deliberately explicit, never a silent switch):
//   - unset / empty        -> 'mysql', source 'default'
//   - 'mysql' | 'MySQL'    -> 'mysql', source 'environment'   (trim + lowercase)
//   - 'mongodb'            -> 'mongodb', source 'environment'
//   - anything else        -> configuration error, startup fails
// There is no fallback from an invalid value to either provider.
export const DEFAULT_DATABASE_PROVIDER = 'mysql';
export const SUPPORTED_DATABASE_PROVIDERS = Object.freeze(['mongodb', 'mysql']);
export const PROVIDER_SOURCES = Object.freeze({ environment: 'environment', default: 'default' });

/**
 * Resolves `DATABASE_PROVIDER` into `{ provider, source, invalid }`.
 *
 * @param {string|undefined} raw the raw environment value
 * @returns {{provider: string|null, source: 'environment'|'default', invalid: string|null}}
 */
export function resolveProvider(raw) {
  const rawValue = typeof raw === 'string' ? raw : '';
  if (rawValue.trim() === '') {
    return { provider: DEFAULT_DATABASE_PROVIDER, source: PROVIDER_SOURCES.default, invalid: null };
  }
  const normalised = rawValue.trim().toLowerCase();
  if (SUPPORTED_DATABASE_PROVIDERS.includes(normalised)) {
    return { provider: normalised, source: PROVIDER_SOURCES.environment, invalid: null };
  }
  return { provider: null, source: PROVIDER_SOURCES.environment, invalid: rawValue };
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),

  // Which storage implementation the repository layer binds to. Both providers
  // are first-class: switching is a configuration change, never a code change.
  // Kept as a plain string here and resolved by `resolveProvider` below, so the
  // error message can name the offending value and the app can report whether the
  // provider came from the environment or from the default.
  DATABASE_PROVIDER: z.string().optional(),

  // Only validated when it is present; the "required" rule is provider-aware
  // (see loadEnv) so a MySQL deployment is not forced to configure MongoDB.
  MONGO_URI: z
    .string()
    .refine((v) => v.length > 0, { message: 'MONGO_URI is required' })
    .refine((v) => MONGO_URI_PREFIXES.some((prefix) => v.startsWith(prefix)), {
      message: 'MONGO_URI must be a mongodb:// or mongodb+srv:// connection string',
    })
    .optional(),

  // ---------------------------------------------------------------------
  // MySQL provider (ignored unless DATABASE_PROVIDER=mysql)
  // ---------------------------------------------------------------------
  MYSQL_HOST: z.string().min(1).default('127.0.0.1'),
  MYSQL_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  MYSQL_USER: z.string().min(1).optional(),
  MYSQL_PASSWORD: z.string().optional().default(''),
  MYSQL_DATABASE: z.string().min(1).optional(),
  // Pool ceiling. Kept deliberately modest: the pool fronts a single Node
  // process, and MySQL's default max_connections (151) is shared with tooling.
  MYSQL_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  // Seconds a single statement may run before it is killed server-side.
  MYSQL_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  MYSQL_SSL: booleanFromString(false),
  // Boot-time capability gate. When true, a topology that cannot run
  // transactions (e.g. a standalone mongod, a non-InnoDB MySQL) refuses to
  // start instead of silently serving with weaker guarantees.
  REQUIRE_TRANSACTIONS: booleanFromString(false),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('1h'),
  FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URL').default('http://localhost:5173'),
  COOKIE_SECURE: booleanFromString(false),
  // SameSite policy for auth cookies. 'lax' is right when the SPA and API share a
  // site (localhost ports still count as same-site). Use 'none' + COOKIE_SECURE
  // when they are deployed on different sites.
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  CSRF_TOKEN_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 60 * 60 * 1000),
  PUBLIC_UPLOAD_PATH: z.string().startsWith('/').default('/uploads'),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  UPLOAD_DIR: z.string().optional().default(''),
  RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
});

/**
 * Parses + validates the environment. Throws an aggregated, readable error so a
 * misconfigured deployment fails at boot rather than at request time.
 */
export function loadEnv(rawEnv = process.env) {
  const parsed = envSchema.safeParse(rawEnv);

  const problems = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join('.') || 'ENV'}: ${issue.message}`);
    }
  }

  // Provider-aware database configuration. Exactly one store must be fully
  // configured; the other provider's variables stay inert.
  const resolved = resolveProvider(rawEnv.DATABASE_PROVIDER);
  const provider = resolved.provider;

  if (resolved.invalid !== null) {
    problems.push(
      `DATABASE_PROVIDER: unsupported value "${resolved.invalid}". ` +
        `Supported values: ${SUPPORTED_DATABASE_PROVIDERS.join(', ')} (case-insensitive; ` +
        `surrounding whitespace is ignored). An invalid value is fatal — the application ` +
        `never falls back to another provider. Leave it unset to use "${DEFAULT_DATABASE_PROVIDER}".`,
    );
  }

  if (provider === 'mongodb') {
    if (!rawEnv.MONGO_URI) problems.push('MONGO_URI is required when DATABASE_PROVIDER=mongodb.');
  } else if (provider === 'mysql') {
    if (!rawEnv.MYSQL_USER) problems.push('MYSQL_USER is required when DATABASE_PROVIDER=mysql.');
    if (!rawEnv.MYSQL_DATABASE) {
      problems.push('MYSQL_DATABASE is required when DATABASE_PROVIDER=mysql.');
    }
    if (rawEnv.NODE_ENV === 'production' && !rawEnv.MYSQL_PASSWORD) {
      problems.push('MYSQL_PASSWORD is required in production when DATABASE_PROVIDER=mysql.');
    }
  }

  const secretProblems = validateJwtSecret(rawEnv.JWT_SECRET, rawEnv.NODE_ENV ?? 'development');
  problems.push(...secretProblems);

  const nodeEnv = rawEnv.NODE_ENV ?? 'development';
  if ((rawEnv.COOKIE_SAME_SITE ?? 'lax') === 'none' && rawEnv.COOKIE_SECURE !== 'true') {
    problems.push(
      'COOKIE_SAME_SITE=none requires COOKIE_SECURE=true (browsers reject it otherwise).',
    );
  }
  if (nodeEnv === 'production' && rawEnv.COOKIE_SECURE !== 'true') {
    problems.push('COOKIE_SECURE must be "true" in production (secure HttpOnly cookies).');
  }
  if (nodeEnv === 'production' && (rawEnv.FRONTEND_URL ?? '').includes('localhost')) {
    problems.push('FRONTEND_URL must not point at localhost in production.');
  }

  if (problems.length > 0 || !parsed.success) {
    const error = new Error(
      `Invalid environment configuration:\n  - ${problems.join('\n  - ')}\n\nSee .env.example for documentation.`,
    );
    error.name = 'EnvValidationError';
    error.problems = problems;
    throw error;
  }

  const data = parsed.data;
  return Object.freeze({
    ...data,
    // The resolved values, not the raw ones: `DATABASE_PROVIDER` is normalised and
    // `DATABASE_PROVIDER_SOURCE` says whether it came from the environment or the default.
    DATABASE_PROVIDER: provider,
    DATABASE_PROVIDER_SOURCE: resolved.source,
    isProduction: data.NODE_ENV === 'production',
    isTest: data.NODE_ENV === 'test',
    isDevelopment: data.NODE_ENV === 'development',
    uploadDir: data.UPLOAD_DIR ? path.resolve(data.UPLOAD_DIR) : path.join(SERVER_ROOT, 'uploads'),
  });
}

export const env = loadEnv();
export default env;
