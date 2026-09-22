import postgres from 'postgres';
import { RADICO_QC_RULES } from '../src/server/brain/radicoRules';

/**
 * Loads Radico's QC document into the rules CIP checks against.
 *
 *   npm run rules:load -- radico-khaitan [--apply]
 *
 * Dry by default. It prints what it would write and changes nothing until
 * --apply, because these decide whether a creative passes.
 *
 * Re-running updates rather than duplicates: a rule is identified by the
 * document's own code - RADICO-GLOBAL-002, 8PM_HONEY_VIS_001 - so the document
 * can be corrected and reloaded without collecting two copies of every rule.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not verify anything. Every rule lands unverified, which in CIP means
 * it can raise a question about a creative but cannot fail one. Somebody has to
 * read each rule and agree with it first, on the Consistency Check page. That
 * is deliberate: this document is one team's draft, and a rule nobody has
 * agreed to should not be able to stop work going out.
 *
 * It also does not touch the rules already in the database. The regulatory ones
 * loaded earlier - statutory warnings, market rules - have no rule_code, are
 * matched by nothing here, and are left exactly as they are.
 */

async function main(): Promise<void> {
  const slug = process.argv[2];
  const apply = process.argv.includes('--apply');

  if (!slug || slug.startsWith('--')) {
    console.error('\n  npm run rules:load -- <company-slug> [--apply]\n');
    process.exit(1);
  }

  const sql = postgres(process.env.DATABASE_ADMIN_URL!, {
    ssl: 'require',
    max: 1,
    onnotice: () => {},
    connect_timeout: 30,
  });

  try {
    const [company] = await sql<{ id: string; name: string }[]>`
      select id, name from companies where slug = ${slug}
    `;
    if (!company) throw new Error(`no company "${slug}"`);

    // A rule filed under a brand nobody has heard of reaches nothing: the
    // checker matches on the brand name as the roster spells it.
    const roster = await sql<{ name: string }[]>`
      select name from company_brands where company_id = ${company.id}
    `;
    const known = new Set(roster.map((b) => b.name.toLowerCase()));

    const existing = await sql<{ rule_code: string }[]>`
      select rule_code from compliance_rules
       where company_id = ${company.id} and rule_code is not null
    `;
    const already = new Set(existing.map((r) => r.rule_code));

    const unknownBrands = new Set<string>();
    for (const rule of RADICO_QC_RULES) {
      if (rule.brand && !known.has(rule.brand.toLowerCase())) unknownBrands.add(rule.brand);
    }

    console.log(`\n  ${company.name}\n`);
    console.log(`    rules in the document      ${RADICO_QC_RULES.length}`);
    console.log(`    already loaded             ${already.size}`);
    console.log(`    would be added             ${RADICO_QC_RULES.filter((r) => !already.has(r.code)).length}`);
    console.log(`    would be updated           ${RADICO_QC_RULES.filter((r) => already.has(r.code)).length}`);

    const bySeverity = tally(RADICO_QC_RULES.map((r) => r.severity));
    const byType = tally(RADICO_QC_RULES.map((r) => r.ruleType));
    console.log(`\n    by severity                ${describe(bySeverity)}`);
    console.log(`    by kind                    ${describe(byType)}`);

    if (unknownBrands.size > 0) {
      console.log(
        `\n    ${unknownBrands.size} brand name(s) are not on this company's roster, so their\n` +
          `    rules would never be applied to anything:\n` +
          [...unknownBrands].map((b) => `      ${b}`).join('\n'),
      );
      console.log(`\n    Roster: ${roster.map((b) => b.name).join(', ')}`);
    }

    if (!apply) {
      console.log('\n  Nothing changed. Add --apply to write them.\n');
      return;
    }

    let written = 0;
    for (const r of RADICO_QC_RULES) {
      await sql`
        insert into compliance_rules
          (company_id, rule_code, brand, product, market, domain, rule_type, severity,
           rule, note, rationale, allowed, prohibited, human_review,
           requirement, category, source, active)
        values
          (${company.id}, ${r.code}, ${r.brand}, ${r.product}, ${r.market}, ${r.domain},
           ${r.ruleType}, ${r.severity}, ${r.rule}, ${r.from}, ${r.rationale},
           ${r.allowed}, ${r.prohibited}, ${r.humanReview},
           ${r.requirement}, ${r.category}, 'manual', true)
        -- The index is partial, so its predicate has to be repeated here or
        -- Postgres will not recognise which constraint is meant.
        on conflict (company_id, rule_code) where rule_code is not null do update set
          brand = excluded.brand, product = excluded.product, market = excluded.market,
          domain = excluded.domain, rule_type = excluded.rule_type, severity = excluded.severity,
          rule = excluded.rule, note = excluded.note, rationale = excluded.rationale,
          allowed = excluded.allowed, prohibited = excluded.prohibited,
          human_review = excluded.human_review, requirement = excluded.requirement,
          category = excluded.category, updated_at = now()
      `;
      written += 1;
    }

    console.log(`\n  ${written} rule(s) written.`);
    console.log('\n  None of them is verified, so none can fail a creative on its own yet.');
    console.log('  Confirm the ones this company stands behind on the Consistency Check page.\n');
  } finally {
    await sql.end();
  }
}

function tally(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function describe(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');
}

main().catch((error) => {
  console.error('\nload failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
