import { withBrainScope, noStore } from '@/server/brain/http';
import { readFilm } from '@/server/video/edit';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** GET the finished film. ?disposition=inline plays it in the page. */
export async function GET(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const film = await readFilm(scope, (await params).id);
    if (!film) return Response.json({ error: 'not_found', message: 'That film is not ready.' }, { status: 404, headers: noStore });
    const inline = new URL(request.url).searchParams.get('disposition') === 'inline';
    return new Response(new Uint8Array(film.bytes), {
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(film.bytes.length),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${film.name}"`,
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}
