import { noStore, withMediaScope } from '@/server/media/http';
import { arrangePost, postLayers } from '@/server/media/arrange';

/**
 * GET /api/media/generations/[id]/layers
 *
 * The post's layers, bottom to top, and which of them it has - what the page
 * draws it from, layer over layer. Made once from the kept scene for a post
 * whose layers were never kept; nothing is spent.
 *
 * POST /api/media/generations/[id]/layers
 *
 * Moves a composed post's layers, on the scene it was made on.
 * Body: { choices?: { bottle?: 'left' | 'center' | 'right' | 'none',
 *                     size?: 'small' | 'medium' | 'large',
 *                     logo?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'none' },
 *         lines?: [{ text, role: 'lead' | 'key' | 'tail' }] }
 *
 * Nothing is asked of a provider and nothing is spent. The post is changed
 * where it is, and the answer is the post as it now is, with its layers -
 * so the page need not ask for them again.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { choices?: unknown; lines?: unknown } | null;

  return withMediaScope(async (scope) => {
    const arranged = await arrangePost(scope, id, { choices: body?.choices, lines: body?.lines });
    return Response.json(arranged, { headers: noStore });
  });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return withMediaScope(async (scope) => Response.json(await postLayers(scope, id), { headers: noStore }));
}
