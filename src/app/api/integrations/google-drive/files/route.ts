import { noStore, withIntegrationScope } from '@/server/integrations/googleDrive/http';
import { listSyncedFiles } from '@/server/integrations/googleDrive/connection';

/**
 * GET /api/integrations/google-drive/files
 *
 * What the last sync found, including what it could not read and why. Files
 * that were skipped are shown rather than quietly omitted.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return withIntegrationScope(async (scope) => {
    const limitParam = Number(new URL(request.url).searchParams.get('limit'));
    const files = await listSyncedFiles(scope, {
      limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined,
    });
    return Response.json({ files }, { headers: noStore });
  });
}
