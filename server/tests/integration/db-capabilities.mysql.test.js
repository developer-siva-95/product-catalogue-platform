import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { shouldSkipMysql } from '../helpers/mysql.js';
import { closePool, resetMysqlSchema } from '../helpers/mysql-db.js';
import { getPool } from '../../src/db/mysql/pool.js';
import { probe } from '../../src/db/mysql/provider.js';

/**
 * MySQL capability probe — against the real MySQL 8.0 server.
 *
 * Mirrors `db-capabilities.test.js` for MongoDB: the probe must not merely read
 * engine flags, it must prove that a transaction can be started, written to and
 * rolled back.
 */
describe.skipIf(shouldSkipMysql())('MySQL transaction capability', () => {
  beforeAll(async () => {
    await resetMysqlSchema();
  });

  afterAll(async () => {
    await closePool();
  });

  it('reports InnoDB, a real version string and transactions available', async () => {
    const capabilities = await probe();

    expect(capabilities).toMatchObject({
      provider: 'mysql',
      transactions: true,
      storageEngine: 'InnoDB',
    });
    expect(capabilities.version).toMatch(/^8\.0\./);
    expect(capabilities.isolation).toBeTruthy();
  });

  it('rolls back a write inside a transaction, leaving no row behind', async () => {
    const pool = getPool();
    const connection = await pool.getConnection();
    try {
      await connection.query('CREATE TEMPORARY TABLE rollback_probe (id INT) ENGINE=InnoDB');
      await connection.beginTransaction();
      await connection.query('INSERT INTO rollback_probe (id) VALUES (1)');
      await connection.rollback();
      const [rows] = await connection.query('SELECT COUNT(*) AS total FROM rollback_probe');
      expect(Number(rows[0].total)).toBe(0);
    } finally {
      connection.release();
    }
  });
});
