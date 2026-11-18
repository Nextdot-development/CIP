import { withMediaScope } from '@/server/media/http';
import { shapeFrom } from '@/server/media/arrange';
import { shapeCanvas } from '@/server/media/composePost';
import { MediaRejected } from '@/server/media/types';

/**
 * GET /api/media/shape?s={shape}&w=&h=
 *   A shape drawn as the post will have it - its words in the brand's face - to show in the studio.
 *   The same drawing the post is made with; nothing is kept, nothing is spent.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return withMediaScope(async () => {
    const url = new URL(request.url);
    let raw: unknown;
    try { raw = JSON.parse(url.searchParams.get('s') ?? ''); } catch { throw new MediaRejected('That is not a shape.'); }
    const size = (k: string) => Math.min(2400, Math.max(4, Math.round(Number(url.searchParams.get(k)) || 0)));
    const png = await shapeCanvas(shapeFrom(raw), size('w'), size('h')).encode('png');
    return new Response(new Uint8Array(png), {
      headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' },
    });
  });
}
