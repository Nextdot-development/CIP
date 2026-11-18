import { requireSession } from '@/server/auth/guards';
import { activeBrand } from '@/server/brain/activeBrand';
import { companyMarkets } from '@/server/brain/markets';
import { withCompanyScope } from '@/server/db';
import { FreeQc } from '@/sections/FreeQc';
import { PostRulesCheck } from '@/sections/PostRulesCheck';
import { listGenerations } from '@/server/media/generation';
import { rulesCheck } from '@/server/media/arrange';

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
           and lower(mime_type) in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp',
                                    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska')
         order by created_at desc
         limit 200
      `,
    ),
  ]);
  // Posts made in the studio, each checked from its own pieces as the page loads - no model, nothing spent.
  const made = await listGenerations(scope, { limit: 40, type: 'image' });
  const posts = (await Promise.all(made.generations
    .filter((g) => g.status === 'completed' && g.layers)
    .slice(0, 12)
    .map(async (g) => {
      const checked = await rulesCheck(scope, g.id).catch(() => null);
      return checked ? { id: g.id, prompt: g.prompt, brand: checked.brand, market: checked.market, verdicts: checked.verdicts } : null;
    })))
    .filter((p): p is NonNullable<typeof p> => p !== null);

  return (
    <div className="rise">
      <PostRulesCheck posts={posts} />
      <FreeQc
        brands={lens.brands.map((b) => b.name)}
        activeBrand={lens.active}
        markets={markets.map((m) => m.market)}
        held={held.map((f) => ({
          id: f.id,
          name: f.name,
          kind: f.mime_type.toLowerCase() === 'application/pdf' ? 'PDF' : f.mime_type.toLowerCase().startsWith('video/') ? 'video' : 'image',
        }))}
      />
    </div>
  );
}
