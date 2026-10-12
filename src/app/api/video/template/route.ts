import { noStore, withBrainScope } from '@/server/brain/http';
import { getTemplate, saveTemplate } from '@/server/video/edit';
import type { VideoTemplateDTO } from '@/server/video/edit';

/**
 * /api/video/template
 *
 * GET  the frames around every film: logo, colours, disclaimer, end screen
 * PUT  change them
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return withBrainScope(async (scope) => Response.json({ template: await getTemplate(scope) }, { headers: noStore }));
}

export async function PUT(request: Request) {
  return withBrainScope(async (scope) => {
    const body = (await request.json().catch(() => ({}))) as Partial<VideoTemplateDTO>;
    return Response.json({ template: await saveTemplate(scope, body) }, { headers: noStore });
  });
}
