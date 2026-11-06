import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DATABASE_PROVIDER,
  resolveProvider,
  validateJwtSecret,
  loadEnv,
} from '../../src/config/env.js';

const STRONG = 'a7f3c1e9b26d4085f7a2c9e1b4d8063f5a7c9e2b4d6f8a0c';

function validRawEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    PORT: '5000',
    // These cases are about parsing/validation, not provider selection: name the
    // provider explicitly instead of inheriting the (now MySQL) default.
    DATABASE_PROVIDER: 'mongodb',
    MONGO_URI: 'mongodb://127.0.0.1:27017/catalogue',
    JWT_SECRET: STRONG,
    JWT_EXPIRES_IN: '1h',
    FRONTEND_URL: 'http://localhost:5173',
    COOKIE_SECURE: 'false',
    ...overrides,
  };
}

describe('validateJwtSecret', () => {
  it('accepts a long, high-entropy secret', () => {
    expect(validateJwtSecret(STRONG, 'development')).toEqual([]);
  });

  it('rejects an empty secret', () => {
    expect(validateJwtSecret('', 'development')[0]).toMatch(/required/i);
    expect(validateJwtSecret(undefined, 'development')[0]).toMatch(/required/i);
  });

  it('rejects secrets shorter than 32 chars in development', () => {
    const problems = validateJwtSecret('short-secret', 'development');
    expect(problems.join(' ')).toMatch(/at least 32 characters/);
  });

  it('requires 48 chars in production', () => {
    const forty = 'abcdefgh12345678ABCDEFGH90123456';
    expect(forty).toHaveLength(32);
    expect(validateJwtSecret(forty, 'development')).toEqual([]);
    expect(validateJwtSecret(forty, 'production').join(' ')).toMatch(/at least 48 characters/);
  });

  it('rejects well-known placeholder values', () => {
    const placeholder = `${'changeme'.padEnd(40, 'x')}`;
    expect(validateJwtSecret(placeholder, 'development').join(' ')).toMatch(/placeholder/i);
    expect(validateJwtSecret('x'.repeat(40), 'development').join(' ')).toMatch(
      /placeholder|distinct/i,
    );
  });

  it('rejects a single repeated character and low character variety', () => {
    expect(validateJwtSecret('a'.repeat(40), 'development')).not.toEqual([]);
    expect(validateJwtSecret('abababab'.repeat(5), 'development')).not.toEqual([]);
  });

  it('rejects dev-prefixed secrets in production only', () => {
    const secret = `dev-${'a1b2c3d4e5f6g7h8'.repeat(4)}`;
    expect(validateJwtSecret(secret, 'development')).toEqual([]);
    expect(validateJwtSecret(secret, 'production').join(' ')).toMatch(/development\/test prefix/i);
  });
});

describe('loadEnv', () => {
  it('parses a valid environment into a frozen object', () => {
    const env = loadEnv(validRawEnv());
    expect(env.PORT).toBe(5000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.isDevelopment).toBe(true);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(Object.isFrozen(env)).toBe(true);
    expect(() => {
      env.PORT = 1;
    }).toThrow(TypeError);
  });

  it('coerces boolean and numeric strings', () => {
    const env = loadEnv(validRawEnv({ COOKIE_SECURE: 'true', PORT: '8080', RATE_LIMIT_MAX: '42' }));
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.PORT).toBe(8080);
    expect(env.RATE_LIMIT_MAX).toBe(42);
  });

  it('fails fast with an aggregated error when MONGO_URI is missing', () => {
    const raw = validRawEnv();
    delete raw.MONGO_URI;
    expect(() => loadEnv(raw)).toThrow(/Invalid environment configuration/);
    try {
      loadEnv(raw);
    } catch (error) {
      expect(error.name).toBe('EnvValidationError');
      expect(error.problems.join(' ')).toMatch(/MONGO_URI/);
    }
  });

  it('rejects a non-mongodb URI', () => {
    expect(() => loadEnv(validRawEnv({ MONGO_URI: 'http://localhost:27017' }))).toThrow(
      /mongodb:\/\//,
    );
  });

  it('rejects a weak JWT secret at startup', () => {
    expect(() => loadEnv(validRawEnv({ JWT_SECRET: 'secret' }))).toThrow(/JWT_SECRET/);
  });

  it('rejects an invalid FRONTEND_URL', () => {
    expect(() => loadEnv(validRawEnv({ FRONTEND_URL: 'not-a-url' }))).toThrow(/FRONTEND_URL/);
  });

  it('enforces secure cookies and a non-localhost frontend in production', () => {
    const problems = [];
    try {
      loadEnv(
        validRawEnv({
          NODE_ENV: 'production',
          COOKIE_SECURE: 'false',
          FRONTEND_URL: 'http://localhost:5173',
          JWT_SECRET: `${'p9q8r7s6t5u4v3w2x1y0z'.repeat(3)}`,
        }),
      );
    } catch (error) {
      problems.push(...error.problems);
    }
    expect(problems.join(' ')).toMatch(/COOKIE_SECURE must be "true"/);
    expect(problems.join(' ')).toMatch(/FRONTEND_URL must not point at localhost/);
  });
});

