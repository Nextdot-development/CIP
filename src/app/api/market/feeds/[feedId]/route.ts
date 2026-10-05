import { withDriveScope, noStore } from '@/server/drive/http';
import { checkFeedNow, listFeeds, setFeedEnabled } from '@/server/brain/filings';
import { pumpInBackground } from '@/server/jobs/pump';

type Params = { params: Promise<{ feedId: string }> };

export const dynamic = 'force-dynamic';
/** A check fetches up to three filings, each a PDF from the exchange. */
export const maxDuration = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () =>
  Response.json({ error: 'not_found', message: 'That feed is not in this workspace.' }, { status: 404, headers: noStore });

/** PATCH { enabled } - stop or start watching. */
export async function PATCH(request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { feedId } = await params;
    const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
    if (!UUID.test(feedId) || !(await setFeedEnabled(scope, feedId, body.enabled === true))) return notFound();
    return Response.json({ feeds: await listFeeds(scope) }, { headers: noStore });
  });
}

/** POST - look for new filings now, rather than at the next check. */
export async function POST(_request: Request, { params }: Params) {
  return withDriveScope(async (scope) => {
    const { feedId } = await params;
    const feeds = UUID.test(feedId) ? await checkFeedNow(scope, feedId) : null;
    if (!feeds) return notFound();
    // What was fetched is read in the background.
    pumpInBackground();
    return Response.json({ feeds }, { headers: noStore });
  });
}
