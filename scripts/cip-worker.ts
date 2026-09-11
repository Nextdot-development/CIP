import {
  claimConnectionForSync,
  runClaimedSync,
} from '../src/server/integrations/googleDrive/jobs';
import { claimNextFile, processClaimedFile, recoverStuckFiles } from '../src/server/drive/processing';
import {
  claimChunksNeedingEmbedding,
  embedClaimedChunks,
} from '../src/server/drive/embeddingQueue';
import { claimGeneration, processGeneration } from '../src/server/media/jobs';
import {
  claimAssetForUnderstanding,
  enqueueEverywhere,
  understandClaimedAsset,
} from '../src/server/brain/understanding';
import { recomputeEverywhere } from '../src/server/brain/brandDna';
import { analyseNextFeedback } from '../src/server/brain/learning';
import { brainStatus } from '../src/server/brain/providers';
import { watchLoop } from './watchLoop';

/**
 * Everything, in the order things depend on each other.
 *
 * The individual workers still exist and can be run alone. This is the one to
 * leave running: a file dropped into a connected Google Drive folder becomes a
 * synced file, then extracted text, then chunks, then vectors, then
 * understanding, then Brand DNA — without anybody running six commands in the
 * right sequence.
 *
 *   npm run cip:worker                     # one pass of everything
 *   npm run cip:worker -- --watch          # keep going (this is the one you want)
 *   npm run cip:worker -- --sync-every=5   # minutes between Google Drive sweeps
 *
 * The order is not arbitrary. Extraction needs a synced file, embedding needs
 * chunks, understanding needs extracted text for documents, and Brand DNA is
 * derived from understanding — so each stage runs after the one it depends on,
 * and a file added while the loop is running is fully processed by the end of
 * the next pass rather than being left half-done.
 *
 * Every stage is separately claimed and leased, so several of these can run at
 * once without duplicating work.
 */
const WATCH = process.argv.includes('--watch');
const pollArg = process.argv.find((a) => a.startsWith('--interval='));
const POLL_MS = pollArg ? Number(pollArg.split('=')[1]) : 30_000;
const syncArg = process.argv.find((a) => a.startsWith('--sync-every='));
/** Google's quotas are per project, so its folders are swept less often. */
const SYNC_EVERY_MINUTES = syncArg ? Number(syncArg.split('=')[1]) : 5;

/** Bounds one pass so a backlog cannot hold any single stage for ever. */
const PER_STAGE = 25;


let stopping = false;
process.on('SIGINT', () => {
  console.log('\nFinishing the current item, then stopping...');
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

type Tally = {
  synced: number; extracted: number; embedded: number;
  understood: number; generations: number; lessons: number;
};

async function pass(): Promise<Tally> {
  const tally: Tally = {
    synced: 0, extracted: 0, embedded: 0, understood: 0, generations: 0, lessons: 0,
  };

  // 1. New files from any connected Google Drive folder.
  for (let i = 0; i < PER_STAGE && !stopping; i += 1) {
    const claim = await claimConnectionForSync({ intervalMinutes: SYNC_EVERY_MINUTES });
    if (!claim) break;
    const outcome = await runClaimedSync(claim);
    if (outcome.status === 'synced') {
      const o = outcome.outcome;
      tally.synced += o.added + o.updated;
      if (o.added + o.updated + o.removed > 0) {
        console.log(
          `  drive sync: ${o.added} added, ${o.updated} updated, ${o.removed} removed, ` +
            `${o.unchanged} unchanged`,
        );
      }
    } else if (outcome.status === 'needs_reauth') {
      console.log('  drive sync: a connection needs reconnecting');
    } else {
      console.log(`  drive sync failed: ${outcome.message}`);
    }
  }

  // 2. Text out of anything new. Files stuck mid-flight are released first.
  await recoverStuckFiles();
  for (let i = 0; i < PER_STAGE && !stopping; i += 1) {
    const file = await claimNextFile();
    if (!file) break;
    await processClaimedFile(file);
    tally.extracted += 1;
  }

  // 3. Vectors for the chunks that came out of it.
  for (let i = 0; i < PER_STAGE && !stopping; i += 1) {
    const claim = await claimChunksNeedingEmbedding();
    if (!claim) break;
    const outcome = await embedClaimedChunks(claim);
    if (outcome.status === 'embedded') tally.embedded += outcome.count;
  }

  // 4. What the assets mean.
  await enqueueEverywhere();
  for (let i = 0; i < PER_STAGE && !stopping; i += 1) {
    const claim = await claimAssetForUnderstanding();
    if (!claim) break;
    const outcome = await understandClaimedAsset(claim);
    if (outcome.status === 'understood') {
      tally.understood += 1;
      console.log(`  understood ${claim.kind} "${claim.filename}"`);
    } else if (outcome.status === 'failed') {
      console.log(`  "${claim.filename}" failed: ${outcome.message}`);
    }
  }

  // 5. What they add up to, but only if something new was learned.
  if (tally.understood > 0) await recomputeEverywhere();

  // 6. Queued video generations, which are slow and asynchronous by nature.
  for (let i = 0; i < PER_STAGE && !stopping; i += 1) {
    const claim = await claimGeneration();
    if (!claim) break;
    const outcome = await processGeneration(claim);
    if (outcome.status === 'completed') tally.generations += 1;
    if (outcome.status === 'pending') break;
  }

  // 7. Anything anybody has said about a result.
  for (let i = 0; i < PER_STAGE && !stopping; i += 1) {
    const outcome = await analyseNextFeedback();
    if (!outcome) break;
    if (outcome.status === 'learned') tally.lessons += outcome.lessons;
  }

  return tally;
}

function describe(tally: Tally): string {
  const parts = [
    tally.synced > 0 ? `${tally.synced} synced` : null,
    tally.extracted > 0 ? `${tally.extracted} extracted` : null,
    tally.embedded > 0 ? `${tally.embedded} embedded` : null,
    tally.understood > 0 ? `${tally.understood} understood` : null,
    tally.generations > 0 ? `${tally.generations} generated` : null,
    tally.lessons > 0 ? `${tally.lessons} lesson(s)` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'nothing to do';
}

async function main() {
  const status = brainStatus();
  console.log(
    `Brain: ${status.provider} / ${status.model} — ` +
      (status.configured ? 'configured' : 'NOT configured, assets will not be analysed'),
  );

  if (!WATCH) {
    console.log('Running one pass of everything.\n');
    console.log(`\nDone — ${describe(await pass())}.`);
    return;
  }

  console.log(
    `Watching every ${POLL_MS / 1000}s, sweeping Google Drive every ${SYNC_EVERY_MINUTES}m. ` +
      'Ctrl+C to stop.\n',
  );
  process.exitCode = await watchLoop({
    name: 'cip',
    pollMs: POLL_MS,
    shouldStop: () => stopping,
    pass: async () => {
      const summary = describe(await pass());
      if (summary !== 'nothing to do') console.log(`  -> ${summary}`);
    },
  });
  console.log('Stopped.');
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('Worker failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