/**
 * Provider resolution (approved behaviour change).
 *
 * The application default is Oracle MySQL 8.0. MongoDB is still supported, but it
 * must be selected explicitly. An unsupported value is fatal — there is no silent
 * fallback to either provider — and the resolved provider always reports whether it
 * came from the environment or from the default.
 */
describe('DATABASE_PROVIDER resolution', () => {
  // Deliberately includes BOTH providers' variables, so the only thing that decides
  // the outcome is DATABASE_PROVIDER itself.
  function providerEnv(overrides = {}) {
    return {
      NODE_ENV: 'development',
      PORT: '5000',
      JWT_SECRET: STRONG,
      FRONTEND_URL: 'http://localhost:5173',
      COOKIE_SECURE: 'false',
      MONGO_URI: 'mongodb://127.0.0.1:27017/catalogue',
      MYSQL_HOST: '127.0.0.1',
      MYSQL_USER: 'storefront_app',
      MYSQL_DATABASE: 'storefront',
      ...overrides,
    };
  }

  it('the documented default is mysql', () => {
    expect(DEFAULT_DATABASE_PROVIDER).toBe('mysql');
  });

  it('selects MySQL when DATABASE_PROVIDER is unset, and says so', () => {
    const env = loadEnv(providerEnv());
    expect(env.DATABASE_PROVIDER).toBe('mysql');
    expect(env.DATABASE_PROVIDER_SOURCE).toBe('default');
  });

  it('selects MySQL when DATABASE_PROVIDER=mysql', () => {
    const env = loadEnv(providerEnv({ DATABASE_PROVIDER: 'mysql' }));
    expect(env.DATABASE_PROVIDER).toBe('mysql');
    expect(env.DATABASE_PROVIDER_SOURCE).toBe('environment');
  });

  it('normalises case and surrounding whitespace (MySQL -> mysql)', () => {
    expect(loadEnv(providerEnv({ DATABASE_PROVIDER: 'MySQL' })).DATABASE_PROVIDER).toBe('mysql');
    expect(loadEnv(providerEnv({ DATABASE_PROVIDER: '  mysql \n' })).DATABASE_PROVIDER).toBe(
      'mysql',
    );
    expect(loadEnv(providerEnv({ DATABASE_PROVIDER: 'MONGODB' })).DATABASE_PROVIDER).toBe(
      'mongodb',
    );
  });

  it('selects MongoDB when DATABASE_PROVIDER=mongodb', () => {
    const env = loadEnv(providerEnv({ DATABASE_PROVIDER: 'mongodb' }));
    expect(env.DATABASE_PROVIDER).toBe('mongodb');
    expect(env.DATABASE_PROVIDER_SOURCE).toBe('environment');
  });

  it('fails startup on an unsupported value instead of falling back', () => {
    expect(() => loadEnv(providerEnv({ DATABASE_PROVIDER: 'postgres' }))).toThrow(
      /Invalid environment configuration/,
    );
    try {
      loadEnv(providerEnv({ DATABASE_PROVIDER: 'postgres' }));
    } catch (error) {
      const problems = error.problems.join(' ');
      expect(problems).toMatch(/DATABASE_PROVIDER: unsupported value "postgres"/);
      expect(problems).toMatch(/Supported values: mongodb, mysql/);
      expect(problems).toMatch(/never falls back/);
    }
  });

  it('an empty value means "unset" (default), not an invalid value', () => {
    const resolved = resolveProvider('');
    expect(resolved).toMatchObject({ provider: 'mysql', source: 'default', invalid: null });
    expect(resolveProvider('   ').provider).toBe('mysql');
  });

  it('treats the unset default as MySQL when validating MySQL requirements', () => {
    // Proof the default is not cosmetic: with MySQL selected and no MYSQL_USER,
    // the *MySQL* requirement is what fails — not a MongoDB one.
    expect(() => loadEnv(providerEnv({ MYSQL_USER: undefined }))).toThrow(
      /MYSQL_USER is required when DATABASE_PROVIDER=mysql/,
    );
    expect(() =>
      loadEnv(providerEnv({ DATABASE_PROVIDER: 'mongodb', MONGO_URI: undefined })),
    ).toThrow(/MONGO_URI is required when DATABASE_PROVIDER=mongodb/);
  });
});
