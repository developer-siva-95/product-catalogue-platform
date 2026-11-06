import mongoose from 'mongoose';
import env from './env.js';
import logger from '../utils/logger.js';

mongoose.set('strictQuery', true);

// NOTE: `sanitizeFilter` is deliberately NOT enabled globally. It rewrites every
// object-valued filter into `{ $eq: {...} }`, which breaks the legitimate
// operators this codebase relies on ($regex for search, $ne for exclude-self
// uniqueness checks, $gt/$lt for cursors). Injection defence is enforced at the
// request boundary instead (middlewares/sanitize.js + strict Zod schemas), which
// is the only place user input enters a query.

let isConnected = false;

/**
 * Opens the MongoDB connection.
 *
 * Lifecycle rules baked in here:
 *  - fail fast (5s server selection) so a bad URI doesn't hang boot;
 *  - no autoIndex in production (indexes are created by migrations/seed time);
 *  - connection events are logged once, not per query.
 *
 * @param {string} [uri]
 * @returns {Promise<import('mongoose').Mongoose>}
 */
export async function connectDB(uri = env.MONGO_URI) {
  if (mongoose.connection.readyState === 1) return mongoose;

  mongoose.connection.on('connected', () => {
    isConnected = true;
    logger.info('mongodb connected', { db: mongoose.connection.name });
  });
  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    logger.warn('mongodb disconnected');
  });
  mongoose.connection.on('error', (error) => {
    logger.error('mongodb connection error', { err: error });
  });

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    autoIndex: !env.isProduction,
    maxPoolSize: env.isProduction ? 20 : 10,
  });

  return mongoose;
}

/**
 * Closes the connection. Safe to call when already closed (graceful shutdown and
 * test teardown both do this unconditionally).
 */
export async function disconnectDB() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  isConnected = false;
}

/** Liveness helper used by /health. */
export function getDbState() {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  return {
    readyState: mongoose.connection.readyState,
    status: states[mongoose.connection.readyState] ?? 'unknown',
    isConnected,
  };
}

export default { connectDB, disconnectDB, getDbState };
