import { requireSession } from '@/server/auth/guards';
import { activeBrand } from '@/server/brain/activeBrand';
import { companyMarkets } from '@/server/brain/markets';
import { coverageFor } from '@/server/brain/qc';
import { brainStatus } from '@/server/brain/providers';
import { QcSection } from '@/sections/QcSection';

export const metadata = { title: 'Creative QC — CIP' };
export const dynamic = 'force-dynamic';

/**
 * Creative QC.
 *
 * Drop in something that is not in CIP yet - a finished banner, a deck page, a
 * PDF from an agency - and get a verdict before it goes anywhere.
 *
 * How much CIP has to judge against is loaded here and shown at the top, rather
 * than left for the reviewer to infer from a clean report. A check against two
 * rules and a check against forty both print "no problems found", and only one
 * of those is worth anything.
 */
export default async function QcPage() {
  const session = await requireSession();
  const scope = session.scope;

  const [lens, markets] = await Promise.all([activeBrand(scope), companyMarkets(scope)]);
  const coverage = await coverageFor(scope, { brand: lens.active, market: null });

  return (
    <QcSection
      configured={brainStatus().configured}
      brands={lens.brands.map((b) => b.name)}
      activeBrand={lens.active}
      markets={markets.map((m) => m.market)}
      coverage={coverage}
    />
  );
}
