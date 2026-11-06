import { shouldSkipMysql } from '../helpers/mysql.js';
import { clearMysqlTables, closePool, resetMysqlSchema } from '../helpers/mysql-db.js';
import { query } from '../../src/db/mysql/pool.js';
import { configureRepositories, getRepositories } from '../../src/repositories/index.js';
import { defineSeedSuite } from '../contracts/seed-contract.js';

configureRepositories('mysql');

/**
 * Fingerprint of every stored record, in the same shape the Mongo adapter
 * produces: plain JSON with ISO timestamps, so `toEqual` compares values and not
 * driver classes.
 */
async function snapshot() {
  const [brands, categories, products, users] = await Promise.all([
    query('SELECT * FROM brands ORDER BY name_normalized'),
    query('SELECT * FROM categories ORDER BY name_normalized'),
    query('SELECT * FROM products ORDER BY slug'),
    query('SELECT * FROM users ORDER BY email'),
  ]);

  return {
    brands: JSON.parse(JSON.stringify(brands)),
    categories: JSON.parse(JSON.stringify(categories)),
    products: JSON.parse(JSON.stringify(products)),
    users: JSON.parse(JSON.stringify(users)),
    counts: {
      brands: brands.length,
      categories: categories.length,
      products: products.length,
      users: users.length,
    },
  };
}

defineSeedSuite({
  provider: 'mysql',
  skip: shouldSkipMysql(),
  repositories: () => getRepositories(),
  setup: resetMysqlSchema,
  teardown: async () => {
    await closePool();
  },
  reset: clearMysqlTables,
  snapshot,
  removeSomeProducts: async (count) => {
    const rows = await query('SELECT id FROM products ORDER BY slug LIMIT ?', [count]);
    if (!rows.length) return;
    const placeholders = rows.map(() => '?').join(', ');
    await query(
      `DELETE FROM products WHERE id IN (${placeholders})`,
      rows.map((row) => row.id),
    );
  },
});
