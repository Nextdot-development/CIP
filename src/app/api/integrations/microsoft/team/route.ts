import { noStore, withMicrosoftScope } from '@/server/integrations/microsoftTeams/http';
import { setTeam } from '@/server/integrations/microsoftTeams/connection';

/**
 * POST /api/integrations/microsoft/team { teamId }
 *
 * Chooses the team to read. The drive behind it is resolved now, so somebody
 * choosing a team CIP cannot open is told here rather than by a sync that
 * fails quietly an hour later.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return withMicrosoftScope(async (scope) => {
    const body = (await request.json().catch(() => null)) as { teamId?: unknown } | null;
    const teamId = typeof body?.teamId === 'string' ? body.teamId.trim() : '';
    if (!teamId) {
      return Response.json(
        { error: 'rejected', message: 'Choose a team to connect.' },
        { status: 422, headers: noStore },
      );
    }

    const connection = await setTeam(scope, teamId);
    return Response.json({ connection }, { headers: noStore });
  });
}
