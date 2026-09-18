import { requireSession } from '@/server/auth/guards';
import { knowledgeOverview } from '@/server/brain/overview';
import { knowledgeGraph } from '@/server/knowledge/graph';
import { brainStatus } from '@/server/brain/providers';
import { readBrandDna } from '@/server/brain/brandDna';
import { readFeedback, readLessons } from '@/server/brain/learning';
import { ffmpegAvailable } from '@/server/brain/media';
import { activeBrand } from '@/server/brain/activeBrand';
import { productBrain } from '@/server/brain/productBrain';
import { sharedTraits } from '@/server/brain/relations';
import { withCompanyScope } from '@/server/db';
import { TrustSection } from '@/sections/TrustSection';

export const metadata = { title: 'Brand Brain — CIP' };
export const dynamic = 'force-dynamic';

/**
 * The Brand Brain, loaded on the server so the page arrives with real numbers
 * rather than spinners.
 *
 * Two views of the same knowledge. The Product Brain is one brand - the one
 * chosen in the sidebar - and the Company Brain is the whole house and what
 * its brands have in common. Loaded for the session's own company: there is
 * no company parameter to pass and none to forget.
 */
export default async function TrustPage() {
  const session = await requireSession();
  const scope = session.scope;
  const { brands, active } = await activeBrand(scope);

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

  const [overview, graph, facts, lessons, feedback, ffmpeg, product, traits] = await Promise.all([
    knowledgeOverview(scope),
    knowledgeGraph(scope),
    // "What it learned" follows the brand in the sidebar, like the graph above it.
    readBrandDna(scope, { brand: active, limit: 120, minEvidence: 1 }),
    readLessons(scope, { limit: 60 }),
    readFeedback(scope, 40),
    ffmpegAvailable(),
    productBrain(scope, active),
    sharedTraits(scope, 40),
  ]);

  return (
    <TrustSection
      overview={overview}
      graph={graph}
      product={product}
      company={{ brands: brands.length, assets: counts.assets, traits }}
      brain={{
        provider: brainStatus(),
        video: { ffmpeg },
        counts,
        topFacts: facts,
        recentLessons: lessons,
        recentFeedback: feedback,
        empty: counts.understood === 0 && counts.facts === 0,
      }}
    />
  );
}
