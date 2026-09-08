import { noStore, withIntegrationScope } from '@/server/integrations/googleDrive/http';
import { getConnection } from '@/server/integrations/googleDrive/connection';
import { syncNow } from '@/server/integrations/googleDrive/sync';
import { GOOGLE_SYNC_LIMIT, rateLimit } from '@/server/rateLimit';
import { pumpInBackground } from '@/server/jobs/pump';

/**
 * POST /api/integrations/google-drive/sync
 *
 * Sync now. Runs in the request because a person pressed a button and wants to
 * see the result; the same work is available to a scheduler through the job
 * abstraction in jobs.ts.
 *
 * Rate limited per company: a sync is a long walk through Google's API, and
 * Google's quotas are per project, so one company hammering the button would
 * spend everybody's allowance.
 */
export const dynamic = 'force-dynamic';

export async function POST() {
  return withIntegrationScope(async (scope) => {
    const limit = rateLimit(`gdrive:sync:${scope.companyId}`, GOOGLE_SYNC_LIMIT());
    if (!limit.allowed) {
      return Response.json(
        { error: 'RATE_LIMITED', message: 'That sync just ran. Give it a moment.' },
        { status: 429, headers: { ...noStore, 'retry-after': String(limit.retryAfterSeconds) } },
      );
    }

    const outcome = await syncNow(scope);

    // Syncing writes rows as pending; something still has to read them. The
    // pump is started rather than awaited, because extraction and a vision
    // model take minutes and this response should not.
    //
    // Without this, a synced file waits for `npm run cip:worker` — which is
    // still the right way to run it, and is what a deployment should do — but
    // pressing Sync Now with no worker running used to do visibly nothing.
    pumpInBackground();

    const connection = await getConnection(scope);
    return Response.json({ outcome, connection }, { headers: noStore });
  });
}
