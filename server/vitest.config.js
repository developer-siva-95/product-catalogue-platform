import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    globalSetup: ['./tests/globalSetup.js'],
    include: ['tests/**/*.test.js'],
    // Integration tests share one MongoDB Memory Server instance, so files run
    // sequentially to keep database state deterministic. Vitest 4 removed
    // `poolOptions`; the equivalent is a single worker at the top level.
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      include: ['src/**/*.js'],
      exclude: ['src/server.js', 'src/config/seed.js', 'src/config/swagger.js'],
    },
  },
});
