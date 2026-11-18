import { noStore, withMediaScope } from '@/server/media/http';
import { MediaRejected } from '@/server/media/types';
import { STUDIO_PICTURE_MAX_BYTES, addStudioPicture, studioPictureChoices } from '@/server/media/studioPictures';

/**
 * GET  /api/media/pictures[?q=glass]
 *   The pictures that can be laid on a post: the studio's own, and Drive's when looked for by name.
 *
 * POST /api/media/pictures
 *   multipart/form-data  file  (PNG, JPG or WebP, up to 15 MB), cut ('1' to take a plain ground off)
 *   application/json     { fileId, cut }
 *   A picture made ready to lay on a post. No model is asked; free.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return withMediaScope(async (scope) => {
    const url = new URL(request.url);
    return Response.json({ pictures: await studioPictureChoices(scope, url.searchParams.get('q'), url.searchParams.get('brand')) }, { headers: noStore });
  });
}

export async function POST(request: Request) {
  return withMediaScope(async (scope) => {
    if ((request.headers.get('content-type') ?? '').includes('application/json')) {
      const body = (await request.json().catch(() => null)) as { fileId?: unknown; cut?: unknown } | null;
      if (typeof body?.fileId !== 'string') throw new MediaRejected('Choose a picture.');
      return Response.json(await addStudioPicture(scope, { fileId: body.fileId }, body.cut === true), { headers: noStore });
    }
    if (Number(request.headers.get('content-length') ?? 0) > STUDIO_PICTURE_MAX_BYTES + 64 * 1024) {
      throw new MediaRejected('That picture is over 15 MB. Bring a smaller one.');
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file === 'string') throw new MediaRejected('Choose a picture.');
    const done = await addStudioPicture(
      scope,
      { upload: { bytes: Buffer.from(await file.arrayBuffer()), filename: file.name || 'picture.png' } },
      form!.get('cut') === '1',
      typeof form!.get('original') === 'string' ? (form!.get('original') as string) : null,
    );
    return Response.json(done, { headers: noStore });
  });
}
