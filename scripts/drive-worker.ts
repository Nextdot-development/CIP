import {
  claimNextFile,
  processClaimedFile,
  queueDepth,
  recoverStuckFiles,
} from '../src/server/drive/processing';
import {
  claimChunksNeedingEmbedding,
  embedClaimedChunks,
  embeddingQueueDepth,
} from '../src/server/drive/embeddingQueue';
import { embedder } from '../src/server/drive/embedding';

/**
 * The extraction worker.
 *
 * A separate, durable process on purpose. Next.js has no background workers —
 * anything started after a response can be killed the moment the response is
 * flushed — so the queue is drained here instead, by something that can be run
 * from cron, a container, or a terminal.
 *
 *   npm run drive:worker            # drain the queue once, then exit
 *   npm run drive:worker -- --watch # keep going, polling for new work
 *
 * Two workers can run side by side: claiming uses FOR UPDATE SKIP LOCKED, so
 * they never take the same file.
 */
const WATCH = process.argv.includes('--watch');
const intervalArg = process.argv.find((a) => a.startsWith('--interval='));
const POLL_MS = intervalArg ? Number(intervalArg.split('=')[1]) : 5_000;

let stopping = false;
process.on('SIGINT', () => {
  console.log('\nFinishing the current file, then stopping...');
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

/**
 * Second pass: give every new chunk a vector.
 *
 * Runs after extraction rather than in its own process, because chunks only
 * exist once extraction has finished — two workers would race on freshly
 * created rows for no benefit.
 */
async function drainEmbeddings(): Promise<{ embedded: number; failed: number }> {
  let embedded = 0;
  let failed = 0;

  for (;;) {
    if (stopping) break;

    const claim = await claimChunksNeedingEmbedding();
    if (!claim) break;

    const started = Date.now();
    const outcome = await embedClaimedChunks(claim);
    const ms = Date.now() - started;

    if (outcome.status === 'embedded') {
      embedded += outcome.count;
      console.log(`  embed ${outcome.count} chunk(s) in ${ms}ms`);
    } else {
      failed += outcome.count;
      console.log(
        `  FAIL  ${outcome.count} chunk(s) — ${outcome.message}` +
          `${outcome.willRetry ? ' (will retry)' : ' (giving up)'}`,
      );
      // A failing batch means the provider is unhappy; stop rather than
      // hammering it with the rest of the queue.
      break;
    }
  }

  return { embedded, failed };
}

async function drain(): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;

  for (;;) {
    if (stopping) break;

    const file = await claimNextFile();
    if (!file) break;

    const started = Date.now();
    const outcome = await processClaimedFile(file);
    const ms = Date.now() - started;

    if (outcome.status === 'processed') {
      processed += 1;
      const notes = outcome.warnings.length ? ` (${outcome.warnings.join(', ')})` : '';
      console.log(
        `  read  ${outcome.name} — ${outcome.chars} chars, ${outcome.chunks} chunks, ${ms}ms${notes}`,
      );
    } else {
      failed += 1;
      console.log(
        `  FAIL  ${outcome.name} — ${outcome.message}${outcome.willRetry ? ' (will retry)' : ' (giving up)'}`,
      );
    }
  }

  return { processed, failed };
}

async function main() {
  const reclaimed = await recoverStuckFiles();
  if (reclaimed > 0) console.log(`Reclaimed ${reclaimed} file(s) from a worker that stopped.`);

  const depth = await queueDepth();
  const waiting = await embeddingQueueDepth();
  console.log(`Queue: ${JSON.stringify(depth)}, ${waiting.pending} chunk(s) to embed`);

  if (!WATCH) {
    // Two passes, in order: extraction produces the chunks that embedding
    // then consumes, so one run takes a freshly uploaded file all the way
    // to searchable rather than leaving it half done until the next.
    const { processed, failed } = await drain();
    const embedded = await drainEmbeddings();
    console.log(
      `\nDone — ${processed} file(s) extracted, ${failed} failed; ` +
      `${embedded.embedded} chunk(s) embedded, ${embedded.failed} failed.`,
    );
    return;
  }

  console.log(`Watching for work every ${POLL_MS / 1000}s, embedding with ${embedder().model}. Ctrl+C to stop.\n`);
  while (!stopping) {
    await drain();
    await drainEmbeddings();
    if (stopping) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
    await recoverStuckFiles();
    const waiting = await embeddingQueueDepth();
    if (waiting.pending > 0) console.log(`  ${waiting.pending} chunk(s) waiting to be embedded`);
  }
  console.log('Stopped.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Worker failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
