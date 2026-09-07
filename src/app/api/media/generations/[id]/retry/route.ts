import { checkGenerationRate, noStore, withMediaScope } from '@/server/media/http';
import { retryGeneration } from '@/server/media/generation';
import { IMAGE_GENERATION_LIMIT, VIDEO_GENERATION_LIMIT } from '@/server/rateLimit';
import { getGeneration } from '@/server/media/generation';

/**
 * POST /api/media/generations/[id]/retry
 *
 * Puts a failed generation back in the queue.
 *
 * Rate limited exactly like creating one: a retry buys another provider call,
 * so leaving it unlimited would be a way around the limit on the endpoint that
 * created the generation in the first place.
 */
export const dynamic = 'force-dynamic';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  return withMediaScope(async (scope) => {
    // Read first so the right bucket is charged — and so an id from another
    // company is 404 before it can consume anybody's allowance.
    const { generation: existing } = await getGeneration(scope, id);

    const limited = checkGenerationRate(
      scope,
      existing.type,
      existing.type === 'video' ? VIDEO_GENERATION_LIMIT() : IMAGE_GENERATION_LIMIT(),
    );
    if (limited) return limited;

    const generation = await retryGeneration(scope, id);
    return Response.json({ generation }, { status: 202, headers: noStore });
  });
}
