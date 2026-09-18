import 'server-only';
import { withCompanyScope } from '../db';
import type { CompanyScope } from '../db';
import { readBrandDna } from './brandDna';
import type { BrandFactDTO } from './brandDna';

/**
 * The Product Brain: one brand's DNA, arranged the way the guidebook draws it.
 *
 * Six areas around a core - visual identity, verbal identity, message pillars,
 * compliance rules, campaign history and the asset library. Every node is
 * counted from the tables; an area CIP has learned nothing about is drawn
 * empty and says so, rather than being filled in to make the picture whole.
 *
 * Facts are sorted into areas by what they are called. That is a reading aid,
 * not a second model: the facts themselves are unchanged, and the full list is
 * one tab away.
 */

export type ClusterKey = 'visual' | 'verbal' | 'pillars' | 'compliance' | 'campaigns' | 'assets';

export type BrainLeaf = { label: string; detail: string };

export type BrainCluster = {
  key: ClusterKey;
  label: string;
  count: number;
  unit: string;
  leaves: BrainLeaf[];
};

export type ProductBrainDTO = {
  brand: string | null;
  assets: number;
  facts: number;
  rules: number;
  /** Areas with at least one thing in them, out of six. */
  covered: number;
  clusters: BrainCluster[];
  /** When the newest fact changed, in words. Null when nothing is learned. */
  updatedAgo: string | null;
};

const PILLAR = /pillar|message|positioning|proposition|promise|purpose|belief|essence|values?\b|platform|territory|story|heritage|origin/i;
const CAMPAIGN = /campaign|occasion|festiv|launch|season|event|activation|sponsor|partnership|promotion/i;
const LEAVES_PER_CLUSTER = 3;

function areaOf(fact: BrandFactDTO): ClusterKey {
  if (fact.section === 'rules') return 'compliance';
  if (fact.section === 'visual' || fact.section === 'video') return 'visual';
  if (CAMPAIGN.test(fact.attribute)) return 'campaigns';
  if (PILLAR.test(fact.attribute)) return 'pillars';
  return 'verbal';
}

function clip(text: string, max = 110): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function ago(date: Date | null): string | null {
  if (!date) return null;
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export async function productBrain(scope: CompanyScope, brand: string | null): Promise<ProductBrainDTO> {
  const [facts, numbers] = await Promise.all([
    readBrandDna(scope, { brand, limit: 500, minEvidence: 1 }),
    withCompanyScope(scope, async (tx) => {
      const counts = await tx<{ assets: number; rules: number; updated_at: Date | null }[]>`
        select
          (select count(*)::int from drive_files
            where company_id = ${scope.companyId} and archived_at is null
              and (${brand}::text is null or brand = ${brand})) as assets,
          (select count(*)::int from compliance_rules
            where company_id = ${scope.companyId} and active
              and (${brand}::text is null or brand is null or brand = ${brand})) as rules,
          (select max(updated_at) from brand_dna_facts
            where company_id = ${scope.companyId} and status = 'active'
              and (${brand}::text is null or brand is null or brand = ${brand})) as updated_at
      `;
      const files = await tx<{ name: string; file_type: string | null }[]>`
        select name, file_type from drive_files
         where company_id = ${scope.companyId} and archived_at is null
           and (${brand}::text is null or brand = ${brand})
         order by created_at desc
         limit ${LEAVES_PER_CLUSTER}
      `;
      const rules = await tx<{ rule: string; market: string | null; requirement: string }[]>`
        select rule, market, requirement from compliance_rules
         where company_id = ${scope.companyId} and active
           and (${brand}::text is null or brand is null or brand = ${brand})
         order by (source = 'regulation') desc, market nulls first, rule
         limit ${LEAVES_PER_CLUSTER}
      `;
      return { counts: counts[0]!, files, rules };
    }),
  ]);

  const grouped: Record<ClusterKey, BrandFactDTO[]> = {
    visual: [], verbal: [], pillars: [], compliance: [], campaigns: [], assets: [],
  };
  for (const fact of facts) grouped[areaOf(fact)].push(fact);

  const leavesFrom = (list: BrandFactDTO[]): BrainLeaf[] =>
    list.slice(0, LEAVES_PER_CLUSTER).map((fact) => ({ label: fact.attribute, detail: clip(fact.value) }));

  const ruleLeaves: BrainLeaf[] = numbers.rules.map((rule) => ({
    label: `${rule.requirement === 'required' ? 'Required' : 'Forbidden'}${rule.market ? ` · ${rule.market}` : ''}`,
    detail: clip(rule.rule),
  }));

  const clusters: BrainCluster[] = [
    { key: 'visual', label: 'Visual Identity', count: grouped.visual.length, unit: 'patterns', leaves: leavesFrom(grouped.visual) },
    {
      key: 'assets',
      label: 'Asset Library',
      count: numbers.counts.assets,
      unit: 'files',
      leaves: numbers.files.map((file) => ({ label: file.file_type ?? 'File', detail: clip(file.name) })),
    },
    { key: 'campaigns', label: 'Campaign History', count: grouped.campaigns.length, unit: 'patterns', leaves: leavesFrom(grouped.campaigns) },
    {
      key: 'compliance',
      label: 'Compliance Rules',
      count: grouped.compliance.length + numbers.counts.rules,
      unit: 'rules',
      leaves: [...ruleLeaves, ...leavesFrom(grouped.compliance)].slice(0, LEAVES_PER_CLUSTER),
    },
    { key: 'pillars', label: 'Message Pillars', count: grouped.pillars.length, unit: 'patterns', leaves: leavesFrom(grouped.pillars) },
    { key: 'verbal', label: 'Verbal Identity', count: grouped.verbal.length, unit: 'patterns', leaves: leavesFrom(grouped.verbal) },
  ];

  return {
    brand,
    assets: numbers.counts.assets,
    facts: facts.length,
    rules: numbers.counts.rules,
    covered: clusters.filter((cluster) => cluster.count > 0).length,
    clusters,
    updatedAgo: ago(numbers.counts.updated_at),
  };
}
