/**
 * Loads the compliance rules an alcohol brand is checked against.
 *
 *   npm run compliance -- <company-slug>            # show what would be added
 *   npm run compliance -- <company-slug> --apply
 *
 * Every rule marked "regulation" was checked against the regulation or a
 * published legal summary of it, and carries the link. None is paraphrased
 * from memory. A rule a reviewer disputes as wrong is retired only if CIP
 * suggested it; a regulator's rule is kept, because one reviewer disagreeing
 * with a statutory requirement does not change the statute.
 *
 * Rules about where and when an advert may run are loaded too, as "medium".
 * The checker never sends those to be judged - a picture cannot show what time
 * it was broadcast - but a reviewer still needs to see them.
 *
 * What is deliberately absent: state-level Indian rules, which differ state by
 * state, and any national European rule, because "Europe" is not a country and
 * the only rules that hold across it are the directive's.
 */
import postgres from 'postgres';
import { addComplianceRule } from '../src/server/brain/checker';
import type { NewComplianceRule } from '../src/server/brain/checker';
import type { CompanyScope } from '../src/server/db';

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { onnotice: () => {} });
const APPLY = process.argv.includes('--apply');

const INDIA_LAW = 'https://corporate.cyrilamarchandblogs.com/2025/06/pouring-over-the-law-navigating-alcohol-advertising-packaging-regulations-in-india-part-1/';
const INDIA_ASCI = 'https://www.asiaiplaw.com/article/surrogate-advertising-asci-issues-fresh-guidelines-for-brand-extension-advertisements';
const NIGERIA_ARCON = 'https://sonibaze.ng/arcon-rules-businesses-advertising-nigeria/';
const GHANA_FDA = 'https://apps.fas.usda.gov/newgainapi/api/Report/DownloadReportByFileName?fileName=Ghana+FDA+Rolls+Out+Draft+Guidelines+for+the+Advertisement+of+Regulated+Products+-+When+Will+It+Notify+the+WTO_Accra_Ghana_GH2025-0010';
const EU_AVMSD = 'https://eur-lex.europa.eu/eli/dir/2010/13/2025-02-08/eng';

