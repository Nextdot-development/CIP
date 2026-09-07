import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runs each test file in its own process, one after another.
 *
 * Every suite boots an embedded PostgreSQL. Running eight of them inside one
 * Node process means eight servers started and stopped in the same event loop,
 * and on Windows that intermittently wedges: the tests all pass and then the
 * run never finishes. It is a resource problem rather than a failing
 * assertion — the same files pass immediately when run apart.
 *
 * A fresh process per file removes the shared state that causes it, and has a
 * second benefit worth having anyway: one suite that leaks a handle can no
 * longer hang the ones after it.
 *
 * Nothing is skipped and nothing is softened. Every file runs, every failure
 * fails the run, and the exit code is non-zero if any file did not pass.
 */

const dir = join(process.cwd(), 'tests');
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort();

const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const selected = only.length > 0 ? files.filter((f) => only.some((o) => f.includes(o))) : files;

/** A file that has genuinely stopped making progress, rather than one that is slow. */
const TIMEOUT_MS = 5 * 60 * 1000;

let failed = 0;
let totalTests = 0;
let totalPassed = 0;
const failures = [];

for (const file of selected) {
  const path = join('tests', file);
  process.stdout.write(`\n── ${file} ${'─'.repeat(Math.max(0, 56 - file.length))}\n`);

  const result = spawnSync(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', '--test', '--test-concurrency=1', path],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: TIMEOUT_MS },
  );

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  // Print the tests and any failure detail, but not PostgreSQL's own startup
  // chatter, which is several screens per file and says nothing useful.
  for (const line of output.split('\n')) {
    if (/^\d{4}-\d{2}-\d{2} .*(LOG|NOTICE|STATEMENT|DETAIL|HINT):/.test(line)) continue;
    if (/^\s*$/.test(line)) continue;
    if (/^(The files belonging|This user must|The database cluster|  locale provider|  LC_|The default|Data page|fixing permissions|creating|selecting|running bootstrap|performing post|syncing data|initdb:|Success\.|You can now start|    |waiting for server|done|server started|listening on)/.test(line)) continue;
    process.stdout.write(`${line}\n`);
  }

  const tests = Number(/^ℹ tests (\d+)$/m.exec(output)?.[1] ?? 0);
  const passed = Number(/^ℹ pass (\d+)$/m.exec(output)?.[1] ?? 0);
  totalTests += tests;
  totalPassed += passed;

  if (result.error?.code === 'ETIMEDOUT' || result.signal !== null) {
    failed += 1;
    failures.push(`${file} — did not finish within ${TIMEOUT_MS / 1000}s`);
    continue;
  }
  if (result.status !== 0) {
    failed += 1;
    failures.push(`${file} — ${tests - passed} test(s) failed`);
  }
}

process.stdout.write(`\n${'═'.repeat(60)}\n`);
process.stdout.write(`${selected.length} file(s), ${totalPassed}/${totalTests} tests passed\n`);

if (failures.length > 0) {
  process.stdout.write('\nFailed:\n');
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

process.exit(failed > 0 ? 1 : 0);
