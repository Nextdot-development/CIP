import { noStore, withBrainScope } from '@/server/brain/http';
import { withCompanyScope } from '@/server/db';

/**
 * GET /api/brain/pdf
 *
 * Every PDF this company has, and how far the visual pass got with each.
 *
 * Company scoped through withBrainScope: there is no parameter here that could
 * widen it, and a file id belonging to another company simply is not in the
 * result rather than being refused — same reason as everywhere else, so ids
 * cannot be probed.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return withBrainScope(async (scope) => {
    const rows = await withCompanyScope(scope, async (tx) =>
      tx<
        {
          file_id: string; name: string; file_size: string; created_at: Date;
          understanding_status: string | null; kind: string | null;
          error_message: string | null; structured: Record<string, unknown> | null;
          pages_total: number; pages_ready: number; pages_failed: number;
          pages_with_text: number; posts: number; duration_ms: number | null;
        }[]
      >`
        select f.id as file_id, f.name, f.file_size, f.created_at,
               u.status as understanding_status, u.kind, u.error_message, u.structured,
               coalesce(p.total, 0)      as pages_total,
               coalesce(p.ready, 0)      as pages_ready,
               coalesce(p.failed, 0)     as pages_failed,
               coalesce(p.with_text, 0)  as pages_with_text,
               coalesce(p.posts, 0)      as posts,
               p.duration_ms
          from drive_files f
          left join lateral (
            select u2.status, u2.kind, u2.error_message, u2.structured
              from asset_understanding u2
             where u2.file_id = f.id and u2.company_id = f.company_id
             order by u2.updated_at desc
             limit 1
          ) u on true
          left join lateral (
            select count(*)::int                                        as total,
                   count(*) filter (where pp.status = 'ready')::int     as ready,
                   count(*) filter (where pp.status = 'failed')::int    as failed,
                   count(*) filter (where pp.has_text_layer)::int       as with_text,
                   coalesce(sum(pp.posts_detected), 0)::int             as posts,
                   sum(pp.duration_ms)::int                             as duration_ms
              from pdf_page_understanding pp
             where pp.file_id = f.id and pp.company_id = f.company_id
          ) p on true
         where f.company_id = ${scope.companyId}
           and f.file_type = 'pdf'
           and f.archived_at is null
         order by f.created_at desc
         limit 100
      `,
    );

    return Response.json(
      {
        // No storage path and no company id: a file is addressed by its id
        // through this same scoped route, exactly like a Drive file.
        pdfs: rows.map((row) => ({
          fileId: row.file_id,
          name: row.name,
          fileSize: Number(row.file_size),
          uploadedAt: row.created_at.toISOString(),
          status: row.understanding_status ?? 'not queued',
          kind: row.kind,
          error: row.error_message,
          pageCount: Number((row.structured as { pageCount?: number } | null)?.pageCount ?? 0),
          pagesProcessed: row.pages_total,
          pagesUnderstood: row.pages_ready,
          pagesFailed: row.pages_failed,
          pagesWithText: row.pages_with_text,
          postsDetected: row.posts,
          processingMs: row.duration_ms,
        })),
      },
      { headers: noStore },
    );
  });
}
