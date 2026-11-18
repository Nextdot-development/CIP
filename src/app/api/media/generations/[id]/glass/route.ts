import { noStore, withMediaScope } from '@/server/media/http';
import { glassOptions } from '@/server/media/arrange';

/**
 * GET /api/media/generations/[id]/glass
 *   The post's brand, and the glasses its library holds - set beside the bottle like its logo. Free.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return withMediaScope(async (scope) => Response.json(await glassOptions(scope, id), { headers: noStore }));
}
