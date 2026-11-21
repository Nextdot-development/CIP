import { requireSession } from '@/server/auth/guards';
import { listGenerations } from '@/server/media/generation';
import { providerStatus } from '@/server/media/providers';
import { companyMarkets } from '@/server/brain/markets';
import { AskSection } from '@/sections/AskSection';
import { IdeationPanel } from '@/sections/IdeationPanel';
import { ClientBriefs } from '@/sections/ClientBriefs';
import { clientBriefs } from '@/server/brain/clientBriefs';
import { activeBrand } from '@/server/brain/activeBrand';
import { brainStatus } from '@/server/brain/providers';
import { brandMarkets, brandPacks } from '@/server/brain/packs';

export const metadata = { title: 'Campaign Ideation — CIP' };
export const dynamic = 'force-dynamic';

/**
 * Loaded for the session's own company: there is no company parameter to pass
 * and none to forget. What has already been made arrives with the page so the
 * history is there before the first render rather than after a fetch.
 */
export default async function AskPage() {
  const session = await requireSession();

  const { active, brands } = await activeBrand(session.scope);
  const markets = (await companyMarkets(session.scope)).map((m) => m.market);

  return (
    <AskSection
      ideation={
        <>
          <ClientBriefs briefs={await clientBriefs(session.scope)} />
          <IdeationPanel brand={active} configured={brainStatus().configured} />
        </>
      }
      initial={(await listGenerations(session.scope, { limit: 30 })).generations}
      providers={providerStatus()}
      markets={markets}
      brandMarkets={await brandMarkets(session.scope, markets)}
      brands={brands.map((b) => b.name)}
      packs={await brandPacks(session.scope)}
      activeBrand={active}
    />
  );
}
