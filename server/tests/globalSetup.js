import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Starts ONE ephemeral mongod **replica set** (single member) for the whole run.
 *
 * Why a replica set rather than a standalone: the startup capability probe
 * (db/mongo/provider.js) reports whether multi-document transactions are
 * available, and decision D2(a) makes that probe mandatory. On a standalone it
 * would always answer "unavailable", so the probe — and any future transaction
 * path — would never actually be exercised. A one-member replica set gives real
 * transactions at almost the same cost.
 *
 * A fixed port is used so worker processes (which do not inherit this process'
 * environment) can reach it via the deterministic URI in tests/setup.js.
 */
export const TEST_MONGO_PORT = 27_999;

export async function setup() {
  // MySQL-only runs (`npm run test:mysql`) need no mongod at all. Starting one
  // anyway costs a few hundred MB and has no effect on the assertions, so it is
  // opt-out via SKIP_MONGO_MEMORY=1 (the Mongo suites still require it).
  if (process.env.SKIP_MONGO_MEMORY === '1') {
    return async function teardown() {};
  }

  const replSet = await MongoMemoryReplSet.create({
    // Cap the WT cache: the fixture set is a few KB, and an unbounded cache on a
    // small CI box is what makes mongod die with an invariant failure under load.
    replSet: { count: 1, dbName: 'catalogue_test', args: ['--wiredTigerCacheSizeGB', '0.25'] },
    instanceOpts: [{ port: TEST_MONGO_PORT, dbName: 'catalogue_test' }],
    binary: { version: process.env.MONGOMS_VERSION ?? '7.0.14' },
  });
  global.__MONGO_INSTANCE__ = replSet;
  return async function teardown() {
    await replSet.stop({ doCleanup: true, force: true });
  };
}
