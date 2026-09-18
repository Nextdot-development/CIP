import postgres from 'postgres';

/**
 * Moves one company's knowledge into another, under a brand.
 *
 *   npm run merge -- <from-slug> <into-slug> --brand "Magic Moments" [--apply]
 *
 * Magic Moments is one of Radico Khaitan's nine brands, and it was also its own
 * company in CIP — two memories of one brand, neither able to use the other.
 * The country decks knew what Magic Moments looks like in Nigeria; the Radico
 * brief knew what Magic Moments sounds like; and a request for a Nigerian Magic
 * Moments post could only ever have half of that.
 *
 * What moves is everything keyed by company: the files, what was read from
 * them, what was learned, what was generated, what feedback taught.
 *
 * What does not move is the bytes. An object was written under the old
 * company's prefix and stays there, because this is one database transaction
 * and an object store is not in it. Reads keep working — they follow the
 * stored path — but the key no longer names the company that owns the file,
 * and that key is what makes a mis-scoped read wrong in the object store too.
 * `npm run storage:relocate -- --apply` puts them right, and this prints a
 * reminder when it finishes. It claimed to move them for a while, which is why
 * thirty-three objects sat under the wrong company until somebody looked.
 * The facts that move are filed under the brand, which is what makes them
 * findable as that brand's rather than the house's.
 *
 * Dry by default. It prints what it would move and changes nothing until
 * --apply, because this is working data and a mistake here is expensive.
 *
 * The move is one transaction. Either the company arrives whole or nothing
 * happens: a half-moved company has files in one place and the facts about
 * them in another, which is worse than both starting states.
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { ssl: 'require', max: 1, onnotice: () => {} });

/**
 * Everything to re-point, in an order that never leaves a child ahead of its
 * parent. The composite foreign keys are (id, company_id) pairs, so a child
 * moved before its parent would briefly reference a row that is not there yet.
 */
const TABLES = [
  'drive_folders',
  'drive_files',
  'drive_file_extractions',
  'drive_file_chunks',
  'drive_file_embeddings',
  'asset_understanding',
  'pdf_page_understanding',
  'pdf_post',
  'brand_dna_facts',
  'brand_dna_evidence',
  'media_generations',
  'media_generation_assets',
  'generation_briefs',
  'generation_feedback',
  'brain_lessons',
  'brain_lesson_evidence',
  'google_drive_connections',
  'google_drive_files',
  'notification_dismissals',
];

/**
 * Left behind on purpose.
 *
 * Sessions belong to whoever signed in and should not survive the move.
 * Branding, the pod and the Phase-1 workspace tables describe the company that
 * is going away, and the one it joins already has its own.
 */
const LEAVE = [
  'sessions', 'memberships', 'company_branding', 'brand_profiles', 'brand_unlocks',
  'brand_topics', 'brand_confirmations', 'brand_palette', 'pod_members', 'requests',
  'monthly_metrics', 'work_items', 'rights_items', 'compliance_checks', 'learnings',
  'cost_lines', 'company_brands',
];

async function countsFor(companyId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = await admin<{ n: number }[]>`
      select count(*)::int as n from ${admin(table)} where company_id = ${companyId}
    `;
    counts[table] = rows[0]?.n ?? 0;
  }
  return counts;
}

