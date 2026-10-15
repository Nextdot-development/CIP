import { withBrainScope, noStore } from '@/server/brain/http';
import { readOutput } from '@/server/video/edit';
import { bytesResponse } from '@/server/video/http';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

const KINDS = ['film', 'vertical', 'thumbnail', 'preview', 'captions'] as const;

/**
 * GET what was made for a film. ?kind= film (the default) | vertical (the
 * Short) | thumbnail | preview | captions (.srt); ?disposition=inline plays or
 * shows it in the page. The address carries ?v= the film's last update, so
 * it can be cached.
 */
export async function GET(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const url = new URL(request.url);
    const asked = url.searchParams.get('kind') ?? 'film';
    const kind = (KINDS as readonly string[]).includes(asked) ? (asked as (typeof KINDS)[number]) : 'film';
    const file = await readOutput(scope, (await params).id, kind);
    if (!file) return Response.json({ error: 'not_found', message: 'That is not ready.' }, { status: 404, headers: noStore });
    return bytesResponse(request, file, { inline: url.searchParams.get('disposition') === 'inline', cache: 'private, max-age=300' });
  });
}
