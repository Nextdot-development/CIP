import { requireSessionOr401 } from '@/server/auth/guards';
import { getWorkspace } from '@/server/workspace/service';

/**
 * GET /api/workspace
 *
 * Returns the signed-in user's company workspace, and only that.
 *
 * There is no company parameter. Adding one would be the bug: the company is
 * read from the session, checked against a membership, and used to scope every
 * query. Manipulating the URL, the headers or the request body cannot change
 * which company answers.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireSessionOr401();
  if (!auth.ok) return auth.response;

  try {
    const workspace = await getWorkspace(auth.session);
    return Response.json(workspace, {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    console.error('GET /api/workspace failed:', error);
    return Response.json(
      { error: 'workspace_unavailable', message: 'We could not load your workspace.' },
      { status: 500 },
    );
  }
}
