import { noStore, withMicrosoftScope } from '@/server/integrations/microsoftTeams/http';
import { disconnect } from '@/server/integrations/microsoftTeams/connection';

/**
 * POST /api/integrations/microsoft/disconnect
 *
 * Stops reading the team. What was already learned stays: disconnecting is
 * "do not read any more", not "forget what you read".
 */
export const dynamic = 'force-dynamic';

export async function POST() {
  return withMicrosoftScope(async (scope) => {
    const connection = await disconnect(scope);
    return Response.json({ connection }, { headers: noStore });
  });
}
