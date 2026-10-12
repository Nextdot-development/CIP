import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { WORDS } from './categoryWords';
import type { Category, LogoCorner } from './categoryWords';

/**
 * What kind of company this is, and the words that follow from it.
 *
 * The machinery is the same for every company: it reads the brand, checks
 * against rules, makes pictures and plans a calendar. What changes is a
 * handful of sentences - what a statutory line is, what may never be
 * promised, what a day to publish nothing for means. They live here, once per
 * category, rather than written into a prompt for a spirits company.
 */

export { WORDS };
export type { Category, LogoCorner };

export type CompanyProfile = {
  name: string;
  category: Category;
  /** Where the approved logo goes on a picture CIP makes. Null: none is placed. */
  logoCorner: LogoCorner | null;
};

const cache = new Map<string, { at: number; profile: CompanyProfile }>();
const CACHE_MS = 60_000;

/** The company's category and settings. Read once a minute at most. */
export async function companyProfile(scope: CompanyScope): Promise<CompanyProfile> {
  const kept = cache.get(scope.companyId);
  if (kept && Date.now() - kept.at < CACHE_MS) return kept.profile;
  const [row] = await withCompanyScope(scope, (tx) => tx<{ name: string; category: Category | null; logo_corner: LogoCorner | null }[]>`
    select name, category, logo_corner from companies where id = ${scope.companyId}
  `);
  const profile: CompanyProfile = {
    name: row?.name ?? '',
    category: row?.category === 'alcohol' || row?.category === 'healthcare' ? row.category : 'general',
    logoCorner: row?.logo_corner ?? null,
  };
  cache.set(scope.companyId, { at: Date.now(), profile });
  return profile;
}

/** Tests change a company's category and need it read again at once. */
export function __forgetCompanyProfiles(): void {
  cache.clear();
}
