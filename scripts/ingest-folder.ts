import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import postgres from 'postgres';
import { uploadFile } from '../src/server/drive/service';
import { marketFromFilename, setFileMarket } from '../src/server/brain/markets';
import type { CompanyScope } from '../src/server/db';

/**
 * Puts a folder of real assets into a company's Drive.
 *
 *   npm run ingest -- <company-slug> <folder> [--market "India"]
 *
 * For the case a Google Drive connection does not cover: a folder that already
 * exists on this machine and needs to be in CIP. Everything after the upload is
 * the ordinary pipeline — the worker reads them, the Brain looks at them, and
 * the facts land wherever they belong.
 *
 * Safe to run twice: a file already in the Drive under the same name is left
 * alone rather than uploaded again, so re-running after adding a few files does
 * only the few.
 */

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { ssl: 'require', max: 1, onnotice: () => {} });

/** What the Drive will accept and the Brain can do something with. */
const READABLE = new Set([
  '.pdf', '.docx', '.txt', '.csv', '.md',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.mp4', '.mov', '.webm',
]);

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

async function main() {
  const [slug, folder] = process.argv.slice(2);
  const marketArg = process.argv.indexOf('--market');
  const market = marketArg > -1 ? process.argv[marketArg + 1] ?? null : null;

  if (!slug || !folder) {
    console.error('\n  npm run ingest -- <company-slug> <folder> [--market "India"]\n');
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

  const existing = await admin<{ name: string }[]>`
    select name from drive_files
     where company_id = ${scope.companyId} and archived_at is null
  `;
  const already = new Set(existing.map((f) => f.name));

  const entries = readdirSync(folder)
    .filter((name) => statSync(join(folder, name)).isFile())
    .filter((name) => READABLE.has(extname(name).toLowerCase()))
    .sort();

  console.log(`\nInto ${row.name} — ${entries.length} readable file(s) in ${folder}\n`);

  let added = 0;
  let skipped = 0;

  for (const name of entries) {
    if (already.has(name)) {
      skipped += 1;
      continue;
    }

    const body = readFileSync(join(folder, name));
    const extension = extname(name).toLowerCase();

    try {
      const file = await uploadFile(scope, {
        folderId: null,
        filename: name,
        mimeType: MIME[extension] ?? 'application/octet-stream',
        body,
      });

      // A market named on the command line wins; otherwise the filename may
      // say, and that suggestion is correctable in the UI like any other.
      const placed = market ?? marketFromFilename(name);
      if (placed) await setFileMarket(scope, file.id, placed);

      added += 1;
      console.log(
        `  + ${name.slice(0, 62).padEnd(63)} ${(body.length / 1024 / 1024).toFixed(1)} MB` +
          (placed ? `  ${placed}` : ''),
      );
    } catch (error) {
      console.log(`  ! ${name.slice(0, 62).padEnd(63)} ${error instanceof Error ? error.message : ''}`);
    }
  }

  console.log(`\n  ${added} added, ${skipped} already there.`);
  console.log('  Now read them: npm run cip:worker\n');

  await admin.end();
}

main().catch(async (error) => {
  console.error('\ningest failed:', error instanceof Error ? error.message : error);
  await admin.end().catch(() => {});
  process.exit(1);
});
