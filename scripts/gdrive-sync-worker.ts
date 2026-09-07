import {
  claimConnectionForSync,
  runClaimedSync,
  syncQueueDepth,
} from '../src/server/integrations/googleDrive/jobs';
import { googleDrive } from '../src/server/integrations/googleDrive';

/**
 * The Google Drive sync worker.
 *
 * Separate and durable for the same reason the extraction worker is: Next.js
 * has no background workers, and a sync is a long walk through somebody else's
 * API. This is also the thing a scheduler would call — running it from cron
 * every hour is the whole of "scheduled sync", with no new machinery.
 *
 *   npm run gdrive:worker                  # sync every connection that is due
 *   npm run gdrive:worker -- --watch       # keep going
 *   npm run gdrive:worker -- --interval-minutes=15
 *
 * It only syncs, and never extracts or embeds: the files it writes are picked
 * up by `npm run drive:worker`, which was already doing that for uploads.
 *
 * Two workers can run side by side. Claiming leases the connection, so they
 * never sync the same folder at once.
 */
const WATCH = process.argv.includes('--watch');
const intervalArg = process.argv.find((a) => a.startsWith('--interval-minutes='));
const INTERVAL_MINUTES = intervalArg ? Number(intervalArg.split('=')[1]) : undefined;
const pollArg = process.argv.find((a) => a.startsWith('--poll='));
const POLL_MS = pollArg ? Number(pollArg.split('=')[1]) : 60_000;

let stopping = false;
process.on('SIGINT', () => {
  console.log('\nFinishing the current sync, then stopping...');
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});

async function drain(): Promise<{ synced: number; reauth: number; failed: number }> {
  const tally = { synced: 0, reauth: 0, failed: 0 };

  for (;;) {
    if (stopping) break;

    const claim = await claimConnectionForSync({ intervalMinutes: INTERVAL_MINUTES });
    if (!claim) break;

    const outcome = await runClaimedSync(claim);

    // Company ids are not printed, and neither are file names: a worker log is
    // read by whoever runs the server, not by the company that owns the files.
    if (outcome.status === 'synced') {
      tally.synced += 1;
      const o = outcome.outcome;
      console.log(
        `  synced a connection — ${o.scanned} seen across ${o.pages} page(s): ` +
          `${o.added} added, ${o.updated} updated, ${o.unchanged} unchanged, ` +
          `${o.unsupported} unsupported, ${o.removed} removed, ${o.failed} failed`,
      );
    } else if (outcome.status === 'needs_reauth') {
      tally.reauth += 1;
      console.log('  a connection needs reconnecting; it will be skipped until somebody does');
    } else {
      tally.failed += 1;
      console.log(`  a sync failed: ${outcome.message}`);
    }
  }

  return tally;
}

async function main() {
  console.log(
    googleDrive().configured
      ? 'Google Drive: an OAuth client is configured.'
      : 'Google Drive: NOT configured — no OAuth client, so nothing can be synced.',
  );

  const depth = await syncQueueDepth();
  console.log(`Connections: ${JSON.stringify(depth)}`);

  if (!WATCH) {
    const tally = await drain();
    console.log(
      `\nDone — ${tally.synced} synced, ${tally.reauth} awaiting reconnection, ${tally.failed} failed.`,
    );
    console.log('Run `npm run drive:worker` to extract and embed what was synced.');
    return;
  }

  console.log(`Watching every ${POLL_MS / 1000}s. Ctrl+C to stop.\n`);
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
    console.error('Sync worker failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
