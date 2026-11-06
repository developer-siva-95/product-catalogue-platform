/**
 * Development helper: starts a throwaway in-memory MongoDB.
 *
 * The project targets a real MongoDB in every deployed environment; this script
 * exists so a developer (or a CI preview) can run the stack without Docker or a
 * system MongoDB. It prints the connection string to paste into `server/.env`.
 *
 * Usage: node scripts/dev-mongo.mjs
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

const port = Number(process.env.DEV_MONGO_PORT ?? 27999);

const server = await MongoMemoryServer.create({
  instance: { port, dbName: 'catalogue', args: ['--wiredTigerCacheSizeGB', '0.25'] },
});

const uri = server.getUri();
process.stdout.write(`MONGO_URI=${uri}\n`);

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
