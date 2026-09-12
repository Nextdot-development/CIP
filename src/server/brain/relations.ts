import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';

/**
 * How a company's brands relate to each other.
 *
 * A house of fifteen brands is not fifteen unrelated things. Whytehall Honey
 * and Magic Moments Remix are both flavoured; Rampur and Jaisalmer sell into
 * the same markets; several sit at the same price. Somebody who knows the
 * portfolio knows this, and CIP did not — every brand was an island.
 *
 * Nothing here is told what a flavour is, or which brands are premium. The
 * dimensions are the attribute names the Brain itself chose while reading the
 * assets — flavour, productType, liquid colour, typographic style — plus the
 * markets the files came from. A trait is something a brand was demonstrably
 * described as. Two brands relate through the traits they share.
 *
 * Which means it learns. Feed a new bottle shot and the traits change; add a
 * brand and the whole roster re-weighs itself. Nobody maintains a taxonomy,
 * because there is no taxonomy to maintain.
 *
 * Weighted by rarity, which is the part that makes it useful rather than
 * noise. "flavour: honey" held by two brands out of fifteen says a great
 * deal. "background: black" held by all fifteen says nothing at all, and
 * unweighted it would say the loudest of anything, because it appears most.
 *
 * A relation is never a fact about a brand. It says Rampur and Jaisalmer are
 * alike; it never says Rampur is what Jaisalmer looks like. Letting a brand
 * borrow its neighbour's look is the exact failure the roster exists to
 * prevent, and the whole of the brand boundary would be undone by doing it
 * here quietly.
 */

/** One thing a brand demonstrably is. */
export type BrandTrait = {
  kind: string;
  value: string;
  evidenceCount: number;
};

/** Two brands, how alike, and why. */
export type BrandRelation = {
  brand: string;
  other: string;
  score: number;
  shared: { kind: string; value: string }[];
};

/**
 * Attributes too generic to relate two brands by.
 *
 * Rarity weighting handles most of this on its own — a trait every brand has
 * ends up weighing almost nothing. These are the ones that are *usually*
 * generic but occasionally rare by accident, where a coincidence would be
 * given far more weight than it deserves. Two brands that happen to be the
 * only ones photographed on white are not thereby related.
 */
const NOT_A_RELATION = new Set([
  'background', 'background colour', 'background color', 'backdrop',
  'lighting', 'composition', 'image quality', 'resolution', 'file type',
  'orientation', 'aspect ratio',
]);

/** A value two brands can be compared on, or null if it is not one. */
function normaliseValue(raw: string): string | null {
  const value = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s&/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // A one-word value is usually a colour and a very long one is usually a
  // sentence about a single asset. Neither compares well across brands: the
  // first matches by accident, the second never matches at all.
  if (value.length < 3 || value.length > 60) return null;
  return value;
}

/**
 * Words that carry no information about which brand this is.
 *
 * Function words, and the vocabulary a vision model uses to describe
 * anything at all - "appears", "visible", "centered". Rarity weighting would
 * give most of them almost nothing anyway; they are dropped outright because
 * they are numerous, and a hundred worthless terms per brand drown the
 * handful of real ones in the length each brand is measured by.
 *
 * Words about spirits - bottle, label, whisky, gold - are deliberately NOT
 * here. Whether "whisky" distinguishes anything is a question about this
 * company's roster rather than about English, and the rarity weighting
 * answers it with that company's own numbers.
 */
