import { withBrainScope, noStore } from '@/server/brain/http';
import { readWaveform } from '@/server/video/edit';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** GET the recording's sound as a picture, for the timeline. */
export async function GET(_request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const png = await readWaveform(scope, (await params).id);
    if (!png) return Response.json({ error: 'not_found', message: 'No sound to draw.' }, { status: 404, headers: noStore });
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' } });
  });
}
