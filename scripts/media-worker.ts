import { claimGeneration, mediaQueueDepth, processGeneration } from '../src/server/media/jobs';
import { providerStatus } from '../src/server/media/providers';

/**
 * The media generation worker.
 *
 * A separate, durable process for the same reason the extraction worker is
 * one: Next.js has no background workers, and anything started after a
 * response can be killed the moment the response is flushed. A Seedance video
 * takes minutes, so it has to be somebody's job to wait for it.
 *
 *   npm run media:worker            # move everything it can, then exit
 *   npm run media:worker -- --watch # keep going, polling for new work
 *
 * Two workers can run side by side: claiming uses FOR UPDATE SKIP LOCKED, so
 * they never take the same generation and nobody pays twice for one video.
 */
const WATCH = process.argv.includes('--watch');
const intervalArg = process.argv.find((a) => a.startsWith('--interval='));
const POLL_MS = intervalArg ? Number(intervalArg.split('=')[1]) : 5_000;

/** Stops one pass from spinning forever on jobs that are merely pending. */
const MAX_STEPS_PER_PASS = 200;

let stopping = false;
process.on('SIGINT', () => {
  console.log('\nFinishing the current generation, then stopping...');
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

type Tally = { submitted: number; completed: number; pending: number; failed: number };

async function drain(): Promise<Tally> {
  const tally: Tally = { submitted: 0, completed: 0, pending: 0, failed: 0 };

  for (let step = 0; step < MAX_STEPS_PER_PASS; step += 1) {
    if (stopping) break;

    const claim = await claimGeneration();
    if (!claim) break;

    const outcome = await processGeneration(claim);
    tally[outcome.status] += 1;

    // Prompts are company-confidential, so nothing here prints one. The id and
    // the outcome are enough to follow what happened.
    if (outcome.status === 'failed') {
      console.log(`  ${claim.type} ${claim.id}: ${outcome.message}${outcome.willRetry ? ' (will retry)' : ''}`);
    } else {
      console.log(`  ${claim.type} ${claim.id}: ${outcome.status}`);
    }

    // A pending video has just been given a next_attempt_at a few seconds out.
    // Claiming again immediately would only find nothing, so end the pass and
    // let the watch loop come back to it.
    if (outcome.status === 'pending') break;
  }

  return tally;
}

async function main() {
  const providers = providerStatus();
  console.log(
    `Providers — image: ${providers.image.provider} (${providers.image.configured ? 'configured' : 'NOT configured, using the fake'})` +
      `, video: ${providers.video.provider} (${providers.video.configured ? 'configured' : 'NOT configured, using the fake'})`,
  );

  const depth = await mediaQueueDepth();
  console.log(`Queue: ${JSON.stringify(depth)}`);

  if (!WATCH) {
    const tally = await drain();
    console.log(
      `\nDone — ${tally.submitted} submitted, ${tally.completed} completed, ` +
        `${tally.pending} still running, ${tally.failed} failed.`,
    );
    return;
  }

  console.log(`Watching for work every ${POLL_MS / 1000}s. Ctrl+C to stop.\n`);
  while (!stopping) {
    await drain();
    if (stopping) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log('Stopped.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // The message only; a stack from deep inside a provider call can quote the
    // request back, and the request contains the prompt.
    console.error('Media worker failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
