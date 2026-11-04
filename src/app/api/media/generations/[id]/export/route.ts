import { noStore, withMediaScope } from '@/server/media/http';
import { exportLayers } from '@/server/media/arrange';
import { EXPORT_TYPES, type ExportFormat } from '@/server/media/layeredExport';

/**
 * GET /api/media/generations/[id]/export?format=png|psd|svg|pdf
 *
 * A composed post as an editor opens it: Photoshop layers, an SVG with live
 * text, a PDF, or the picture. Set again from the kept scene - nothing is
 * asked of a provider and nothing is spent.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const asked = new URL(request.url).searchParams.get('format') ?? 'png';
  const format = (asked in EXPORT_TYPES ? asked : 'png') as ExportFormat;

  return withMediaScope(async (scope) => {
    const bytes = await exportLayers(scope, id, format);
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...noStore,
        'content-type': EXPORT_TYPES[format],
        'content-length': String(bytes.byteLength),
        'content-disposition': `attachment; filename="cip-post-${id.slice(0, 8)}.${format}"`,
      },
    });
  });
}
