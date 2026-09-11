import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { watchLoop } from '../scripts/watchLoop';

/**
 * The loop every `--watch` worker runs.
 *
 * No database and no network: what is being tested is whether a worker meant
 * to sit there for days survives the ordinary failures of sitting there for
 * days. It did not — one dropped connection ended the process and the backlog
 * stood still until somebody noticed.
 */

describe('a worker left running', () => {
  it('carries on after a pass throws', async () => {
    let passes = 0;
    const code = await watchLoop({
      pollMs: 1,
      shouldStop: () => passes >= 4,
      pass: async () => {
        passes += 1;
        // The failure that killed it in production, on the very first pass.
        if (passes === 1) throw new Error('read ECONNRESET');
      },
    });

    assert.equal(code, 0, 'a single dropped connection ended the watch');
    assert.ok(passes >= 4, `only ${passes} passes ran`);
  });

  it('gives up when nothing is working, rather than spinning for ever', async () => {
    let passes = 0;
    const code = await watchLoop({
      pollMs: 0,
      shouldStop: () => false,
      pass: async () => {
        passes += 1;
        // A revoked credential does not fix itself, and a worker retrying it
        // silently is worse than one that stops and is noticed.
        throw new Error('permission denied');
      },
    });

    assert.equal(code, 1, 'a hopeless worker reported success');
    assert.ok(passes < 30, `it retried ${passes} times before giving up`);
  });

  it('forgets a failure once a pass succeeds', async () => {
    // Otherwise a worker that blips once an hour eventually gives up for no
    // reason, having never actually been broken.
    let passes = 0;
    const code = await watchLoop({
      pollMs: 0,
      shouldStop: () => passes >= 30,
      pass: async () => {
        passes += 1;
        if (passes % 2 === 1) throw new Error('intermittent');
      },
    });

    assert.equal(code, 0, 'alternating failures were treated as a broken worker');
    assert.equal(passes, 30);
  });

  it('stops when asked, without waiting out the backoff first', async () => {
    let passes = 0;
    let stop = false;
    const started = Date.now();

    const running = watchLoop({
      // Long enough that waiting it out would be obvious in the elapsed time.
      pollMs: 10_000,
      shouldStop: () => stop,
      pass: async () => {
        passes += 1;
        throw new Error('still down');
      },
    });

    // Ctrl+C arrives while the loop is in its backoff.
    setTimeout(() => {
      stop = true;
    }, 30);

    const code = await running;
    assert.equal(code, 0);
    assert.ok(
      Date.now() - started < 5_000,
      'Ctrl+C was ignored until the backoff elapsed, which reads as a worker that will not quit',
    );
  });
});
