/**
 * The loop every `--watch` worker runs.
 *
 * It exists because all five of them had the same hole: a pass that threw
 * ended the process. That is fine for a one-shot run and wrong for a worker
 * meant to sit there for days — these run against a hosted database where a
 * dropped connection is an ordinary event, and a single `read ECONNRESET`
 * killed the watch and left a backlog standing still until somebody noticed
 * the process was gone.
 *
 * Carrying on loses nothing. Every stage claims its work under a lease, so
 * whatever was in flight when the connection went is released and picked up
 * again on the next pass.
 *
 * Repeated failure is a different thing from a blip, though — a revoked
 * credential, a database that has gone away — so the delay grows with each
 * failure and the loop eventually stops. A worker that gives up is visible; a
 * worker that retries a hopeless thing for ever is not.
 */
export type WatchOptions = {
  /**
   * One pass of whatever this worker does.
   *
   * Whatever it returns is ignored — each worker already reports its own
   * tally in its own words, and the loop only needs to know whether the pass
   * finished or threw.
   */
  pass: () => Promise<unknown>;
  /** Milliseconds between passes, when they are working. */
  pollMs: number;
  /** Whether a signal has asked the worker to finish and stop. */
  shouldStop: () => boolean;
  /** Named in the log line, so several workers in one terminal are tellable apart. */
  name?: string;
};

/**
 * How many passes may fail in a row before giving up.
 *
 * High enough to ride out a database restart, low enough that something
 * genuinely broken surfaces rather than being retried until somebody looks.
 */
const MAX_CONSECUTIVE_FAILURES = 10;

/** Runs until asked to stop, or until it has failed too many times running. */
export async function watchLoop(options: WatchOptions): Promise<number> {
  const label = options.name ? `${options.name}: ` : '';
  let consecutiveFailures = 0;

  while (!options.shouldStop()) {
    try {
      await options.pass();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      // The message only, never a stack: both can quote a file name, which
      // belongs to the company whose Drive this is.
      console.error(
        `  ${label}pass failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ` +
          (error instanceof Error ? error.message : 'unknown'),
      );

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`  ${label}too many passes failed in a row. Stopping so this is noticed.`);
        return 1;
      }

      // Longer each time, so a worker whose dependency is already in trouble
      // is not the thing making it worse.
      await sleep(options.pollMs * consecutiveFailures, options.shouldStop);
      continue;
    }

    if (options.shouldStop()) break;
    await sleep(options.pollMs, options.shouldStop);
  }

  return 0;
}

/**
 * Waits, but wakes up to check whether it has been asked to stop.
 *
 * A plain timer meant Ctrl+C during a long backoff was ignored until it
 * elapsed, which reads as a worker that will not quit.
 */
async function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  const step = 250;
  for (let waited = 0; waited < ms; waited += step) {
    if (shouldStop()) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
  }
}
