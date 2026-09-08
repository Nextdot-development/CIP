import { noStore, withBrainScope } from '@/server/brain/http';
import { readFeedback, readLessons } from '@/server/brain/learning';

/**
 * GET /api/brain/lessons
 *
 * What this company's feedback has taught, and the feedback behind it.
 */
export const dynamic = 'force-dynamic';

const STATUSES = ['candidate', 'confirmed', 'rejected', 'superseded'] as const;

export async function GET(request: Request) {
  return withBrainScope(async (scope) => {
    const statusParam = new URL(request.url).searchParams.get('status');
    const status = (STATUSES as readonly string[]).includes(statusParam ?? '')
      ? (statusParam as (typeof STATUSES)[number])
      : null;

    const [lessons, feedback] = await Promise.all([
      readLessons(scope, { status, limit: 100 }),
      readFeedback(scope, 50),
    ]);

    return Response.json({ lessons, feedback }, { headers: noStore });
  });
}
