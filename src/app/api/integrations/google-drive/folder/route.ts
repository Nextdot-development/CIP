import { noStore, withIntegrationScope } from '@/server/integrations/googleDrive/http';
import { setFolder } from '@/server/integrations/googleDrive/connection';

/**
 * POST /api/integrations/google-drive/folder
 *
 * Chooses which folder to sync. The id is stored, not a URL: a URL is one way
 * of naming a folder, it changes shape whenever Google feels like it, and it is
 * not evidence of anything. The id is confirmed readable by the connected
 * account before it is saved.
 */
export const dynamic = 'force-dynamic';

type Body = { folderId?: unknown };

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

    // Only this one field is read. A company id in the body is not ignored by
    // convention; there is nowhere for it to go.
    const folderId = typeof body.folderId === 'string' ? body.folderId : '';
    const connection = await setFolder(scope, folderId);
    return Response.json({ connection }, { headers: noStore });
  });
}
