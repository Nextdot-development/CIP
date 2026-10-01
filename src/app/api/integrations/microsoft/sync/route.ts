import { noStore, withMicrosoftScope } from '@/server/integrations/microsoftTeams/http';
import { getConnection } from '@/server/integrations/microsoftTeams/connection';
import { syncNow } from '@/server/integrations/microsoftTeams/sync';
import { TEAMS_SYNC_LIMIT, rateLimit } from '@/server/rateLimit';
import { pumpInBackground } from '@/server/jobs/pump';

/**
 * POST /api/integrations/microsoft/sync
 *
 * Sync now. Runs in the request because a person pressed a button and wants to
 * see the result; the same work reaches the worker through jobs.ts, which is
 * what makes the connection keep itself up to date without anybody pressing
 * anything.
 */
export const dynamic = 'force-dynamic';

export async function POST() {
  return withMicrosoftScope(async (scope) => {
    const limit = await rateLimit(`teams:sync:${scope.companyId}`, TEAMS_SYNC_LIMIT());
    if (!limit.allowed) {
      return Response.json(
        { error: 'RATE_LIMITED', message: 'That sync just ran. Give it a moment.' },
        { status: 429, headers: { ...noStore, 'retry-after': String(limit.retryAfterSeconds) } },
      );
    }

    const outcome = await syncNow(scope);

    // Syncing writes rows as pending; something still has to read them. Started
    // rather than awaited, because extraction and a vision model take minutes
    // and this response should not.
    pumpInBackground();

    const connection = await getConnection(scope);
    return Response.json({ outcome, connection }, { headers: noStore });
  });
}
