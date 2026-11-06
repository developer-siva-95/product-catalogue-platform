import { describe, it, expect, vi } from 'vitest';
import { createShutdownHandler } from '../../src/shutdown.js';

/**
 * Graceful shutdown (Phase 7 hardening).
 *
 * The sequence has three properties that matter operationally and are invisible
 * until they are wrong:
 *  1. the HTTP listener stops accepting and in-flight requests are drained
 *     **before** the database handles are closed;
 *  2. the database is closed exactly once, even if the orchestrator sends SIGTERM
 *     and then SIGINT;
 *  3. a database that refuses to close cannot hang the process forever.
 */
function fakeServer({ closeError } = {}) {
  return {
    closed: 0,
    close(callback) {
      this.closed += 1;
      setImmediate(() => callback(closeError));
    },
  };
}

describe('graceful shutdown', () => {
  it('drains the listener, then closes the database, then exits 0', async () => {
    const order = [];
    const server = {
      close(callback) {
        order.push('server.close');
        setImmediate(() => callback());
      },
    };
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      server,
      disconnect: async () => {
        order.push('disconnect');
      },
      exit,
    });

    await shutdown('SIGTERM');

    expect(order).toEqual(['server.close', 'disconnect']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('is idempotent: a second signal never closes the database twice', async () => {
    const disconnect = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      server: fakeServer(),
      disconnect,
      exit,
    });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('SIGTERM')]);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when the listener fails to close, but still releases the database', async () => {
    const disconnect = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      server: fakeServer({ closeError: new Error('close failed') }),
      disconnect,
      exit,
    });

    await shutdown('SIGTERM');

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits 1 when the database refuses to close', async () => {
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      server: fakeServer(),
      disconnect: async () => {
        throw new Error('pool still has active connections');
      },
      exit,
    });

    await shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('force-exits when a stuck socket never calls back', async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const shutdown = createShutdownHandler({
        // Never calls its callback: the classic hung keep-alive connection.
        server: { close: () => {} },
        disconnect: async () => {},
        exit,
        timeoutMs: 5_000,
      });

      void shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(5_100);

      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
