import { withDriveScope, noStore } from '@/server/drive/http';
import { FeedRejected, addFeed, listFeeds } from '@/server/brain/filings';

/**
 * /api/market/feeds
 *
 * GET   the listed companies whose stock exchange filings are being watched
 * POST  { symbol, name } - start watching one, by its NSE symbol
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return withDriveScope(async (scope) => Response.json({ feeds: await listFeeds(scope) }, { headers: noStore }));
}

export async function POST(request: Request) {
  return withDriveScope(async (scope) => {
    const body = (await request.json().catch(() => ({}))) as { symbol?: unknown; name?: unknown };
    try {
      await addFeed(scope, { symbol: String(body.symbol ?? ''), name: String(body.name ?? '') });
    } catch (error) {
      if (error instanceof FeedRejected) {
        return Response.json({ error: 'rejected', message: error.message }, { status: 422, headers: noStore });
      }
      throw error;
    }
    return Response.json({ feeds: await listFeeds(scope) }, { status: 201, headers: noStore });
  });
}
