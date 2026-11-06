#!/usr/bin/env node
/**
 * Cross-platform "run the API and the SPA together" launcher.
 *
 * The old script was `npm run dev --workspace server & npm run dev --workspace client`.
 * `&` is a POSIX background operator; in PowerShell it is the call operator and in
 * cmd.exe it is not a separator at all, so the pair never started reliably on
 * Windows. This launcher is plain Node, starts both npm workspaces, prefixes their
 * output, and shuts both down together — no shell syntax, no dependency.
 *
 * Usage:
 *   node scripts/dev.mjs              # whatever DATABASE_PROVIDER says (default MySQL)
 *   node scripts/dev.mjs mysql        # force DATABASE_PROVIDER=mysql for both processes
 *   node scripts/dev.mjs mongodb      # force DATABASE_PROVIDER=mongodb
 *
 * Exit code: the first non-zero exit of either process, or 0 after Ctrl+C.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// server/scripts/dev.mjs -> repository root, whatever directory npm was invoked from
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const PROVIDERS = ['mongodb', 'mysql'];
const requested = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
const provider = requested ?? process.env.DATABASE_PROVIDER ?? null;

if (requested && !PROVIDERS.includes(requested)) {
  process.stderr.write(
    `dev: unknown provider "${requested}" — expected one of: ${PROVIDERS.join(', ')}\n`,
  );
  process.exit(2);
}

const baseEnv = { ...process.env };
if (provider) baseEnv.DATABASE_PROVIDER = provider;

const targets = [
  { name: 'server', workspace: 'server' },
  { name: 'client', workspace: 'client' },
];

const prefixWidth = Math.max(...targets.map((target) => target.name.length));
const children = [];
let shuttingDown = false;
let exitCode = 0;

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    // npm.cmd -> node -> vite/watch: /T kills the whole tree, /F forces it.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    // detached: true gave each child its own process group, so -pid reaches the tree.
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  for (const child of children) killTree(child);
  // give the trees a moment to die before this process exits
  setTimeout(() => process.exit(exitCode), 300).unref();
}

function pipeWithPrefix(stream, name) {
  const reader = createInterface({ input: stream });
  reader.on('line', (line) => {
    process.stdout.write(`[${name.padEnd(prefixWidth)}] ${line}\n`);
  });
}

process.stdout.write(
  `dev: DATABASE_PROVIDER=${provider ?? '(from server/.env, default mysql)'} — starting ${targets
    .map((target) => target.workspace)
    .join(' + ')}\n`,
);

for (const target of targets) {
  const child = spawn(`npm run dev --workspace ${target.workspace}`, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: baseEnv,
    cwd: REPO_ROOT,
    shell: true,
    detached: process.platform !== 'win32',
  });

  children.push(child);
  pipeWithPrefix(child.stdout, target.name);
  pipeWithPrefix(child.stderr, target.name);

  child.on('error', (error) => {
    process.stderr.write(`dev: failed to start ${target.workspace}: ${error.message}\n`);
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    if (code !== 0 || signal) {
      process.stderr.write(`dev: ${target.workspace} stopped unexpectedly (${reason})\n`);
      shutdown(code || 1);
      return;
    }
    // A clean exit of one process is still the end of the dev session.
    if (children.every((entry) => entry.exitCode === 0)) shutdown(0);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdout.write(`\ndev: ${signal} — stopping both processes\n`);
    shutdown(0);
  });
}

process.on('exit', () => {
  for (const child of children) killTree(child);
});
