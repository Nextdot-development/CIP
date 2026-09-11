import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { adminSql } from '../db-admin';
import { BRAIN_LIMITS } from './providers/types';

/**
 * What a company's assets add up to.
 *
 * Brand DNA is not written by asking a model "what is this brand like?". It is
 * counted: every analysed asset contributes small claims, identical claims
 * accumulate evidence, and a claim only becomes something the Brain will state
 * once enough separate assets agree. One image can never make a rule.
 *
 * That is the difference between a fact and a guess, and it is why every fact
 * carries its evidence count and the assets it came from.
 */

export type BrandSection = 'visual' | 'video' | 'content' | 'rules';

export type BrandFactDTO = {
  id: string;
  section: BrandSection;
  attribute: string;
  value: string;
  kind: 'observed' | 'derived' | 'preference' | 'inference' | 'hypothesis';
  confidence: number;
  evidenceCount: number;
  updatedAt: string;
  /**
   * The markets whose files produced this fact.
   *
   * Empty when none of them has been placed. Two or more means the pattern
   * holds across countries — it is the brand, not one country's version of it.
   */
  markets: string[];
  /** Which brand it is about. Null means it belongs to the whole house. */
  brand: string | null;
};

export type BrandFactEvidenceDTO = {
  fileId: string | null;
  fileName: string | null;
  note: string | null;
};

/**
 * Confidence from evidence.
 *
 * Saturating rather than linear: the step from one asset to three says a great
 * deal, the step from thirty to thirty-two says almost nothing. Capped below 1
 * because no amount of counting makes an inference certain.
 *
 *   1 asset  -> 0.25     3 assets -> 0.50     9 assets -> 0.75
 */
export function confidenceFromEvidence(evidenceCount: number): number {
  if (evidenceCount <= 0) return 0;
  const confidence = evidenceCount / (evidenceCount + 3);
  return Math.min(0.95, Math.round(confidence * 1000) / 1000);
}

/**
 * Recomputes a company's Brand DNA from the evidence currently on record.
 *
 * Idempotent by construction: it reads the evidence and writes the conclusion,
 * so running it twice changes nothing and running it after new assets arrive
 * moves the numbers. Nothing is invented — a company with no analysed assets
 * ends up with no facts.
 */
export async function recomputeBrandDna(scope: CompanyScope): Promise<{
  facts: number;
  promoted: number;
  demoted: number;
}> {
  return withCompanyScope(scope, async (tx) => {
    // Evidence is the count of distinct assets supporting a claim, taken from
    // the provenance rows rather than a counter that could drift.
    await tx`
      update brand_dna_facts f
         set evidence_count = coalesce(e.n, 0),
             updated_at = now()
        from (
          select fact_id, count(distinct file_id)::int as n
            from brand_dna_evidence
           where file_id is not null
           group by fact_id
        ) e
       where e.fact_id = f.id
         and f.evidence_count is distinct from coalesce(e.n, 0)
    `;

    // Confidence follows evidence, everywhere, in one statement.
    await tx`
      update brand_dna_facts
         set confidence = least(0.95, round((evidence_count::numeric / (evidence_count + 3)), 3)),
             updated_at = now()
    `;

    // A claim backed by enough separate assets stops being a single
    // observation and becomes a pattern the Brain will state.
    const promoted = await tx<{ id: string }[]>`
      update brand_dna_facts
         set kind = 'derived', updated_at = now()
       where kind = 'observed'
         and evidence_count >= ${BRAIN_LIMITS.factMinEvidence}
         and status = 'active'
      returning id
    `;

    // And one that has lost its evidence goes back to being an observation,
    // so deleting assets genuinely weakens what the Brain claims.
    const demoted = await tx<{ id: string }[]>`
      update brand_dna_facts
         set kind = 'observed', updated_at = now()
       where kind = 'derived'
         and evidence_count < ${BRAIN_LIMITS.factMinEvidence}
      returning id
    `;

    const total = await tx<{ n: number }[]>`
      select count(*)::int n from brand_dna_facts where status = 'active'
    `;

    return {
      facts: total[0]?.n ?? 0,
      promoted: promoted.length,
      demoted: demoted.length,
    };
  });
}

/**
 * The Brand DNA a caller may see.
 *
 * Ordered by confidence, so the most-evidenced claims come first, and bounded
 * so a company with thousands of observations does not ship all of them.
 */
