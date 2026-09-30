import { noStore, withBrainScope } from '@/server/brain/http';
import { compareWithEarlier } from '@/server/brain/revisions';

type Params = { params: Promise<{ checkId: string }> };

export const dynamic = 'force-dynamic';

/**
 * GET /api/brain/checks/[checkId]/compare[?with=<earlier check id>]
 *
 * This check next to the version before it: what was fixed, what is still
 * open, what is new. Without `with`, the earlier version is found when it can
 * be told for certain; with it, the one a person picked. Another company's
 * check is a 404 either way.
 */
export async function GET(request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const { checkId } = await params;
    const withId = new URL(request.url).searchParams.get('with');
    const revision = await compareWithEarlier(scope, checkId, withId);
    if (!revision) {
      return Response.json(
        { error: 'not_found', message: 'That check is not in this workspace.' },
        { status: 404, headers: noStore },
      );
    }
    return Response.json({ revision }, { headers: noStore });
  });
}
