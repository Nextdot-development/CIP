import postgres from 'postgres';
import { embedAssets } from '../src/server/drive/assetSearch';

/**
 * Embeds what CIP saw in each picture, so Creative Search can find them.
 *
 *   npm run embed:assets -- radico-khaitan
 *
 * Search by meaning runs on document chunks, and a chunk belongs to an
 * extraction — the text pulled out of a document. A photograph has none, so it
 * had no vector, so Creative Search could not find a single image. On this
 * database that was 431 pictures invisible to the search built to find them.
 *
 * Safe to run again. An asset already embedded under this model is skipped, and
 * a re-read replaces its vector rather than leaving the old description
 * findable for ever.
 */

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug || slug.startsWith('--')) {
    console.error('\n  npm run embed:assets -- <company-slug>\n');
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

    const [owner] = await sql<{ user_id: string }[]>`
      select user_id from memberships where company_id = ${company.id} limit 1
    `;
    if (!owner) throw new Error(`${company.name} has no members`);

    console.log(`\n  ${company.name}\n`);

    const scope = { companyId: company.id, userId: owner.user_id, role: 'owner' as const };
    const { embedded, skipped } = await embedAssets(scope, {
      onProgress: (done, total) => {
        process.stderr.write(`  ${done}/${total}\n`);
      },
    });

    console.log(`\n  embedded  ${embedded}`);
    console.log(`  skipped   ${skipped}   (nothing worth embedding was written about them)`);
    console.log('\n  Creative Search can find these by what is in them now.\n');
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('\nembedding failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
