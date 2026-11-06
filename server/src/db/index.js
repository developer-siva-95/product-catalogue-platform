import env from '../config/env.js';
import logger from '../utils/logger.js';
import { configureRepositories, getRepositories } from '../repositories/index.js';
import * as mongoProvider from './mongo/provider.js';
import * as mysqlProvider from './mysql/provider.js';

/**
 * Provider facade.
 *
 * `DATABASE_PROVIDER` selects one of two equally functional storage back-ends.
 * Selecting a provider is a *configuration* change: no module above this file
 * knows which one is active, and `/health`, the repository registry and
 * transaction handling all go through this module.
 */

/** @type {Record<string, typeof mongoProvider>} */
const providers = {
  mongodb: mongoProvider,
  mysql: mysqlProvider,
};

export const SUPPORTED_PROVIDERS = Object.freeze(Object.keys(providers));

/**
 * @param {string} [providerName] defaults to the configured DATABASE_PROVIDER
 * @returns {typeof mongoProvider}
 */
export function getProvider(providerName = env.DATABASE_PROVIDER) {
  const provider = providers[providerName];
  if (!provider) {
    throw new Error(
      `Unknown DATABASE_PROVIDER "${providerName}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}.`,
    );
  }
  return provider;
}

/** @returns {string} the active provider name ('mongodb' | 'mysql') */
export function getProviderName() {
  return env.DATABASE_PROVIDER;
}

/**
 * Connects the selected provider, probes its capabilities, binds the repository
 * registry to it and enforces REQUIRE_TRANSACTIONS.
 *
 * Order matters: the probe runs *before* the registry is bound so a provider
 * that cannot honour its concurrency guarantees never starts serving traffic.
 *
 * @returns {Promise<{provider: string, transactions: boolean, version?: string}>}
 */
export async function connectDatabase(options = {}) {
  const provider = getProvider(options.provider);
  // Provider resolution is never invisible: every process that opens a database
  // (API, seed, migration CLI, tests) logs which provider it resolved and whether
  // that came from the environment or from the default. No credentials, no URIs.
  logger.info('database provider resolved', {
    provider: getProviderName(),
    source: env.DATABASE_PROVIDER_SOURCE,
  });
  await provider.connect();

  const capabilities = await provider.probe();
  logger.info('database capabilities', { ...capabilities });

  if (env.REQUIRE_TRANSACTIONS) {
    try {
      assertTransactionCapability(capabilities, true);
    } catch (error) {
      await provider.disconnect().catch(() => {});
      throw error;
    }
  }

  // Binds the repository layer to the same provider that answered the probe.
  configureRepositories(capabilities.provider);
  return capabilities;
}

/**
 * Enforces the REQUIRE_TRANSACTIONS policy for a probed capability set.
 *
 * Extracted (and exported) so the policy is testable without having to provision a
 * deliberately broken database: the guarantee that matters is that a deployment
 * which cannot transact never starts serving when the policy demands it.
 *
 * @param {{provider?: string, transactions?: boolean, reason?: string}} capabilities
 * @param {boolean} required
 * @returns {true}
 */
export function assertTransactionCapability(capabilities, required) {
  if (!required || capabilities?.transactions) return true;

  const error = new Error(
    `REQUIRE_TRANSACTIONS=true but the ${capabilities?.provider ?? 'configured'} deployment ` +
      `cannot run transactions (${capabilities?.reason ?? 'unknown reason'}).`,
  );
  error.name = 'TransactionCapabilityError';
  throw error;
}

/** Closes the active provider connection. */
export async function disconnectDatabase() {
  await getProvider().disconnect();
}

/**
 * Connection state for /health.
 * @returns {{provider: string, status: string, isConnected: boolean}}
 */
export function getDatabaseState() {
  return getProvider().state();
}

/** Liveness probe for /health (version + latency). */
export async function getDatabaseHealth() {
  return getProvider().health();
}

/**
 * Runs `handler(connectionOrSession)` inside a provider transaction.
 * MongoDB passes a `ClientSession`, MySQL passes a `PoolConnection`; both expose
 * the same `transactional()` repository methods, so callers stay provider-blind.
 *
 * @template T
 * @param {(tx: unknown) => Promise<T>} handler
 * @returns {Promise<T>}
 */
export async function withTransaction(handler) {
  return getProvider().withTransaction(handler);
}

/** The repositories bound to the active provider. */
export { getRepositories };

export default {
  connectDatabase,
  disconnectDatabase,
  getDatabaseState,
  getDatabaseHealth,
  withTransaction,
  getProvider,
  getProviderName,
  getRepositories,
};
