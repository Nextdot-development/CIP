import { noStore, withBrainScope } from '@/server/brain/http';
import { setSignalStatus } from '@/server/brain/market';

type Params = { params: Promise<{ signalId: string }> };

export const dynamic = 'force-dynamic';

/**
 * POST /api/market/signals/[signalId]   { "status": "rejected" | "active" }
 *
 * "Wrong? Remove it." A removed signal no longer reaches the screen or the
 * Brain's answers, and reading the report again does not bring it back.
 */
export async function POST(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const { signalId } = await params;
    const body = (await request.json().catch(() => ({}))) as { status?: unknown };
    if (body.status !== 'rejected' && body.status !== 'active') {
      return Response.json({ error: 'INVALID_REQUEST', message: 'Set status to "rejected" or "active".' }, { status: 400, headers: noStore });
    }
    const ok = await setSignalStatus(scope, signalId, body.status);
    if (!ok) return Response.json({ error: 'not_found', message: 'That signal is not here.' }, { status: 404, headers: noStore });
    return Response.json({ ok: true }, { headers: noStore });
  });
}
