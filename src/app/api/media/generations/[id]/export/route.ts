import { noStore, withMediaScope } from '@/server/media/http';
import { EXPORT_SHAPES, exportLayers } from '@/server/media/arrange';
import { EXPORT_TYPES, type ExportFormat } from '@/server/media/layeredExport';

/**
 * GET /api/media/generations/[id]/export?format=png|psd|svg|pdf&shape=1:1|4:5|9:16|16:9
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
  // Another shape, laid out again on the same background; none is the post as made.
  const shape = new URL(request.url).searchParams.get('shape');

  return withMediaScope(async (scope) => {
    const bytes = await exportLayers(scope, id, format, shape && shape in EXPORT_SHAPES ? shape : null);
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...noStore,
        'content-type': EXPORT_TYPES[format],
        'content-length': String(bytes.byteLength),
        'content-disposition': `attachment; filename="cip-post-${id.slice(0, 8)}${shape && shape in EXPORT_SHAPES ? `-${shape.replace(':', 'x')}` : ''}.${format}"`,
      },
    });
  });
}
