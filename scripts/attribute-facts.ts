import postgres from 'postgres';
import { companyBrands, brandForText } from '../src/server/brain/brands';
import type { CompanyScope } from '../src/server/db';

/**
 * Gives a brand back to knowledge that arrived without one.
 *
 *   npm run attribute -- <company-slug>            # show what would change
 *   npm run attribute -- <company-slug> --apply    # write it
 *
 * A fact is attributed at the moment an asset is read, against whatever roster
 * the company had at the time. Add a brand afterwards — or discover that its
 * bottles are all filed under an expression name — and everything already
 * learnt about it stays filed under nobody. That pool is not harmless: it
 * competes with every brand's own knowledge in every brief, and on the real
 * library it was winning.
 *
 * This does not ask a model anything. It uses the evidence CIP already stored:
 * which files produced a fact, and which brand those files belong to. A fact
 * is moved only when *every* file behind it points at the same single brand.
 * Anything evidenced by two brands' files is left alone, because that is what
 * a house-wide fact actually looks like and the two are not distinguishable
 * from the outside.
 *
 * Dry by default, and it prints every change it would make. Re-running it is
 * safe: a fact that already has a brand is never touched.
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { onnotice: () => {} });

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug || slug.startsWith('--')) {
    console.error('\n  npm run attribute -- <company-slug> [--apply]\n');
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
  const brands = await companyBrands(scope);
  if (brands.length === 0) {
    console.log(`\n${row.name} has no brand roster, so there is nothing to attribute to.\n`);
    return;
  }

  console.log(`\n${row.name} — ${brands.length} brand(s) on the roster\n`);

  // Every unattributed fact, with the names of the files that evidenced it.
  const facts = await admin<{ id: string; attribute: string; value: string; files: string[] }[]>`
    select b.id, b.attribute, b.value, array_agg(distinct f.name) as files
      from brand_dna_facts b
      join brand_dna_evidence e on e.fact_id = b.id and e.company_id = b.company_id
      join drive_files f on f.id = e.file_id and f.company_id = e.company_id
     where b.company_id = ${scope.companyId}
       and b.status = 'active'
       and b.brand is null
     group by b.id, b.attribute, b.value
  `;

  const moves: { id: string; brand: string; attribute: string; value: string }[] = [];
  let spansBrands = 0;
  let saysNothing = 0;

  for (const fact of facts) {
    const perFile = fact.files.map((name) => brandForText(name, brands));

    // Every file must name a brand, and it must be the same one. A single
    // file that says nothing is enough to stop the move: it may be the one
    // piece of evidence that makes this fact house-wide.
    if (perFile.some((b) => b === null)) {
      saysNothing += 1;
      continue;
    }
    const distinct = new Set(perFile as string[]);
    if (distinct.size !== 1) {
      spansBrands += 1;
      continue;
    }

    moves.push({ id: fact.id, brand: [...distinct][0]!, attribute: fact.attribute, value: fact.value });
  }

  const tally = new Map<string, number>();
  for (const move of moves) tally.set(move.brand, (tally.get(move.brand) ?? 0) + 1);

  for (const [brand, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${brand.padEnd(26)} ${String(n).padStart(5)} fact(s) would become theirs`);
  }

  console.log(`\n  left as house-wide:`);
  console.log(`    ${String(spansBrands).padStart(5)}  evidenced by more than one brand's files`);
  console.log(`    ${String(saysNothing).padStart(5)}  from files whose names name no brand`);

  // A sample, so a person can check the reasoning rather than trust the count.
  console.log('\n  for example:');
  for (const move of moves.slice(0, 8)) {
    console.log(`    ${move.brand.padEnd(22)} ${move.attribute}: ${move.value.slice(0, 44)}`);
  }

  if (!APPLY) {
    console.log(`\n  Nothing written. Re-run with --apply to make these ${moves.length} change(s).\n`);
    return;
  }

  // One transaction: a half-attributed library is worse than an unattributed
  // one, because the half that moved no longer balances the half that did not.
  let written = 0;
  await admin.begin(async (tx) => {
    for (const move of moves) {
      // The identity index includes the brand, so a fact moving onto a brand
      // that already holds the same claim would collide. The older row wins
      // and this one is retired rather than the whole batch failing.
      const done = await tx<{ id: string }[]>`
        update brand_dna_facts
           set brand = ${move.brand}, updated_at = now()
         where id = ${move.id} and company_id = ${scope.companyId}
           and not exists (
             select 1 from brand_dna_facts other
              where other.company_id = ${scope.companyId}
                and other.section = brand_dna_facts.section
                and other.attribute = brand_dna_facts.attribute
                and other.value = brand_dna_facts.value
                and other.brand = ${move.brand}
           )
        returning id
      `;
      if (done.length > 0) written += 1;
    }
  });

  console.log(`\n  ${written} fact(s) attributed. ${moves.length - written} already existed under that brand.\n`);
}

main()
  .then(async () => {
    await admin.end();
  })
  .catch(async (error) => {
    console.error('\nattribute failed:', error instanceof Error ? error.message : error);
    await admin.end().catch(() => {});
    process.exit(1);
  });
