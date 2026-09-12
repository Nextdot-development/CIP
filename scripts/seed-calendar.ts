/**
 * Puts a year of occasions on a company's calendar.
 *
 *   npm run calendar -- <company-slug>            # show what would be added
 *   npm run calendar -- <company-slug> --apply
 *
 * The rows below are the 2026 West Africa calendar as it was supplied, plus
 * the dates checking it against the public holiday lists showed were missing.
 * Both are marked in `source`, so what came from the sheet and what CIP
 * suggested stay tellable apart and a person can throw the suggestions away.
 *
 * Nothing here is computed. Easter moves, Eid moves against the Gregorian
 * calendar every year, and a rule that computes them would be CIP asserting
 * dates it has no business asserting. Next year somebody enters next year's,
 * which is an hour of honest work.
 */
import postgres from 'postgres';
import { addOccasion } from '../src/server/brain/calendar';
import type { NewOccasion } from '../src/server/brain/calendar';
import type { CompanyScope } from '../src/server/db';

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { onnotice: () => {} });
const APPLY = process.argv.includes('--apply');

const EN = ['English'];
const EN_FR = ['English', 'French'];

/** Exactly the supplied sheet. Ghana's dates, headed West Africa. */
const FROM_SHEET: NewOccasion[] = [
  { occasion: 'Independence Day', market: 'Ghana', startsOn: '2026-03-06', kind: 'public_holiday', languages: EN },
  { occasion: 'Easter Sunday', market: 'West Africa', startsOn: '2026-04-05', kind: 'observance', languages: EN_FR },
  { occasion: 'Easter Monday', market: 'West Africa', startsOn: '2026-04-06', kind: 'public_holiday', languages: EN_FR },
  { occasion: 'May Day', market: 'West Africa', startsOn: '2026-05-01', kind: 'public_holiday', languages: EN_FR },
  { occasion: "Mothers' Day", market: 'West Africa', startsOn: '2026-05-10', kind: 'observance', languages: EN },
  { occasion: 'African Union Day', market: 'West Africa', startsOn: '2026-05-25', kind: 'observance', languages: EN },
  { occasion: "Fathers' Day", market: 'West Africa', startsOn: '2026-06-21', kind: 'observance', languages: EN_FR },
  { occasion: "Founders' Day", market: 'Ghana', startsOn: '2026-09-21', kind: 'public_holiday', languages: EN },
  { occasion: 'Black Friday', market: 'West Africa', startsOn: '2026-11-27', kind: 'observance', languages: EN_FR },
  { occasion: "Farmers' Day", market: 'Ghana', startsOn: '2026-12-04', kind: 'public_holiday', languages: EN },
  { occasion: 'Christmas Eve', market: 'West Africa', startsOn: '2026-12-24', kind: 'observance', languages: EN_FR },
  { occasion: 'Christmas Day', market: 'West Africa', startsOn: '2026-12-25', kind: 'public_holiday', languages: EN_FR },
  { occasion: 'Boxing Day', market: 'West Africa', startsOn: '2026-12-26', kind: 'public_holiday', languages: EN_FR },
  { occasion: "New Year's Eve", market: 'West Africa', startsOn: '2026-12-31', kind: 'observance', languages: EN_FR },
];

/**
 * What checking the sheet against the published holiday lists turned up.
 *
 * Every date here was verified against a national holiday list, not guessed.
 * They are suggestions rather than facts about this company's plans: whether
 * Radico markets around Eid in a given country is a decision for the people
 * who know the market, and CIP putting it on the calendar is not that decision
 * being made.
 */
const SUGGESTED: NewOccasion[] = [
  {
    occasion: 'Republic Day',
    market: 'Ghana',
    startsOn: '2026-07-03',
    kind: 'public_holiday',
    languages: EN,
    note: 'Falls on Wednesday 1 July and is observed Friday 3 July under Act 601. Missing from the supplied sheet.',
  },
  {
    occasion: 'Eid al-Fitr',
    market: 'West Africa',
    startsOn: '2026-03-19',
    endsOn: '2026-03-20',
    kind: 'public_holiday',
    languages: EN_FR,
    note: 'A public holiday across West Africa and absent from the sheet. Worth a deliberate decision for an alcohol brand rather than an oversight.',
  },
  {
    occasion: 'Eid al-Adha',
    market: 'West Africa',
    startsOn: '2026-05-27',
    endsOn: '2026-05-28',
    kind: 'public_holiday',
    languages: EN_FR,
    note: 'As above. Two days, and it moves about eleven days earlier each year.',
  },
  {
    occasion: 'Independence Day',
    market: 'Nigeria',
    startsOn: '2026-10-01',
    kind: 'public_holiday',
    languages: EN,
    note: 'Nigeria is the largest West African market and does not appear on the sheet at all.',
  },
  {
    occasion: 'Democracy Day',
    market: 'Nigeria',
    startsOn: '2026-06-12',
    kind: 'public_holiday',
    languages: EN,
  },
  {
    occasion: 'Eid-el-Maulud',
    market: 'Nigeria',
    startsOn: '2026-08-25',
    kind: 'public_holiday',
    languages: EN,
  },
  {
    occasion: 'Detty December',
    market: 'West Africa',
    startsOn: '2026-12-01',
    endsOn: '2026-12-31',
    kind: 'season',
    languages: EN_FR,
    note: 'Not a date. The December return-season across Nigeria and Ghana, and the commercial peak of the year for spirits - the sheet has four December days and not the season they sit inside.',
  },
];

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug || slug.startsWith('--')) {
    console.error('\n  npm run calendar -- <company-slug> [--apply]\n');
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

  const all = [
    ...FROM_SHEET.map((o) => ({ ...o, source: 'imported' as const })),
    ...SUGGESTED.map((o) => ({ ...o, source: 'suggested' as const })),
  ];

  console.log(`\n${row.name} — ${FROM_SHEET.length} from the sheet, ${SUGGESTED.length} suggested\n`);
  for (const occasion of all) {
    const span = occasion.endsOn && occasion.endsOn !== occasion.startsOn
      ? `${occasion.startsOn} to ${occasion.endsOn}`
      : occasion.startsOn;
    const mark = occasion.source === 'suggested' ? '+' : ' ';
    console.log(`  ${mark} ${span.padEnd(24)} ${(occasion.market ?? 'everywhere').padEnd(13)} ${occasion.occasion}`);
  }

  if (!APPLY) {
    console.log(`\n  Nothing written. Re-run with --apply to add these ${all.length}.\n`);
    return;
  }

  let added = 0;
  for (const occasion of all) if (await addOccasion(scope, occasion)) added += 1;
  console.log(`\n  ${added} occasion(s) on the calendar.\n`);
}

main()
  .then(async () => { await admin.end(); })
  .catch(async (error) => {
    console.error('\ncalendar seed failed:', error instanceof Error ? error.message : error);
    await admin.end().catch(() => {});
    process.exit(1);
  });
