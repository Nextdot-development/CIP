import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { factKey, tidyFact, type TidyFact } from './factTidy';

/**
 * Brand DNA already on record, said the way new facts are.
 *
 * Each fact is tidied; facts that turn out to be the same claim become one,
 * the rest standing behind it as merged, with their evidence added to it; and
 * what is not about a brand is set aside. Nothing is deleted - a merged or
 * set-aside fact keeps its own evidence, and its own words wherever another
 * fact does not need them.
 *
 * A fact about no brand, every piece of whose evidence comes from one brand's
 * files, is that brand's. "Logo top-right" seen on twenty Whytehall posts was
 * stored as the whole house's because the model did not say which brand it
 * was looking at, and so it reached Magic Moments' briefs too.
 *
 * Derived from scratch every time, so running it again changes nothing, and a
 * file given a brand later moves its facts to that brand on the next run.
 */

export type TidyRow = TidyFact & {
  id: string;
  status: string;
  /** 'preference' when a person confirmed it. */
  kind?: string;
  evidence_count: number;
  file_brands: string[];
  unbranded_files: boolean;
};

type Change = { id: string; attribute: string; value: string; brand: string | null; status: string; kind: string };

export type TidyPlan = {
  /** Facts that now say the claim, with what they say. */
  keep: Change[];
  /** Facts that were the same claim as another. */
  merged: { id: string; into: string }[];
  /** Facts that are not knowledge about a brand. */
  setAside: string[];
  /** Merged facts that must give up their words to the fact taking them. */
  displaced: Change[];
  attributed: number;
};

/** How a merged fact's words are marked when another fact needed them. */
const MERGED = ' (merged)';

/** A fact's words without that mark. */
function ownWords(row: TidyRow): string {
  return row.value.endsWith(MERGED) ? row.value.slice(0, -MERGED.length) : row.value;
}

/** What tidying would do to these facts. Pure, so it can be checked without a database. */
export function planTidy(rows: TidyRow[]): TidyPlan {
  const groups = new Map<string, { target: TidyFact; members: TidyRow[] }>();
  const setAside: string[] = [];
  let attributed = 0;

  for (const row of rows) {
    const tidy = tidyFact({ section: row.section, attribute: row.attribute, value: ownWords(row), brand: row.brand });
    if (!tidy) {
      if (row.status !== 'rejected' && row.status !== 'set_aside') setAside.push(row.id);
      continue;
    }
    const ownBrand = !tidy.brand && !row.unbranded_files && row.file_brands.length === 1;
    if (ownBrand) attributed += 1;
    const target = { ...tidy, brand: ownBrand ? row.file_brands[0]! : tidy.brand };
    const key = factKey(target);
    const group = groups.get(key) ?? { target, members: [] };
    group.members.push(row);
    groups.set(key, group);
  }

  // Which fact holds each wording now. A fact a person rejected keeps its
  // words whatever they tidy to, so the claim stays rejected.
  const holder = new Map(rows.map((r) => [factKey(r), r]));

  const keep: Change[] = [];
  const merged: { id: string; into: string }[] = [];
  const final = new Map<string, string>();

  for (const [key, { target, members }] of groups) {
    const held = holder.get(key);
    // The fact already saying it exactly stays, so nothing changes its words
    // when it need not - and a rejected one takes its duplicates with it.
    const exact = held && (members.includes(held) || held.status === 'rejected') ? held : undefined;
    const canonical = exact
      ?? members.filter((r) => r.status !== 'rejected')
        .sort((a, b) => Number(b.kind === 'preference') - Number(a.kind === 'preference') || b.evidence_count - a.evidence_count)[0];
    if (!canonical) continue;

    // A claim a person rejected in any of its wordings stays rejected in all.
    const status = members.some((r) => r.status === 'rejected') || canonical.status === 'rejected'
      ? 'rejected'
      : canonical.status === 'merged' || canonical.status === 'set_aside' ? 'active' : canonical.status;
    // And one a person confirmed in any wording stays confirmed.
    const kind = members.some((r) => r.kind === 'preference') ? 'preference' : canonical.kind ?? 'observed';
    final.set(canonical.id, key);

    if (factKey(canonical) !== key || canonical.status !== status || (canonical.kind ?? 'observed') !== kind) {
      keep.push({ id: canonical.id, attribute: target.attribute, value: target.value, brand: target.brand, status, kind });
    }
    for (const member of members) {
      if (member.id !== canonical.id && member.status !== 'rejected') {
        merged.push({ id: member.id, into: canonical.id });
      }
    }
  }

  // A merged fact whose words a kept fact is taking - the house's "logo:
  // small" when the copy seen only on Whytehall posts became Whytehall's -
  // has its words marked, so the two never clash.
  const taken = new Set(final.values());
  const displaced = merged
    .map((m) => rows.find((r) => r.id === m.id)!)
    .filter((r) => taken.has(factKey(r)))
    .map((r) => ({
      id: r.id, attribute: r.attribute, value: `${ownWords(r)}${MERGED}`, brand: r.brand, status: 'merged', kind: r.kind ?? 'observed',
    }));

  return { keep, merged, setAside, displaced, attributed };
}

