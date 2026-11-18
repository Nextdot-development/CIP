import { noStore, withMediaScope } from '@/server/media/http';
import { keepAsBrandGlass, originalOf, removeStudioPicture } from '@/server/media/studioPictures';
import { MediaRejected } from '@/server/media/types';

type Params = { params: Promise<{ id: string }> };

/**
 * GET    /api/media/pictures/[id]   the picture a cut-out was cut from, for the brush to bring back
 * PATCH  /api/media/pictures/[id]   { glassOf: brand } - kept as that brand's glass
 * DELETE /api/media/pictures/[id]   a studio picture taken away (archived, restorable)
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: Params) {
  return withMediaScope(async (scope) => {
    const { id } = await params;
    return Response.json({ original: await originalOf(scope, id) }, { headers: noStore });
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return withMediaScope(async (scope) => {
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { glassOf?: unknown } | null;
    if (typeof body?.glassOf !== 'string') throw new MediaRejected('Say which brand it is the glass of.');
    return Response.json({ ok: await keepAsBrandGlass(scope, id, body.glassOf) }, { headers: noStore });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return withMediaScope(async (scope) => {
    const { id } = await params;
    return Response.json({ ok: await removeStudioPicture(scope, id) }, { headers: noStore });
  });
}
