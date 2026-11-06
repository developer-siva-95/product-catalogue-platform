import logger from './utils/logger.js';
import { disconnectDatabase } from './db/index.js';

/**
 * Graceful-shutdown sequencing, kept in its own module so it can be unit-tested
 * without booting a database or a listener.
 */
/**
 * @param {object} options
 * @param {{ close: (callback: (error?: Error) => void) => void }} options.server
 * @param {(signal: string) => Promise<void>} [options.disconnect]
 * @param {(code: number) => void} [options.exit]
 * @param {number} [options.timeoutMs]
 * @returns {(signal: string) => Promise<void>}
 */
export function createShutdownHandler({
  server,
  disconnect = disconnectDatabase,
  exit = (code) => process.exit(code),
  timeoutMs = 15_000,
}) {
  let shuttingDown = false;

  return async function shutdown(signal) {
    if (shuttingDown) {
      logger.warn('shutdown already in progress, ignoring signal', { signal });
      return;
    }
    shuttingDown = true;
    logger.info('shutdown initiated', { signal });

    // Unref'd so it never keeps the process alive on its own; it only fires if a
    // socket or the database refuses to let go.
    const forceExit = setTimeout(() => {
      logger.error('forced shutdown after timeout', { timeoutMs });
      exit(1);
    }, timeoutMs);
    forceExit.unref?.();

    await new Promise((resolve) => {
      server.close(async (closeError) => {
        if (closeError) logger.error('error while closing http server', { err: closeError });
        try {
          await disconnect();
          logger.info('shutdown complete', { signal });
          exit(closeError ? 1 : 0);
        } catch (error) {
          logger.error('error while closing database', { err: error });
          exit(1);
        } finally {
          clearTimeout(forceExit);
          resolve();
        }
      });
    });
  };
}
