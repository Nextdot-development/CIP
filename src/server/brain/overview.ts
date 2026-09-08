import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';

/**
 * What this company has actually taught CIP.
 *
 * Every number here is counted from a table at the moment it is asked for.
 * None of it is a stored percentage or a seeded figure: the pages that show
 * "how full is my knowledge base" used to read a `brand_profiles.understanding_pct`
 * that a seed had written and nothing ever updated, so a company that had
 * uploaded nothing and one that had uploaded a hundred files showed the same
 * number.
 *
 * Read once on the server so a page arrives with real figures rather than
 * spinners.
 */

export type KnowledgeOverview = {
  /** Files in the Drive, and how far each has got. */
  files: {
    total: number;
    understood: number;
    waiting: number;
    failed: number;
    /** Kinds present, largest first, for "what kind of knowledge is in here". */
    byKind: { kind: string; count: number; understood: number }[];
  };
  /** What was learned from them. */
  learned: {
    facts: number;
    /** Facts with enough evidence behind them to be stated rather than guessed. */
    derived: number;
    posts: number;
    lessons: number;
  };
  /** Where it came from. */
  sources: {
    uploaded: number;
    googleDrive: number;
    driveConnected: boolean;
    driveFolder: string | null;
    lastSyncAt: string | null;
  };
  /** Nothing has been taught yet. Worth its own state rather than a row of zeroes. */
  empty: boolean;
};

export async function knowledgeOverview(scope: CompanyScope): Promise<KnowledgeOverview> {
  return withCompanyScope(scope, async (tx) => {
    const [totals] = await tx<
      {
        total: number; understood: number; waiting: number; failed: number;
        uploaded: number; google: number;
      }[]
    >`
      select
        count(*)::int                                                   as total,
        count(*) filter (where u.status = 'ready')::int                 as understood,
        count(*) filter (where u.status is null
                            or u.status in ('pending', 'processing'))::int as waiting,
        count(*) filter (where u.status = 'failed')::int                as failed,
        count(*) filter (where f.source_type = 'cip_drive')::int        as uploaded,
        count(*) filter (where f.source_type = 'google_drive')::int     as google
      from drive_files f
      left join lateral (
        select status from asset_understanding
         where file_id = f.id and company_id = f.company_id
         order by updated_at desc limit 1
      ) u on true
      where f.company_id = ${scope.companyId} and f.archived_at is null
    `;

    // Grouped by what a person would call it, not by mime type.
    const kinds = await tx<{ kind: string; count: number; understood: number }[]>`
      select
        case
          when f.file_type in ('png', 'jpg', 'jpeg', 'gif', 'webp') then 'Images'
          when f.file_type in ('mp4', 'mov', 'webm', 'mkv')         then 'Video'
          when f.file_type = 'pdf'                                   then 'PDFs'
          when f.file_type in ('mp3', 'wav')                         then 'Audio'
          else 'Documents'
        end as kind,
        count(*)::int as count,
        count(*) filter (where u.status = 'ready')::int as understood
      from drive_files f
      left join lateral (
        select status from asset_understanding
         where file_id = f.id and company_id = f.company_id
         order by updated_at desc limit 1
      ) u on true
      where f.company_id = ${scope.companyId} and f.archived_at is null
      group by 1
      order by 2 desc
    `;

    const [learned] = await tx<
      { facts: number; derived: number; posts: number; lessons: number }[]
    >`
      select
        (select count(*)::int from brand_dna_facts
          where company_id = ${scope.companyId} and status = 'active')      as facts,
        (select count(*)::int from brand_dna_facts
          where company_id = ${scope.companyId} and kind = 'derived')       as derived,
        (select count(*)::int from pdf_post
          where company_id = ${scope.companyId})                            as posts,
        (select count(*)::int from brain_lessons
          where company_id = ${scope.companyId})                            as lessons
    `;

    const connection = await tx<
      { status: string; folder_name: string | null; last_sync_at: Date | null }[]
    >`
      select status, folder_name, last_sync_at
        from google_drive_connections where company_id = ${scope.companyId}
    `;

    const files = {
      total: totals?.total ?? 0,
      understood: totals?.understood ?? 0,
      waiting: totals?.waiting ?? 0,
      failed: totals?.failed ?? 0,
      byKind: kinds,
    };

    return {
      files,
      learned: {
        facts: learned?.facts ?? 0,
        derived: learned?.derived ?? 0,
        posts: learned?.posts ?? 0,
        lessons: learned?.lessons ?? 0,
      },
      sources: {
        uploaded: totals?.uploaded ?? 0,
        googleDrive: totals?.google ?? 0,
        driveConnected: connection[0]?.status === 'connected',
        driveFolder: connection[0]?.folder_name ?? null,
        lastSyncAt: connection[0]?.last_sync_at?.toISOString() ?? null,
      },
      empty: files.total === 0,
    };
  });
}
