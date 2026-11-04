import { noStore, withMediaScope } from '@/server/media/http';
import { layerFile } from '@/server/media/arrange';

/**
 * GET /api/media/generations/[id]/layers/[name]
 *
 * One layer of a post arranged layer by layer - background, shadow, bottle,
 * headline or logo - on transparency. ?v= is what the layer holds, so a
 * browser keeps it until that layer changes, and fetches only the one that did.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await context.params;
  const v = new URL(request.url).searchParams.get('v');
  return withMediaScope(async (scope) => {
    const bytes = await layerFile(scope, id, name, v);
    return new Response(new Uint8Array(bytes), {
      headers: {
        // Kept by this browser only, and only under this version of the layer.
        ...(v ? { 'cache-control': 'private, max-age=31536000, immutable' } : noStore),
        'content-type': 'image/png',
        'content-length': String(bytes.byteLength),
      },
    });
  });
}
