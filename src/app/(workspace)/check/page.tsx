import { requireSession } from '@/server/auth/guards';
import { listChecks, listRules } from '@/server/brain/checker';
import { companyBrands } from '@/server/brain/brands';
import { companyMarkets } from '@/server/brain/markets';
import { brainStatus } from '@/server/brain/providers';
import { withCompanyScope } from '@/server/db';
import { CheckSection } from '@/sections/CheckSection';

export const metadata = { title: 'Consistency Check — CIP' };
export const dynamic = 'force-dynamic';

/**
 * The Consistency & Compliance Checker.
 *
 * Loaded on the server for the session's own company, so the page arrives with
 * its images, its rules and its recent checks rather than a row of spinners.
 * The images are read here directly rather than through the Drive listing,
 * because the checker only ever wants one thing from it: pictures it can judge.
 */
export default async function CheckPage() {
  const session = await requireSession();
  const scope = session.scope;

  const [images, checks, rules, brands, markets] = await Promise.all([
    withCompanyScope(scope, (tx) =>
      tx<{ id: string; name: string; brand: string | null; market: string | null; created_at: Date }[]>`
        select id, name, brand, market, created_at
          from drive_files
         where company_id = ${scope.companyId}
           and archived_at is null
           and lower(mime_type) in ('image/png', 'image/jpeg', 'image/webp')
         order by created_at desc
         limit 120
      `,
    ),
    listChecks(scope, 20),
    listRules(scope),
    companyBrands(scope),
    companyMarkets(scope),
  ]);

  return (
    <CheckSection
      configured={brainStatus().configured}
      images={images.map((image) => ({
        id: image.id,
        name: image.name,
        brand: image.brand,
        market: image.market,
      }))}
      recent={checks}
      rules={rules}
      brands={brands.map((b) => b.name)}
      markets={markets.map((m) => m.market)}
    />
  );
}
