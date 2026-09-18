import postgres from 'postgres';
import { writeFileSync } from 'node:fs';
import type { CompanyScope } from '../src/server/db';
import { recomputeBrandDna } from '../src/server/brain/brandDna';
import { recomputeRelations } from '../src/server/brain/relations';

/**
 * Folds brand lines into their parent brand.
 *
 *   npm run brands:merge -- <company-slug> --into "Whytehall" \
 *     --from "Whytehall Honey" --from "Whytehall Fire" [--backup file.json] [--apply]
 *
 * The roster once listed a brand's lines as brands of their own - Whytehall
 * Honey beside Whytehall, Magic Moments Remix beside Magic Moments - so that a
 * line's look would not be averaged into its parent. In use that read as the
 * same brand three times, and the house thinks of them as one brand. This puts
 * them back together.
 *
 * What moves: every fact, file, lesson, rule, occasion and check filed under a
 * line is re-filed under the parent. A fact the parent already holds is not
 * duplicated - its evidence joins the parent's copy. The line's name becomes
 * an alias of the parent, so a file called "Whytehall Honey Logo.png" still
 * lands on Whytehall. Traits and relations are derived, so they are rebuilt
 * rather than moved.
 *
 * Dry by default. With --apply it writes a backup of every row it changes
 * first, then makes the change in one transaction: a half-merged brand has
 * facts under one name and files under another, which is worse than either.
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { onnotice: () => {}, max: 1 });

const APPLY = process.argv.includes('--apply');

function args(): { slug: string; into: string; from: string[]; backup: string | null } {
  const argv = process.argv.slice(2);
  const from: string[] = [];
  let into = '';
  let backup: string | null = null;
  let slug = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--into') into = argv[++i] ?? '';
    else if (arg === '--from') from.push(argv[++i] ?? '');
    else if (arg === '--backup') backup = argv[++i] ?? null;
    else if (arg === '--apply') continue;
    else if (!slug) slug = arg;
  }
  return { slug, into: into.trim(), from: from.map((f) => f.trim()).filter(Boolean), backup };
}

/** Tables whose brand is a plain label, with no uniqueness that includes it. */
const PLAIN = ['drive_files', 'creative_checks', 'content_calendar'] as const;

