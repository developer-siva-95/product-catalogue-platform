#!/usr/bin/env node
/**
 * Cross-platform sequential runner for npm scripts.
 *
 * `npm run a && npm run b && npm run c` chains are POSIX-shell syntax. `&&` does
 * not exist in Windows PowerShell 5.1, and in PowerShell 7 it behaves differently
 * enough to be a trap, so `verify`, `test` and friends are expressed as a list of
 * npm scripts handed to this launcher. Plain Node, no dependency.
 *
 * Usage:
 *   node scripts/steps.mjs lint format:check test build
 *
 * Behaviour:
 *   - runs `npm run <script>` for each argument, in order, in the current directory
 *   - stops at the first failure and exits with that script's exit code
 *   - prints a summary line per step so a failed gate is obvious in any terminal
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const steps = process.argv.slice(2);

if (steps.length === 0) {
  process.stderr.write('Usage: node scripts/steps.mjs <npm-script> [<npm-script> ...]\n');
  process.exit(2);
}

function runStep(step) {
  return new Promise((resolve) => {
    // shell: true so that `npm` resolves on Windows (npm.cmd) and on POSIX alike.
    // The command line is built as a single string because that is the only form
    // Node passes to the shell verbatim; every token here is npm-script-simple.
    const child = spawn(`npm run ${step}`, { stdio: 'inherit', cwd: REPO_ROOT, shell: true });
    child.on('error', () => resolve(1));
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  });
}

let failed = 0;

for (const [index, step] of steps.entries()) {
  process.stdout.write(`\n=== [${index + 1}/${steps.length}] npm run ${step}\n`);
  const code = await runStep(step);
  if (code !== 0) {
    process.stderr.write(`\n=== FAILED: npm run ${step} (exit code ${code})\n`);
    failed = code;
    break;
  }
}

if (failed === 0) {
  process.stdout.write(`\n=== All ${steps.length} step(s) passed: ${steps.join(', ')}\n`);
}

process.exitCode = failed;
