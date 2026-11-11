import { noStore, withMediaScope } from '@/server/media/http';
import { MediaRejected } from '@/server/media/types';
import { OWN_BACKGROUND_MAX_BYTES, newBackground, ownBackground, previousBackground } from '@/server/media/arrange';

/**
 * POST /api/media/generations/[id]/background
 *
 * { note?: string, quality?: 'standard' | 'better' | 'best' }
 *                          paints the post a new background - the one call
 *                          here that is paid for - with what the person wants
 *                          in it, and sets the post again on it as arranged.
 * { action: 'previous' }   goes back to the background before, for nothing.
 *
 * multipart/form-data with `file`: a picture the person brought, as the
 *                          background - the bottle, logo and words set on it
 *                          as they were. Nothing is asked of a model; free.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if ((request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    return withMediaScope(async (scope) => {
      // Refused before it is read whole when it says it is too big.
      if (Number(request.headers.get('content-length') ?? 0) > OWN_BACKGROUND_MAX_BYTES + 64 * 1024) {
        throw new MediaRejected('That picture is over 15 MB. Bring a smaller one.');
      }
      const form = await request.formData().catch(() => null);
      const file = form?.get('file');
      if (!file || typeof file === 'string') throw new MediaRejected('Choose a picture for the background.');
      const generation = await ownBackground(scope, id, { bytes: Buffer.from(await file.arrayBuffer()), mimeType: file.type });
      return Response.json({ generation }, { headers: noStore });
    });
  }
  const body = (await request.json().catch(() => null)) as { note?: unknown; action?: unknown; quality?: unknown } | null;

  return withMediaScope(async (scope) => {
    const generation = body?.action === 'previous'
      ? await previousBackground(scope, id)
      // Always at the least it costs: the page no longer offers a dearer one.
      : await newBackground(scope, id, body?.note);
    return Response.json({ generation }, { headers: noStore });
  });
}
