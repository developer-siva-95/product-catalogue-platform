import { shouldSkipMysql } from '../helpers/mysql.js';
import { clearMysqlTables, closePool, resetMysqlSchema } from '../helpers/mysql-db.js';
import { configureRepositories, getRepositories } from '../../src/repositories/index.js';
import { defineRepositoryContractSuite } from '../contracts/repository-contract.js';
import { defineTextSearchSuite } from '../contracts/text-search-contract.js';

/**
 * Shared contract suite — MySQL provider.
 *
 * The exact same expectations as `contracts.mongo.test.js`, executed against a real
 * MySQL 8.0 server. Skips (rather than fails) when no credentials are supplied, so
 * `npm run verify` works without MySQL; `MYSQL_REQUIRE=1` turns a missing server
 * into a failure.
 */
configureRepositories('mysql');

defineRepositoryContractSuite({
  provider: 'mysql',
  skip: shouldSkipMysql(),
  repositories: () => getRepositories(),
  setup: resetMysqlSchema,
  teardown: async () => {
    await closePool();
  },
  reset: clearMysqlTables,
});

/* Text search: InnoDB FULLTEXT has no stemmer — the one documented divergence. */
defineTextSearchSuite({
  provider: 'mysql',
  skip: shouldSkipMysql(),
  repositories: () => getRepositories(),
  setup: resetMysqlSchema,
  teardown: async () => {
    await closePool();
  },
  reset: clearMysqlTables,
  textSearch: {
    stems: false,
    reason: 'InnoDB FULLTEXT uses no stemmer, so inflected forms do not match in text mode',
    expected: {
      sneaker: 1,
      sneakers: 0,
      Sandal: 1,
      sandals: 0,
      cap: 1,
      boot: 1,
      the: 0,
      be: 0,
    },
  },
});
