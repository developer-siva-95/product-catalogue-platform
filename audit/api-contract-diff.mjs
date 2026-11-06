/**
 * Compares two API contract snapshots produced by api-contract-snapshot.mjs.
 *
 *   node audit/api-contract-diff.mjs <before.json> <after.json>
 *
 * Exits 1 when any entry differs, and prints the first divergence of each changed
 * entry (status, content-type, wire text at the first differing character, or the
 * key-order/type map) so a contract drift is obvious instead of being a diff blob.
 */
import { readFileSync } from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: node audit/api-contract-diff.mjs <before.json> <after.json>');
  process.exit(2);
}

const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));

const beforeEntries = new Map(before.entries.map((entry) => [entry.label, entry]));
const afterEntries = new Map(after.entries.map((entry) => [entry.label, entry]));

const problems = [];

for (const label of beforeEntries.keys()) {
  if (!afterEntries.has(label)) problems.push(`missing in after: ${label}`);
}
for (const label of afterEntries.keys()) {
  if (!beforeEntries.has(label)) problems.push(`new entry (not in baseline): ${label}`);
}

function firstDifference(a, b) {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : limit;
}

for (const [label, expected] of beforeEntries) {
  const actual = afterEntries.get(label);
  if (!actual) continue;
  if (JSON.stringify(expected) === JSON.stringify(actual)) continue;

  const parts = [];
  if (expected.status !== actual.status)
    parts.push(`status ${expected.status} -> ${actual.status}`);
  if (expected.contentType !== actual.contentType) parts.push(`content-type changed`);
  if (expected.wire !== actual.wire) {
    const at = firstDifference(expected.wire, actual.wire);
    parts.push(
      `wire differs at ${at}: ...${expected.wire.slice(Math.max(0, at - 60), at + 90)}  =>  ...${actual.wire.slice(
        Math.max(0, at - 60),
        at + 90,
      )}`,
    );
  }
  if (JSON.stringify(expected.shape) !== JSON.stringify(actual.shape))
    parts.push('shape/key-order changed');
  problems.push(`${label}: ${parts.join(' | ')}`);
}

console.log(`compared ${beforeEntries.size} entries against ${afterEntries.size}`);
if (problems.length > 0) {
  console.log(`CONTRACT DRIFT: ${problems.length} problem(s)`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log('CONTRACT STABLE: every entry is byte-identical (status, key order, types, values)');
