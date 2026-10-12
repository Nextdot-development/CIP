import { noStore, withBrainScope } from '@/server/brain/http';
import { createEdit, listEdits } from '@/server/video/edit';

/**
 * /api/video/edits
 *
 * GET   the company's video edits, newest first
 * POST  { fileId, doctorName, doctorTitle } - hear a recording and plan its edit
 */
export const dynamic = 'force-dynamic';
/** Hearing a recording of a few minutes, then planning it. */
export const maxDuration = 300;

export async function GET() {
  return withBrainScope(async (scope) => Response.json({ edits: await listEdits(scope) }, { headers: noStore }));
}

export async function POST(request: Request) {
  return withBrainScope(async (scope) => {
    const body = (await request.json().catch(() => ({}))) as { fileId?: unknown; doctorName?: unknown; doctorTitle?: unknown };
    const edit = await createEdit(scope, {
      fileId: String(body.fileId ?? ''),
      doctorName: String(body.doctorName ?? ''),
      doctorTitle: typeof body.doctorTitle === 'string' ? body.doctorTitle : null,
    });
    return Response.json({ edit }, { status: 201, headers: noStore });
  });
}
