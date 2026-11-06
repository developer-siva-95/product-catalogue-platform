import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectTestDB, disconnectTestDB } from '../helpers/db.js';
import {
  assertTransactionCapability,
  connectDatabase,
  disconnectDatabase,
  getDatabaseState,
  getProviderName,
  withTransaction,
} from '../../src/db/index.js';
import { probe as probeMongo } from '../../src/db/mongo/provider.js';
import { isPoolCreated } from '../../src/db/mysql/pool.js';
import { getRepositories } from '../../src/repositories/index.js';
import { Product } from '../../src/modules/products/model.js';

/**
 * Startup capability probe (decision D2(a)) — against the real topology.
 *
 * The test mongod runs as a **single-node replica set**, so the probe must report
 * transactions as *available*. On the standalone instance used before P5 it could
 * only ever answer "unavailable", which meant the probe and `withTransaction` were
 * never actually exercised.
 */
describe('MongoDB transaction capability', () => {
  beforeAll(async () => {
    await connectTestDB();
  });

  afterAll(async () => {
    await disconnectTestDB();
  });

  it('never opens a MySQL pool while MongoDB is the selected provider', async () => {
    const poolBefore = isPoolCreated();
    const capabilities = await connectDatabase();

    expect(capabilities.provider).toBe('mongodb');
    expect(getProviderName()).toBe('mongodb');
    // Order-independent: whatever a neighbouring suite did, connecting MongoDB
    // must not create (or reconfigure) the MySQL pool.
    expect(isPoolCreated()).toBe(poolBefore);
  });

  it('reports transactions available on a replica set', async () => {
    const capabilities = await probeMongo();
    expect(capabilities).toMatchObject({ provider: 'mongodb', transactions: true });
  });

  it('runs a real multi-document transaction that rolls back atomically', async () => {
    const { products } = getRepositories();
    const before = await Product.countDocuments({});

    await expect(
      withTransaction(async (session) => {
        await Product.create(
          [
            {
              title: 'Transaction Rollback Product',
              slug: 'transaction-rollback-product',
              price: 1,
              stock: 1,
              description: 'should not survive',
              brand: '650000000000000000000001',
              category: '651000000000000000000001',
            },
          ],
          { session },
        );
        throw new Error('rollback on purpose');
      }),
    ).rejects.toThrow('rollback on purpose');

    // The insert inside the aborted transaction must not be visible.
    expect(await Product.countDocuments({})).toBe(before);
    expect(await Product.findOne({ slug: 'transaction-rollback-product' }).lean()).toBeNull();
    expect(products).toBeDefined();
  });
});

describe('REQUIRE_TRANSACTIONS policy', () => {
  it('allows boot when the policy is off, whatever the topology', () => {
    expect(assertTransactionCapability({ provider: 'mongodb', transactions: false }, false)).toBe(
      true,
    );
  });

  it('allows boot when the policy is on and transactions are available', () => {
    expect(assertTransactionCapability({ provider: 'mongodb', transactions: true }, true)).toBe(
      true,
    );
  });

  it('refuses boot when the policy is on and the topology cannot transact', () => {
    expect(() =>
      assertTransactionCapability(
        { provider: 'mongodb', transactions: false, reason: 'standalone' },
        true,
      ),
    ).toThrow(/REQUIRE_TRANSACTIONS=true but the mongodb deployment cannot run transactions/);
  });

  it('names the provider in the refusal so a misconfiguration is diagnosable', () => {
    try {
      assertTransactionCapability({ provider: 'mysql', transactions: false }, true);
    } catch (error) {
      expect(error.name).toBe('TransactionCapabilityError');
      expect(error.message).toContain('mysql');
    }
  });
});

describe('provider bootstrap', () => {
  it('binds the repository registry to the provider that answered the probe', async () => {
    await connectTestDB();
    const capabilities = await connectDatabase({ provider: 'mongodb' });

    expect(capabilities.provider).toBe('mongodb');
    expect(getProviderName()).toBe('mongodb');
    expect(getDatabaseState()).toMatchObject({ provider: 'mongodb', status: 'connected' });
    expect(Object.isFrozen(getRepositories())).toBe(true);
    expect(typeof getRepositories().products.listStorefront).toBe('function');

    await disconnectDatabase();
    await connectTestDB();
  });
});
