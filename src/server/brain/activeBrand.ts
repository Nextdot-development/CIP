import 'server-only';
import { cookies } from 'next/headers';
import type { CompanyScope } from '../db';
import { companyBrands } from './brands';
import type { Brand } from './brands';

/**
 * Which brand the person is working on.
 *
 * The switcher at the top of the sidebar is a lens, not a permission: every
 * brand in the house is visible to everyone in it. So the choice lives in a
 * cookie, and it is checked against this company's own roster every time it
 * is read - a name left over from another company, or a brand since removed,
 * reads as "all brands" rather than as a filter that matches nothing.
 */
export const ACTIVE_BRAND_COOKIE = 'cip_brand';

export async function activeBrand(
  scope: CompanyScope,
): Promise<{ brands: Brand[]; active: string | null }> {
  const [brands, jar] = await Promise.all([companyBrands(scope), cookies()]);
  const wanted = jar.get(ACTIVE_BRAND_COOKIE)?.value ?? null;
  const active = brands.find((brand) => brand.name === wanted)?.name ?? null;
  return { brands, active };
}
