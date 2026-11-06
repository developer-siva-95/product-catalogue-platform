import { connectTestDB, disconnectTestDB, clearDatabase, syncIndexes } from '../helpers/db.js';
import { configureRepositories, getRepositories } from '../../src/repositories/index.js';
import { defineRepositoryContractSuite } from '../contracts/repository-contract.js';
import { defineTextSearchSuite } from '../contracts/text-search-contract.js';

/**
 * Shared contract suite — MongoDB provider.
 *
 * Runs against a **single-node replica set** (see tests/globalSetup.js), i.e. the
 * same topology the startup capability probe is required to accept.
 */
configureRepositories('mongodb');

defineRepositoryContractSuite({
  provider: 'mongodb',
  skip: false,
  repositories: () => getRepositories(),
  setup: async () => {
    await connectTestDB();
    await syncIndexes();
  },
  teardown: disconnectTestDB,
  reset: clearDatabase,
});

/* Text search: MongoDB's `$text` index stems, so inflected forms match. */
defineTextSearchSuite({
  provider: 'mongodb',
  skip: false,
  repositories: () => getRepositories(),
  setup: async () => {
    await connectTestDB();
    await syncIndexes();
  },
  teardown: disconnectTestDB,
  reset: clearDatabase,
  textSearch: {
    stems: true,
    expected: {
      sneaker: 1,
      sneakers: 1,
      Sandal: 1,
      sandals: 1,
      cap: 1,
      boot: 1,
      the: 0,
      be: 0,
    },
  },
});
