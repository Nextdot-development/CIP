import { withBrainScope, noStore } from '@/server/brain/http';
import { getEdit } from '@/server/video/edit';
import { bytesResponse } from '@/server/video/http';
import { readFile } from '@/server/drive/service';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** GET the recording a film is made from, to play beside its timeline. */
export async function GET(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const edit = await getEdit(scope, (await params).id);
    if (!edit) return Response.json({ error: 'not_found', message: 'That edit is not in this workspace.' }, { status: 404, headers: noStore });
    const source = await readFile(scope, edit.sourceFileId);
    return bytesResponse(request, { bytes: source.body, name: source.filename, type: source.file.mimeType }, { inline: true, cache: 'private, max-age=3600' });
  });
}
