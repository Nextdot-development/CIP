import { requireSession } from '@/server/auth/guards';
import { listGenerations } from '@/server/media/generation';
import { providerStatus } from '@/server/media/providers';
import { companyMarkets } from '@/server/brain/markets';
import { AskSection } from '@/sections/AskSection';
import { IdeationPanel } from '@/sections/IdeationPanel';
import { activeBrand } from '@/server/brain/activeBrand';
import { brainStatus } from '@/server/brain/providers';

export const metadata = { title: 'Campaign Ideation — CIP' };
export const dynamic = 'force-dynamic';

/**
 * Loaded for the session's own company: there is no company parameter to pass
 * and none to forget. What has already been made arrives with the page so the
 * history is there before the first render rather than after a fetch.
 */
export default async function AskPage() {
  const session = await requireSession();

  const { active } = await activeBrand(session.scope);

  return (
    <AskSection
      ideation={<IdeationPanel brand={active} configured={brainStatus().configured} />}
      initial={(await listGenerations(session.scope, { limit: 30 })).generations}
      providers={providerStatus()}
      markets={(await companyMarkets(session.scope)).map((m) => m.market)}
    />
  );
}
