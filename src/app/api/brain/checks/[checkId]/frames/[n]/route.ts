import { noStore, withBrainScope } from '@/server/brain/http';
import { checkFrame } from '@/server/brain/checker';

type Params = { params: Promise<{ checkId: string; n: string }> };

export const dynamic = 'force-dynamic';

/**
 * GET /api/brain/checks/[checkId]/frames/[n]
 *
 * One frame a video check was judged on, so a flag can show the moment it is
 * about. Another company's check is a 404, exactly like one that never existed.
 */
export async function GET(_request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const { checkId, n } = await params;
    const body = await checkFrame(scope, checkId, Number(n));
    if (!body) {
      return Response.json(
        { error: 'not_found', message: 'That frame is not in this workspace.' },
        { status: 404, headers: noStore },
      );
    }
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': 'image/jpeg',
        // A kept frame never changes, and is only this person's to see.
        'cache-control': 'private, max-age=86400, immutable',
      },
    });
  });
}
