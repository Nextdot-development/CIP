import { noStore, withMediaScope } from '@/server/media/http';
import { newBackground, previousBackground } from '@/server/media/arrange';

/**
 * POST /api/media/generations/[id]/background
 *
 * { note?: string }        paints the post a new background - the one call
 *                          here that is paid for - with what the person wants
 *                          in it, and sets the post again on it as arranged.
 * { action: 'previous' }   goes back to the background before, for nothing.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { note?: unknown; action?: unknown } | null;

  return withMediaScope(async (scope) => {
    const generation = body?.action === 'previous'
      ? await previousBackground(scope, id)
      : await newBackground(scope, id, body?.note);
    return Response.json({ generation }, { headers: noStore });
  });
}
