import { noStore, withBrainScope } from '@/server/brain/http';
import { getCheck } from '@/server/brain/checker';

type Params = { params: Promise<{ checkId: string }> };

export const dynamic = 'force-dynamic';

/**
 * GET /api/brain/checks/[checkId]
 *
 * One check, its flags, and what each flag was judged against. Another
 * company's check id is a 404, exactly like an id that never existed.
 */
export async function GET(_request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const { checkId } = await params;
    const check = await getCheck(scope, checkId);
    if (!check) {
      return Response.json(
        { error: 'not_found', message: 'That check is not in this workspace.' },
        { status: 404, headers: noStore },
      );
    }
    return Response.json({ check }, { headers: noStore });
  });
}
