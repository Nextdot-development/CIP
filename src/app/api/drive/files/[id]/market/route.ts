import { withDriveScope, noStore } from '@/server/drive/http';
import { setFileMarket } from '@/server/brain/markets';

type Params = { params: Promise<{ id: string }> };

/**
 * PUT /api/drive/files/[id]/market
 *
 * Which market this file's knowledge belongs to. Sending null clears it, which
 * puts the file back to belonging to the brand at large.
 *
 * Scoped like every other Drive write: another company's file id gives 404,
 * not a different answer.
 */
export const dynamic = 'force-dynamic';

type Body = { market?: unknown };

export async function PUT(request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { id } = await params;

    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      return Response.json(
        { error: 'rejected', message: 'Send a JSON body.' },
        { status: 400, headers: noStore },
      );
    }

    const market = typeof body.market === 'string' && body.market.trim().length > 0
      ? body.market.trim()
      : null;

    // Scoped in the update itself, so another company's id changes nothing and
    // is answered the same way an id that never existed would be.
    const found = await setFileMarket(scope, id, market);
    if (!found) {
      return Response.json(
        { error: 'not_found', message: 'That file could not be found.' },
        { status: 404, headers: noStore },
      );
    }

    return Response.json({ market }, { headers: noStore });
  });
}
