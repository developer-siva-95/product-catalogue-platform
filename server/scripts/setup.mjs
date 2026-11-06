#!/usr/bin/env node
/**
 * Cross-platform `npm run setup` — one command from a fresh clone to a seeded database.
 *
 * Works identically in Windows PowerShell and on Linux/macOS: plain Node, no shell
 * syntax, no dependency. It never overwrites an existing server/.env and never
 * touches data outside the configured database.
 *
 * Usage:
 *   npm run setup                 # provider from server/.env (default mongodb)
 *   npm run setup:mysql           # force the MySQL path (migrations, then seed)
 *   npm run setup:mongodb         # force the MongoDB path (seed only)
 *   node scripts/setup.mjs mysql --no-seed        # schema only
 *   node scripts/setup.mjs --check                # report what is missing, change nothing
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SERVER_ENV = path.join(REPO_ROOT, 'server', '.env');
const ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example');

const PROVIDERS = ['mongodb', 'mysql'];
const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('-')));
const positional = args.filter((arg) => !arg.startsWith('-'));

const checkOnly = flags.has('--check');
const skipSeed = checkOnly || flags.has('--no-seed');
const skipMigrate = checkOnly || flags.has('--no-migrate');
const requestedProvider = positional[0] ?? null;

if (requestedProvider && !PROVIDERS.includes(requestedProvider)) {
  process.stderr.write(
    `setup: unknown provider "${requestedProvider}" — expected one of: ${PROVIDERS.join(', ')}\n`,
  );
  process.exit(2);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function step(message) {
  process.stdout.write(`\n=== ${message}\n`);
}

/** Minimal KEY=VALUE reader — enough to find DATABASE_PROVIDER without a dependency. */
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const result = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return result;
}

function runNpm(script) {
  log(`> npm run ${script}`);
  // shell: true resolves npm.cmd on Windows and npm on POSIX.
  const result = spawnSync('npm', ['run', script], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    shell: true,
  });
  return result.status ?? 1;
}

// ----------------------------------------------------------------- 1. Node version
const requiredMajor = Number((/>=(\d+)/.exec(readEngine()) ?? [])[1] ?? 22);
function readEngine() {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).engines?.node ?? ''
    );
  } catch {
    return '';
  }
}
const nodeMajor = Number(process.versions.node.split('.')[0]);
step(`Environment — Node ${process.versions.node}, ${process.platform}`);
if (nodeMajor < requiredMajor) {
  process.stderr.write(
    `setup: Node ${requiredMajor}+ is required (see package.json "engines"), found ${process.versions.node}.\n`,
  );
  process.exit(1);
}
log(`ok: Node ${nodeMajor} satisfies engines ${readEngine() || `>=${requiredMajor}`}`);

// ---------------------------------------------------------------------- 2. server/.env
step('server/.env');
const previousEnv = readEnvFile(SERVER_ENV);

if (fs.existsSync(SERVER_ENV)) {
  log('ok: server/.env already exists (left untouched)');
  if (previousEnv.JWT_SECRET?.includes('replace-me')) {
    log(`
warn: JWT_SECRET is still the placeholder from .env.example — the API will refuse to boot.
      Generate one with:
        node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
      and paste it into server/.env      (PowerShell: notepad server\\.env)`);
  }
} else if (checkOnly) {
  log('missing: server/.env — run `npm run setup` to create it from .env.example');
} else {
  if (!fs.existsSync(ENV_EXAMPLE)) {
    process.stderr.write(`setup: ${ENV_EXAMPLE} is missing, cannot create server/.env\n`);
    process.exit(1);
  }
  const generatedSecret = randomBytes(64).toString('hex');
  const contents = fs
    .readFileSync(ENV_EXAMPLE, 'utf8')
    .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${generatedSecret}`);
  fs.writeFileSync(SERVER_ENV, contents, 'utf8');
  log('ok: created server/.env from .env.example with a freshly generated JWT_SECRET');
  log('    edit it if your database is not on 127.0.0.1 or needs a password');
}

// ------------------------------------------------------------------------ 3. provider
// server/.env is read for display, but a variable already exported in this shell
// wins: dotenv does not override the process environment, so neither does this.
const fileEnv = readEnvFile(SERVER_ENV);
const env = { ...fileEnv };
for (const key of [
  'DATABASE_PROVIDER',
  'MONGO_URI',
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_DATABASE',
]) {
  if (process.env[key] !== undefined && process.env[key] !== '') env[key] = process.env[key];
}
// Mirrors src/config/env.js: an unset DATABASE_PROVIDER now means MySQL.
const provider = requestedProvider ?? env.DATABASE_PROVIDER ?? 'mysql';
const passwordFromShell = Boolean(process.env.MYSQL_PASSWORD);

step(`Provider — ${provider}`);
if (provider === 'mysql') {
  const missing = ['MYSQL_USER', 'MYSQL_DATABASE'].filter((key) => !env[key]);
  if (missing.length) {
    log(`warn: ${missing.join(', ')} not set in server/.env`);
  } else {
    log(
      `ok: ${env.MYSQL_USER}@${env.MYSQL_HOST ?? '127.0.0.1'}:${env.MYSQL_PORT ?? '3306'}/${env.MYSQL_DATABASE}`,
    );
  }
  if (!env.MYSQL_PASSWORD) {
    log('note: MYSQL_PASSWORD is empty — fine for a local dev user, never for production');
  } else if (passwordFromShell) {
    log('ok: MYSQL_PASSWORD supplied by the current shell environment');
  }
} else {
  log(`ok: MONGO_URI=${env.MONGO_URI ?? '(unset)'}`);
  if (env.MONGO_URI && !/replicaSet=/.test(env.MONGO_URI)) {
    log(
      'note: no ?replicaSet= in MONGO_URI — transactions are unavailable (REQUIRE_TRANSACTIONS=false is the default)',
    );
  }
}

// ----------------------------------------------------------------------- 4. migrate
if (provider === 'mysql') {
  step('MySQL schema');
  if (skipMigrate) {
    log('skipped (--no-migrate / --check)');
  } else if (runNpm('db:migrate') !== 0) {
    process.stderr.write(
      '\nsetup: schema migration failed — is MySQL running and server/.env correct?\n',
    );
    process.exit(1);
  }
} else {
  step('MongoDB schema');
  log('nothing to do — MongoDB is schemaless, collections are created on first write');
}

// -------------------------------------------------------------------------- 5. seed
step('Seed data');
if (skipSeed) {
  log('skipped (--no-seed / --check)');
} else {
  const seedScript = provider === 'mysql' ? 'seed:mysql' : 'seed';
  if (runNpm(seedScript) !== 0) {
    process.stderr.write(
      `\nsetup: seeding failed — check that the ${provider} server is running and reachable.\n`,
    );
    process.exit(1);
  }
}

// ------------------------------------------------------------------- 6. next steps
step('Done');
log(
  provider === 'mysql'
    ? `Next:  npm run dev  or  npm run dev:mysql   (API on :5000, SPA on :5173) — MySQL is the default provider
Tests: npm run test:mysql  ·  npm run test:contracts  ·  npm run test:migration
E2E:   npm run test:e2e:mysql`
    : `Next:  npm run dev              (API on :5000, SPA on :5173)
Tests: npm run verify  ·  npm run test:contracts
E2E:   npm run test:e2e:mongodb`,
);
