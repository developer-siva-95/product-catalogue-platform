import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { shouldSkipMysql } from '../helpers/mysql.js';
import { clearMysqlTables, closePool, resetMysqlSchema } from '../helpers/mysql-db.js';
import { withTransaction } from '../../src/db/mysql/pool.js';
import { configureRepositories, getRepositories } from '../../src/repositories/index.js';

configureRepositories('mysql');

/**
 * MySQL concurrency evidence (Section 10: "concurrency-safe inventory").
 *
 * The shared contract suite already asserts that a contended decrement never
 * oversells. This file adds the two things that only a real MySQL can prove:
 *
 *  1. a heavy contended decrement (8 concurrent buyers against 5 units, five
 *     products at once) still lands exactly on stock 0 with no lost update;
 *  2. **a genuine InnoDB deadlock** — two transactions locking the same two rows in
 *     opposite order — is absorbed by the retry wrapper in `pool.withTransaction`
 *     instead of surfacing as a 409/500 to the caller.
 */
describe.skipIf(shouldSkipMysql())('MySQL concurrency', () => {
  const repos = () => getRepositories();

  beforeAll(async () => {
    await resetMysqlSchema();
  }, 90_000);

  afterAll(async () => {
    await closePool();
  }, 60_000);

  beforeEach(async () => {
    await clearMysqlTables();
  });

  async function seedProducts(count, stock) {
    const brand = await repos().brands.create({ name: 'Concurrency Brand', description: 'b' });
    const category = await repos().categories.create({ name: 'Concurrency Cat', description: 'c' });
    const created = [];
    for (let index = 1; index <= count; index += 1) {
      const record = await repos().products.create({
        payload: {
          title: `Contended Product ${index}`,
          description: 'contended',
          price: 10 + index,
          stock,
          brand: brand.id,
          category: category.id,
          isActive: true,
        },
        slugSource: `Contended Product ${index}`,
        skuPrefix: 'CON',
      });
      created.push(record);
    }
    return created;
  }

  it('settles 8 concurrent buyers per product on exactly 5 units, five products at a time', async () => {
    const stock = 5;
    const products = await seedProducts(5, stock);

    const attempts = products.flatMap((product) =>
      Array.from({ length: 8 }, () => repos().products.updateStock(product._id, { delta: -1 })),
    );

    const results = await Promise.all(attempts);
    const applied = results.filter((result) => result && !result.insufficient);
    const refused = results.filter((result) => result?.insufficient);

    expect(applied).toHaveLength(5 * stock);
    expect(refused).toHaveLength(5 * (8 - stock));

    for (const product of products) {
      const after = await repos().products.findAdminById(product._id);
      expect(after.stock).toBe(0);
      expect(after.__v).toBe(stock);
    }
  }, 60_000);

  it('absorbs a real InnoDB deadlock by retrying the whole transaction', async () => {
    const [first, second] = await seedProducts(2, 10);
    const handlerRuns = { a: 0, b: 0 };

    /** Locks `x` then `y`, sleeping in between so the two orders interleave. */
    function contendingTransaction(key, firstId, secondId) {
      return withTransaction(
        async (connection) => {
          handlerRuns[key] += 1;
          await connection.query('UPDATE products SET stock = stock WHERE id = ?', [firstId]);
          await new Promise((resolve) => setTimeout(resolve, 150));
          await connection.query('UPDATE products SET stock = stock WHERE id = ?', [secondId]);
          return key;
        },
        { attempts: 6 },
      );
    }

    const settled = await Promise.allSettled([
      contendingTransaction('a', first._id, second._id),
      contendingTransaction('b', second._id, first._id),
    ]);

    expect(settled.map((entry) => entry.status)).toEqual(['fulfilled', 'fulfilled']);
    // A deadlock happened and was retried: at least one handler ran twice.
    expect(handlerRuns.a + handlerRuns.b).toBeGreaterThan(2);
    expect(Math.max(handlerRuns.a, handlerRuns.b)).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
