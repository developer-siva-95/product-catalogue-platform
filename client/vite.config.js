import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite configuration.
 *
 * The SPA always talks to a *relative* `/api/v1` base URL. In development Vite
 * proxies those requests (and `/uploads`) to the Express server, which means:
 *  - cookies and CSRF stay first-party (no CORS/cookie SameSite problems);
 *  - the app works unchanged behind the preview host, because requests never
 *    reference localhost from the browser;
 *  - the production build can be served by the same origin as the API.
 */
const API_TARGET = process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:5000';
const DEV_ORIGIN = process.env.VITE_DEV_ORIGIN ?? 'http://localhost:5173';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 5173),
    strictPort: false,
    // The sandbox preview host is dynamic, so host checking is disabled here.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // The backend enforces an exact CORS origin; rewrite it so proxied
        // requests are always accepted regardless of which host the browser used.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyRequest) => {
            proxyRequest.setHeader('origin', DEV_ORIGIN);
          });
        },
      },
      '/uploads': { target: API_TARGET, changeOrigin: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
    // Same proxy as the dev server: `vite preview` must be able to reach the API
    // with first-party cookies, otherwise the built bundle cannot be smoke tested.
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyRequest) => {
            proxyRequest.setHeader('origin', DEV_ORIGIN);
          });
        },
      },
      '/uploads': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        /**
         * Vite 8 bundles with Rolldown, which requires `manualChunks` to be a
         * function (the object form that worked with Rollup is rejected with
         * "manualChunks is not a function"). The grouping is unchanged: React +
         * Router in `vendor`, the Redux data layer in `redux`.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) {
            return 'vendor';
          }
          if (
            /node_modules[\\/](@reduxjs[\\/]toolkit|react-redux|redux|redux-thunk|immer|reselect|use-sync-external-store)[\\/]/.test(
              id,
            )
          ) {
            return 'redux';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
    include: ['src/**/*.test.{js,jsx}'],
    restoreMocks: true,
    // jsdom runs on Node's fetch/Request implementation, which (unlike a browser)
    // refuses to construct a Request from a relative URL. Tests therefore use an
    // absolute base URL; the app itself keeps the relative `/api/v1` default.
    env: { VITE_API_BASE_URL: 'http://localhost:3000/api/v1' },
  },
});
