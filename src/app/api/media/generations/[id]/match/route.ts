import { noStore, withMediaScope } from '@/server/media/http';
import { matchScene } from '@/server/media/arrange';

/**
 * POST /api/media/generations/[id]/match   { file, box }
 *   The light and brightness that set a picture into the scene where it stands. Measured; free.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  return withMediaScope(async (scope) => Response.json(await matchScene(scope, id, body), { headers: noStore }));
}
