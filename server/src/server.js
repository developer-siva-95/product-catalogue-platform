import http from 'node:http';
import env from './config/env.js';
import logger from './utils/logger.js';
import { createApp } from './app.js';
import { connectDatabase, getProviderName, SUPPORTED_PROVIDERS } from './db/index.js';
import { createShutdownHandler } from './shutdown.js';

/**
 * Process entrypoint: env validation (already done at import of config/env),
 * DB connection, HTTP listener and graceful shutdown.
 *
 * Shutdown sequence: stop accepting connections -> drain in-flight requests ->
 * close the database handles (Mongo sockets / the MySQL pool) -> exit. A hard
 * timeout guarantees the process cannot hang forever on a stuck socket (container
 * orchestrators would otherwise SIGKILL, which is exactly what leaves MySQL
 * connections half-closed and pool slots leaked).
 *
 * `createShutdownHandler` is exported and pure with respect to the process (all
 * side effects are injected) so the sequence — including the "second signal is
 * ignored" and "force exit after timeout" rules — is covered by a unit test
 * instead of being verified by hand at 3 a.m.
 */

export async function bootstrap() {
  const capabilities = await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  server.listen(env.PORT, '0.0.0.0', () => {
    logger.info('server listening', {
      provider: getProviderName(),
      providerSource: env.DATABASE_PROVIDER_SOURCE,
      supportedProviders: SUPPORTED_PROVIDERS,
      transactions: capabilities.transactions,
      port: env.PORT,
      env: env.NODE_ENV,
      url: `http://localhost:${env.PORT}`,
      cors: env.FRONTEND_URL,
    });
  });

  const shutdown = createShutdownHandler({ server });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void shutdown(signal));
  }

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { err: reason });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { err: error });
    void shutdown('uncaughtException');
  });

  return server;
}

bootstrap().catch((error) => {
  logger.error('failed to start server', { err: error });
  process.exit(1);
});
