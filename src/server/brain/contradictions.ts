import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';

/**
 * Making the Brain disagree with itself.
 *
 * Every fact CIP had ever learned was active. A claim read once off a blurry
 * photograph stood beside one seen across forty assets, and both went into the
 * same brief — so a generator could be told the cap is gold and the cap is
 * black in the same breath. That is not the model inventing things. It is
 * knowledge nobody ever went back to.
 *
 * The hard part is not picking a winner. It is knowing which pairs are even in
 * competition. "colour palette: deep navy" and "colour palette: warm gold" are
 * a palette, not a disagreement; "cap colour: gold" and "cap colour: black"
 * cannot both be true of one bottle. Nothing here is told which attributes are
 * which — that is read off the company's own facts, so it stays right for a
 * vocabulary CIP invents as it goes.
 *
 * And where the evidence does not settle it, it is not settled. Forty assets
 * against one is a resolved question; three against two is a thing CIP does
 * not know, and saying otherwise confidently is exactly the failure this is
 * meant to prevent.
 */

export type ContradictionOutcome = {
  /** Facts brought back because whatever beat them no longer does. */
  restored: number;
  /** Facts a better-evidenced claim replaced. */
  superseded: number;
  /** Facts that cannot both be true and are evenly supported. */
  contested: number;
};

/**
 * How much better-evidenced a claim has to be to retire its rival.
 *
 * Twice the evidence, and at least two assets behind it. One asset beating
 * one asset is a coin toss with a winner declared; this is the line between
 * counting evidence and pretending to.
 */
const DECISIVE_RATIO = 2;
const DECISIVE_FLOOR = 2;

/**
 * The share of brands that must hold exactly one value for an attribute
 * before it is treated as answering a single question.
 *
 * Two thirds: high enough that a genuinely list-like attribute is never
 * mistaken for a single-valued one, low enough that a single-valued attribute
 * survives a few brands whose assets disagreed.
 */
const SINGLE_VALUED_SHARE = 2 / 3;

/**
 * Re-judges a company's facts against each other.
 *
 * Run on every recompute, and derived from scratch every time: facts set
 * aside automatically are restored first, so a claim that lost to something
 * which has since lost its own evidence comes back on its own. A fact a
 * person rejected is never touched — that is a decision, not an inference.
 */
export async function resolveContradictions(
  scope: CompanyScope,
): Promise<ContradictionOutcome> {
  return withCompanyScope(scope, async (tx) => {
    // Everything automatic is undone before anything is decided, so the
    // outcome always reflects the evidence as it stands rather than the order
    // things happened to be learned in.
    const restored = await tx<{ id: string }[]>`
      update brand_dna_facts
         set status = 'active', updated_at = now()
       where company_id = ${scope.companyId}
         and status in ('superseded', 'contested')
      returning id
    `;

    // Which attributes answer a single question, learned from how this
    // company's own brands actually use them. An attribute most brands hold
    // one value for is answering "what colour is the cap?"; one most brands
    // hold several of is collecting a list.
    const shapes = await tx<{ attribute: string; single: number; total: number }[]>`
      with per_brand as (
        select lower(btrim(attribute)) as attribute,
               brand,
               count(distinct value)::int as values
          from brand_dna_facts
         where company_id = ${scope.companyId}
           and status = 'active'
           and brand is not null
         group by 1, 2
      )
      select attribute,
             count(*) filter (where values = 1)::int as single,
             count(*)::int as total
        from per_brand
       group by attribute
    `;

    const singleValued = new Set(
      shapes
        // An attribute only one brand uses says nothing about its shape, and
        // treating it as single-valued would retire a claim on no grounds.
        .filter((s) => s.total >= 3 && s.single / s.total >= SINGLE_VALUED_SHARE)
        .map((s) => s.attribute),
    );

    if (singleValued.size === 0) {
      return { restored: restored.length, superseded: 0, contested: 0 };
    }

    // Every place one brand holds more than one answer to a single question.
    const clashes = await tx<{
      brand: string;
      section: string;
      attribute: string;
      ids: string[];
      evidence: number[];
    }[]>`
      select brand,
             section,
             lower(btrim(attribute)) as attribute,
             array_agg(id order by evidence_count desc, updated_at desc) as ids,
             array_agg(evidence_count order by evidence_count desc, updated_at desc) as evidence
        from brand_dna_facts
       where company_id = ${scope.companyId}
         and status = 'active'
         and brand is not null
         and lower(btrim(attribute)) = any(${[...singleValued]}::text[])
       group by brand, section, lower(btrim(attribute))
      having count(*) > 1
    `;

    const toSupersede: string[] = [];
    const toContest: string[] = [];

    for (const clash of clashes) {
      const [best, ...rest] = clash.evidence;
      const runnerUp = rest[0] ?? 0;

      const decisive =
        (best ?? 0) >= DECISIVE_FLOOR && (best ?? 0) >= runnerUp * DECISIVE_RATIO;

      if (decisive) {
        // One claim is genuinely better supported. The others step aside, and
        // will come back if it ever loses its evidence.
        toSupersede.push(...clash.ids.slice(1));
      } else {
        // Nothing here settles it. Every claim is set aside, including the one
        // that happens to lead — a brief with neither is honest, a brief with
        // the marginal winner is a confident guess.
        toContest.push(...clash.ids);
      }
    }

    if (toSupersede.length > 0) {
      await tx`
        update brand_dna_facts set status = 'superseded', updated_at = now()
         where company_id = ${scope.companyId} and id = any(${toSupersede}::uuid[])
      `;
    }
    if (toContest.length > 0) {
      await tx`
        update brand_dna_facts set status = 'contested', updated_at = now()
         where company_id = ${scope.companyId} and id = any(${toContest}::uuid[])
      `;
    }

    return {
      restored: restored.length,
      superseded: toSupersede.length,
      contested: toContest.length,
    };
  });
}

/** One thing the company's own assets disagree about. */
export type Disagreement = {
  brand: string;
  attribute: string;
  /** Every answer the assets gave, best-supported first. */
  values: { value: string; evidenceCount: number }[];
};

/**
 * What CIP cannot decide.
 *
 * The other half of knowing something: a brief is better without a coin-toss
 * answer in it, and a person is better off being told which question the
 * assets answer two ways. This is what the Trust page shows and what a
 * request for more material should be aimed at.
 */
export async function disagreements(
  scope: CompanyScope,
  limit = 40,
): Promise<Disagreement[]> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<
      { brand: string; attribute: string; value: string; evidence_count: number }[]
    >`
      select brand, attribute, value, evidence_count
        from brand_dna_facts
       where company_id = ${scope.companyId}
         and status = 'contested'
         and brand is not null
       order by brand, lower(btrim(attribute)), evidence_count desc
       limit ${Math.min(Math.max(limit, 1), 300) * 4}
    `;

    const grouped = new Map<string, Disagreement>();
    for (const row of rows) {
      const key = `${row.brand}${row.attribute.toLowerCase().trim()}`;
      const existing = grouped.get(key);
      const value = { value: row.value, evidenceCount: row.evidence_count };
      if (existing) existing.values.push(value);
      else grouped.set(key, { brand: row.brand, attribute: row.attribute, values: [value] });
    }

    return [...grouped.values()].slice(0, Math.min(Math.max(limit, 1), 300));
  });
}
