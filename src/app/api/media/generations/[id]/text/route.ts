import { noStore, withMediaScope } from '@/server/media/http';
import { changeText } from '@/server/media/retext';

/**
 * POST /api/media/generations/[id]/text
 *
 * Sets a composed post again with new words, on the scene it was made on.
 * Body: { lines: [{ text, role: 'lead' | 'key' | 'tail' }] }
 *
 * Not rate limited like making a picture: nothing is asked of a provider and
 * nothing is spent. The answer is the new version; the old one is untouched.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { lines?: unknown } | null;

  return withMediaScope(async (scope) => {
    const generation = await changeText(scope, id, body?.lines);
    return Response.json({ generation }, { status: 201, headers: noStore });
  });
}