async function main(): Promise<void> {
  const { slug, into, from, backup } = args();
  if (!slug || !into || from.length === 0) {
    console.error('\n  npm run brands:merge -- <company-slug> --into "<Brand>" --from "<Line>" [--from ...] [--backup file] [--apply]\n');
    process.exit(1);
  }
  if (from.includes(into)) throw new Error('a brand cannot be merged into itself');

  const [company] = await admin<{ company_id: string; user_id: string; name: string }[]>`
    select c.id as company_id, u.id as user_id, c.name
      from companies c
      join memberships m on m.company_id = c.id
      join users u on u.id = m.user_id
     where c.slug = ${slug}
     order by m.role
     limit 1
  `;
  if (!company) throw new Error(`no company with slug "${slug}"`);
  const companyId = company.company_id;

  const roster = await admin<{ name: string; note: string | null; aliases: string[] | null }[]>`
    select name, note, aliases from company_brands where company_id = ${companyId}
  `;
  const parent = roster.find((b) => b.name === into);
  if (!parent) throw new Error(`"${into}" is not on ${company.name}'s roster`);
  const lines = from
    .map((name) => roster.find((b) => b.name === name))
    .filter((b): b is NonNullable<typeof b> => {
      return Boolean(b);
    });
  const missing = from.filter((name) => !roster.some((b) => b.name === name));
  if (missing.length) console.log(`Not on the roster, skipped: ${missing.join(', ')}`);
  if (lines.length === 0) {
    console.log('Nothing to merge.');
    return;
  }
  const names = lines.map((l) => l.name);

  // ---- the plan ------------------------------------------------------------
  console.log(`\n${company.name}: merging ${names.map((n) => `"${n}"`).join(', ')} into "${into}"\n`);
  for (const name of names) {
    const [facts] = await admin<{ n: number; shared: number }[]>`
      select count(*)::int as n,
             count(*) filter (where exists (
               select 1 from brand_dna_facts p
                where p.company_id = v.company_id and p.brand = ${into}
                  and p.section = v.section and p.attribute = v.attribute and p.value = v.value
             ))::int as shared
        from brand_dna_facts v
       where v.company_id = ${companyId} and v.brand = ${name}
    `;
    const counts: string[] = [`facts ${facts!.n} (${facts!.shared} already held by ${into})`];
    for (const table of [...PLAIN, 'brain_lessons', 'compliance_rules']) {
      const [row] = await admin<{ n: number }[]>`
        select count(*)::int as n from ${admin(table)} where company_id = ${companyId} and brand = ${name}
      `;
      if (row!.n > 0) counts.push(`${table} ${row!.n}`);
    }
    console.log(`  ${name}: ${counts.join(', ')}`);
  }

  if (!APPLY) {
    console.log('\nDry run - nothing changed. Add --apply to merge.\n');
    return;
  }

  // ---- backup --------------------------------------------------------------
  const snapshot: Record<string, unknown> = { company: slug, into, from: names, takenAt: new Date().toISOString() };
  snapshot.roster = lines.concat(parent);
  snapshot.brand_dna_facts = await admin`
    select * from brand_dna_facts where company_id = ${companyId} and brand in ${admin(names)}
  `;
  snapshot.brand_dna_evidence = await admin`
    select e.id, e.fact_id from brand_dna_evidence e
      join brand_dna_facts f on f.id = e.fact_id and f.company_id = e.company_id
     where e.company_id = ${companyId} and f.brand in ${admin(names)}
  `;
  for (const table of [...PLAIN, 'brain_lessons', 'compliance_rules']) {
    snapshot[table] = await admin`
      select id, brand from ${admin(table)} where company_id = ${companyId} and brand in ${admin(names)}
    `;
  }
  const backupPath = backup ?? `brand-merge-${slug}-${Date.now()}.json`;
  writeFileSync(backupPath, JSON.stringify(snapshot, null, 2));
  console.log(`\nBackup written to ${backupPath}`);

  // ---- the merge -----------------------------------------------------------
  await admin.begin(async (tx) => {
    // One line at a time, so two lines holding the same fact collapse into the
    // parent's copy instead of colliding with each other.
    for (const name of names) {
      const pairs = await tx<{ variant_id: string; parent_id: string }[]>`
        select v.id as variant_id, p.id as parent_id
          from brand_dna_facts v
          join brand_dna_facts p
            on p.company_id = v.company_id and p.brand = ${into}
           and p.section = v.section and p.attribute = v.attribute and p.value = v.value
         where v.company_id = ${companyId} and v.brand = ${name}
      `;
      for (const pair of pairs) {
        await tx`update brand_dna_evidence set fact_id = ${pair.parent_id}
                  where company_id = ${companyId} and fact_id = ${pair.variant_id}`;
        await tx`update check_flags set fact_id = ${pair.parent_id}
                  where company_id = ${companyId} and fact_id = ${pair.variant_id}`;
        await tx`delete from brand_dna_facts where company_id = ${companyId} and id = ${pair.variant_id}`;
      }
      await tx`update brand_dna_facts set brand = ${into}, updated_at = now()
                where company_id = ${companyId} and brand = ${name}`;

      // Lessons and rules carry the brand in their identity. None exist for a
      // line today; if one ever collides, stop rather than guess which to keep.
      for (const table of ['brain_lessons', 'compliance_rules'] as const) {
        try {
          await tx`update ${tx(table)} set brand = ${into} where company_id = ${companyId} and brand = ${name}`;
        } catch (error) {
          throw new Error(`${table}: "${name}" holds a row "${into}" already has - resolve it by hand (${error instanceof Error ? error.message : 'conflict'})`);
        }
      }
      for (const table of PLAIN) {
        await tx`update ${tx(table)} set brand = ${into} where company_id = ${companyId} and brand = ${name}`;
      }
    }

    await tx`delete from brand_relations where company_id = ${companyId}
              and (brand_a in ${tx(names)} or brand_b in ${tx(names)})`;
    await tx`delete from brand_traits where company_id = ${companyId} and brand in ${tx(names)}`;

    // The lines' names live on as the parent's aliases, and what made each
    // distinct stays in the parent's note, which is what the model reads when
    // it decides which brand a fact is about.
    const aliases = [
      ...new Set(
        [...(parent.aliases ?? []), ...names, ...lines.flatMap((l) => l.aliases ?? [])]
          .map((a) => a.trim().toLowerCase())
          .filter((a) => a.length > 1 && a !== into.toLowerCase()),
      ),
    ];
    const described = lines
      .filter((l) => l.note && !/^A .* line\. Named separately/.test(l.note))
      .map((l) => `${l.name.replace(`${into} `, '')} (${(l.note ?? '').split('.')[0]!.trim()})`);
    const lineList = names.map((n) => n.replace(`${into} `, '')).join(', ');
    const note = [
      parent.note?.replace(/\s*Lines: .*$/, '') ?? '',
      `Lines: ${lineList}${described.length ? ` - ${described.join('; ')}` : ''}.`,
    ].filter(Boolean).join(' ');

    await tx`update company_brands set aliases = ${aliases}, note = ${note}
              where company_id = ${companyId} and name = ${into}`;
    await tx`delete from company_brands where company_id = ${companyId} and name in ${tx(names)}`;
  });
  console.log('Merged.');

  // ---- rebuild what is derived --------------------------------------------
  const scope: CompanyScope = { companyId, userId: company.user_id, role: 'owner' };
  const dna = await recomputeBrandDna(scope);
  // Forced: a brand has just been folded into another, and a brand that no
  // longer exists moves no timestamp the freshness check can see.
  const relations = await recomputeRelations(scope, { force: true });
  console.log(`Brand DNA recomputed: ${dna.facts} active facts. Relations rebuilt: ${relations.brands} brands, ${relations.traits} traits, ${relations.relations} relations.\n`);
}

main()
  .then(async () => {
    await admin.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await admin.end({ timeout: 1 });
    process.exit(1);
  });
