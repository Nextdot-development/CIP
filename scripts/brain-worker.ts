import {
  claimAssetForUnderstanding,
  enqueueEverywhere,
  understandClaimedAsset,
  understandingQueueDepth,
} from '../src/server/brain/understanding';
import { recomputeEverywhere } from '../src/server/brain/brandDna';
import { analyseNextFeedback } from '../src/server/brain/learning';
import { brainStatus } from '../src/server/brain/providers';
import { ffmpegAvailable } from '../src/server/brain/media';
import { watchLoop } from './watchLoop';

/**
 * The Brain worker.
 *
 * A separate, durable process for the same reason the other workers are:
 * Next.js has no background workers, and analysing a video takes minutes.
 *
 *   npm run brain:worker              # one pass, then exit
 *   npm run brain:worker -- --watch   # keep going
 *
 * One pass is: queue anything new, understand what is queued, recompute Brand
 * DNA from the evidence that now exists, then learn from any feedback nobody
 * has looked at yet. That order matters — Brand DNA is derived from
 * understanding, so recomputing before analysing would use yesterday's
 * evidence.
 *
 * Two workers can run side by side. Claiming leases each asset, so they never
 * analyse the same one and nobody pays twice.
 */
const WATCH = process.argv.includes('--watch');
const intervalArg = process.argv.find((a) => a.startsWith('--interval='));
const POLL_MS = intervalArg ? Number(intervalArg.split('=')[1]) : 20_000;

/** Bounds one pass, so a large backlog cannot hold the loop for ever. */
const MAX_ASSETS_PER_PASS = 25;
const MAX_FEEDBACK_PER_PASS = 25;

let stopping = false;
process.on('SIGINT', () => {
  console.log('\nFinishing the current asset, then stopping...');
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

type Tally = { understood: number; unsupported: number; failed: number; lessons: number };

async function pass(): Promise<Tally> {
  const tally: Tally = { understood: 0, unsupported: 0, failed: 0, lessons: 0 };

  const queued = await enqueueEverywhere();
  if (queued > 0) console.log(`  queued ${queued} asset(s) for understanding`);

  for (let i = 0; i < MAX_ASSETS_PER_PASS && !stopping; i += 1) {
    const claim = await claimAssetForUnderstanding();
    if (!claim) break;

    const outcome = await understandClaimedAsset(claim);

    // Names are printed, never content: a worker log is read by whoever runs
    // the server, not by the company whose assets these are.
    if (outcome.status === 'understood') {
      tally.understood += 1;
      console.log(`  ${claim.kind} "${claim.filename}" understood (${outcome.facts} fact(s))`);
    } else if (outcome.status === 'unsupported') {
      tally.unsupported += 1;
      console.log(`  ${claim.kind} "${claim.filename}" skipped: ${outcome.reason}`);
    } else {
      tally.failed += 1;
      console.log(
        `  ${claim.kind} "${claim.filename}" failed: ${outcome.message}` +
          (outcome.willRetry ? ' (will retry)' : ''),
      );
    }
  }

  if (tally.understood > 0) {
    const touched = await recomputeEverywhere();
    if (touched > 0) console.log(`  recomputed Brand DNA for ${touched} company(ies)`);
  }

  for (let i = 0; i < MAX_FEEDBACK_PER_PASS && !stopping; i += 1) {
    const outcome = await analyseNextFeedback();
    if (!outcome) break;
    if (outcome.status === 'learned') {
      tally.lessons += outcome.lessons;
      console.log(
        `  feedback analysed: ${outcome.lessons} lesson(s)` +
          (outcome.confirmed > 0 ? `, ${outcome.confirmed} newly confirmed` : ''),
      );
    } else if (outcome.status === 'failed') {
      console.log(`  feedback could not be analysed: ${outcome.message}`);
    }
  }

  return tally;
}

async function main() {
  const status = brainStatus();
  console.log(
    `Brain: ${status.provider} / ${status.model} — ` +
      (status.configured ? 'configured' : 'NOT configured, nothing can be analysed'),
  );
  console.log(`ffmpeg: ${(await ffmpegAvailable()) ? 'available' : 'NOT available, videos will be skipped'}`);
  console.log(`Queue: ${JSON.stringify(await understandingQueueDepth())}\n`);

  if (!WATCH) {
    const tally = await pass();
    console.log(
      `\nDone — ${tally.understood} understood, ${tally.unsupported} unsupported, ` +
        `${tally.failed} failed, ${tally.lessons} lesson(s) from feedback.`,
    );
    return;
  }

  console.log(`Watching every ${POLL_MS / 1000}s. Ctrl+C to stop.\n`);
  process.exitCode = await watchLoop({
    name: 'brain',
    pollMs: POLL_MS,
    shouldStop: () => stopping,
    pass,
  });
  console.log('Stopped.');
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    // The message only: a stack from inside a provider call can quote content.
    console.error('Brain worker failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
