import { noStore, withMediaScope } from '@/server/media/http';
import { seeThroughPicture } from '@/server/media/arrange';

/**
 * POST /api/media/generations/[id]/see-through   { file, box? }
 *   A glass on the post made see-through in the light where it stands, kept as a new picture.
 *   Nothing is asked of a model; free.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  return withMediaScope(async (scope) => Response.json(await seeThroughPicture(scope, id, body), { headers: noStore }));
}
