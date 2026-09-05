import { withDriveScope, noStore } from '@/server/drive/http';
import { listFolder } from '@/server/drive/service';

/** GET /api/drive?folderId=<uuid|omitted for the root> */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return withDriveScope(async (scope) => {
    const folderId = new URL(request.url).searchParams.get('folderId');
    const listing = await listFolder(scope, folderId && folderId !== 'root' ? folderId : null);
    return Response.json(listing, { headers: noStore });
  });
}
