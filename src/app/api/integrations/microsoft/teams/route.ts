import { noStore, withMicrosoftScope } from '@/server/integrations/microsoftTeams/http';
import { listTeams } from '@/server/integrations/microsoftTeams/connection';

/**
 * GET /api/integrations/microsoft/teams
 *
 * The teams CIP can see, so somebody can choose one. Asked of Microsoft each
 * time rather than cached: a team created this morning should be choosable
 * this morning, and the call is one request.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return withMicrosoftScope(async (scope) => {
    const teams = await listTeams(scope);
    return Response.json({ teams }, { headers: noStore });
  });
}
