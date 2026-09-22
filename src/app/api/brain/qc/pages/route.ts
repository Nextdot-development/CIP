import { noStore, withBrainScope } from '@/server/brain/http';
import { pageCountFor } from '@/server/brain/qc';

/**
 * /api/brain/qc/pages?fileId=
 *
 * How many pages there are to check, before any of them is checked.
 *
 * A deck is checked a page at a time, one request each, so the page doing the
 * asking has to know how many requests that is. It also means the reviewer can
 * be told "page 3 of 14" while it runs rather than watching a spinner that
 * could mean anything.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return withBrainScope(async (scope) => {
    const fileId = new URL(request.url).searchParams.get('fileId')?.trim() ?? '';
    const pages = await pageCountFor(scope, fileId);
    return Response.json({ pages }, { headers: noStore });
  });
}
