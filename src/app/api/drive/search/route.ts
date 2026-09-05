import { withDriveScope, noStore } from '@/server/drive/http';
import { search } from '@/server/drive/service';
import type { FileKind } from '@/lib/fileTypes';

/** GET /api/drive/search?q=&kind= */
export const dynamic = 'force-dynamic';

const KINDS: FileKind[] = ['document', 'spreadsheet', 'presentation', 'image', 'video', 'audio', 'data'];

export async function GET(request: Request) {
  return withDriveScope(async (scope) => {
    const params = new URL(request.url).searchParams;
    const raw = params.get('kind');
    const kind = raw && (KINDS as string[]).includes(raw) ? (raw as FileKind) : null;

    const results = await search(scope, params.get('q') ?? '', kind);
    return Response.json(results, { headers: noStore });
  });
}
