import { noStore, withBrainScope } from '@/server/brain/http';
import { readBrandDna } from '@/server/brain/brandDna';
import type { BrandSection } from '@/server/brain/brandDna';
import { companyBrands } from '@/server/brain/brands';
import { listRules } from '@/server/brain/checker';

/**
 * GET /api/brain/brand-dna/report?brand=
 *
 * "Export Brand DNA Report": what CIP knows about one brand, as a document a
 * person can read, forward or argue with. Every line is a stored fact or rule
 * with its evidence count - nothing is summarised by a model on the way out.
 *
 * A brand not on this company's roster is treated as no brand, so the report
 * falls back to the whole house rather than to another company's brand.
 */
export const dynamic = 'force-dynamic';

const SECTION_TITLE: Record<BrandSection, string> = {
  visual: 'Visual identity',
  video: 'Video and motion',
  content: 'Verbal identity and messaging',
  rules: 'Brand rules',
};

const SOURCE_NOTE = {
  regulation: 'regulation',
  suggested: 'suggested by CIP, needs review',
  manual: 'added by your team',
} as const;

export async function GET(request: Request) {
  return withBrainScope(async (scope) => {
    const wanted = new URL(request.url).searchParams.get('brand');
    const brands = await companyBrands(scope);
    const brand = brands.find((b) => b.name === wanted)?.name ?? null;

    const [facts, rules] = await Promise.all([
      readBrandDna(scope, { brand, limit: 500, minEvidence: 1 }),
      listRules(scope),
    ]);
    const applicable = rules.filter((rule) => rule.active && (!brand || !rule.brand || rule.brand === brand));

    const title = brand ?? 'All brands';
    const lines: string[] = [
      `# Brand DNA Report — ${title}`,
      '',
      `Generated ${new Date().toISOString().slice(0, 10)} by CIP from ${facts.length} learned patterns and ${applicable.length} compliance rules.`,
      '',
      'Each pattern shows how many assets support it. A pattern with one supporting asset is an early read, not a settled fact.',
      '',
    ];

    for (const section of Object.keys(SECTION_TITLE) as BrandSection[]) {
      const inSection = facts.filter((fact) => fact.section === section);
      if (inSection.length === 0) continue;
      lines.push(`## ${SECTION_TITLE[section]}`, '');
      for (const fact of inSection) {
        const notes = [
          `${fact.evidenceCount} asset${fact.evidenceCount === 1 ? '' : 's'}`,
          fact.brand ? null : 'house-wide',
          fact.markets.length ? fact.markets.join(', ') : null,
        ].filter(Boolean);
        lines.push(`- **${fact.attribute}:** ${fact.value} _(${notes.join('; ')})_`);
      }
      lines.push('');
    }

    if (applicable.length > 0) {
      lines.push('## Compliance rules', '');
      const byMarket = new Map<string, typeof applicable>();
      for (const rule of applicable) {
        const key = rule.market ?? 'Every market';
        byMarket.set(key, [...(byMarket.get(key) ?? []), rule]);
      }
      for (const [market, list] of byMarket) {
        lines.push(`### ${market}`, '');
        for (const rule of list) {
          const notes = [SOURCE_NOTE[rule.source], rule.referenceUrl].filter(Boolean);
          lines.push(`- **${rule.requirement === 'required' ? 'Required' : 'Forbidden'}:** ${rule.rule} _(${notes.join('; ')})_`);
        }
        lines.push('');
      }
    }

    if (facts.length === 0 && applicable.length === 0) {
      lines.push('CIP has not learned anything about this brand yet. Add files to the brain and they appear here once they have been read.', '');
    }

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'brand';
    return new Response(lines.join('\n'), {
      headers: {
        ...noStore,
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="brand-dna-${slug}.md"`,
      },
    });
  });
}
