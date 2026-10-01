import { noStore, withIntegrationScope } from '@/server/integrations/googleDrive/http';
import { listPickableFolders } from '@/server/integrations/googleDrive/connection';

/**
 * GET /api/integrations/google-drive/folders
 *
 * The folders the connected account could be pointed at, so somebody can pick
 * one instead of hunting for a link. Asked of Google each time rather than
 * cached: a folder made this morning should be choosable this morning.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return withIntegrationScope(async (scope) => {
    const folders = await listPickableFolders(scope);
    return Response.json({ folders }, { headers: noStore });
  });
}
