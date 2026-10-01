import { noStore, withMicrosoftScope } from '@/server/integrations/microsoftTeams/http';
import { listSyncedFiles } from '@/server/integrations/microsoftTeams/connection';

/**
 * GET /api/integrations/microsoft/files
 *
 * What the last syncs saw, including what was skipped and why. A file CIP
 * cannot read must be visible as such, or a Team of Excel workbooks looks
 * like a Team that synced perfectly and taught nothing.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return withMicrosoftScope(async (scope) => {
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? '100');
    const files = await listSyncedFiles(scope, Number.isFinite(limit) ? limit : 100);
    return Response.json({ files }, { headers: noStore });
  });
}
