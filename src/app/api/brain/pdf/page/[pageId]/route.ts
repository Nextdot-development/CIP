import { withBrainScope } from '@/server/brain/http';
import { readPageImage } from '@/server/brain/pdfVisual';

type Params = { params: Promise<{ pageId: string }> };

export const dynamic = 'force-dynamic';

/**
 * GET /api/brain/pdf/page/[pageId]
 *
 * The rendered page image, so a person can see what the model was looking at
 * when it made a claim.
 *
 * These bytes are a customer's own material and the bucket is private, so this
 * route is the only way out: session checked, company scoped, no signed URLs.
 * A page id from another company is a 404, the same answer as one that never
 * existed.
 */
export async function GET(_request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const { pageId } = await params;

    // A malformed id must not reach the query as one, or Postgres raises
    // instead of simply finding nothing.
    if (!/^[0-9a-f-]{36}$/i.test(pageId)) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    const image = await readPageImage(scope, pageId);
    if (!image) return Response.json({ error: 'not_found' }, { status: 404 });

    return new Response(new Uint8Array(image.bytes), {
      headers: {
        'content-type': image.mimeType,
        'content-length': String(image.bytes.length),
        'content-disposition': 'inline',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
      },
    });
  });
}
