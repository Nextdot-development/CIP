import { requireSessionOr401 } from '@/server/auth/guards';
import { noStore } from '@/server/drive/http';
import { DriveNotFound, DriveRejected } from '@/server/drive/service';
import { semanticSearch } from '@/server/drive/semanticSearch';
import { SEMANTIC_SEARCH_LIMIT, rateLimit } from '@/server/rateLimit';

/**
 * POST /api/drive/search/semantic
 *
 * Finds passages by meaning within the caller's company. There is no company
 * parameter — the scope comes from the session, and the row-level security
 * policy turns it into the filter.
 *
 * POST rather than GET for two reasons: the call spends money on an embedding
 * request, and a search query is prose that has no business in a URL or a
 * server access log.
 */
export const dynamic = 'force-dynamic';

type Body = {
  query?: unknown;
  limit?: unknown;
  folderId?: unknown;
  fileTypes?: unknown;
};

export async function POST(request: Request) {
  const auth = await requireSessionOr401();
  if (!auth.ok) return auth.response;

  const { scope } = auth.session;

  // Every search costs an embedding call, so the ceiling is per user.
  const limit = rateLimit(`semantic:${scope.userId}`, SEMANTIC_SEARCH_LIMIT);
  if (!limit.allowed) {
    return Response.json(
      { error: 'rate_limited', message: 'That is a lot of searching. Try again in a moment.' },
      {
        status: 429,
        headers: { ...noStore, 'retry-after': String(limit.retryAfterSeconds) },
      },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'bad_request', message: 'Send a JSON body.' }, { status: 400, headers: noStore });
  }

  try {
    const results = await semanticSearch(scope, {
      query: typeof body.query === 'string' ? body.query : '',
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      // A company id in the body is simply not read. Only these four fields are.
      folderId: typeof body.folderId === 'string' ? body.folderId : null,
      fileTypes: Array.isArray(body.fileTypes) ? body.fileTypes.filter((t): t is string => typeof t === 'string') : null,
    });

    return Response.json(results, {
      headers: { ...noStore, 'x-ratelimit-remaining': String(limit.remaining) },
    });
  } catch (error) {
    if (error instanceof DriveNotFound) {
      return Response.json({ error: 'not_found', message: error.message }, { status: 404, headers: noStore });
    }
    if (error instanceof DriveRejected) {
      return Response.json({ error: 'rejected', message: error.message }, { status: 422, headers: noStore });
    }
    // Never echo the error: it may carry the query or document text.
    console.error('Semantic search failed for a request.');
    return Response.json(
      { error: 'search_error', message: 'Search is unavailable right now.' },
      { status: 500, headers: noStore },
    );
  }
}
