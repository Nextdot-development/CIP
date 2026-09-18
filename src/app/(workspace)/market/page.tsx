import { requireSession } from '@/server/auth/guards';
import { activeBrand } from '@/server/brain/activeBrand';
import { marketOverview } from '@/server/brain/market';
import { brainStatus } from '@/server/brain/providers';
import { MarketSection } from '@/sections/MarketSection';

export const metadata = { title: 'Market Intelligence — CIP' };
export const dynamic = 'force-dynamic';

/**
 * Competitive & Market Intelligence, from the reports the company adds.
 *
 * Loaded for the brand in the sidebar: its own numbers, its competitors' and
 * the category's, and not a sibling brand's.
 */
export default async function MarketPage() {
  const session = await requireSession();
  const { active } = await activeBrand(session.scope);
  const overview = await marketOverview(session.scope, { brand: active });

  return (
    <MarketSection
      configured={brainStatus().configured}
      brand={active}
      sources={overview.sources}
      signals={overview.signals}
    />
  );
}
