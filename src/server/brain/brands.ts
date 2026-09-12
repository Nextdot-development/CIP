import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';

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
  /**
   * The other names this brand appears under.
   *
   * A brand is rarely written down as its own name. Rampur's bottles arrive
   * called Asava_Bottle.png and Jugalbandi_5_Bottle.png — expressions of
   * Rampur, none of them containing the word. Without these, that knowledge
   * is attributed to nobody and ends up in the pool that competes with every
   * other brand's own brief.
   */
  aliases: string[];
  /** Facts attributed to it. */
  facts: number;
};

/** The brands this company works on, in the order it put them. */
export async function companyBrands(scope: CompanyScope): Promise<Brand[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ name: string; note: string | null; aliases: string[] | null; facts: number }[]>`
      select b.name, b.note, b.aliases,
             count(f.id) filter (where f.status = 'active')::int as facts
        from company_brands b
        left join brand_dna_facts f
          on f.company_id = b.company_id and f.brand = b.name
       where b.company_id = ${scope.companyId}
       group by b.name, b.note, b.aliases, b.position
       order by b.position, b.name
    `;
    return rows.map((row) => ({ ...row, aliases: row.aliases ?? [] }));
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
 * The brand a piece of text is about, including the other names it goes by.
 *
 * The same longest-first rule, over names and aliases together, so "Whytehall
 * Honey" still beats "Whytehall" and "Rampur Asava" still beats "Asava". Used
 * wherever a filename or a request has to be resolved to a brand and the
 * brand's own name may not appear in it at all.
 *
 * Two different brands matching means no match, exactly as for markets: a file
 * called "rampur-and-jaisalmer.png" is about both and belongs to neither, and
 * picking one would file its knowledge under the wrong half.
 */
export function brandForText(text: string, brands: readonly Brand[]): string | null {
  const haystack = text.toLowerCase();

  // Every name a brand answers to, longest first so the most specific wins.
  const needles: { needle: string; brand: string }[] = [];
  for (const brand of brands) {
    needles.push({ needle: brand.name.toLowerCase(), brand: brand.name });
    for (const alias of brand.aliases) needles.push({ needle: alias, brand: brand.name });
  }
  needles.sort((a, b) => b.needle.length - a.needle.length);

  // Longest first, and a match swallows the stretch of text it used. Without
  // that, "WHYTEHALL HONEY Logo.png" matches both Whytehall Honey and
  // Whytehall and looks like two brands — when the second is only the first
  // one's own name showing through. The specific match consumes the span, so
  // the general one has nothing left to match on.
  const consumed: { start: number; end: number }[] = [];
  const matched = new Set<string>();

  for (const { needle, brand } of needles) {
    const at = haystack.indexOf(needle);
    if (at < 0) continue;

    const inside = consumed.some((span) => at >= span.start && at + needle.length <= span.end);
    if (inside) continue;

    consumed.push({ start: at, end: at + needle.length });
    matched.add(brand);
  }

  // One brand's own sub-names collapsing to itself is a single match, which is
  // the point: "Rampur Asava" hits both and still means Rampur. Two different
  // brands is no match at all.
  return matched.size === 1 ? [...matched][0]! : null;
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

/**
 * Labels files with the brand their name says they are about.
 *
 * A reference image has to be filterable before it is handed to a generator,
 * and the facts derived from a file are not enough — the file itself is what
 * gets attached. So the brand is stored on the file, derived from its name
 * against this company's roster and the other names those brands go by.
 *
 * Deterministic and free: no model is asked anything. A name that names two
 * brands, or none, is left null and reaches every brand, which is the same
 * rule the facts follow.
 *
 * Runs on every worker pass, so a file that arrives after a brand is added to
 * the roster is labelled the next time round rather than staying anonymous
 * for ever.
 */
export async function suggestBrands(scope: CompanyScope): Promise<number> {
  const roster = await companyBrands(scope);
  if (roster.length === 0) return 0;

  return withCompanyScope(scope, async (tx) => {
    const unlabelled = await tx<{ id: string; name: string }[]>`
      select id, name from drive_files
       where company_id = ${scope.companyId}
         and archived_at is null
         and brand is null
       limit 2000
    `;

    let labelled = 0;
    for (const file of unlabelled) {
      const brand = brandForText(file.name, roster);
      if (!brand) continue;

      await tx`
        update drive_files set brand = ${brand}, updated_at = now()
         where id = ${file.id} and company_id = ${scope.companyId}
      `;
      labelled += 1;
    }
    return labelled;
  });
}

/** Sets, or clears, which brand a file is about. */
export async function setFileBrand(
  scope: CompanyScope,
  fileId: string,
  brand: string | null,
): Promise<boolean> {
  const roster = await brandNames(scope);
  const resolved = brand === null ? null : normaliseBrand(brand, roster);
  if (brand !== null && resolved === null) return false;

  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update drive_files set brand = ${resolved}, updated_at = now()
       where id = ${fileId} and company_id = ${scope.companyId}
      returning id
    `;
    return rows.length > 0;
  });
}

/**
 * Labels files across every company.
 *
 * The worker has no session to derive a scope from, exactly as with
 * understanding, so it walks the companies and scopes each one properly.
 */
export async function suggestBrandsEverywhere(): Promise<number> {
  const sql = adminSql();
  let companies: { id: string }[];
  try {
    companies = await sql<{ id: string }[]>`select id from companies`;
  } finally {
    await sql.end();
  }

  let labelled = 0;
  for (const company of companies) {
    labelled += await suggestBrands({
      companyId: company.id,
      userId: '00000000-0000-0000-0000-000000000000',
      role: 'owner',
    });
  }
  return labelled;
}

/** Adds a brand to the roster. Idempotent: the same name twice is once. */
export async function addBrand(
  scope: CompanyScope,
  input: { name: string; note?: string | null; position?: number; aliases?: readonly string[] },
): Promise<void> {
  const name = input.name.trim().slice(0, 80);
  if (name.length === 0) return;

  // Lower-cased and de-duplicated here, because this is the one place a name
  // enters the roster and matching is case-insensitive everywhere it is used.
  const aliases = [
    ...new Set(
      (input.aliases ?? [])
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.length > 1 && a !== name.toLowerCase()),
    ),
  ];

  await withCompanyScope(scope, async (tx) => {
    await tx`
      insert into company_brands (company_id, name, note, position, aliases)
      values (${scope.companyId}, ${name}, ${input.note?.trim() || null},
              ${input.position ?? 0}, ${aliases})
      on conflict (company_id, name) do update
         set note = coalesce(excluded.note, company_brands.note),
             position = excluded.position,
             -- Aliases are replaced rather than merged when any are given, so
             -- removing one is possible; leaving them out keeps what is there.
             aliases = case when cardinality(excluded.aliases) > 0
                            then excluded.aliases else company_brands.aliases end
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
