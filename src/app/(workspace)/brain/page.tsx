import { requireSession } from '@/server/auth/guards';
import { brainStatus } from '@/server/brain/providers';
import { readBrandDna } from '@/server/brain/brandDna';
import { readFeedback, readLessons } from '@/server/brain/learning';
import { ffmpegAvailable } from '@/server/brain/media';
import { withCompanyScope } from '@/server/db';
import { BrainSection } from '@/sections/BrainSection';

export const metadata = { title: 'Brain — CIP' };
export const dynamic = 'force-dynamic';

/**
 * Rendered on the server so the page arrives with real numbers rather than
 * spinners. Loaded for the session's own company: there is no company
 * parameter to pass and none to forget.
 */
export default async function BrainPage() {
  const session = await requireSession();
  const scope = session.scope;

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

  const [facts, lessons, feedback] = await Promise.all([
    readBrandDna(scope, { limit: 120, minEvidence: 1 }),
    readLessons(scope, { limit: 60 }),
    readFeedback(scope, 40),
  ]);

  return (
    <BrainSection
      initial={{
        provider: brainStatus(),
        video: { ffmpeg: await ffmpegAvailable() },
        counts,
        topFacts: facts,
        recentLessons: lessons,
        recentFeedback: feedback,
        empty: counts.understood === 0 && counts.facts === 0,
      }}
    />
  );
}
