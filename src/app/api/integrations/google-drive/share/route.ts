import { noStore, withIntegrationScope } from '@/server/integrations/googleDrive/http';
import { connectSharedFolder } from '@/server/integrations/googleDrive/connection';

/**
 * POST /api/integrations/google-drive/share
 *
 * Connects a folder somebody has shared with CIP's service account. Nobody
 * signs in: the folder link is the whole request, and whether CIP can read it
 * is checked with the service account before anything is saved.
 */
export const dynamic = 'force-dynamic';

type Body = { folder?: unknown };

export async function POST(request: Request) {
  return withIntegrationScope(async (scope) => {
    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      return Response.json(
        { error: 'rejected', message: 'Send a JSON body.' },
        { status: 400, headers: noStore },
      );
    }
    const folder = typeof body.folder === 'string' ? body.folder : '';
    const connection = await connectSharedFolder(scope, folder);
    return Response.json({ connection }, { headers: noStore });
  });
}
