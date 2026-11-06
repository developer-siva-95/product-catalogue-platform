import { describe, it, expect } from 'vitest';
import { SUPPORTED_PROVIDERS, getProvider, getProviderName } from '../../src/db/index.js';
import * as mongoProvider from '../../src/db/mongo/provider.js';
import * as mysqlProvider from '../../src/db/mysql/provider.js';
import { mysqlPoolConfig } from '../../src/db/mysql/pool.js';

/**
 * Provider selection is configuration, not code. These tests pin the parts of
 * that promise which are checkable without a live server: exactly two providers
 * exist, each implements the full adapter surface, and the MySQL pool settings
 * that guarantee contract parity (UTC, DECIMAL-as-string, no multi-statement) are
 * the ones actually passed to the driver.
 */
describe('database provider facade', () => {
  const adapterSurface = ['connect', 'disconnect', 'state', 'probe', 'health', 'withTransaction'];

  it('supports exactly mongodb and mysql', () => {
    expect(SUPPORTED_PROVIDERS).toEqual(['mongodb', 'mysql']);
  });

  it('binds the provider selected for this process (the test harness pins MongoDB)', () => {
    // The *default* for the application is covered in env.test.js (unset -> mysql).
    // Here we assert the facade reports exactly the provider the environment chose,
    // rather than inventing one of its own.
    expect(getProviderName()).toBe(process.env.DATABASE_PROVIDER);
    expect(SUPPORTED_PROVIDERS).toContain(getProviderName());
  });

  it.each([
    ['mongodb', mongoProvider],
    ['mysql', mysqlProvider],
  ])('the %s adapter implements the whole surface', (name, adapter) => {
    expect(adapter.name).toBe(name);
    for (const method of adapterSurface) {
      expect(typeof adapter[method], `${name}.${method}`).toBe('function');
    }
  });

  it('resolves a provider by explicit name', () => {
    expect(getProvider('mysql').name).toBe('mysql');
    expect(getProvider('mongodb').name).toBe('mongodb');
  });

  it('throws on an unknown provider instead of falling back to MongoDB', () => {
    expect(() => getProvider('postgres')).toThrow(/Unknown DATABASE_PROVIDER "postgres"/);
  });

  it('reports a disconnected state before connecting', () => {
    expect(mysqlProvider.state()).toEqual({
      provider: 'mysql',
      status: 'disconnected',
      isConnected: false,
    });
    expect(mongoProvider.state()).toMatchObject({ provider: 'mongodb' });
    expect(mongoProvider.state().status).toBe('disconnected');
  });
});

describe('MySQL pool configuration', () => {
  const config = mysqlPoolConfig();

  it('pins UTC so DATETIME round-trips are timezone independent', () => {
    expect(config.timezone).toBe('Z');
  });

  it('reads DECIMAL as a string so money never becomes a float', () => {
    expect(config.decimalNumbers).toBe(false);
    expect(config.supportBigNumbers).toBe(true);
  });

  it('forbids multiple statements per query (injection hardening)', () => {
    expect(config.multipleStatements).toBe(false);
  });

  it('uses utf8mb4 and a bounded pool with a connect timeout', () => {
    expect(config.charset).toBe('utf8mb4');
    expect(config.connectionLimit).toBeGreaterThan(0);
    expect(config.connectTimeout).toBe(10_000);
    expect(config.waitForConnections).toBe(true);
  });

  it('allows overrides for tooling without mutating the defaults', () => {
    expect(mysqlPoolConfig({ database: 'storefront_test' }).database).toBe('storefront_test');
    expect(mysqlPoolConfig().database).not.toBe('storefront_test');
  });
});