export async function readBrandDna(
  scope: CompanyScope,
  options: {
    section?: BrandSection | null;
    limit?: number;
    minEvidence?: number;
    /**
     * Narrow to one market's knowledge.
     *
     * Keeps a fact when it was seen in that market's files, and also when it
     * was seen in two or more markets — a pattern that holds across countries
     * is not a local one, and dropping it would leave the brief with only what
     * makes this market different and none of what makes it the same brand.
     */
    market?: string | null;
    /**
     * Narrow to one brand's knowledge.
     *
     * Keeps facts about that brand and facts about no brand in particular —
     * a rule that applies to everything the house makes belongs to each of
     * its brands. A fact about a sibling brand is dropped: Whytehall's
     * restraint has no business in a Magic Moments brief.
     */
    brand?: string | null;
  } = {},
): Promise<BrandFactDTO[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const minEvidence = options.minEvidence ?? 1;
  const section = options.section ?? null;
  const market = options.market ?? null;
  const brand = options.brand ?? null;

  const rows = await withCompanyScope(scope, async (tx) =>
    tx<
      {
        id: string; section: BrandSection; attribute: string; value: string;
        kind: BrandFactDTO['kind']; confidence: string; evidence_count: number; updated_at: Date;
        markets: string[]; brand: string | null;
      }[]
    >`
      with fact_markets as (
        -- Which markets each fact was actually seen in, from the files that
        -- evidenced it. Not stored on the fact: relabel a file and every fact
        -- it supports moves with it, with nothing to keep in step.
        select e.fact_id,
               array_remove(array_agg(distinct f.market), null) as markets
          from brand_dna_evidence e
          join drive_files f
            on f.id = e.file_id and f.company_id = e.company_id
         where e.company_id = ${scope.companyId}
         group by e.fact_id
      )
      select b.id, b.section, b.attribute, b.value, b.brand, b.kind, b.confidence,
             b.evidence_count, b.updated_at,
             coalesce(m.markets, '{}') as markets
        from brand_dna_facts b
        left join fact_markets m on m.fact_id = b.id
       where b.status = 'active'
         and b.evidence_count >= ${minEvidence}
         -- This brand's knowledge, plus everything that belongs to the house.
         and (${brand}::text is null or b.brand is null or b.brand = ${brand})
         and (${section}::text is null or b.section = ${section})
         and (
           ${market}::text is null
           -- Seen in this market, or seen in enough markets to be the brand
           -- rather than one country's version of it.
           or ${market} = any(coalesce(m.markets, '{}'))
           or coalesce(array_length(m.markets, 1), 0) >= 2
           -- A fact from a file nobody has placed belongs to the brand at
           -- large; withholding it would leave a market with less than it has.
           or coalesce(array_length(m.markets, 1), 0) = 0
         )
       order by b.confidence desc, b.evidence_count desc, b.attribute
       limit ${limit}
    `,
  );

  return rows.map((row) => ({
    id: row.id,
    section: row.section,
    attribute: row.attribute,
    value: row.value,
    kind: row.kind,
    confidence: Number(row.confidence),
    evidenceCount: row.evidence_count,
    updatedAt: row.updated_at.toISOString(),
    markets: row.markets ?? [],
    brand: row.brand,
  }));
}

/**
 * Which assets support one fact.
 *
 * This is what makes "why does the Brain believe this?" answerable, and it is
 * why the evidence rows exist at all. File names are safe to show; storage
 * paths are not, and are never selected.
 */
export async function factEvidence(
  scope: CompanyScope,
  factId: string,
  limit = 20,
): Promise<BrandFactEvidenceDTO[]> {
  if (!isUuid(factId)) return [];

  const rows = await withCompanyScope(scope, async (tx) =>
    tx<{ file_id: string | null; name: string | null; note: string | null }[]>`
      select e.file_id, f.name, e.note
        from brand_dna_evidence e
        left join drive_files f on f.id = e.file_id
       where e.fact_id = ${factId}
       order by e.created_at desc
       limit ${Math.min(Math.max(limit, 1), 100)}
    `,
  );

  return rows.map((row) => ({ fileId: row.file_id, fileName: row.name, note: row.note }));
}

/**
 * Campaigns and products this company's own assets mention.
 *
 * Used to decide whether a request is ambiguous — if a company has four
 * campaigns and the request names none of them, the Brain has to ask. Read from
 * evidence rather than a hand-maintained list, so it is always what the company
 * actually has.
 */
export async function knownSubjects(scope: CompanyScope): Promise<{
  campaigns: string[];
  products: string[];
}> {
  const rows = await withCompanyScope(scope, async (tx) =>
    tx<{ attribute: string; value: string }[]>`
      select attribute, value
        from brand_dna_facts
       where status = 'active'
         and attribute in ('campaign', 'product')
       order by evidence_count desc
       limit 60
    `,
  );

  return {
    campaigns: [...new Set(rows.filter((r) => r.attribute === 'campaign').map((r) => r.value))],
    products: [...new Set(rows.filter((r) => r.attribute === 'product').map((r) => r.value))],
  };
}

/** Recomputes for every company. Called by the worker after understanding runs. */
export async function recomputeEverywhere(): Promise<number> {
  const sql = adminSql();
  let companies: { id: string }[];
  try {
    companies = await sql<{ id: string }[]>`select id from companies`;
  } finally {
    await sql.end();
  }

  let touched = 0;
  for (const company of companies) {
    const scope: CompanyScope = {
      companyId: company.id,
      userId: '00000000-0000-0000-0000-000000000000',
      role: 'owner',
    };
    const result = await recomputeBrandDna(scope);
    if (result.facts > 0) touched += 1;
  }
  return touched;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
