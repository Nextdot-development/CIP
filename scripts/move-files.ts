import postgres from 'postgres';
import { deleteFileForever } from '../src/server/drive/service';
import { recomputeBrandDna } from '../src/server/brain/brandDna';
import type { CompanyScope } from '../src/server/db';

/**
 * Takes files out of a company, and everything that was learned from them.
 *
 *   npm run unlearn -- <company-slug> <file-type|name-fragment>
 *
 * Deleting the file is the easy half. The hard half is that the Brain already
 * read it: its understanding, its evidence, and any Brand DNA fact that had no
 * other asset behind it all have to go too, or the company keeps believing
 * something it can no longer show you where it came from.
 *
 * Facts with other evidence survive with a lower count, which is what should
 * happen — they are less well evidenced now, not wrong.
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { ssl: 'require', max: 1, onnotice: () => {} });

async function main() {
  const [slug, match] = process.argv.slice(2);
  if (!slug || !match) {
    console.error('\n  npm run unlearn -- <company-slug> <file-type|name-fragment>\n');
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

  const files = await admin<{ id: string; name: string }[]>`
    select id, name from drive_files
     where company_id = ${scope.companyId}
       and archived_at is null
       and (file_type = ${match} or name ilike ${'%' + match + '%'})
     order by name
  `;

  if (files.length === 0) {
    console.log(`\n  Nothing in ${row.name} matches "${match}".\n`);
    await admin.end();
    return;
  }

  console.log(`\n  Removing ${files.length} file(s) from ${row.name}, and what they taught it.\n`);

  const ids = files.map((f) => f.id);

  // Evidence first, so a fact left with nothing behind it can be spotted.
  const evidence = await admin`
    delete from brand_dna_evidence
     where company_id = ${scope.companyId} and file_id = any(${ids})
    returning fact_id
  `;

  const orphans = await admin<{ id: string }[]>`
    delete from brand_dna_facts f
     where f.company_id = ${scope.companyId}
       and not exists (
         select 1 from brand_dna_evidence e where e.fact_id = f.id
       )
    returning f.id
  `;

  await admin`
    delete from asset_understanding
     where company_id = ${scope.companyId} and file_id = any(${ids})
  `;

  for (const file of files) {
    // Through the service, so the stored bytes go with the row rather than
    // being orphaned in the bucket.
    await deleteFileForever(scope, file.id).catch(() => {});
  }

  // What is left is re-counted, so anything that lost some of its evidence
  // says so rather than keeping a confidence it no longer earns.
  await recomputeBrandDna(scope);

  console.log(`  files removed:      ${files.length}`);
  console.log(`  evidence removed:   ${evidence.length}`);
  console.log(`  facts that had no other source: ${orphans.length}`);
  console.log('');

  await admin.end();
}

main().catch(async (error) => {
  console.error('\nfailed:', error instanceof Error ? error.message : error);
  await admin.end().catch(() => {});
  process.exit(1);
});