const RULES: NewComplianceRule[] = [
  // --- India ----------------------------------------------------------------
  {
    market: 'India', category: 'medium', requirement: 'forbidden', source: 'regulation', referenceUrl: INDIA_LAW,
    rule: 'No advertising that directly or indirectly promotes alcohol on television or cable.',
    note: 'Cable Television Networks Rules 1994, Rule 7(2)(viii). Extended in 2000 to every channel carried in India.',
  },
  {
    market: 'India', category: 'claim', requirement: 'forbidden', source: 'regulation', referenceUrl: INDIA_ASCI,
    rule: 'A brand-extension creative must not show or suggest the alcoholic product itself.',
    note: 'ASCI guidelines on brand extensions. A surrogate that is really an advert for the liquor is the thing they exist to stop.',
  },
  {
    market: 'India', category: 'disclaimer', requirement: 'required', source: 'suggested',
    rule: 'Where the product is shown, carry the statutory warning that consumption of liquor is injurious to health.',
    note: "Radico's own Indian creatives carry this line. Suggested from that practice rather than cited to an advertising regulation.",
  },

  // --- Nigeria --------------------------------------------------------------
  {
    market: 'Nigeria', category: 'disclaimer', requirement: 'required', source: 'regulation', referenceUrl: NIGERIA_ARCON,
    rule: 'Carry a responsible drinking message.',
    note: 'ARCON Code of Advertising Practice.',
  },
  {
    market: 'Nigeria', category: 'audience', requirement: 'forbidden', source: 'regulation', referenceUrl: NIGERIA_ARCON,
    rule: 'Must not show, or appear to be aimed at, anyone who is or looks under 18.',
    note: 'ARCON Code of Advertising Practice.',
  },
  {
    market: 'Nigeria', category: 'claim', requirement: 'forbidden', source: 'regulation', referenceUrl: NIGERIA_ARCON,
    rule: 'Must not suggest drinking improves physical performance, social success, sexual attractiveness or mental ability.',
    note: 'ARCON Code of Advertising Practice.',
  },
  {
    market: 'Nigeria', category: 'claim', requirement: 'forbidden', source: 'regulation', referenceUrl: NIGERIA_ARCON,
    rule: 'Must not present drinking as a solution to personal problems.',
    note: 'ARCON Code of Advertising Practice.',
  },
  {
    market: 'Nigeria', category: 'medium', requirement: 'forbidden', source: 'regulation', referenceUrl: NIGERIA_ARCON,
    rule: 'Not placed where children are a significant share of the audience, including television before 9pm.',
    note: 'ARCON Code of Advertising Practice.',
  },

  // --- Ghana ----------------------------------------------------------------
  {
    market: 'Ghana', category: 'disclaimer', requirement: 'required', source: 'regulation', referenceUrl: GHANA_FDA,
    rule: 'Carry "Drink Responsibly".',
    note: 'FDA Ghana advertising guidelines. The 2025 revision was published as a draft.',
  },
  {
    market: 'Ghana', category: 'disclaimer', requirement: 'required', source: 'regulation', referenceUrl: GHANA_FDA,
    rule: 'Carry "Not for sale to persons under 18 years of age".',
    note: 'FDA Ghana advertising guidelines. The 2025 revision was published as a draft.',
  },
  {
    market: 'Ghana', category: 'disclaimer', requirement: 'required', source: 'regulation', referenceUrl: GHANA_FDA,
    rule: 'Carry "Not recommended for pregnant women".',
    note: 'FDA Ghana advertising guidelines. The 2025 revision was published as a draft.',
  },
  {
    market: 'Ghana', category: 'placement', requirement: 'required', source: 'regulation', referenceUrl: GHANA_FDA,
    rule: 'Health warnings sit at the bottom of the advert, no smaller than 30% of the largest type used.',
    note: 'FDA Ghana advertising guidelines. The 2025 revision was published as a draft.',
  },
  {
    market: 'Ghana', category: 'claim', requirement: 'forbidden', source: 'regulation', referenceUrl: GHANA_FDA,
    rule: 'No cartoon characters or animation.',
    note: 'FDA Ghana draft advertising guidelines, 2025.',
  },
  {
    market: 'Ghana', category: 'medium', requirement: 'forbidden', source: 'regulation', referenceUrl: GHANA_FDA,
    rule: 'Radio and television adverts run only between 8pm and 6am.',
    note: 'FDA Ghana advertising guidelines.',
  },

  // --- Europe ---------------------------------------------------------------
  {
    market: 'Europe', category: 'audience', requirement: 'forbidden', source: 'regulation', referenceUrl: EU_AVMSD,
    rule: 'Must not be aimed at minors, or show minors drinking.',
    note: 'Audiovisual Media Services Directive, Article 22.',
  },
  {
    market: 'Europe', category: 'claim', requirement: 'forbidden', source: 'regulation', referenceUrl: EU_AVMSD,
    rule: 'Must not link drinking to better physical performance or to driving.',
    note: 'Audiovisual Media Services Directive, Article 22.',
  },
  {
    market: 'Europe', category: 'claim', requirement: 'forbidden', source: 'regulation', referenceUrl: EU_AVMSD,
    rule: 'Must not suggest that drinking contributes to social or sexual success.',
    note: 'Audiovisual Media Services Directive, Article 22.',
  },
  {
    market: 'Europe', category: 'claim', requirement: 'forbidden', source: 'regulation', referenceUrl: EU_AVMSD,
    rule: 'Must not claim alcohol has therapeutic qualities, or is a stimulant, a sedative or a way to resolve personal conflicts.',
    note: 'Audiovisual Media Services Directive, Article 22.',
  },
  {
    market: 'Europe', category: 'claim', requirement: 'forbidden', source: 'regulation', referenceUrl: EU_AVMSD,
    rule: 'Must not encourage immoderate drinking, or present abstinence or moderation in a negative light.',
    note: 'Audiovisual Media Services Directive, Article 22.',
  },
];

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug || slug.startsWith('--')) {
    console.error('\n  npm run compliance -- <company-slug> [--apply]\n');
    process.exit(1);
  }

  const rows = await admin<{ company_id: string; user_id: string; name: string }[]>`
    select c.id as company_id, u.id as user_id, c.name
      from companies c
      join memberships m on m.company_id = c.id
      join users u on u.id = m.user_id
     where c.slug = ${slug}
     order by m.role
     limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error(`no company with slug "${slug}"`);
  const scope: CompanyScope = { companyId: row.company_id, userId: row.user_id, role: 'owner' };

  console.log(`\n${row.name} — ${RULES.length} compliance rule(s)\n`);
  for (const rule of RULES) {
    const mark = rule.category === 'medium' ? '·' : rule.requirement === 'required' ? '+' : '-';
    console.log(`  ${mark} ${(rule.market ?? 'every market').padEnd(8)} ${(rule.source ?? 'manual').padEnd(10)} ${rule.rule.slice(0, 84)}`);
  }

  if (!APPLY) {
    console.log('\n  + required   - forbidden   · where and when it runs (never sent to the checker)');
    console.log('\n  Nothing written. Re-run with --apply to add them.\n');
    return;
  }

  let added = 0;
  for (const rule of RULES) if (await addComplianceRule(scope, rule)) added += 1;
  console.log(`\n  ${added} rule(s) in place.\n`);
}

main()
  .then(async () => { await admin.end(); })
  .catch(async (error) => {
    console.error('\ncompliance seed failed:', error instanceof Error ? error.message : error);
    await admin.end().catch(() => {});
    process.exit(1);
  });
