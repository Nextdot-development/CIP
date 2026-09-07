import { noStore, withIntegrationScope } from '@/server/integrations/googleDrive/http';
import { getConnection } from '@/server/integrations/googleDrive/connection';

/**
 * GET /api/integrations/google-drive
 *
 * The connection status for the caller's own company. Carries no tokens: the
 * DTO has no field for one.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return withIntegrationScope(async (scope) => {
    const connection = await getConnection(scope);
    return Response.json({ connection }, { headers: noStore });
  });
}
