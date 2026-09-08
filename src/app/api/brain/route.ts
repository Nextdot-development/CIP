import { noStore, withBrainScope } from '@/server/brain/http';
import { brainStatus } from '@/server/brain/providers';
import { readBrandDna } from '@/server/brain/brandDna';
import { readFeedback, readLessons } from '@/server/brain/learning';
import { withCompanyScope } from '@/server/db';
import { ffmpegAvailable } from '@/server/brain/media';

/**
 * GET /api/brain
 *
 * What the Brain knows about the caller's own company, and how well set up it
 * is. Counts are read from the company's rows, never stored or estimated.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return withBrainScope(async (scope) => {
    const counts = await withCompanyScope(scope, async (tx) => {
      const rows = await tx<
        {
          understood: number; pending: number; failed: number; unsupported: number;
          facts: number; derived: number; lessons: number; confirmed: number;
          feedback: number; briefs: number; assets: number;
        }[]
      >`
        select
          (select count(*)::int from asset_understanding where status = 'ready')       as understood,
          (select count(*)::int from asset_understanding where status = 'pending')     as pending,
          (select count(*)::int from asset_understanding where status = 'failed')      as failed,
          (select count(*)::int from asset_understanding where status = 'unsupported') as unsupported,
          (select count(*)::int from brand_dna_facts where status = 'active')          as facts,
          (select count(*)::int from brand_dna_facts where kind = 'derived')           as derived,
          (select count(*)::int from brain_lessons)                                    as lessons,
          (select count(*)::int from brain_lessons where status = 'confirmed')         as confirmed,
          (select count(*)::int from generation_feedback)                              as feedback,
          (select count(*)::int from generation_briefs)                                as briefs,
          (select count(*)::int from drive_files where archived_at is null)            as assets
      `;
      return rows[0]!;
    });

    const [topFacts, recentLessons, recentFeedback] = await Promise.all([
      readBrandDna(scope, { limit: 8, minEvidence: 1 }),
      readLessons(scope, { limit: 8 }),
      readFeedback(scope, 8),
    ]);

    return Response.json(
      {
        provider: brainStatus(),
        video: { ffmpeg: await ffmpegAvailable() },
        counts,
        topFacts,
        recentLessons,
        recentFeedback,
        // Honest emptiness: a company with nothing analysed says so rather than
        // showing an encouraging-looking dashboard of zeroes.
        empty: counts.understood === 0 && counts.facts === 0,
      },
      { headers: noStore },
    );
  });
}
