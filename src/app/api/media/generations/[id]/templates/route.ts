import { noStore, withMediaScope } from '@/server/media/http';
import { dropTemplate, saveTemplate, templatesFor } from '@/server/media/arrange';

/**
 * GET    /api/media/generations/[id]/templates            the templates saved for the post's brand
 * POST   /api/media/generations/[id]/templates  { name }  this post's arrangement kept as one
 * DELETE /api/media/generations/[id]/templates?template=  one let go
 * Free: nothing is made.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return withMediaScope(async (scope) => Response.json(await templatesFor(scope, id), { headers: noStore }));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  return withMediaScope(async (scope) => Response.json(await saveTemplate(scope, id, body), { headers: noStore }));
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const template = new URL(request.url).searchParams.get('template') ?? '';
  return withMediaScope(async (scope) => Response.json(await dropTemplate(scope, id, template), { headers: noStore }));
}
