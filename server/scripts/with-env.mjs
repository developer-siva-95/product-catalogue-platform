#!/usr/bin/env node
/**
 * Cross-platform environment wrapper for npm scripts.
 *
 * `VAR=value command` and `export` are POSIX-shell syntax: they do not work in
 * Windows PowerShell (or cmd.exe), so every npm script that needs an environment
 * variable for one command goes through this launcher instead. It is plain Node —
 * no shell features, no extra dependency.
 *
 * Usage:
 *   node scripts/with-env.mjs DATABASE_PROVIDER=mysql -- npm run dev --workspace server
 *   node scripts/with-env.mjs MYSQL_REQUIRE=1 -- vitest run tests/integration/x.test.js
 *
 * Rules:
 *   - everything before `--` is KEY=VALUE, applied on top of the current
 *     environment (the parent environment still wins for keys you do not set)
 *   - everything after `--` is the command, spawned with the current working
 *     directory and stdin/stdout/stderr inherited
 *   - the child's exit code becomes this process's exit code
 */
import { spawn } from 'node:child_process';

const USAGE = `Usage: node scripts/with-env.mjs KEY=VALUE [KEY=VALUE ...] -- <command> [args...]

Example:
  node scripts/with-env.mjs DATABASE_PROVIDER=mysql -- npm run dev --workspace server`;

function fail(message) {
  process.stderr.write(`with-env: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);

if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(argv.length === 0 ? 2 : 0);
}

const separator = argv.indexOf('--');
if (separator === -1) fail('missing the "--" separator between assignments and the command');

const assignments = argv.slice(0, separator);
const command = argv[separator + 1];
const commandArgs = argv.slice(separator + 2);

if (!command) fail('no command given after "--"');

const env = { ...process.env };

for (const token of assignments) {
  const equals = token.indexOf('=');
  if (equals < 1) fail(`"${token}" is not in KEY=VALUE form`);
  const key = token.slice(0, equals);
  const value = token.slice(equals + 1);
  env[key] = value;
}

/**
 * Quotes one token so that the shell we hand the command line to (cmd.exe on
 * Windows, /bin/sh elsewhere) sees exactly one argument.
 *
 * `shell: true` is what makes this launcher work on Windows, where the
 * executables npm puts on PATH (`npm`, `vitest`, `playwright`) are `.cmd` shims
 * that Node cannot spawn directly — but a shell also re-parses the command line,
 * so arguments must be quoted for the shell instead of being passed as an argv
 * array.
 */
function shellQuote(token) {
  if (/^[\w@./:=+,-]+$/.test(token)) return token;

  if (process.platform === 'win32') {
    // cmd.exe: double quotes, with inner quotes doubled.
    return `"${token.replace(/"/g, '""')}"`;
  }

  // POSIX sh: single quotes, with embedded single quotes closed and reopened.
  const escaped = token.replace(/'/g, `'\\''`);
  return `'${escaped}'`;
}

const commandLine = [command, ...commandArgs].map(shellQuote).join(' ');

process.stdout.write(`with-env: ${assignments.join(' ')} -- ${commandLine}\n`);

const child = spawn(commandLine, { stdio: 'inherit', env, shell: true });

child.on('error', (error) => {
  process.stderr.write(`with-env: failed to start "${command}": ${error.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`with-env: "${command}" was terminated by ${signal}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 0;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // the child already exited
    }
  });
}
