import { withDriveScope, noStore } from '@/server/drive/http';
import { requestReprocess } from '@/server/drive/processing';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/**
 * POST /api/drive/files/[id]/reprocess
 *
 * Puts a file back in the queue and clears its attempt count. It does not do
 * the work — the worker picks it up — so this returns immediately.
 */
export async function POST(_request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { id } = await params;
    await requestReprocess(scope, id);
    return Response.json({ status: 'pending' }, { headers: noStore });
  });
}
