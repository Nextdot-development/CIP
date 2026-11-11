import { noStore, withMediaScope } from '@/server/media/http';
import { MediaRejected } from '@/server/media/types';
import { OWN_BACKGROUND_MAX_BYTES } from '@/server/media/arrange';
import { postOnOwnPicture } from '@/server/media/ownPicture';

/**
 * POST /api/media/own-picture   multipart/form-data
 *   file     the picture to set the post on (PNG, JPG or WebP, up to 15 MB)
 *   brand    the brand it is for
 *   request  what the post is, optionally with its headline in quotes
 *   ratio    '1:1' | '4:5' | '9:16' | '16:9' | '3:2' | '2:3'
 *
 * A new post on the person's own picture: the brand's bottle, logo and
 * headline set on it, layer by layer. Nothing is painted, no model is asked;
 * free.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return withMediaScope(async (scope) => {
    // Refused before it is read whole when it says it is too big.
    if (Number(request.headers.get('content-length') ?? 0) > OWN_BACKGROUND_MAX_BYTES + 64 * 1024) {
      throw new MediaRejected('That picture is over 15 MB. Bring a smaller one.');
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file === 'string') throw new MediaRejected('Choose a picture for the background.');
    const generation = await postOnOwnPicture(scope, {
      brand: form!.get('brand'),
      request: form!.get('request'),
      ratio: form!.get('ratio'),
      picture: { bytes: Buffer.from(await file.arrayBuffer()), mimeType: file.type },
    });
    return Response.json({ generation }, { headers: noStore });
  });
}
