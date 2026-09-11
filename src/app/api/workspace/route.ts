import { requireSessionOr401 } from '@/server/auth/guards';
import { getWorkspace } from '@/server/workspace/service';
import { pumpInBackground } from '@/server/jobs/pump';

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

    // Opening CIP is enough to bring it up to date. The pump sweeps any
    // connected Google Drive folder that is due, reads whatever is new, and
    // understands it — so a file dropped into the folder is known about without
    // anybody pressing Sync Now. Started, not awaited: this response is the
    // workspace, and it must not wait on somebody else's API.
    pumpInBackground();

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
