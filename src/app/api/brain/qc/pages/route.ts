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
/**
 * Long enough to fetch a document and count its pages.
 *
 * No model is called here, but a deck is downloaded out of the object store and
 * parsed, and the platform's default allows far less than that takes. A request
 * that runs out of time is killed with no error anybody can read.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  return withBrainScope(async (scope) => {
    const fileId = new URL(request.url).searchParams.get('fileId')?.trim() ?? '';
    const pages = await pageCountFor(scope, fileId);
    return Response.json({ pages }, { headers: noStore });
  });
}
