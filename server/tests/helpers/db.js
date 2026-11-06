import mongoose from 'mongoose';
import env from '../../src/config/env.js';
import { clearDatabase, TEST_MONGO_URI } from '../setup.js';

/**
 * Safety gate: refuses to run if the connection string is not the ephemeral test
 * instance. Prevents an accidental `.env` leak from wiping real data.
 */
function assertIsolatedDatabase(uri) {
  const isMemoryServer = uri === TEST_MONGO_URI && uri.includes('127.0.0.1:27999');
  if (!isMemoryServer) {
    throw new Error(`Refusing to run tests against a non-test database: ${uri}`);
  }
}

export async function connectTestDB() {
  assertIsolatedDatabase(env.MONGO_URI);
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(env.MONGO_URI, { autoIndex: true });
  return mongoose.connection;
}

export async function disconnectTestDB() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

export { clearDatabase };

/** Ensures all model indexes exist before a spec that depends on uniqueness. */
export async function syncIndexes() {
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
}
