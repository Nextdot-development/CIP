import { withDriveScope, noStore } from '@/server/drive/http';
import { archiveFile, deleteFileForever, renameFile, restoreFile } from '@/server/drive/service';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** PATCH /api/drive/files/[id]  { name } or { archived: false } to restore */
export async function PATCH(request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { id } = await params;
    const body = (await request.json()) as { name?: string; archived?: boolean };

    if (body.archived === false) {
      await restoreFile(scope, id);
      return new Response(null, { status: 204, headers: noStore });
    }

    const file = await renameFile(scope, id, String(body.name ?? ''));
    return Response.json(file, { headers: noStore });
  });
}

/** DELETE /api/drive/files/[id][?permanent=1] */
export async function DELETE(request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { id } = await params;
    const permanent = new URL(request.url).searchParams.get('permanent') === '1';

    if (permanent) await deleteFileForever(scope, id);
    else await archiveFile(scope, id);

    return new Response(null, { status: 204, headers: noStore });
  });
}
