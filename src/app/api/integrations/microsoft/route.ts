import { noStore, withMicrosoftScope } from '@/server/integrations/microsoftTeams/http';
import { getConnection } from '@/server/integrations/microsoftTeams/connection';

/**
 * GET /api/integrations/microsoft
 *
 * The connection status for the caller's own company. Carries no credentials:
 * the DTO has no field for one, and with app-only auth there is none to leak.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return withMicrosoftScope(async (scope) => {
    const connection = await getConnection(scope);
    return Response.json({ connection }, { headers: noStore });
  });
}
