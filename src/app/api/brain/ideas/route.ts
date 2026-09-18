import { noStore, withBrainScope } from '@/server/brain/http';
import { IdeasRejected, ideate } from '@/server/brain/ideas';
import { activeBrand } from '@/server/brain/activeBrand';
import { rateLimit } from '@/server/rateLimit';

/**
 * POST /api/brain/ideas   { brief }
 *
 * Three campaign concepts for the brief, each with the sources it stands on.
 * The brand is the one the brief names, else the one chosen in the sidebar.
 */
export const dynamic = 'force-dynamic';

const IDEAS_LIMIT = { capacity: 6, refillPerSecond: 1 / 10 };

export async function POST(request: Request) {
  return withBrainScope(async (scope) => {
    const limit = await rateLimit(`ideas:${scope.userId}`, IDEAS_LIMIT);
    if (!limit.allowed) {
      return Response.json(
        { error: 'rate_limited', message: 'That is a lot of concepts at once. Give it a moment.' },
        { status: 429, headers: { ...noStore, 'retry-after': String(limit.retryAfterSeconds) } },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { brief?: unknown };
    try {
      const { active } = await activeBrand(scope);
      const result = await ideate(scope, {
        brief: typeof body.brief === 'string' ? body.brief : '',
        activeBrand: active,
      });
      return Response.json(result, { headers: noStore });
    } catch (error) {
      if (error instanceof IdeasRejected) {
        return Response.json({ error: 'rejected', message: error.message }, { status: 422, headers: noStore });
      }
      throw error;
    }
  });
}
