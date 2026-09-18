import { noStore, withBrainScope } from '@/server/brain/http';
import { enqueueUnderstanding, understandingQueueDepth } from '@/server/brain/understanding';
import { GOOGLE_SYNC_LIMIT, rateLimit } from '@/server/rateLimit';

/**
 * POST /api/brain/understand
 *
 * Queues anything in this company that has not been understood yet. Returns
 * immediately: analysing a video takes minutes, and the worker does it.
 */
export const dynamic = 'force-dynamic';

export async function POST() {
  return withBrainScope(async (scope) => {
    // Reuses the sweep limit: this is the same kind of "do a big job" button.
    const limit = await rateLimit(`brain:understand:${scope.companyId}`, GOOGLE_SYNC_LIMIT());
    if (!limit.allowed) {
      return Response.json(
        { error: 'RATE_LIMITED', message: 'That just ran. Give it a moment.' },
        { status: 429, headers: { ...noStore, 'retry-after': String(limit.retryAfterSeconds) } },
      );
    }

    const queued = await enqueueUnderstanding(scope);
    return Response.json({ queued, queue: await understandingQueueDepth() }, { headers: noStore });
  });
}
