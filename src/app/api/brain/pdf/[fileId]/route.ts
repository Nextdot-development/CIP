import { noStore, withBrainScope } from '@/server/brain/http';
import { readPdfPages } from '@/server/brain/pdfVisual';

type Params = { params: Promise<{ fileId: string }> };

export const dynamic = 'force-dynamic';

/**
 * GET /api/brain/pdf/[fileId]
 *
 * Everything the visual pass recorded for one PDF: page by page, and the posts
 * found on each. This is what makes a claim checkable — a fact says it came
 * from page 7, and page 7 can be looked at.
 *
 * Another company's file id returns an empty result rather than a 403, exactly
 * as elsewhere, so ids cannot be probed for existence.
 */
export async function GET(_request: Request, { params }: Params) {
  return withBrainScope(async (scope) => {
    const { fileId } = await params;
    const { pages, posts } = await readPdfPages(scope, fileId);

    return Response.json(
      {
        // The page image is addressed by page id through the scoped route
        // below. No storage path ever reaches a client.
        pages: pages.map((page) => ({ ...page, imageUrl: `/api/brain/pdf/page/${page.id}` })),
        posts,
      },
      { headers: noStore },
    );
  });
}
