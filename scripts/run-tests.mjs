import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * Child output goes to a file rather than a pipe. PostgreSQL is verbose, and a
 * pipe has a fixed buffer: fill it and the child blocks writing while the
 * parent waits for the child, which is a deadlock that looks exactly like a
 * hanging test. A file descriptor has no such limit.
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

const logs = mkdtempSync(join(tmpdir(), 'cip-test-logs-'));

let totalTests = 0;
let totalPassed = 0;
const failures = [];

/** PostgreSQL's startup chatter is several screens per file and says nothing. */
function interesting(line) {
  if (/^\d{4}-\d{2}-\d{2} .*(LOG|NOTICE|STATEMENT|DETAIL|HINT|WARNING):/.test(line)) return false;
  if (/^\s*$/.test(line)) return false;
  return !/^(The files belonging|This user must|The database cluster|\s+locale provider|\s+LC_|The default|Data page|fixing permissions|creating|selecting|running bootstrap|performing post|syncing data|initdb:|Success\.|You can now start|\s{4}|waiting for server|done|server started|listening on|\^)/.test(line);
}

for (const file of selected) {
  process.stdout.write(`\n── ${file} ${'─'.repeat(Math.max(0, 56 - file.length))}\n`);

  const logPath = join(logs, `${file}.log`);
  const fd = openSync(logPath, 'w');
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        '--conditions=react-server',
        '--import',
        'tsx',
        '--test',
        '--test-concurrency=1',
        // Exits once the run has finished, instead of waiting for the event
        // loop to drain. Embedded PostgreSQL and its client occasionally leave
        // a handle open on Windows, and the process then sits there for ever
        // having already printed that every test passed.
        //
        // This only fires after the run completes, so a test that genuinely
        // hangs still hangs and is still caught by the timeout below. It hides
        // a slow shutdown, never a failure.
        '--test-force-exit',
        join('tests', file),
      ],
      { stdio: ['ignore', fd, fd], timeout: TIMEOUT_MS },
    );
  } finally {
    closeSync(fd);
  }

  const output = readFileSync(logPath, 'utf8');
  for (const line of output.split('\n')) {
    if (interesting(line)) process.stdout.write(`${line}\n`);
  }

  const tests = Number(/^ℹ tests (\d+)$/m.exec(output)?.[1] ?? 0);
  const passed = Number(/^ℹ pass (\d+)$/m.exec(output)?.[1] ?? 0);
  totalTests += tests;
  totalPassed += passed;

  if (result.error?.code === 'ETIMEDOUT' || result.signal !== null) {
    failures.push(`${file} — did not finish within ${TIMEOUT_MS / 1000}s`);
  } else if (result.status !== 0) {
    failures.push(`${file} — ${tests - passed} of ${tests} test(s) failed`);
  }
}

rmSync(logs, { recursive: true, force: true });

process.stdout.write(`\n${'═'.repeat(60)}\n`);
process.stdout.write(`${selected.length} file(s), ${totalPassed}/${totalTests} tests passed\n`);

if (failures.length > 0) {
  process.stdout.write('\nFailed:\n');
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
}

process.exit(failures.length > 0 ? 1 : 0);