export async function tidyBrandDna(scope: CompanyScope): Promise<{
  merged: number;
  setAside: number;
  attributed: number;
  changed: number;
}> {
  return withCompanyScope(scope, async (tx) => {
    const rows = await tx<TidyRow[]>`
      select f.id, f.section, f.attribute, f.value, f.brand, f.status, f.kind, f.evidence_count,
             coalesce(array_remove(array_agg(distinct d.brand), null), '{}') as file_brands,
             coalesce(bool_or(e.file_id is not null and d.brand is null), false) as unbranded_files
        from brand_dna_facts f
        left join brand_dna_evidence e on e.fact_id = f.id and e.company_id = f.company_id
        left join drive_files d on d.id = e.file_id and d.company_id = e.company_id
       where f.company_id = ${scope.companyId}
       group by f.id
    `;
    const plan = planTidy(rows);

    if (plan.merged.length > 0) {
      const ids = plan.merged.map((m) => m.id);
      const into = plan.merged.map((m) => m.into);
      await tx`
        update brand_dna_facts f
           set status = 'merged', merged_into = m.into, updated_at = now()
          from unnest(${ids}::uuid[], ${into}::uuid[]) as m(id, into)
         where f.id = m.id and f.company_id = ${scope.companyId}
           and (f.status <> 'merged' or f.merged_into is distinct from m.into)
      `;
      // The evidence behind each merged fact now also stands behind what it
      // was merged into - counted by distinct file, so nothing counts twice.
      await tx`
        insert into brand_dna_evidence (company_id, fact_id, file_id, page_number, source_type, note)
        select distinct on (m.into, e.file_id, e.page_number)
               e.company_id, m.into, e.file_id, e.page_number, e.source_type, e.note
          from unnest(${ids}::uuid[], ${into}::uuid[]) as m(id, into)
          join brand_dna_evidence e on e.fact_id = m.id and e.company_id = ${scope.companyId}
         where not exists (
           select 1 from brand_dna_evidence x
            where x.fact_id = m.into
              and x.file_id is not distinct from e.file_id
              and x.page_number is not distinct from e.page_number
         )
      `;
    }
    if (plan.setAside.length > 0) {
      await tx`
        update brand_dna_facts set status = 'set_aside', merged_into = null, updated_at = now()
         where company_id = ${scope.companyId} and id = any(${plan.setAside}::uuid[])
      `;
    }

    // New words in two steps: every fact changing them first lets go of its
    // old ones, so no two facts ever hold the same words in between.
    const changes = [...plan.displaced, ...plan.keep];
    if (changes.length > 0) {
      const ids = changes.map((c) => c.id);
      await tx`
        update brand_dna_facts set value = 'tidying ' || id::text
         where company_id = ${scope.companyId} and id = any(${ids}::uuid[])
      `;
      await tx`
        update brand_dna_facts f
           set attribute = c.attribute, value = c.value, brand = c.brand, status = c.status, kind = c.kind,
               merged_into = case when c.status = 'merged' then f.merged_into end,
               updated_at = now()
          from unnest(
            ${ids}::uuid[], ${changes.map((c) => c.attribute)}::text[], ${changes.map((c) => c.value)}::text[],
            ${changes.map((c) => c.brand)}::text[], ${changes.map((c) => c.status)}::text[],
            ${changes.map((c) => c.kind)}::text[]
          ) as c(id, attribute, value, brand, status, kind)
         where f.id = c.id and f.company_id = ${scope.companyId}
      `;
    }

    return {
      merged: plan.merged.length,
      setAside: plan.setAside.length,
      attributed: plan.attributed,
      changed: changes.length,
    };
  });
}
