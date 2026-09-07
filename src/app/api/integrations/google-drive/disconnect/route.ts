import { noStore, withIntegrationScope } from '@/server/integrations/googleDrive/http';
import { disconnect } from '@/server/integrations/googleDrive/connection';

/**
 * POST /api/integrations/google-drive/disconnect
 *
 * Forgets the tokens. The documents already ingested stay: they are the
 * company's knowledge, and disconnecting an integration is not a request to
 * destroy what it brought in.
 */
export const dynamic = 'force-dynamic';

export async function POST() {
  return withIntegrationScope(async (scope) => {
    const connection = await disconnect(scope);
    return Response.json({ connection }, { headers: noStore });
  });
}
