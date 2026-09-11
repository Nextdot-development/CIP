import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';

/**
 * Which brand a piece of knowledge is about.
 *
 * A house with several brands does not have one voice. Radico Khaitan's own
 * brief puts it plainly — "do not allow all brands to collapse into the same
 * vocabulary" — and it is right: Whytehall is regal and restrained, Magic
 * Moments is playful and loud, and a brief drawn from both is neither.
 *
 * This is the market problem one level up, with one difference that changes
 * the design. A market can be read off a file: India.pdf is India's. A brand
 * cannot — a context document describes nine of them in one upload — so the
 * brand belongs to the fact rather than the file, and is attributed by the
 * model already reading the asset.
 *
 * A company with no roster behaves exactly as it did before: every fact is
 * null, nothing is filtered, and nothing asks.
 */

export type Brand = {
  name: string;
  note: string | null;
  /** Facts attributed to it. */
  facts: number;
};

/** The brands this company works on, in the order it put them. */
export async function companyBrands(scope: CompanyScope): Promise<Brand[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ name: string; note: string | null; facts: number }[]>`
      select b.name, b.note,
             count(f.id) filter (where f.status = 'active')::int as facts
        from company_brands b
        left join brand_dna_facts f
          on f.company_id = b.company_id and f.brand = b.name
       where b.company_id = ${scope.companyId}
       group by b.name, b.note, b.position
       order by b.position, b.name
    `;
    return rows;
  });
}

/** Just the names, for handing to a model as a closed list. */
export async function brandNames(scope: CompanyScope): Promise<string[]> {
  const brands = await companyBrands(scope);
  return brands.map((b) => b.name);
}

/**
 * The brand a request names, if it names one this company has.
 *
 * Longest name first, so "Whytehall Honey" wins over "Whytehall" — otherwise
 * every flavour would resolve to the parent and lose exactly the distinction
 * that matters.
 */
export function brandInRequest(requestText: string, brands: readonly string[]): string | null {
  const text = requestText.toLowerCase();

  const byLength = [...brands].sort((a, b) => b.length - a.length);
  for (const brand of byLength) {
    if (text.includes(brand.toLowerCase())) return brand;
  }

  return null;
}

/**
 * Puts a name onto the roster, or leaves it alone.
 *
 * Matched case-insensitively so "whytehall" does not become a second
 * Whytehall. What comes back is the name as the roster spells it, which is the
 * one every fact should be filed under.
 */
export function normaliseBrand(value: unknown, brands: readonly string[]): string | null {
  if (typeof value !== 'string') return null;

  const candidate = value.trim();
  if (candidate.length === 0) return null;

  const match = brands.find((brand) => brand.toLowerCase() === candidate.toLowerCase());
  return match ?? null;
}

/** Adds a brand to the roster. Idempotent: the same name twice is once. */
export async function addBrand(
  scope: CompanyScope,
  input: { name: string; note?: string | null; position?: number },
): Promise<void> {
  const name = input.name.trim().slice(0, 80);
  if (name.length === 0) return;

  await withCompanyScope(scope, async (tx) => {
    await tx`
      insert into company_brands (company_id, name, note, position)
      values (${scope.companyId}, ${name}, ${input.note?.trim() || null}, ${input.position ?? 0})
      on conflict (company_id, name) do update
         set note = coalesce(excluded.note, company_brands.note),
             position = excluded.position
    `;
  });
}

/** Takes a brand off the roster. Facts already filed under it keep their name. */
export async function removeBrand(scope: CompanyScope, name: string): Promise<void> {
  await withCompanyScope(scope, async (tx) => {
    await tx`
      delete from company_brands
       where company_id = ${scope.companyId} and name = ${name}
    `;
  });
}
