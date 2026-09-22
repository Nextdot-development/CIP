import { requireSession } from '@/server/auth/guards';
import { activeBrand } from '@/server/brain/activeBrand';
import { companyMarkets } from '@/server/brain/markets';
import { coverageFor } from '@/server/brain/qc';
import { brainStatus } from '@/server/brain/providers';
import { withCompanyScope } from '@/server/db';
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

  const [lens, markets, held] = await Promise.all([
    activeBrand(scope),
    companyMarkets(scope),
    /**
     * What CIP already holds that can be checked.
     *
     * Offered beside the dropzone because an upload through the site carries at
     * most 4.5 MB - the hosting platform's limit, not CIP's - and a deck is
     * routinely larger. A file that is already here never went through that
     * limit and can be checked whatever its size.
     */
    withCompanyScope(scope, (tx) =>
      tx<{ id: string; name: string; mime_type: string; file_size: number }[]>`
        select id, name, mime_type, file_size
          from drive_files
         where company_id = ${scope.companyId}
           and archived_at is null
           and lower(mime_type) in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')
         order by created_at desc
         limit 200
      `,
    ),
  ]);
  const coverage = await coverageFor(scope, { brand: lens.active, market: null });

  return (
    <QcSection
      configured={brainStatus().configured}
      brands={lens.brands.map((b) => b.name)}
      activeBrand={lens.active}
      markets={markets.map((m) => m.market)}
      coverage={coverage}
      held={held.map((f) => ({
        id: f.id,
        name: f.name,
        isPdf: f.mime_type.toLowerCase() === 'application/pdf',
        sizeMb: Number((f.file_size / 1024 / 1024).toFixed(1)),
      }))}
    />
  );
}