const NOT_A_TERM = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'than', 'into', 'over', 'from',
  'under', 'above', 'below', 'also', 'such', 'very', 'more', 'most', 'some',
  'each', 'both', 'when', 'where', 'which', 'while', 'their', 'there', 'here',
  'been', 'being', 'have', 'has', 'had', 'are', 'was', 'were', 'will',
  'would', 'could', 'should', 'its', 'his', 'her', 'not', 'but', 'all', 'any',
  'one', 'two', 'three', 'other', 'another', 'same', 'own',
  'text', 'word', 'words', 'image', 'picture', 'photo', 'shows', 'showing',
  'shown', 'seen', 'looks', 'appears', 'appearing', 'contains', 'containing',
  'including', 'placed', 'placement', 'presented', 'presentation', 'visible',
  'large', 'small', 'main', 'left', 'right', 'centre', 'center', 'centered',
  'centred', 'top', 'bottom', 'middle', 'front', 'back', 'side', 'sides',
  'area', 'areas', 'part', 'parts', 'element', 'elements', 'style', 'styling',
  'design', 'overall', 'general', 'clear', 'clearly', 'slight', 'slightly',
  // Added after reading what the first real run produced. Every one of these
  // linked two brands by nothing: "Magic Moments and Morpheus both: displayed,
  // wears, rather". They are frequent enough to collide by accident and rare
  // enough that the rarity weighting cannot catch them.
  'brand', 'brands', 'rather', 'displayed', 'display', 'wears', 'wearing',
  'reads', 'reading', 'smaller', 'larger', 'bigger', 'matching', 'outer',
  'inner', 'across', 'along', 'around', 'near', 'next', 'colour', 'color',
  'colours', 'colors', 'tone', 'tones', 'look', 'feel', 'features',
  'featuring', 'used', 'uses', 'using', 'set', 'sets', 'type', 'types',
  'panel', 'panels', 'boxes', 'holding', 'placed-on', 'sits', 'sitting',
]);

/**
 * The comparable terms in one described attribute.
 *
 * The attribute name is deliberately not one of them. It is the model's own
 * phrasing of what it was looking at, freshly invented each time - the same
 * observation came back as "alcohol strength text", "alcohol strength
 * visible" and "alcohol by volume" - so keying on it meant that across 1231
 * traits on a real roster, not one single trait was held by two brands.
 *
 * The value is kept whole AND broken into words. Whole, because "non-chill
 * filtered" is one thing and three brands said exactly that. In words,
 * because two brands describing the same gold serif wordmark will not phrase
 * the sentence identically, and "gold" and "serif" survive where the whole
 * sentence does not.
 */
function termsIn(rawValue: string): string[] {
  const value = normaliseValue(rawValue);
  if (!value) return [];

  const terms = new Set<string>([value]);
  for (const word of value.split(' ')) {
    if (word.length < 3 || NOT_A_TERM.has(word)) continue;
    terms.add(word);
  }
  return [...terms];
}

/** A trait a brand holds, and how many of its facts said so. */
type Held = { kind: string; value: string; count: number };

/**
 * Rebuilds one company's traits and relations from what it already knows.
 *
 * Deleted and rewritten rather than merged. Both tables are derived, a fact
 * that was retired should take its trait with it, and a merge would leave
 * yesterday's conclusions sitting alongside today's with no way to tell them
 * apart.
 */
