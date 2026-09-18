import { noStore, withBrainScope } from '@/server/brain/http';
import { rereadSource } from '@/server/brain/market';
import { pumpInBackground } from '@/server/jobs/pump';

type Params = { params: Promise<{ sourceId: string }> };

export const dynamic = 'force-dynamic';

/**
 * POST /api/market/sources/[sourceId]   { "action": "reread" }
 *
 * Reads a report again from the start. Signals a person removed stay removed.
 */
export async function POST(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const { sourceId } = await params;
    const body = (await request.json().catch(() => ({}))) as { action?: unknown };
    if (body.action !== 'reread') {
      return Response.json({ error: 'INVALID_REQUEST', message: 'The only action is "reread".' }, { status: 400, headers: noStore });
    }
    const ok = await rereadSource(scope, sourceId);
    if (!ok) return Response.json({ error: 'not_found', message: 'That report is not here.' }, { status: 404, headers: noStore });
    pumpInBackground();
    return Response.json({ ok: true }, { headers: noStore });
  });
}
