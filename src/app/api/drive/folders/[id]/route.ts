import { withDriveScope, noStore } from '@/server/drive/http';
import { archiveFolder, renameFolder } from '@/server/drive/service';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** PATCH /api/drive/folders/[id]  { name } */
export async function PATCH(request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { id } = await params;
    const body = (await request.json()) as { name?: string };
    const folder = await renameFolder(scope, id, String(body.name ?? ''));
    return Response.json(folder, { headers: noStore });
  });
}

/** DELETE /api/drive/folders/[id] — archives the folder and its contents */
export async function DELETE(_request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { id } = await params;
    await archiveFolder(scope, id);
    return new Response(null, { status: 204, headers: noStore });
  });
}
