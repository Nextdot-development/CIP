import { withDriveScope } from '@/server/drive/http';
import { readFile } from '@/server/drive/service';
import { canPreviewInline, specFor } from '@/lib/fileTypes';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/**
 * GET /api/drive/files/[id]/content[?disposition=inline]
 *
 * The only way bytes leave the server. The object store is private and there
 * are no signed URLs, so every byte anyone downloads passed the session check
 * and the company scope on the way out.
 */
export async function GET(request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { id } = await params;
    const { file, body, filename } = await readFile(scope, id);

    const spec = specFor(filename);
    const wantsInline = new URL(request.url).searchParams.get('disposition') === 'inline';
    // Inline rendering happens on our own origin, so only types that cannot
    // carry script are ever shown that way. SVG is excluded for that reason.
    const inline = wantsInline && spec !== null && canPreviewInline(spec);

    const asciiName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');

    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': file.mimeType,
        'content-length': String(body.length),
        'content-disposition':
          `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; ` +
          `filename*=UTF-8''${encodeURIComponent(filename)}`,
        // Never let a browser guess a different type than the one we stored.
        'x-content-type-options': 'nosniff',
        // If anything did slip through, it can neither load nor call anything.
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
      },
    });
  });
}
