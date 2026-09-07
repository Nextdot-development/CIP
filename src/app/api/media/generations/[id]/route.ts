import { noStore, withMediaScope } from '@/server/media/http';
import { getGeneration } from '@/server/media/generation';

/**
 * GET /api/media/generations/[id]
 *
 * One generation and its assets. This is what the UI polls while a video is
 * being made. An id belonging to another company is not found — never
 * forbidden, which would confirm it exists.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  return withMediaScope(async (scope) => {
    const { generation, assets } = await getGeneration(scope, id);
    return Response.json({ generation, assets }, { headers: noStore });
  });
}
