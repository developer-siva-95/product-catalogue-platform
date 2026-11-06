import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

// Shared messages for the repository-boundary rule (see the server block below).
const DRIVER_MESSAGE =
  'Database drivers are only allowed inside src/repositories/**. Use the repository interface instead.';
const MODEL_MESSAGE =
  'Controllers must not import models or the database connection; call a service.';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.cache/**',
      '**/.arena/**',
      '**/.vite/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'server/uploads/**',
    ],
  },
  js.configs.recommended,

  // ---------------------------------------------------------------- server
  {
    files: [
      'server/**/*.js',
      'server/scripts/**/*.mjs',
      'playwright.config.js',
      'eslint.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
    },
  },

  // ------------------------------------------------- server: repository boundary
  // Services and controllers must stay storage-agnostic: MongoDB and MySQL are
  // interchangeable behind `src/repositories/*`. Nothing above the repository
  // layer may import a database driver, the connection module or (for
  // controllers) a Mongoose model.
  {
    files: ['server/src/modules/**/service.js', 'server/src/middlewares/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'mongoose', message: DRIVER_MESSAGE },
            { name: 'mongodb', message: DRIVER_MESSAGE },
            { name: 'bson', message: DRIVER_MESSAGE },
            { name: 'mysql2', message: DRIVER_MESSAGE },
            {
              name: 'mysql2/promise',
              message: 'Use src/repositories/mysql/* instead.',
            },
          ],
          patterns: [
            { group: ['mongodb/*', 'mysql2/*'], message: DRIVER_MESSAGE },
            {
              group: ['**/model.js', '**/config/db.js', '**/db/index.js'],
              message: MODEL_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    // Stricter for controllers: they translate HTTP and must not know that a
    // model exists. Services legitimately import models until P2 moves those
    // queries into `repositories/mongo/*`.
    files: ['server/src/modules/**/controller.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'mongoose', message: DRIVER_MESSAGE },
            { name: 'mongodb', message: DRIVER_MESSAGE },
            { name: 'bson', message: DRIVER_MESSAGE },
            { name: 'mysql2', message: DRIVER_MESSAGE },
            { name: 'mysql2/promise', message: DRIVER_MESSAGE },
          ],
          patterns: [
            { group: ['mongodb/*', 'mysql2/*'], message: DRIVER_MESSAGE },
            { group: ['**/model.js', '**/config/db.js', '**/db/index.js'], message: MODEL_MESSAGE },
          ],
        },
      ],
    },
  },

  // ------------------------------------------------- e2e specs (Node + in-page code)
  {
    files: ['e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Playwright specs run in Node, but `page.evaluate` callbacks are serialised
      // into the browser, so both global sets are required.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
    },
  },

  // ------------------------------------------------- audit harnesses (Node + in-page code)
  {
    files: ['audit/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // The Playwright harnesses run in Node but also contain functions that
      // are serialised into the page, so both global sets are required.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
    },
  },

  // ---------------------------------------------------------------- tests
  {
    files: ['server/tests/**/*.js', 'client/src/**/*.test.jsx', 'client/src/test/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.vitest } },
    rules: { 'no-console': 'off' },
  },

  // ------------------------------------------------- client build tooling (Node)
  {
    files: ['client/vite.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  // ---------------------------------------------------------------- client
  {
    files: ['client/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.vitest },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...react.configs.flat.recommended.rules,
      // eslint-plugin-react-hooks v7 bundles the React Compiler rule set inside
      // `configs.recommended`. The rules that catch real bugs (hook order and
      // stale closures) stay blocking; the compiler-only diagnostics are
      // reported as warnings so they are visible while the components are
      // migrated to compiler-friendly patterns, without failing the gate.
      ...Object.fromEntries(
        Object.entries(reactHooks.configs.recommended.rules).map(([rule, level]) => [
          rule,
          rule === 'react-hooks/rules-of-hooks' || rule === 'react-hooks/exhaustive-deps'
            ? level
            : 'warn',
        ]),
      ),
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];
