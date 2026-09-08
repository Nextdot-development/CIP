import { noStore, withBrainScope } from '@/server/brain/http';
import { searchMemory } from '@/server/brain/retrieval';
import { withCompanyScope } from '@/server/db';

/**
 * GET /api/brain/memory?q=
 *
 * Searches what the Brain understands about this company's assets. Company
 * scoped: there is no parameter that could widen it.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return withBrainScope(async (scope) => {
    const term = new URL(request.url).searchParams.get('q')?.trim() ?? '';

    if (term.length === 0) {
      // No query: the most recently understood assets, so the view is not empty.
      const recent = await withCompanyScope(scope, async (tx) =>
        tx<{ file_id: string; name: string; file_type: string; summary: string; kind: string }[]>`
          select u.file_id, f.name, f.file_type, u.summary, u.kind
            from asset_understanding u
            join drive_files f on f.id = u.file_id
           where u.status = 'ready' and f.archived_at is null
           order by u.updated_at desc
           limit 40
        `,
      );
      return Response.json(
        {
          memory: recent.map((r) => ({
            fileId: r.file_id, fileName: r.name, fileType: r.file_type,
            summary: r.summary, kind: r.kind,
          })),
        },
        { headers: noStore },
      );
    }

    const results = await searchMemory(scope, term);
    return Response.json(
      {
        memory: results.map((r) => ({
          fileId: r.fileId, fileName: r.fileName, fileType: r.fileType, summary: r.summary,
        })),
      },
      { headers: noStore },
    );
  });
}