export async function recomputeRelations(scope: CompanyScope): Promise<{
  brands: number;
  traits: number;
  relations: number;
}> {
  return withCompanyScope(scope, async (tx) => {
    const roster = await tx<{ name: string }[]>`
      select name from company_brands where company_id = ${scope.companyId}
    `;

    await tx`delete from brand_relations where company_id = ${scope.companyId}`;
    await tx`delete from brand_traits where company_id = ${scope.companyId}`;

    // One brand cannot be related to anything, and no brands means a company
    // that does not work this way at all.
    if (roster.length < 2) return { brands: roster.length, traits: 0, relations: 0 };

    // --- traits ------------------------------------------------------------

    // What each brand was described as, from its own facts. Attributed facts
    // only: a fact belonging to no brand belongs to all of them and would
    // relate every brand to every other.
    const factRows = await tx<{ brand: string; kind: string; value: string; n: number }[]>`
      select brand, attribute as kind, value, count(*)::int as n
        from brand_dna_facts
       where company_id = ${scope.companyId}
         and status = 'active'
         and brand is not null
       group by brand, attribute, value
    `;

    // Where each brand's files came from. Not in the facts, and one of the
    // dimensions that matters most — two brands sold into the same country
    // are related whatever else differs.
    const marketRows = await tx<{ brand: string; value: string; n: number }[]>`
      select brand, market as value, count(*)::int as n
        from drive_files
       where company_id = ${scope.companyId}
         and archived_at is null
         and brand is not null
         and market is not null
       group by brand, market
    `;

    const traits = new Map<string, Map<string, Held>>();
    const add = (brand: string, kind: string, rawValue: string, n: number): void => {
      const cleanKind = kind.toLowerCase().trim();
      if (NOT_A_RELATION.has(cleanKind)) return;

      // A market is stated, not described, so it is one term exactly as given.
      // Its key is prefixed so a country can never collide with a word
      // somebody happened to use in a sentence; the prefix is on the key
      // only, because the thing a person reads is the country.
      const terms: { key: string; value: string }[] =
        cleanKind === 'market'
          ? [{ key: `market:${rawValue.toLowerCase().trim()}`, value: rawValue.toLowerCase().trim() }]
          : termsIn(rawValue).map((term) => ({ key: term, value: term }));

      const forBrand = traits.get(brand) ?? new Map<string, Held>();
      for (const term of terms) {
        const existing = forBrand.get(term.key);
        forBrand.set(
          term.key,
          existing
            ? { ...existing, count: existing.count + n }
            : { kind: cleanKind, value: term.value, count: n },
        );
      }
      traits.set(brand, forBrand);
    };

    for (const row of factRows) add(row.brand, row.kind, row.value, row.n);
    for (const row of marketRows) add(row.brand, 'market', row.value, row.n);

    let written = 0;
    for (const [brand, forBrand] of traits) {
      for (const held of forBrand.values()) {
        await tx`
          insert into brand_traits (company_id, brand, kind, value, evidence_count)
          values (${scope.companyId}, ${brand}, ${held.kind}, ${held.value}, ${held.count})
          on conflict (company_id, brand, kind, value)
            do update set evidence_count = excluded.evidence_count, updated_at = now()
        `;
        written += 1;
      }
    }

    // --- relations ---------------------------------------------------------

    // How many brands hold each trait. A trait only one brand has cannot
    // relate anything, and one every brand has relates nothing.
    const holders = new Map<string, number>();
    for (const forBrand of traits.values()) {
      for (const key of forBrand.keys()) holders.set(key, (holders.get(key) ?? 0) + 1);
    }

    // Counted over the brands that actually have traits, not over the roster.
    // A brand nothing is known about yet cannot hold a trait, and counting it
    // would make every real trait look rarer than it is.
    const total = traits.size;

    /** Rare is informative. Universal is not. */
    const weightOf = (key: string): number => {
      const held = holders.get(key) ?? 0;

      // Held by one brand, so it cannot relate that brand to anything.
      if (held < 2) return 0;

      // Held by every brand, so it says nothing about which two are alike.
      // Only meaningful once there are more than two: at two, "both have it"
      // is the entire comparison rather than a thing that fails to
      // distinguish, and the rule would rule out every relation there is.
      if (total > 2 && held >= total) return 0;

      return total === 2 ? 1 : Math.log(total / held);
    };

    /** The length of a brand, in the space its traits describe. */
    const magnitude = (forBrand: Map<string, Held>): number => {
      let sum = 0;
      for (const key of forBrand.keys()) sum += weightOf(key) ** 2;
      return Math.sqrt(sum);
    };

    const magnitudes = new Map<string, number>();
    for (const [brand, forBrand] of traits) magnitudes.set(brand, magnitude(forBrand));

    let relations = 0;
    const named = [...traits.keys()].sort();

    for (let i = 0; i < named.length; i += 1) {
      for (let j = i + 1; j < named.length; j += 1) {
        const a = named[i]!;
        const b = named[j]!;
        const ta = traits.get(a)!;
        const tb = traits.get(b)!;

        const shared: { kind: string; value: string; weight: number }[] = [];
        let dot = 0;
        for (const [key, held] of ta) {
          if (!tb.has(key)) continue;
          const weight = weightOf(key);
          if (weight <= 0) continue;
          dot += weight ** 2;
          shared.push({ kind: held.kind, value: held.value, weight });
        }

        if (shared.length === 0) continue;

        const denominator = (magnitudes.get(a) ?? 0) * (magnitudes.get(b) ?? 0);
        if (denominator === 0) continue;

        const score = Math.min(1, dot / denominator);
        // Below this two brands share a coincidence rather than a character.
        if (score < 0.05) continue;

        // Strongest first, and bounded: the point is to explain the number,
        // not to reproduce both brands in full.
        shared.sort((x, y) => y.weight - x.weight);
        const explanation = shared.slice(0, 8).map((s) => ({ kind: s.kind, value: s.value }));

        // Ordered, so a pair cannot be stored twice with its ends swapped.
        const [first, second] = a < b ? [a, b] : [b, a];
        await tx`
          insert into brand_relations (company_id, brand_a, brand_b, score, shared)
          values (${scope.companyId}, ${first!}, ${second!}, ${score.toFixed(4)},
                  ${tx.json(explanation)})
          on conflict (company_id, brand_a, brand_b)
            do update set score = excluded.score, shared = excluded.shared, updated_at = now()
        `;
        relations += 1;
      }
    }

    return { brands: roster.length, traits: written, relations };
  });
}

