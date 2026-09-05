import { withDriveScope, noStore } from '@/server/drive/http';
import { createFolder } from '@/server/drive/service';

/** POST /api/drive/folders  { parentId, name } */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return withDriveScope(async (scope) => {
    const body = (await request.json()) as { parentId?: string | null; name?: string };
    const folder = await createFolder(scope, body.parentId ?? null, String(body.name ?? ''));
    return Response.json(folder, { status: 201, headers: noStore });
  });
}