async function main() {
  const [fromSlug, intoSlug] = process.argv.slice(2);
  const brandArg = process.argv.indexOf('--brand');
  const brand = brandArg > -1 ? process.argv[brandArg + 1] ?? null : null;
  const apply = process.argv.includes('--apply');

  if (!fromSlug || !intoSlug) {
    console.error('\n  npm run merge -- <from-slug> <into-slug> --brand "Name" [--apply]\n');
    process.exit(1);
  }

  const companies = await admin<{ id: string; slug: string; name: string }[]>`
    select id, slug, name from companies where slug in (${fromSlug}, ${intoSlug})
  `;
  const from = companies.find((c) => c.slug === fromSlug);
  const into = companies.find((c) => c.slug === intoSlug);
  if (!from) throw new Error(`no company "${fromSlug}"`);
  if (!into) throw new Error(`no company "${intoSlug}"`);

  if (brand) {
    const known = await admin<{ name: string }[]>`
      select name from company_brands where company_id = ${into.id} and name = ${brand}
    `;
    if (known.length === 0) {
      throw new Error(`"${brand}" is not on ${into.name}'s roster — add it first, or the facts would be filed under a brand nothing else knows about`);
    }
  }

  // Noted before the move, so the brand is applied to exactly what came
  // across rather than to everything the destination happens to hold.
  const movedFacts = await admin<{ id: string }[]>`
    select id from brand_dna_facts where company_id = ${from.id}
  `;
  const movedFactIds = movedFacts.map((f) => f.id);

  const before = await countsFor(from.id);
  const intoBefore = await countsFor(into.id);
  const moving = Object.entries(before).filter(([, n]) => n > 0);

  console.log(`\n  ${from.name}  ->  ${into.name}${brand ? `, as "${brand}"` : ''}\n`);
  for (const [table, n] of moving) {
    console.log(`    ${table.padEnd(28)} ${String(n).padStart(5)}`);
  }
  if (moving.length === 0) console.log('    (nothing to move)');

  const leaving = await admin<{ n: number }[]>`
    select count(*)::int as n from sessions where company_id = ${from.id}
  `;
  console.log(`\n  left behind: ${LEAVE.length} table(s) describing the old company, and ${leaving[0]!.n} session(s).`);

  if (!apply) {
    console.log('\n  Nothing changed. Add --apply to do it.\n');
    await admin.end();
    return;
  }

  // The composite foreign keys are what make cross-company parentage
  // impossible to represent — (file_id, company_id) has to match a drive_files
  // row in the same company — and that is exactly what blocks this. Moving the
  // parent breaks the child until the child moves too, and there is no order
  // that avoids it.
  //
  // So they are made deferrable for the move and checked at commit instead of
  // per statement. Deferred is not disabled: a company that arrives half-moved
  // still fails at COMMIT and rolls back. The constraints go back to immediate
  // afterwards, whatever happens.
  const constraints = await admin<{ child: string; conname: string }[]>`
    select conrelid::regclass::text as child, conname
      from pg_constraint
     where contype = 'f'
       and pg_get_constraintdef(oid) like '%company_id%'
       and not condeferrable
  `;

  const setDeferrable = async (on: boolean): Promise<void> => {
    for (const c of constraints) {
      await admin.unsafe(
        `alter table ${c.child} alter constraint "${c.conname}" ` +
          (on ? 'deferrable initially immediate' : 'not deferrable'),
      );
    }
  };

  await setDeferrable(true);
  console.log(`\n  ${constraints.length} constraint(s) deferred for the move.`);

  try {
    // One transaction: either it all arrives or none of it does.
    await admin.begin(async (tx) => {
      await tx.unsafe('set constraints all deferred');

      // A company may hold exactly one Google Drive connection, so two of them
      // cannot both arrive. The destination's is the one that stays — it is
      // the connection somebody set up for the company that is keeping the
      // work — and the synced-file records are re-pointed onto it so the
      // history of what came from Drive survives the move.
      const [keep] = await tx<{ id: string }[]>`
        select id from google_drive_connections where company_id = ${into.id}
      `;

      if (keep) {
        // The moved files came from a folder this connection does not watch, so
        // re-pointing them at it would have the next sync archive every one of
        // them as "no longer in the connected folder" — which is what happened
        // the first time, and took three country decks with it.
        //
        // Cutting the link is the truthful move: nothing is coming to update
        // them any more. They stay as ordinary files, with their history.
        const orphaned = await tx`
          delete from google_drive_files where company_id = ${from.id} returning id
        `;
        await tx`delete from google_drive_connections where company_id = ${from.id}`;
        console.log(
          `  kept the destination Google Drive connection; dropped the other and ` +
            `cut ${orphaned.length} sync link(s), so the next sync cannot archive them.`,
        );
      }

      for (const table of TABLES) {
        await tx`update ${tx(table)} set company_id = ${into.id} where company_id = ${from.id}`;
      }

      if (brand) {
        // Only the facts that came with this company. Anything the destination
        // already believed keeps whatever brand it had — the two briefs' facts
        // are already filed under the brand each is about.
        await tx`
          update brand_dna_facts set brand = ${brand}
           where company_id = ${into.id} and brand is null
             and id = any(${movedFactIds})
        `;
      }

      // Signed-in sessions for a company that no longer holds anything would
      // resolve to an empty workspace.
      await tx`delete from sessions where company_id = ${from.id}`;
    });
  } finally {
    // Back to immediate, whether the move worked or not. Leaving the database
    // looser than it was found would be a worse outcome than a failed merge.
    await setDeferrable(false);
    console.log('  constraints back to immediate.');
  }

  const after = await countsFor(into.id);
  const stillThere = await countsFor(from.id);

  console.log('\n  moved:');
  let wrong = 0;
  for (const table of TABLES) {
    // One connection per company, so two cannot both arrive: one was dropped
    // on purpose above, and counting it as missing would cry wolf on every
    // merge where the destination was already connected.
    const expected =
      table === 'google_drive_connections'
        ? Math.max(intoBefore[table] ?? 0, before[table] ?? 0)
        : (intoBefore[table] ?? 0) + (before[table] ?? 0);
    const actual = after[table] ?? 0;
    const left = stillThere[table] ?? 0;
    if (actual !== expected || left !== 0) {
      console.log(`    ${table.padEnd(28)} expected ${expected}, found ${actual}, ${left} left behind  MISMATCH`);
      wrong += 1;
    } else if (before[table]) {
      console.log(`    ${table.padEnd(28)} ${String(actual).padStart(5)}`);
    }
  }

  console.log(wrong === 0 ? '\n  Every row accounted for.\n' : `\n  ${wrong} table(s) do not add up — check before trusting this.\n`);

  // The rows have moved and their objects have not: they are still under the
  // old company's prefix, which reads fine and is wrong.
  console.log('  The bytes are still under the old company. Put them right with:');
  console.log('    npm run storage:relocate -- --apply\n');
  await admin.end();
  if (wrong > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error('\nmerge failed:', error instanceof Error ? error.message : error);
  await admin.end().catch(() => {});
  process.exit(1);
});