/** What a brand is, as CIP worked it out. Strongest evidence first. */
export async function traitsOf(
  scope: CompanyScope,
  brand: string,
  limit = 40,
): Promise<BrandTrait[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<{ kind: string; value: string; evidence_count: number }[]>`
      select kind, value, evidence_count
        from brand_traits
       where company_id = ${scope.companyId} and brand = ${brand}
       order by evidence_count desc, kind, value
       limit ${Math.min(Math.max(limit, 1), 200)}
    `;
    return rows.map((r) => ({ kind: r.kind, value: r.value, evidenceCount: r.evidence_count }));
  });
}

/**
 * Which brands this one is like, closest first.
 *
 * Pass no brand to get the whole map, which is what the Trust page draws.
 */
export async function relationsOf(
  scope: CompanyScope,
  brand: string | null = null,
  limit = 50,
): Promise<BrandRelation[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<
      { brand_a: string; brand_b: string; score: string; shared: { kind: string; value: string }[] }[]
    >`
      select brand_a, brand_b, score, shared
        from brand_relations
       where company_id = ${scope.companyId}
         and (${brand}::text is null or brand_a = ${brand} or brand_b = ${brand})
       order by score desc, brand_a, brand_b
       limit ${Math.min(Math.max(limit, 1), 200)}
    `;

    return rows.map((row) => {
      // Answered from the asked-for end, so a caller never has to work out
      // which of the two it was looking at.
      const isA = brand === null || row.brand_a === brand;
      return {
        brand: isA ? row.brand_a : row.brand_b,
        other: isA ? row.brand_b : row.brand_a,
        score: Number(row.score),
        shared: row.shared ?? [],
      };
    });
  });
}

/**
 * Recomputes every company's relations.
 *
 * Called from the worker after Brand DNA is recomputed, so the map keeps step
 * with the knowledge it is drawn from without anybody running anything.
 */
export async function recomputeRelationsEverywhere(): Promise<number> {
  const sql = adminSql();
  let companies: { id: string }[];
  try {
    companies = await sql<{ id: string }[]>`select id from companies`;
  } finally {
    await sql.end();
  }

  let touched = 0;
  for (const company of companies) {
    const outcome = await recomputeRelations({
      companyId: company.id,
      userId: '00000000-0000-0000-0000-000000000000',
      role: 'owner',
    });
    if (outcome.relations > 0) touched += 1;
  }
  return touched;
}
