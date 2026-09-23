import { withDriveScope, noStore } from '@/server/drive/http';
import { findEverything } from '@/server/drive/findEverything';

/**
 * GET /api/drive/search/everything?q=
 *
 * One search across the file names, inside the documents, and inside the
 * pictures — merged, so nobody has to guess which of the three will find what
 * they are looking for.
 */
export const dynamic = 'force-dynamic';
/**
 * Long enough to embed the query and run three searches.
 *
 * Turning the words into a vector is a call to a model, and the platform's
 * default allows less time than that plus three queries can take. A request
 * killed for running too long comes back with nothing anybody can read.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  return withDriveScope(async (scope) => {
    const params = new URL(request.url).searchParams;
    const files = await findEverything(scope, params.get('q') ?? '');
    return Response.json({ files }, { headers: noStore });
  });
}
