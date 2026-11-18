import { noStore, withMediaScope } from '@/server/media/http';
import { freeQc } from '@/server/brain/freeQc';
import { MediaRejected } from '@/server/media/types';
import { readFile } from '@/server/drive/service';

/**
 * POST /api/brain/qc/free
 *   multipart/form-data  file, brand, market     a creative brought in, read here and kept nowhere
 *   application/json     { fileId, brand, market } a creative already in Drive
 *   Judged against the brand's and market's rules with no model: nothing is spent.
 */
export const dynamic = 'force-dynamic';
const MAX = 25 * 1024 * 1024;

export async function POST(request: Request) {
  return withMediaScope(async (scope) => {
    if ((request.headers.get('content-type') ?? '').includes('application/json')) {
      const body = (await request.json().catch(() => null)) as { fileId?: unknown; brand?: unknown; market?: unknown } | null;
      if (typeof body?.fileId !== 'string') throw new MediaRejected('Choose a creative.');
      const file = await readFile(scope, body.fileId).catch(() => null);
      if (!file) throw new MediaRejected('That file is not in Drive any more.');
      return Response.json(await freeQc(scope, { bytes: file.body, mime: file.file.mimeType, brand: body.brand, market: body.market }), { headers: noStore });
    }
    if (Number(request.headers.get('content-length') ?? 0) > MAX + 64 * 1024) throw new MediaRejected('That file is over 25 MB.');
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file === 'string') throw new MediaRejected('Choose a creative.');
    return Response.json(await freeQc(scope, {
      bytes: Buffer.from(await file.arrayBuffer()), mime: file.type || 'image/png', brand: form!.get('brand'), market: form!.get('market'),
    }), { headers: noStore });
  });
}
