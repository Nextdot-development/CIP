import 'server-only';
import { claimNextFile, processClaimedFile, recoverStuckFiles } from '../drive/processing';
import { claimChunksNeedingEmbedding, embedClaimedChunks } from '../drive/embeddingQueue';
import {
  claimAssetForUnderstanding,
  enqueueEverywhere,
  understandClaimedAsset,
} from '../brain/understanding';
import { recomputeEverywhere } from '../brain/brandDna';

/**
 * Moving the queue along, from inside the app.
 *
 * Every stage of the pipeline was already correct: a Google Drive sync writes
 * a drive_files row as `pending`, extraction claims pending rows, understanding
 * claims extracted ones. What was missing is that something has to *run* them,
 * and the only thing that did was `npm run cip:worker`, which nobody had
 * started. So a synced PDF sat at `pending` for ever while the UI called it
 * "In your Knowledge Layer" — the row existed, and nothing had read it.
 *
 * This is not a second worker. It calls the same claim-and-process functions
 * the worker calls, under the same leases, so the two can run at once and
 * neither does an item twice. `npm run cip:worker -- --watch` remains the way
 * to run this properly: it keeps going, it sweeps Drive folders on a timer, and
 * it survives the web process restarting. The pump exists so that a deployment
 * without a separate worker still makes progress, and so that pressing Sync Now
 * does something visible.
 *
 * Three things it deliberately will not do:
 *
 *   - It does not run media generation. That stage spends money at a provider,
 *     and an HTTP request that happens to arrive is not a reason to spend it.
 *   - It does not block the request that started it. Callers fire and forget;
 *     progress is read back from the database like any other state.
 *   - It does not run twice at once in one process. A single-flight guard means
 *     ten clicks on Sync Now start one pump, not ten.
 */

/** One pass, bounded. A backlog is drained over several passes, not one. */
const PER_STAGE = 12;

/**
 * Long enough to get a few pages of a PDF through the vision model, short
 * enough that a serverless host does not kill it mid-write. Work already
 * claimed is finished; the rest waits for the next pass.
 */
const MAX_RUN_MS = 60_000;

export type PumpTally = {
  extracted: number;
  embedded: number;
  understood: number;
  failed: number;
  /** True when a limit stopped the pass with work still waiting. */
  moreWaiting: boolean;
};

let running: Promise<PumpTally> | null = null;

/** Whether a pass is in flight right now, for the status endpoint. */
export function pumpIsRunning(): boolean {
  return running !== null;
}

/**
 * Runs one bounded pass, or joins the one already running.
 *
 * Joining rather than queueing is deliberate: two passes started a second apart
 * would claim the same items, and the second would find nothing to do anyway.
 */
export async function pumpQueues(): Promise<PumpTally> {
  if (running) return running;

  running = runPass().finally(() => {
    running = null;
  });

  return running;
}

/**
 * Starts a pass without waiting for it.
 *
 * For request handlers: the caller has already done its own work and the
 * response should not wait on a vision model. A rejection here is swallowed on
 * purpose — the pump's failures belong in the rows it was working on, and the
 * request that kicked it succeeded regardless.
 */
export function pumpInBackground(): void {
  void pumpQueues().catch(() => {
    // Each stage records its own failure against its own row. There is nothing
    // useful to log here that is not already stored, and the content of a
    // failure can carry the customer's data.
  });
}

async function runPass(): Promise<PumpTally> {
  const tally: PumpTally = { extracted: 0, embedded: 0, understood: 0, failed: 0, moreWaiting: false };
  const deadline = Date.now() + MAX_RUN_MS;
  const outOfTime = (): boolean => Date.now() > deadline;

  // A worker that died mid-file leaves a claim behind. Releasing those first is
  // what stops one crash from stranding a file for ever.
  await recoverStuckFiles().catch(() => {});

  // Each stage is independent. A stage that cannot run at all — no pgvector,
  // so no embeddings table — must not take the pass down with it: extraction
  // and understanding still work, and a database without vectors is a
  // supported shape everywhere else in CIP.
  const stage = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch {
      // Per-item failures are recorded against their own rows by the code that
      // claimed them. What reaches here is a stage that could not start, and
      // the next pass will find the same work still waiting.
    }
  };

  // 1. Text out of anything new.
  await stage(async () => {
    for (let i = 0; i < PER_STAGE; i += 1) {
      if (outOfTime()) {
        tally.moreWaiting = true;
        return;
      }
      const file = await claimNextFile();
      if (!file) break;
      await processClaimedFile(file);
      tally.extracted += 1;
      if (i === PER_STAGE - 1) tally.moreWaiting = true;
    }
  });

  // 2. Vectors for the chunks that came out of it.
  await stage(async () => {
    for (let i = 0; i < PER_STAGE; i += 1) {
      if (outOfTime()) {
        tally.moreWaiting = true;
        return;
      }
      const claim = await claimChunksNeedingEmbedding();
      if (!claim) break;
      const outcome = await embedClaimedChunks(claim);
      if (outcome.status === 'embedded') tally.embedded += outcome.count;
    }
  });

  // 3. What the assets mean. This is the expensive stage — a PDF costs a
  //    vision call per band — so it is last and it is bounded like the rest.
  await stage(async () => {
    await enqueueEverywhere();
    for (let i = 0; i < PER_STAGE; i += 1) {
      if (outOfTime()) {
        tally.moreWaiting = true;
        return;
      }
      const claim = await claimAssetForUnderstanding();
      if (!claim) break;
      const outcome = await understandClaimedAsset(claim);
      if (outcome.status === 'understood') tally.understood += 1;
      else if (outcome.status === 'failed') tally.failed += 1;
      if (i === PER_STAGE - 1) tally.moreWaiting = true;
    }
  });

  // 4. What they add up to, but only when something new was actually learned.
  if (tally.understood > 0) await recomputeEverywhere().catch(() => {});

  return tally;
}
