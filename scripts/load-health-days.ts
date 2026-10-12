import postgres from 'postgres';
import { addOccasion } from '../src/server/brain/calendar';
import { HEALTH_DAYS } from '../src/server/brain/healthDays';

/**
 * Puts the health awareness days on a company's calendar.
 *
 *   npm run calendar:health -- narayana-health
 *
 * Safe to run again: an occasion already there is updated, never doubled, and
 * a note somebody typed on it is kept.
 */
async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug) {
    console.error('\n  npm run calendar:health -- <company-slug>\n');
    process.exit(1);
  }
  const sql = postgres(process.env.DATABASE_ADMIN_URL!, { ssl: 'require', max: 1, onnotice: () => {} });
  const [company] = await sql<{ id: string; category: string }[]>`select id, category from companies where slug = ${slug}`;
  const [owner] = company
    ? await sql<{ user_id: string }[]>`select user_id from memberships where company_id = ${company.id} order by (role = 'owner') desc limit 1`
    : [];
  await sql.end();
  if (!company || !owner) throw new Error(`no company "${slug}" with a member`);
  if (company.category !== 'healthcare') console.warn(`  note: "${slug}" is not a healthcare company`);

  const scope = { companyId: company.id, userId: owner.user_id, role: 'owner' as const };
  let added = 0;
  for (const day of HEALTH_DAYS) {
    if (await addOccasion(scope, { ...day, kind: 'observance', source: 'imported', note: 'Health awareness day' })) added += 1;
  }
  console.log(`\n  ${added} health day(s) on the calendar of ${slug}.\n`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
