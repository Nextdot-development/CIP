import { noStore, withMediaScope } from '@/server/media/http';
import { rulesCheck } from '@/server/media/arrange';
import { MediaRejected } from '@/server/media/types';

/**
 * POST /api/brain/qc/rules   { generationId }
 *   A post made in the studio checked against its brand's and market's rules from its own pieces:
 *   each rule passed, broken, or for a person to look at. No model is asked; free.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { generationId?: unknown } | null;
  return withMediaScope(async (scope) => {
    if (typeof body?.generationId !== 'string') throw new MediaRejected('Choose a post to check.');
    return Response.json(await rulesCheck(scope, body.generationId), { headers: noStore });
  });
}
