import { noStore, withMediaScope } from '@/server/media/http';
import { cancelGeneration } from '@/server/media/generation';

/**
 * POST /api/media/generations/[id]/cancel
 *
 * Stops a generation that has not finished.
 *
 * This exists because fal's queue really does have a cancel endpoint
 * (PUT .../requests/{id}/cancel); it is not a button that only updates our own
 * row and hopes. Our record is settled first and the provider is told after,
 * so a provider that refuses still leaves the generation cancelled here.
 */
export const dynamic = 'force-dynamic';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  return withMediaScope(async (scope) => {
    const generation = await cancelGeneration(scope, id);
    return Response.json({ generation }, { headers: noStore });
  });
}
