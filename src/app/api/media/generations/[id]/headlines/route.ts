import { noStore, withMediaScope } from '@/server/media/http';
import { headlineOptions } from '@/server/media/arrange';

/**
 * GET /api/media/generations/[id]/headlines
 *
 * Other headlines to try on a composed post: its own words broken another
 * way, and the brand's headlines from its past posts - and the colours the
 * headline may take, the brand's own. Read from what CIP
 * already holds - nothing is asked of a model and nothing is spent.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return withMediaScope(async (scope) => Response.json(await headlineOptions(scope, id), { headers: noStore }));
}
