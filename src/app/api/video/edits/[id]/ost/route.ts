import { noStore, withBrainScope } from '@/server/brain/http';
import { getEdit, ostTable } from '@/server/video/edit';

type Params = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** GET the plan as the house's OST sheet: one Markdown table. */
export async function GET(_request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const edit = await getEdit(scope, (await params).id);
    if (!edit?.plan) return Response.json({ error: 'not_found', message: 'That edit has no plan yet.' }, { status: 404, headers: noStore });
    const name = (edit.plan.title || 'ost').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'ost';
    return new Response(ostTable(edit.plan), {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${name} - OST.md"`,
        ...noStore,
      },
    });
  });
}
