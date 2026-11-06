import mongoose from 'mongoose';
import { connectDB, disconnectDB, getDbState } from '../../config/db.js';
import logger from '../../utils/logger.js';

/**
 * MongoDB provider adapter.
 *
 * Thin wrapper over `config/db.js` that exposes the provider-neutral surface the
 * rest of the application uses (connect / disconnect / state / probe / health /
 * withTransaction). Keeping Mongoose behind this module means `src/db/index.js`,
 * `server.js` and `/health` never import a driver.
 */

export const name = 'mongodb';

/** @returns {Promise<void>} */
export async function connect() {
  await connectDB();
}

/** @returns {Promise<void>} */
export async function disconnect() {
  await disconnectDB();
}

/**
 * Provider-neutral connection state.
 * `status` keeps the exact strings the /health contract has always reported
 * ('connected' / 'disconnected' / 'connecting' / 'disconnecting').
 */
export function state() {
  const db = getDbState();
  return {
    provider: name,
    status: db.status,
    isConnected: db.isConnected || db.status === 'connected',
    readyState: db.readyState,
  };
}

/**
 * Capability probe: can this deployment run multi-document transactions?
 *
 * The catalogue's inventory path is designed so it does *not* need them (a
 * single-document guarded `$inc` plus optimistic concurrency), but the answer is
 * still reported at boot and can be made mandatory via REQUIRE_TRANSACTIONS —
 * silently degrading to a non-transactional topology is exactly the failure mode
 * this probe exists to prevent.
 *
 * @returns {Promise<{provider: string, transactions: boolean, reason?: string, topology?: string}>}
 */
export async function probe() {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    // A `ping` is *not* on MongoDB's allow-list of commands that may run inside a
    // multi-document transaction, so it would report `false` even on a healthy
    // replica set (found by the P5 capability test). Probe with a real read
    // instead: `find` is allowed, and a missing collection is a valid empty result.
    await mongoose.connection.db.collection('__capability_probe').findOne({}, { session });
    await session.commitTransaction();
    return { provider: name, transactions: true, topology: 'replica-set-or-sharded' };
  } catch (error) {
    // Standalone mongod rejects any transaction with "Transaction numbers are
    // only allowed on a replica set member or mongos".
    return { provider: name, transactions: false, reason: error.message, topology: 'standalone' };
  } finally {
    await session.endSession();
  }
}

/**
 * Runs `handler(session)` in a transaction. Only reachable when the probe
 * reported transactions available; the caller decides whether to require them.
 *
 * @template T
 * @param {(session: import('mongoose').ClientSession) => Promise<T>} handler
 * @returns {Promise<T>}
 */
export async function withTransaction(handler) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await handler(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/** @returns {Promise<{ok: boolean, latencyMs: number, version?: string, error?: string}>} */
export async function health() {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await mongoose.connection.db.command({ ping: 1 });
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return {
      ok: result.ok === 1,
      latencyMs: Number(latencyMs.toFixed(1)),
      version: mongoose.version,
    };
  } catch (error) {
    logger.error('mongodb health probe failed', { err: error });
    return { ok: false, latencyMs: -1, error: error.message };
  }
}

export default { name, connect, disconnect, state, probe, withTransaction, health };
